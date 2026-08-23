// Phase A — A6. Renderer-side daemon connection flag.
//
// Module-level mutable boolean kept in sync by AppLayout's main-event
// listeners (`daemon:connected` / `daemon:disconnected`). Read via the
// `isDaemonModeActive` getter from any code path that needs to short-circuit
// the .txt scrollback persistence path while a daemon is healthy.
//
// Why module-level rather than store-based: the consumers
// (`dumpScrollbackBuffersSync`, autosave timer, IPC short-circuit candidates)
// are called outside React's render cycle, often before Zustand has hydrated
// (initial whenReady promise resolves async). A simple module-scope let
// gives every caller the live value with no closure-snapshot risk that a
// boolean held in component state would have, while staying easy to reset
// in tests via {@link resetDaemonModeForTests}.

let active = false;

type DaemonModeListener = () => void;
const listeners = new Set<DaemonModeListener>();

/** True while the renderer believes the main process has a live daemon
 *  connection. Updated by AppLayout's onConnected / onDisconnected listeners. */
export function isDaemonModeActive(): boolean {
  return active;
}

/**
 * Subscribe to connection changes (useSyncExternalStore contract).
 *
 * The imperative getter above is enough for the call-outside-render consumers
 * this module was written for, but a UI control gated on the connection has to
 * REPAINT when it flips — a stash button left enabled after the daemon dropped
 * would offer an action that is guaranteed to be refused (#977).
 */
export function subscribeDaemonMode(listener: DaemonModeListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Setter used by AppLayout's event listeners. Not for general use. */
export function setDaemonModeActive(value: boolean): void {
  if (active === value) return;
  active = value;
  notify();
}

/** Reset for vitest beforeEach hooks. */
export function resetDaemonModeForTests(): void {
  active = false;
  notify();
}
