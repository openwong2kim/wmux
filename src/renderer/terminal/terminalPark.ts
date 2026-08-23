import type { Terminal } from '@xterm/xterm';

// #1002 — terminal adoption across a pane-tree restructure.
//
// Splitting a pane replaces the target leaf with a NEW branch node that holds
// the old leaf as a child (paneSlice.splitPane). React resolves that as an
// unmount + mount of the surviving leaf: either the component type changes
// (`<Pane>` → `<Group>` at the workspace root) or the parent Fragment's key
// changes from the leaf id to the new branch id. Dragging a pane and closing a
// sibling that collapses a branch restructure the tree the same way.
//
// The unmount tore down the xterm instance, so the remount built a fresh one
// and refilled it from the daemon ring buffer — the user watched the whole
// conversation get written from the top and land at the bottom. Nothing had
// restarted; only the view was destroyed and replayed.
//
// This module is the other half of that: on teardown the hook hands the live
// Terminal here instead of disposing it, and the next mount on the same ptyId
// adopts it — moving its DOM element into the new container, buffer, scroll
// position and all — so there is nothing to replay.
//
// The window is deliberately tiny. React flushes a commit's passive UNMOUNT
// effects before its passive MOUNT effects, so a restructure parks and adopts
// inside one synchronous flush; no timer can fire in between. The TTL is slack
// for a commit that gets split, not a cache: a pane the user actually closed
// never comes back for its terminal, and 250 ms later it is disposed exactly as
// before.

export interface ParkedTerminal {
  terminal: Terminal;
  /** xterm's root element, detached with the old container but still intact. */
  element: HTMLElement;
  /** Viewport row at park time, restored after the adopting mount fits. */
  viewportY: number;
  /** Whether the pane was pinned to the bottom (the common case). */
  atBottom: boolean;
}

interface ParkEntry extends ParkedTerminal {
  timer: ReturnType<typeof setTimeout>;
  dispose: () => void;
}

/** Slack for a split commit, not a cache lifetime. See the note above. */
export const PARK_TTL_MS = 250;

const parked = new Map<string, ParkEntry>();

function evict(ptyId: string): void {
  const entry = parked.get(ptyId);
  if (!entry) return;
  parked.delete(ptyId);
  clearTimeout(entry.timer);
  entry.dispose();
}

/**
 * Hand a live terminal over instead of disposing it. `dispose` is the caller's
 * own teardown — it runs if nobody adopts within the TTL, so the no-adopter
 * path stays byte-identical to the pre-#1002 behaviour.
 */
export function parkTerminal(
  ptyId: string,
  terminal: Terminal,
  element: HTMLElement,
  dispose: () => void,
  ttlMs: number = PARK_TTL_MS,
): void {
  if (!ptyId) { dispose(); return; }
  // A second park on one ptyId means two live instances existed for it; the
  // older one is unreachable, so let it go rather than leaking it.
  evict(ptyId);

  let viewportY = 0;
  let atBottom = true;
  try {
    const buffer = terminal.buffer.active;
    viewportY = buffer.viewportY;
    atBottom = buffer.viewportY >= buffer.baseY;
  } catch {
    // A terminal too far into teardown to read still parks — the adopting
    // mount just falls back to scrolling to the bottom.
  }

  const timer = setTimeout(() => {
    parked.delete(ptyId);
    dispose();
  }, ttlMs);

  parked.set(ptyId, { terminal, element, viewportY, atBottom, timer, dispose });
}

/**
 * Claim the terminal parked for this ptyId, if any. Claiming cancels the
 * pending dispose — from here on the adopting mount owns the instance.
 */
export function adoptTerminal(ptyId: string): ParkedTerminal | null {
  if (!ptyId) return null;
  const entry = parked.get(ptyId);
  if (!entry) return null;
  parked.delete(ptyId);
  clearTimeout(entry.timer);
  const { terminal, element, viewportY, atBottom } = entry;
  return { terminal, element, viewportY, atBottom };
}

/**
 * Put the adopted viewport back where the user left it. Call this AFTER the
 * adopting mount has fitted, since a fit can change how many rows the viewport
 * holds and therefore what "the bottom" means.
 */
export function restoreParkedViewport(entry: ParkedTerminal): void {
  try {
    if (entry.atBottom) entry.terminal.scrollToBottom();
    else entry.terminal.scrollToLine(entry.viewportY);
  } catch {
    // Scroll restoration is cosmetic; a disposed or unsized terminal must not
    // take the mount down with it.
  }
}

/** Test seam: drop every park without running its dispose. */
export function __resetTerminalPark(): void {
  for (const entry of parked.values()) clearTimeout(entry.timer);
  parked.clear();
}

/** Test seam: is a terminal currently parked for this ptyId? */
export function __isParked(ptyId: string): boolean {
  return parked.has(ptyId);
}
