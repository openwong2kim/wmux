// Per-pane notice for a lost daemon connection.
//
// When the daemon drops, main swaps to local handlers and respawns with
// backoff; until a pane is attached to the daemon again it is cut off and
// anything typed into it never reaches its shell. This module turns main's
// daemon:* events into one notice per affected pane, so each pane says so at
// once — reconnecting, reconnected (cleared on its own), or gave up (stays) —
// and remembers which panes took input during the gap.
//
// Notices are keyed by surface, not ptyId: a reconcile after the reconnect may
// rebind a surface to a new session, and the notice has to follow the pane.
// A pane counts as reconnected only once its own session pipe has replayed
// (flush-complete) — daemon:connected fires before panes reattach, and input
// sent in between is still dropped.
//
// Module-level like daemonMode.ts: the IPC events are wired once (AppLayout),
// input is noted from outside React (useTerminal's key and paste paths), and
// Terminal.tsx reads it through useSyncExternalStore.

export type DaemonLinkState = 'reconnecting' | 'reconnected' | 'gave-up';

export interface PaneLinkNotice {
  state: DaemonLinkState;
  /** Respawn attempt in flight (1-based); 0 before the first is scheduled. */
  attempt: number;
  /** The user typed or pasted into this pane while it was cut off. */
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
let down = false;
const listeners = new Set<() => void>();

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

/** True while some pane still waits on its reattach — lets callers skip the
 *  surface lookup for the common flush-complete with nothing pending. */
export function hasPendingReattach(): boolean {
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
    notices.set(surfaceId, { state: 'reconnecting', attempt: 0, inputLost: prev.get(surfaceId)?.inputLost ?? false });
  }
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
  if (down) return;
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

/** daemon:respawn-exhausted — no more attempts this session. */
export function noteDaemonGaveUp(): void {
  if (!down) return;
  for (const [id, n] of notices) {
    if (n.state === 'reconnecting') notices.set(id, { ...n, state: 'gave-up' });
  }
  notify();
}

/**
 * The user sent input to `ptyId`. While the pane is cut off this marks the
 * input as possibly lost; once it is reconnected, typing there means the
 * user has moved on, so the notice goes.
 */
export function notePaneInput(ptyId: string): void {
  const surfaceId = surfaceByPty.get(ptyId);
  const n = surfaceId ? notices.get(surfaceId) : undefined;
  if (!surfaceId || !n) return;
  if (n.state === 'reconnected') {
    drop(surfaceId);
  } else if (!n.inputLost) {
    notices.set(surfaceId, { ...n, inputLost: true });
  } else {
    return;
  }
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
  down = false;
  notify();
}
