// === LanLink wire codec + app-message decoder (PR-4, pure, state-free) ===
//
// Binary length-prefix framing for the AEAD channel. UNLIKE the control pipe
// (DaemonPipeServer, newline-JSON TEXT framing), the LAN channel is BINARY:
// [u32be length][u8 type][body]. The codec is STATE-FREE — it knows nothing
// about connection state; rejecting an out-of-state frame type is the server's
// job (C3). All caps here are pre-decrypt (G1) so an unpaired attacker cannot
// exhaust memory before authentication.

import { isTaskState, type TaskState } from '../../shared/types';

export const WIRE_VERSION = 1;
export const MIN_WIRE_VERSION = 1;
export const CIPHER_ID = 1; // 1 == chacha20-poly1305 IETF (the ONLY accepted cipher)
export const ACCEPTED_VERSIONS = Object.freeze([1] as const);
export const ACCEPTED_CIPHERS = Object.freeze([1] as const);
export const MAX_FRAME = 64 * 1024; // G1: pre-decrypt OOM cap on a single frame
export const MAX_JSON_DEPTH = 64; // C11: pre-parse JSON-bomb guard
export const LEN_BYTES = 4;

export type FrameType =
  | 0x01 // PAKE_HELLO      (unknown peer, window-gated)
  | 0x02 // PAKE2           (responder -> joiner)
  | 0x03 // CONFIRM         (joiner -> responder ONLY)
  | 0x04 // RECONNECT_HELLO (known peer, ephemeral-DH, no scrypt)
  | 0x05 // RECONNECT2      (responder -> joiner, ephemeral pub + nonce)
  | 0x10; // AEAD_RECORD

const VALID_FRAME_TYPES: ReadonlySet<number> = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x10]);

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

/**
 * Pulls complete length-prefixed frames out of a growing buffer. STATE-FREE.
 * THROWS WireError on: a declared length > MAX_FRAME, a buffered backlog that
 * exceeds one max frame (slow-loris memory, G1), or an unknown type byte.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxFrame: number;

  constructor(maxFrame: number = MAX_FRAME) {
    this.maxFrame = maxFrame;
  }

  push(chunk: Buffer): void {
    // Append. The server drains complete frames immediately via next(), so the
    // backlog normally holds only the in-flight partial frame plus any frames
    // pipelined into the same TCP segment (legitimate back-to-back traffic — e.g.
    // a near-max AEAD record split across segments followed by the next record).
    // A hard ceiling well ABOVE a single max frame prevents pre-decrypt OOM (G1)
    // without rejecting that legitimate pipelining; an oversized SINGLE frame is
    // still rejected by next() (declared length > maxFrame), and a dribbled
    // never-completing partial frame is killed by the server's handshake / idle
    // timeout (slow-loris). The earlier `maxFrame + LEN_BYTES` cap wrongly
    // rejected a valid record that arrived back-to-back with the next one.
    if (this.buf.length + chunk.length > 4 * this.maxFrame) {
      throw new WireError('LanLink frame backlog exceeds limit');
    }
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
  }

  /** Returns the next complete frame, or null if more bytes are needed. */
  next(): { type: FrameType; body: Buffer } | null {
    if (this.buf.length < LEN_BYTES) return null;
    const len = this.buf.readUInt32BE(0);
    if (len < 1 || len > this.maxFrame) {
      throw new WireError(`LanLink declared frame length ${len} out of range`);
    }
    if (this.buf.length < LEN_BYTES + len) return null; // incomplete — need more
    const type = this.buf[LEN_BYTES];
    if (!VALID_FRAME_TYPES.has(type)) {
      throw new WireError(`LanLink unknown frame type 0x${type.toString(16)}`);
    }
    const body = Buffer.from(this.buf.subarray(LEN_BYTES + 1, LEN_BYTES + len));
    this.buf = Buffer.from(this.buf.subarray(LEN_BYTES + len));
    return { type: type as FrameType, body };
  }
}

/** Encode a frame: [u32be (1 + body.length)][u8 type][body]. */
export function encodeFrame(type: FrameType, body: Buffer): Buffer {
  const len = 1 + body.length;
  if (len > MAX_FRAME) throw new WireError('encodeFrame: body exceeds MAX_FRAME');
  const out = Buffer.allocUnsafe(LEN_BYTES + len);
  out.writeUInt32BE(len, 0);
  out.writeUInt8(type, LEN_BYTES);
  body.copy(out, LEN_BYTES + 1);
  return out;
}

/**
 * Parse DECRYPTED plaintext JSON with two hardenings (C11): a pre-parse nesting
 * scan rejects a JSON bomb (> MAX_JSON_DEPTH nested `[`/`{`) BEFORE JSON.parse
 * builds the tree, and a reviver drops `__proto__` / `constructor` / `prototype`
 * keys so a crafted message can't pollute any object it lands in. THROWS
 * WireError on a bomb or on invalid JSON.
 */
export function safeJsonParse(buf: Buffer): unknown {
  const text = buf.toString('utf8');
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') {
      depth++;
      if (depth > MAX_JSON_DEPTH) throw new WireError('LanLink JSON nesting exceeds MAX_JSON_DEPTH');
    } else if (c === ']' || c === '}') {
      if (depth > 0) depth--;
    }
  }
  try {
    return JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    });
  } catch (err) {
    throw new WireError(`LanLink invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface DecodedAppMessage {
  /** Raw message kind — NOT yet admitted; the server calls router.admitKind. */
  kind: string;
  peerName: string;
  text: string;
  senderSeq: number; // C8 idempotency: monotonic per-peer
  state?: TaskState; // C10: attached only when isTaskState
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set(['kind', 'peerName', 'text', 'senderSeq', 'state']);

/**
 * Decode decrypted plaintext into the restricted TEXT-ONLY schema with a
 * POSITIVE key allow-list. THROWS WireError on any extra key (incl. parts /
 * file / data / mimeType / bytes / uri — a full Task is never deserialized),
 * non-string text/peerName/kind, or a non-finite-int senderSeq. A `state` field
 * present-but-not-a-valid-TaskState is DROPPED (the record proceeds without it,
 * C10); the disk validator additionally rejects a present-and-invalid state.
 */
export function decodeAppMessage(plaintext: Buffer): DecodedAppMessage {
  const parsed = safeJsonParse(plaintext);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WireError('LanLink app message must be a JSON object');
  }
  const o = parsed as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new WireError(`LanLink app message has disallowed key ${JSON.stringify(k)}`);
    }
  }
  const kind = o['kind'];
  if (typeof kind !== 'string') throw new WireError('LanLink app message kind must be a string');
  const peerName = o['peerName'];
  if (typeof peerName !== 'string') throw new WireError('LanLink app message peerName must be a string');
  const text = o['text'];
  if (typeof text !== 'string') throw new WireError('LanLink app message text must be a string');
  const senderSeq = o['senderSeq'];
  if (typeof senderSeq !== 'number' || !Number.isInteger(senderSeq) || senderSeq < 0) {
    throw new WireError('LanLink app message senderSeq must be a non-negative integer');
  }
  const msg: DecodedAppMessage = { kind, peerName, text, senderSeq };
  if ('state' in o && isTaskState(o['state'])) {
    msg.state = o['state'];
  }
  return msg;
}
