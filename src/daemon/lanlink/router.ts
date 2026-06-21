// === LanLink inbound message-kind allow-list (PR-4, C20) ===
//
// A POSITIVE allow-list over the KINDS of application message a paired peer may
// send over the AEAD channel. This is NOT an RPC forwarder and shares NOTHING
// with the daemon control pipe (DaemonPipeServer) or the main RpcRouter: it
// never references a2a.task.send, daemon.inbox.poll, lanlink.status, or any
// execute/spawn surface — so a remote peer's frame can only ever land read-only
// in the durable inbox. (The drift-lock test asserts the accepted set excludes
// all of those plus any execute/spawn/send substring.)
//
// Pollution-safe BY CONSTRUCTION (C20): admission is a `typeof === 'string'`
// pre-check then `.includes` on a FROZEN ARRAY — never an object-map index — so
// a crafted kind like '__proto__' / 'constructor' / 'hasOwnProperty' cannot
// masquerade as admitted via a prototype-chain lookup.

/** The only inbound application message kinds a paired peer may send. */
export const ACCEPTED_KINDS = Object.freeze(['msg.text', 'state.update'] as const);
export type AcceptedKind = (typeof ACCEPTED_KINDS)[number];

export class RouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterError';
  }
}

/** True iff `k` is an admitted inbound message kind (frozen-array membership). */
export function isAcceptedKind(k: unknown): k is AcceptedKind {
  if (typeof k !== 'string') return false;
  return (ACCEPTED_KINDS as readonly string[]).includes(k);
}

/**
 * Admit a kind or THROW RouterError. The dispatch counterpart to the structural
 * import wall (daemonExecuteWall): an unregistered kind — including
 * `a2a.task.send` or any execute-spawning kind — is refused before the message
 * reaches the inbox.
 */
export function admitKind(k: unknown): AcceptedKind {
  if (!isAcceptedKind(k)) {
    const shown = typeof k === 'string' ? JSON.stringify(k) : typeof k;
    throw new RouterError(`LanLinkRouter: rejected message kind ${shown}`);
  }
  return k;
}
