// Per-pane notice for a lost daemon connection.
//
// When the daemon drops, main swaps to local handlers and respawns with
// backoff; until a pane is attached to the daemon again it is cut off and
// anything typed into it never reaches its shell. This module turns main's
// daemon:* events into one notice per affected pane, so each pane says so at
// once — reconnecting, reconnected (cleared on its own), or gave up (stays) —
// and remembers which panes lost input: main reports every write it dropped
// (IPC.PTY_WRITE_DROPPED), so no input path can slip past.
//
// Notices are keyed by surface, not ptyId: a reconcile after the reconnect may
// rebind a surface to a new session, and the notice has to follow the pane.
// A pane counts as reconnected only once its own session pipe has replayed
// (flush-complete) — daemon:connected fires before panes reattach, and input
// sent in between is still dropped.
//
// Module-level like daemonMode.ts: the IPC events are wired once (AppLayout),
// user input is noted from outside React (useTerminal's key and paste paths),
// and Terminal.tsx reads it through useSyncExternalStore.

export type DaemonLinkState = 'reconnecting' | 'reconnected' | 'gave-up';

export interface PaneLinkNotice {
  state: DaemonLinkState;
  /** Respawn attempt in flight (1-based); 0 before the first is scheduled. */
  attempt: number;
  /** Main dropped input sent to this pane while it was cut off. */
  inputLost: boolean;
}

export interface DaemonPaneRef {
  surfaceId: string;
  ptyId: string;
}

/** How long a "reconnected" notice stays when nothing was typed meanwhile. */
export const RECONNECTED_NOTICE_MS = 4000;

const notices = new Map<string, PaneLinkNotice>();
const surfaceByPty = new Map<string, string>();
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Panes main dropped a write for while they had no notice yet, not attached
 *  since: on a graceful daemon shutdown the session pipes close before the
 *  control link does, so the first lost keys come before daemon:disconnected. */
const droppedBeforeNotice = new Set<string>();
let down = false;
const listeners = new Set<() => void>();
/** Store lookup for a ptyId the drop did not see (set once by AppLayout). */
let resolveSurfaceForPty: (ptyId: string) => string | null = () => null;

function notify(): void {
  for (const listener of listeners) listener();
}

function cancelClearTimer(surfaceId: string): void {
  const timer = clearTimers.get(surfaceId);
  if (timer !== undefined) {
    clearTimeout(timer);
    clearTimers.delete(surfaceId);
  }
}

function drop(surfaceId: string): void {
  cancelClearTimer(surfaceId);
  notices.delete(surfaceId);
}

export function subscribeDaemonLinkNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getPaneLinkNotice(surfaceId: string | null | undefined): PaneLinkNotice | null {
  return surfaceId ? notices.get(surfaceId) ?? null : null;
}

/** True while some pane still waits on its reattach — skips the surface
 *  lookup for the common flush-complete with nothing pending. */
function hasPendingReattach(): boolean {
  for (const n of notices.values()) if (n.state === 'reconnecting') return true;
  return false;
}

/**
 * daemon:disconnected. `panes` are the panes attached to the daemon at the
 * moment it dropped; a pane created afterwards runs on a local PTY and gets
 * no notice. Notices of panes that no longer exist are dropped here.
 */
export function noteDaemonDisconnected(panes: Iterable<DaemonPaneRef>): void {
  down = true;
  const prev = new Map(notices);
  for (const surfaceId of [...notices.keys()]) drop(surfaceId);
  surfaceByPty.clear();
  for (const { surfaceId, ptyId } of panes) {
    surfaceByPty.set(ptyId, surfaceId);
    const lost = (prev.get(surfaceId)?.inputLost ?? false) || droppedBeforeNotice.has(ptyId);
    notices.set(surfaceId, { state: 'reconnecting', attempt: 0, inputLost: lost });
  }
  droppedBeforeNotice.clear();
  notify();
}

/** daemon:reconnecting — a respawn attempt is scheduled. */
export function noteDaemonReconnecting(attempt: number): void {
  if (!down) return;
  for (const [id, n] of notices) {
    if (n.state === 'reconnecting') notices.set(id, { ...n, attempt });
  }
  notify();
}

/** daemon:connected. Panes stay "reconnecting" until each reattaches. */
export function noteDaemonConnected(): void {
  down = false;
}

