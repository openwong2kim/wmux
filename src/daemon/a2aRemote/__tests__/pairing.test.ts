import { describe, expect, it } from 'vitest';
import { parseInvite } from '../../../shared/a2aRemote';
import { A2A_PAIR_MAX_ATTEMPTS, A2A_PAIR_TTL_MS, PairingSlot, inviteHost, mintPairCode } from '../pairing';
import { inviteIpv4s, rankedExternalIpv4s } from '../server';

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
      { address: '10.1.2.3', preferred: true },
      { address: '192.168.0.20', preferred: true },
      { address: '203.0.113.5', preferred: true },
      { address: '172.20.0.1', preferred: false },
      { address: '172.17.0.1', preferred: false },
      { address: '100.101.102.103', preferred: false },
      { address: '100.64.0.2', preferred: false },
    ]);
    // 100.64/10 only: 100.63.x and 100.128.x are ordinary addresses.
    expect(rankedExternalIpv4s({ en0: [nic('100.63.0.1'), nic('100.128.0.1')] } as never).every((r) => r.preferred)).toBe(true);
  });

  it('an invite offers only the preferred addresses, or everything when none is preferred', () => {
    expect(inviteIpv4s([
      { address: '10.1.2.3', preferred: true },
      { address: '100.64.0.2', preferred: false },
    ])).toEqual(['10.1.2.3']);
    expect(inviteIpv4s([
      { address: '172.20.0.1', preferred: false },
      { address: '100.64.0.2', preferred: false },
    ])).toEqual(['172.20.0.1', '100.64.0.2']);
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
