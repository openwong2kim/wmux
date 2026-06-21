import { describe, it, expect } from 'vitest';
import { PairingInitiator, PairingResponder, deterministicPeerUuid } from '../pairing';
import { AeadSealer, AeadOpener } from '../aead';

async function runHandshake(joinPin: string, hostPin: string) {
  const ini = new PairingInitiator(joinPin, 'B-joiner');
  const res = new PairingResponder(hostPin, 'A-host');
  const helloBody = ini.hello();
  const pake2Body = await res.onHello(helloBody);
  const { confirm, pending } = await ini.onPake2(pake2Body);
  const r = res.onConfirm(confirm); // throws on wrong PIN
  const iniResult = ini.verifyRespMac(r.respMac, pending);
  return { ini, res, r, pending, iniResult };
}

describe('pairing — PIN-EKE double-masked handshake', () => {
  it('correct PIN: both sides agree on longTermSecret, peerUuid, and session keys', async () => {
    const { r, pending, iniResult } = await runHandshake('314159', '314159');
    // shared long-term secret matches on both sides
    expect(r.result.longTermSecret.equals(iniResult.longTermSecret)).toBe(true);
    // peerUuid is deterministic and agreed by both sides
    expect(r.result.peerUuid).toBe(iniResult.peerUuid);
    // names crossed over
    expect(r.result.peerName).toBe('B-joiner');
    expect(iniResult.peerName).toBe('A-host');
    // session keys agree across the two sides (so AEAD will interoperate)
    expect(r.sessionKeys.c2sKey.equals(pending.sessionKeys.c2sKey)).toBe(true);
    expect(r.sessionKeys.s2cKey.equals(pending.sessionKeys.s2cKey)).toBe(true);
  });

  it('the established AEAD session interoperates in both directions', async () => {
    const { r, pending } = await runHandshake('271828', '271828');
    // joiner -> host (c2s)
    const c2sSeal = new AeadSealer(pending.sessionKeys.c2sKey, 1);
    const c2sOpen = new AeadOpener(r.sessionKeys.c2sKey, 1);
    expect(c2sOpen.open(c2sSeal.seal(Buffer.from('ping'))).toString()).toBe('ping');
    // host -> joiner (s2c) — e.g. the respMac carrier
    const s2cSeal = new AeadSealer(r.sessionKeys.s2cKey, 2);
    const s2cOpen = new AeadOpener(pending.sessionKeys.s2cKey, 2);
    expect(s2cOpen.open(s2cSeal.seal(r.respMac)).equals(r.respMac)).toBe(true);
  });

  it('wrong PIN: the handshake fails (no shared secret)', async () => {
    await expect(runHandshake('000000', '999999')).rejects.toThrow();
  });

  it('PIN never appears in any wire frame', async () => {
    const pin = '424242';
    const ini = new PairingInitiator(pin, 'B');
    const res = new PairingResponder(pin, 'A');
    const helloBody = ini.hello();
    const pake2Body = await res.onHello(helloBody);
    const { confirm } = await ini.onPake2(pake2Body);
    for (const frame of [helloBody, pake2Body, confirm]) {
      expect(frame.toString('latin1')).not.toContain(pin);
      // also check the raw bytes of the PIN's ascii form are not a contiguous run
      expect(frame.includes(Buffer.from(pin, 'utf8'))).toBe(false);
    }
  });

  it('deterministicPeerUuid is stable for a given pubkey and RFC4122-v5 shaped', () => {
    const pub = Buffer.alloc(32, 7);
    const u1 = deterministicPeerUuid(pub);
    const u2 = deterministicPeerUuid(pub);
    expect(u1).toBe(u2);
    expect(u1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('tampering with PAKE2 breaks the confirm MAC', async () => {
    const ini = new PairingInitiator('555555', 'B');
    const res = new PairingResponder('555555', 'A');
    const helloBody = ini.hello();
    const pake2Body = await res.onHello(helloBody);
    // flip a byte in the responder nonce region (offset 32..48) so the transcript differs
    pake2Body[40] ^= 0xff;
    await expect(
      (async () => {
        const { confirm } = await ini.onPake2(pake2Body);
        res.onConfirm(confirm);
      })(),
    ).rejects.toThrow();
  });
});