/**
 * A session pipe finished its replay (flush-complete) for `ptyId`, bound to
 * `resolveSurfaceId()` in the store. That pane is live again: show
 * "reconnected", which clears on its own unless input was lost, in which case
 * it stays until the user types there again or dismisses it.
 */
export function notePaneReattached(ptyId: string, resolveSurfaceId: () => string | null): void {
  // Its pipe is live again: an earlier drop no longer means it is cut off.
  droppedBeforeNotice.delete(ptyId);
  if (down || !hasPendingReattach()) return;
  const surfaceId = surfaceByPty.get(ptyId) ?? resolveSurfaceId();
  if (!surfaceId) return;
  const n = notices.get(surfaceId);
  if (!n || n.state !== 'reconnecting') return;
  surfaceByPty.set(ptyId, surfaceId);
  notices.set(surfaceId, { ...n, state: 'reconnected' });
  if (!n.inputLost) {
    cancelClearTimer(surfaceId);
    clearTimers.set(surfaceId, setTimeout(() => {
      clearTimers.delete(surfaceId);
      if (notices.get(surfaceId)?.state === 'reconnected') {
        notices.delete(surfaceId);
        notify();
      }
    }, RECONNECTED_NOTICE_MS));
  }
  notify();
}

/**
 * How a write drop or user input finds the surface of a ptyId the drop did
 * not map: a reconcile may rebind a cut-off surface to a new session before
 * that session's flush-complete.
 */
export function setDaemonLinkSurfaceResolver(resolve: (ptyId: string) => string | null): void {
  resolveSurfaceForPty = resolve;
}

/** daemon:respawn-exhausted — no more attempts this session. */
export function noteDaemonGaveUp(): void {
  if (!down) return;
  for (const [id, n] of notices) {
    if (n.state === 'reconnecting') notices.set(id, { ...n, state: 'gave-up' });
  }
  notify();
}

/** The notice of the surface `ptyId` is bound to, mapping a rebound id. */
function surfaceWithNotice(ptyId: string): string | null {
  // Every keystroke can land here; with no notice there is nothing to look up.
  if (notices.size === 0) return null;
  const mapped = surfaceByPty.get(ptyId);
  if (mapped) return notices.has(mapped) ? mapped : null;
  // A surface rebound to a new session keeps its notice; a pane opened
  // during the gap has none, so it stays unmapped.
  const resolved = resolveSurfaceForPty(ptyId);
  if (!resolved || !notices.has(resolved)) return null;
  surfaceByPty.set(ptyId, resolved);
  return resolved;
}

/**
 * Main dropped a write for `ptyId` (IPC.PTY_WRITE_DROPPED): those bytes never
 * reached the shell, whichever path sent them. The notice says so and stays
 * until the user types there again or dismisses it.
 */
export function notePaneWriteDropped(ptyId: string): void {
  const surfaceId = surfaceWithNotice(ptyId);
  const n = surfaceId ? notices.get(surfaceId) : undefined;
  if (!surfaceId || !n) {
    droppedBeforeNotice.add(ptyId);
    return;
  }
  if (n.inputLost) return;
  cancelClearTimer(surfaceId);
  notices.set(surfaceId, { ...n, inputLost: true });
  notify();
}

/**
 * The user typed or pasted into `ptyId`. Once the pane is reconnected that
 * means they have moved on, so the notice goes. Only a user action calls
 * this: a terminal's own replies must not clear the warning.
 */
export function notePaneUserInput(ptyId: string): void {
  const surfaceId = surfaceWithNotice(ptyId);
  if (!surfaceId || notices.get(surfaceId)?.state !== 'reconnected') return;
  drop(surfaceId);
  notify();
}

/** The pane's dismiss button. */
export function dismissPaneLinkNotice(surfaceId: string): void {
  if (!notices.has(surfaceId)) return;
  drop(surfaceId);
  notify();
}

/** Reset for vitest beforeEach hooks. */
export function resetDaemonLinkNoticeForTests(): void {
  for (const surfaceId of [...notices.keys()]) drop(surfaceId);
  surfaceByPty.clear();
  droppedBeforeNotice.clear();
  resolveSurfaceForPty = () => null;
  down = false;
  notify();
}
