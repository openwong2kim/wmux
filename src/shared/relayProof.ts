import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// The pipe relay's proof that it is the relay (CdpPipeRelay ↔ the MCP engine).
// A relay endpoint's name or port can be taken by another process once the
// relay stops listening there, and a client cannot ask a pipe or a port who
// serves it. So each relay grant carries, beside its one-time token, a proof
// key: 256 random bits, handed to the client only in the browser.cdp.info
// reply over the authenticated wmux pipe and never sent on the relay
// connection. Once connected, the client sends a fresh nonce as the CDP
// command `Wmux.relayProof`; the relay answers on that same connection with
// HMAC-SHA256(key, label || nonce), using the key of the token that
// connection spent. Nothing uses the browser until the answer checks out.
// ---------------------------------------------------------------------------

export const RELAY_PROOF_METHOD = 'Wmux.relayProof';
const LABEL = Buffer.from('wmux-relay-proof/v1', 'utf8');
export const RELAY_PROOF_KEY_BYTES = 32;
export const RELAY_PROOF_NONCE_BYTES = 32;

const B64URL = /^[A-Za-z0-9_-]+$/;

/** A fresh proof key, as the grant carries it (base64url). */
export function newRelayProofKey(): Buffer {
  return randomBytes(RELAY_PROOF_KEY_BYTES);
}

/** A fresh client nonce (base64url). */
export function newRelayProofNonce(): string {
  return randomBytes(RELAY_PROOF_NONCE_BYTES).toString('base64url');
}

/** `text` as base64url bytes, or null when it is not, or is shorter than `min` bytes. */
export function decodeRelayProofBytes(text: unknown, min: number): Buffer | null {
  if (typeof text !== 'string' || !B64URL.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length >= min ? bytes : null;
}

/** HMAC-SHA256(key, "wmux-relay-proof/v1" || nonce), base64url. */
export function relayProof(key: Buffer, nonce: Buffer): string {
  return createHmac('sha256', key).update(LABEL).update(nonce).digest('base64url');
}

/** Whether `answer` is the proof for `key` and `nonce`, compared in constant time. */
export function relayProofMatches(key: Buffer, nonce: Buffer, answer: unknown): boolean {
  const got = decodeRelayProofBytes(answer, 1);
  if (!got) return false;
  const want = Buffer.from(relayProof(key, nonce), 'base64url');
  return got.length === want.length && timingSafeEqual(got, want);
}
