/**
 * Single-dispatch fan-out for DaemonClient's `session:data` event.
 *
 * DaemonClient emits ONE `session:data` event for ALL sessions (the payload
 * carries the sessionId). Registering one EventEmitter listener per session
 * made every daemon output chunk wake O(N) listeners — N-1 of them early-
 * returning on an id mismatch — i.e. O(N^2) aggregate work on a busy fleet,
 * and past EventEmitter's default 10-listener ceiling it spammed
 * MaxListenersExceededWarning at boot / workspace switch.
 *
 * This installs exactly ONE shared listener on the client and routes each
 * frame to its session's handler via a Map, so dispatch is O(1) in session
 * count and `listenerCount('session:data')` stays at 1 no matter how many
 * sessions are open.
 *
 * A single-slot Map (not a Set) is correct: registration has REPLACE semantics
 * — every call site (PTY_CREATE, PTY_RECONNECT) swaps an id's prior handler and
 * no id ever has two live handlers at once. (This is unlike the renderer's
 * createPtyDispatcher, which needs a Set because a fast unmount→remount briefly
 * runs two React instances on one ptyId.)
 *
 * Electron-free by design so it can be unit-tested against a bare EventEmitter;
 * pty.handler.ts (which imports electron) owns the flush-on-swap batching and
 * only delegates the listener+map bookkeeping here.
 */

export type SessionDataPayload = { sessionId: string; data: Buffer };
export type SessionDataHandler = (payload: SessionDataPayload) => void;

/** The subset of DaemonClient (EventEmitter) this dispatcher relies on. */
export interface SessionDataEmitter {
  on(event: 'session:data', listener: SessionDataHandler): unknown;
  removeListener(event: 'session:data', listener: SessionDataHandler): unknown;
  listenerCount(event: 'session:data'): number;
}

export interface SessionDataDispatcher {
  /** Register (or replace) the handler for `sessionId`. Returns true if it
   *  replaced an existing handler (the caller flushes the old generation). */
  set(sessionId: string, handler: SessionDataHandler): boolean;
  has(sessionId: string): boolean;
  /** Drop the handler for `sessionId`. Returns true if one was present. */
  delete(sessionId: string): boolean;
  /** Number of registered per-session handlers (map size). */
  size(): number;
  /** The shared listener count on the underlying emitter (invariant: 1). */
  listenerCount(): number;
  /** Detach the shared listener and drop all handlers. */
  dispose(): void;
}

export function createSessionDataDispatcher(client: SessionDataEmitter): SessionDataDispatcher {
  const handlers = new Map<string, SessionDataHandler>();
  const shared: SessionDataHandler = (payload) => {
    // Unknown id → dropped (session disposed, or not yet registered) rather
    // than fanned out to every handler.
    const handler = handlers.get(payload.sessionId);
    if (handler) handler(payload);
  };
  client.on('session:data', shared);

  return {
    set(sessionId, handler) {
      const replaced = handlers.has(sessionId);
      handlers.set(sessionId, handler);
      return replaced;
    },
    has(sessionId) {
      return handlers.has(sessionId);
    },
    delete(sessionId) {
      return handlers.delete(sessionId);
    },
    size() {
      return handlers.size;
    },
    listenerCount() {
      return client.listenerCount('session:data');
    },
    dispose() {
      client.removeListener('session:data', shared);
      handlers.clear();
    },
  };
}
