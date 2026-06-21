import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  deriveSessionKeys,
  AeadSealer,
  AeadOpener,
  AeadError,
  AEAD_KEY_LEN,
  AEAD_NONCE_LEN,
} from '../aead';

function mkSession() {
  const longTerm = crypto.randomBytes(32);
  const ee = crypto.randomBytes(32);
  const helloNonce = crypto.randomBytes(16);
  const respNonce = crypto.randomBytes(16);
  return deriveSessionKeys(longTerm, ee, helloNonce, respNonce);
}

describe('aead — chacha20-poly1305 IETF channel', () => {
  it('seal/open round-trips on the c2s direction', () => {
    const { c2sKey } = mkSession();
    const sealer = new AeadSealer(c2sKey, 1);
    const opener = new AeadOpener(c2sKey, 1);
    const pt = Buffer.from('hello over the lan', 'utf8');
    const out = opener.open(sealer.seal(pt));
    expect(out.equals(pt)).toBe(true);
  });

  it('rejects a tag-tampered record', () => {
    const { c2sKey } = mkSession();
    const rec = new AeadSealer(c2sKey, 1).seal(Buffer.from('x'));
    rec[rec.length - 1] ^= 0x01; // flip a tag byte
    expect(() => new AeadOpener(c2sKey, 1).open(rec)).toThrow(AeadError);
  });

  it('drops a replayed (non-increasing counter) record', () => {
    const { c2sKey } = mkSession();
    const sealer = new AeadSealer(c2sKey, 1);
    const opener = new AeadOpener(c2sKey, 1);
    const r1 = sealer.seal(Buffer.from('one'));
    expect(opener.open(r1).toString()).toBe('one');
    expect(() => opener.open(r1)).toThrow(/replay/i); // same counter again
  });

  it('a tag failure leaves lastCounter unchanged so the genuine next record opens (C17)', () => {
    const { c2sKey } = mkSession();
    const sealer = new AeadSealer(c2sKey, 1);
    const opener = new AeadOpener(c2sKey, 1);
    const r1 = sealer.seal(Buffer.from('a'));
    const r2 = sealer.seal(Buffer.from('b'));
    expect(opener.open(r1).toString()).toBe('a');
    // forge a record at counter 2 with a bad tag -> AeadError, must NOT advance lastCounter
    const forged = Buffer.from(r2);
    forged[forged.length - 1] ^= 0xff;
    expect(() => opener.open(forged)).toThrow(AeadError);
    // the genuine counter-2 record still opens
    expect(opener.open(r2).toString()).toBe('b');
  });

  it('separates keys by direction (c2s != s2c)', () => {
    const s = mkSession();
    expect(s.c2sKey.length).toBe(AEAD_KEY_LEN);
    expect(s.s2cKey.length).toBe(AEAD_KEY_LEN);
    expect(s.c2sKey.equals(s.s2cKey)).toBe(false);
  });

  it('deriveSessionKeys consumes ee — same (longTerm, nonces) yields DIFFERENT keys when ee differs (C2)', () => {
    const longTerm = crypto.randomBytes(32);
    const helloNonce = crypto.randomBytes(16);
    const respNonce = crypto.randomBytes(16);
    const a = deriveSessionKeys(longTerm, crypto.randomBytes(32), helloNonce, respNonce);
    const b = deriveSessionKeys(longTerm, crypto.randomBytes(32), helloNonce, respNonce);
    expect(a.c2sKey.equals(b.c2sKey)).toBe(false);
  });

  it('uses a 12-byte nonce space (record header is the 8-byte counter)', () => {
    const { c2sKey } = mkSession();
    const rec = new AeadSealer(c2sKey, 1).seal(Buffer.from('z'));
    // record = [8B counter][ct][16B tag]; counter starts at 1
    expect(rec.readBigUInt64BE(0)).toBe(1n);
    expect(AEAD_NONCE_LEN).toBe(12);
  });

  it('rejects a too-short record', () => {
    const { c2sKey } = mkSession();
    expect(() => new AeadOpener(c2sKey, 1).open(Buffer.alloc(4))).toThrow(AeadError);
  });
});
