import { describe, it, expect } from 'vitest';
import {
  FrameReader,
  encodeFrame,
  safeJsonParse,
  decodeAppMessage,
  WireError,
  MAX_FRAME,
  MAX_JSON_DEPTH,
  LEN_BYTES,
} from '../wire';

describe('wire — framing', () => {
  it('encodes and reads back a frame', () => {
    const r = new FrameReader();
    r.push(encodeFrame(0x10, Buffer.from('hello')));
    const f = r.next();
    expect(f?.type).toBe(0x10);
    expect(f?.body.toString()).toBe('hello');
    expect(r.next()).toBeNull();
  });

  it('reassembles a frame split across chunks', () => {
    const frame = encodeFrame(0x01, Buffer.from('abc'));
    const r = new FrameReader();
    r.push(frame.subarray(0, 3));
    expect(r.next()).toBeNull();
    r.push(frame.subarray(3));
    expect(r.next()?.body.toString()).toBe('abc');
  });

  it('rejects a declared length > MAX_FRAME (G1)', () => {
    const r = new FrameReader();
    const buf = Buffer.alloc(LEN_BYTES);
    buf.writeUInt32BE(MAX_FRAME + 1, 0);
    r.push(buf);
    expect(() => r.next()).toThrow(WireError);
  });

  it('allows legitimate back-to-back frames but rejects a gross backlog overflow (G1)', () => {
    const r = new FrameReader(64);
    // back-to-back (a full frame plus the start of the next) is fine
    expect(() => r.push(Buffer.alloc(64 + LEN_BYTES + 1))).not.toThrow();
    // a gross overflow well past the hard ceiling (4 * maxFrame) is rejected
    const r2 = new FrameReader(64);
    expect(() => r2.push(Buffer.alloc(4 * 64 + 1))).toThrow(WireError);
  });

  it('rejects an unknown frame type', () => {
    const body = Buffer.from('x');
    const out = Buffer.alloc(LEN_BYTES + 1 + body.length);
    out.writeUInt32BE(1 + body.length, 0);
    out.writeUInt8(0x09, LEN_BYTES); // 0x09 is not a valid frame type
    body.copy(out, LEN_BYTES + 1);
    const r = new FrameReader();
    r.push(out);
    expect(() => r.next()).toThrow(WireError);
  });
});

describe('wire — safeJsonParse', () => {
  it('drops prototype-pollution keys', () => {
    const v = safeJsonParse(Buffer.from('{"a":1,"__proto__":{"polluted":true}}')) as Record<string, unknown>;
    expect(v['a']).toBe(1);
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects a deep-nesting bomb before JSON.parse (C11)', () => {
    const depth = MAX_JSON_DEPTH + 5;
    const bomb = '['.repeat(depth) + ']'.repeat(depth);
    expect(() => safeJsonParse(Buffer.from(bomb))).toThrow(WireError);
  });

  it('rejects invalid JSON', () => {
    expect(() => safeJsonParse(Buffer.from('{not json'))).toThrow(WireError);
  });
});

describe('wire — decodeAppMessage (text-only restricted subset)', () => {
  const base = { kind: 'msg.text', peerName: 'B', text: 'hi', senderSeq: 1 };

  it('decodes a valid text message', () => {
    const m = decodeAppMessage(Buffer.from(JSON.stringify(base)));
    expect(m.kind).toBe('msg.text');
    expect(m.text).toBe('hi');
    expect(m.senderSeq).toBe(1);
    expect(m.state).toBeUndefined();
  });

  it('rejects any disallowed key (file/data/parts/mimeType/bytes/execute)', () => {
    for (const extra of [
      { file: { bytes: 'AA' } },
      { data: { x: 1 } },
      { parts: [] },
      { mimeType: 'image/png' },
      { bytes: 'AA' },
      { uri: 'http://x' },
      { execute: true },
      { metadata: {} },
    ]) {
      expect(() => decodeAppMessage(Buffer.from(JSON.stringify({ ...base, ...extra })))).toThrow(WireError);
    }
  });

  it('rejects a non-object, non-string fields, and a bad senderSeq', () => {
    expect(() => decodeAppMessage(Buffer.from('[]'))).toThrow(WireError);
    expect(() => decodeAppMessage(Buffer.from(JSON.stringify({ ...base, text: 1 })))).toThrow(WireError);
    expect(() => decodeAppMessage(Buffer.from(JSON.stringify({ ...base, peerName: null })))).toThrow(WireError);
    expect(() => decodeAppMessage(Buffer.from(JSON.stringify({ ...base, senderSeq: -1 })))).toThrow(WireError);
    expect(() => decodeAppMessage(Buffer.from(JSON.stringify({ ...base, senderSeq: 1.5 })))).toThrow(WireError);
  });

  it('drops an invalid state but attaches a valid TaskState (C10)', () => {
    expect(decodeAppMessage(Buffer.from(JSON.stringify({ ...base, state: 'bogus' }))).state).toBeUndefined();
    expect(decodeAppMessage(Buffer.from(JSON.stringify({ ...base, state: 'constructor' }))).state).toBeUndefined();
    expect(decodeAppMessage(Buffer.from(JSON.stringify({ ...base, state: 'working' }))).state).toBe('working');
  });
});
