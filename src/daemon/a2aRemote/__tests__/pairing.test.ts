import { describe, expect, it } from 'vitest';
import { parseInvite } from '../../../shared/a2aRemote';
import { A2A_PAIR_MAX_ATTEMPTS, A2A_PAIR_TTL_MS, PairingSlot, inviteHost, mintPairCode } from '../pairing';
import { inviteAlt, inviteIpv4s, rankedExternalIpv4s, type RankedIpv4 } from '../server';

const FP = Array.from({ length: 32 }, () => 'AB').join(':');

describe('PairingSlot', () => {
  it('mints codes the invite grammar accepts', () => {
    for (let i = 0; i < 50; i++) expect(mintPairCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it('begin returns a parseable invite with a 10 minute deadline', () => {
    let now = 1_000;
    const slot = new PairingSlot({ now: () => now, mintCode: () => 'ABCDEFGH' });
    const r = slot.begin({ host: 'desk-pc', port: 45660, fingerprint256: FP });
    expect(parseInvite(r.invite)).toEqual({
      ok: true,
      invite: { host: 'desk-pc', port: 45660, code: 'ABCDEFGH', fingerprint256: FP },
    });
    expect(r.expiresAt).toBe(1_000 + A2A_PAIR_TTL_MS);
    now += A2A_PAIR_TTL_MS;
    expect(slot.status().active).toBe(false);
    expect(slot.check('ABCDEFGH')).toEqual({ ok: false, reason: 'expired' });
  });

  it('burns the code after five wrong attempts', () => {
    const slot = new PairingSlot({ mintCode: () => 'ABCDEFGH' });
    slot.begin({ host: 'h', port: 1, fingerprint256: FP });
    for (let i = 1; i <= A2A_PAIR_MAX_ATTEMPTS; i++) {
      expect(slot.check('ZZZZZZZZ')).toEqual({ ok: false, reason: 'invalid-code' });
    }
    expect(slot.check('ABCDEFGH')).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts lower case, is single use after consume, and cancel clears it', () => {
    const slot = new PairingSlot({ mintCode: () => 'ABCDEFGH' });
    slot.begin({ host: 'h', port: 1, fingerprint256: FP });
    expect(slot.check(' abcdefgh ')).toEqual({ ok: true });
    slot.consume();
    expect(slot.check('ABCDEFGH')).toEqual({ ok: false, reason: 'expired' });
    slot.begin({ host: 'h', port: 1, fingerprint256: FP });
    slot.cancel();
    expect(slot.status()).toEqual({ active: false, expiresAt: null, attemptsLeft: 0 });
  });
});

describe('inviteHost', () => {
  it('prefers a valid machine name, falls back to the first IPv4', () => {
    expect(inviteHost('DESKTOP-AB12', ['10.0.0.5'])).toBe('DESKTOP-AB12');
    expect(inviteHost('My PC', ['10.0.0.5', '10.0.0.6'])).toBe('10.0.0.5');
    expect(inviteHost('', [])).toBeNull();
  });
});

describe('invite addresses', () => {
  const nic = (address: string, internal = false) =>
    ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as const;

  it('ranks physical before virtual adapters and CGNAT, then RFC1918 first; drops link-local', () => {
    const ranked = rankedExternalIpv4s({
      'vEthernet (WSL)': [nic('172.20.0.1')],
      docker0: [nic('172.17.0.1')],
      lo0: [nic('127.0.0.1', true)],
      en7: [nic('203.0.113.5')],
      Ethernet: [nic('10.1.2.3')],
      'Wi-Fi': [nic('169.254.9.9'), nic('192.168.0.20')],
      en9: [nic('100.101.102.103')],
      utun3: [nic('100.64.0.2')],
    } as never);
    expect(ranked).toEqual([
      { address: '10.1.2.3', preferred: true, tailnet: false },
      { address: '192.168.0.20', preferred: true, tailnet: false },
      { address: '203.0.113.5', preferred: true, tailnet: false },
      { address: '172.20.0.1', preferred: false, tailnet: false },
      { address: '172.17.0.1', preferred: false, tailnet: false },
      // CGNAT on a physical adapter is not a tailnet address.
      { address: '100.101.102.103', preferred: false, tailnet: false },
      { address: '100.64.0.2', preferred: false, tailnet: true },
    ]);
    // 100.64/10 only: 100.63.x and 100.128.x are ordinary addresses.
    expect(rankedExternalIpv4s({ en0: [nic('100.63.0.1'), nic('100.128.0.1')] } as never).every((r) => r.preferred)).toBe(true);
  });

  it('flags Tailscale adapters on every platform, and only in 100.64/10', () => {
    const ranked = rankedExternalIpv4s({
      tailscale0: [nic('100.100.1.1')],
      Tailscale: [nic('100.100.1.2')],
      utun4: [nic('100.100.1.3'), nic('10.8.0.2')],
      docker0: [nic('100.100.1.4')],
    } as never);
    expect(ranked.filter((r) => r.tailnet).map((r) => r.address)).toEqual(['100.100.1.1', '100.100.1.2', '100.100.1.3']);
  });

  const lan = (address: string): RankedIpv4 => ({ address, preferred: true, tailnet: false });
  const tail = (address: string): RankedIpv4 => ({ address, preferred: false, tailnet: true });
  const virt = (address: string): RankedIpv4 => ({ address, preferred: false, tailnet: false });

  it('an invite offers the LAN addresses, then the tailnet ones; other virtual adapters only when nothing is preferred', () => {
    // LAN only: unchanged.
    expect(inviteIpv4s([lan('10.1.2.3'), virt('172.17.0.1')])).toEqual(['10.1.2.3']);
    // LAN + tailnet: the tailnet address follows the LAN ones; Docker/WSL stay out.
    expect(inviteIpv4s([lan('10.1.2.3'), lan('192.168.0.20'), virt('172.20.0.1'), tail('100.64.0.2')])).toEqual([
      '10.1.2.3', '192.168.0.20', '100.64.0.2',
    ]);
    // Tailnet only: it comes first, the other virtual adapters last.
    expect(inviteIpv4s([virt('172.20.0.1'), virt('172.17.0.1'), tail('100.64.0.2')])).toEqual([
      '100.64.0.2', '172.20.0.1', '172.17.0.1',
    ]);
    // Nothing preferred, no tailnet: everything, as ranked.
    expect(inviteIpv4s([virt('172.20.0.1'), virt('100.101.0.1')])).toEqual(['172.20.0.1', '100.101.0.1']);
  });

  it('alt keeps the last slot for a tailnet address when LAN addresses would fill every slot', () => {
    const many = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5'];
    // Name host: 4 slots, LAN would fill them all.
    expect(inviteAlt([...many, '100.64.0.2'], 'desk-pc')).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3', '100.64.0.2']);
    // IP host (no usable name): host + 4 alt, still one of them the tailnet address.
    expect(inviteAlt([...many, '100.64.0.2'], '10.0.0.1')).toEqual(['10.0.0.2', '10.0.0.3', '10.0.0.4', '100.64.0.2']);
    // No tailnet address: LAN behaviour unchanged (host + 4).
    expect(inviteAlt(many, 'desk-pc')).toEqual(many.slice(0, 4));
    expect(inviteAlt(many, '10.0.0.1')).toEqual(many.slice(1, 5));
    // Room to spare: nothing is replaced.
    expect(inviteAlt(['10.0.0.1', '100.64.0.2'], 'desk-pc')).toEqual(['10.0.0.1', '100.64.0.2']);
    // The tailnet address is the host itself: no slot reserved.
    expect(inviteAlt(['100.64.0.2', ...many], '100.64.0.2')).toEqual(many.slice(0, 4));
  });

  it('an invite carries the name as host and the ranked IPv4s as alt', () => {
    const slot = new PairingSlot({ mintCode: () => 'ABCDEFGH' });
    const r = slot.begin({ host: 'desk-pc', port: 45660, fingerprint256: FP, alt: ['10.1.2.3', '192.168.0.20'] });
    const parsed = parseInvite(r.invite);
    expect(parsed.ok && parsed.invite.alt).toEqual(['10.1.2.3', '192.168.0.20']);
    expect(parseInvite(slot.begin({ host: 'desk-pc', port: 1, fingerprint256: FP, alt: [] }).invite)).toMatchObject({
      ok: true,
      invite: { host: 'desk-pc' },
    });
  });
});
