// AwaitingScreenVerifier — releases a pane stuck at `awaiting_input` once the
// dialog it was blocked on has gone from its screen.
//
// Mid-turn, the bridge's `awaitingHuman` clears only on a recognised answer
// key or a Stop hook. An answer the key test does not recognise (a shape the
// unframed stdin stream produced, a dialog closed some other way) left the pane
// "needs you" for the rest of the turn. Byte activity must not clear it — a
// subagent painting behind a real dialog is not an answer — so this reads what
// is actually ON the screen instead.
//
// Rules, each one load-bearing:
//   - Claude family only (see terminalPrompt.ts): the dialog predicate knows
//     that shape and no other.
//   - Only while the pane is awaiting. No render, no timer, no state for any
//     other pane.
//   - At most one render in flight per pane. Triggers that land meanwhile
//     coalesce into one follow-up.
//   - Re-render only when output arrived after the last verified frame, plus
//     the one settle confirmation below. No unconditional polling.
//   - Two consecutive readable, non-blank, dialog-free frames to clear. The
//     second is read after a short settle, so a frame caught mid-redraw (rows
//     erased, the next ones not drawn yet) cannot release a live dialog.
//   - While a dialog stays up, the gap between renders backs off; stdin input
//     resets it, because a human acting is the one thing that answers a
//     dialog. A pane whose subagents keep painting behind a dialog for hours
//     therefore costs at most one render every few seconds on the shared
//     snapshot queue.
//   - Anything unreadable (render failed, wrong geometry, blank grid) keeps the
//     pane awaiting. A failed render is retried a bounded number of times; it
//     never counts as a verified frame.
//   - "Dialog still up" is structural (screenShowsActiveDialog): the dialog must
//     own the bottom of the screen, so its text left in the output above cannot
//     hold a pane "needs you".
//   - Right before releasing, the output mark must still be the second frame's.
//     New output since then restarts the verification.

import { capSnapshot } from './web/snapshotWindow';
import { screenShowsActiveDialog } from './transcript/chatScreenGate';

/** Wait before the confirming second read of a dialog-free frame. */
export const AWAITING_VERIFY_SETTLE_MS = 750;
/** Shortest gap between two renders of one pane. */
export const AWAITING_VERIFY_MIN_GAP_MS = 250;
/** Longest gap the dialog-still-there backoff reaches. */
export const AWAITING_VERIFY_MAX_GAP_MS = 5_000;
/** Consecutive failed renders retried before the verifier waits for new output. */
export const AWAITING_VERIFY_RENDER_RETRIES = 3;

export interface AwaitingFrame {
  rows: readonly string[];
  /** The pane's output byte count at the instant the grid was read. */
  mark: number;
}

export interface AwaitingScreenVerifierDeps {
  /** Is the pane still blocked on a human? */
  isAwaiting(sessionId: string): boolean;
  /** Claude-family pane? Everything else is never verified. */
  eligible(sessionId: string): boolean;
  /** Monotonic output byte count, or null when the pane is gone. */
  outputMark(sessionId: string): number | null;
  /** The visible grid at the live geometry, or null when it cannot be read. */
  render(sessionId: string): Promise<AwaitingFrame | null>;
  /** Release the pane (`bridge.clearAwaiting('screen-cleared')`). */
  clear(sessionId: string): void;
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
  settleMs?: number;
  minGapMs?: number;
  maxGapMs?: number;
}

interface PaneState {
  inFlight: boolean;
  /** A trigger arrived while a render was in flight. */
  queued: boolean;
  /** Consecutive dialog-free frames. */
  streak: number;
  /** Output mark of the last frame this pane was verified at. */
  lastMark: number | null;
  lastRunAt: number;
  gapMs: number;
  /** The one scheduled run, if any. */
  cancel: (() => void) | null;
  /** The scheduled run is the settle confirmation: it may re-read the same frame. */
  settleDue: boolean;
  /** Consecutive renders that failed (null / threw). */
  renderFailures: number;
}

export class AwaitingScreenVerifier {
  private readonly states = new Map<string, PaneState>();
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly minGapMs: number;
  private readonly maxGapMs: number;

  constructor(private readonly deps: AwaitingScreenVerifierDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });
    this.now = deps.now ?? Date.now;
    this.settleMs = deps.settleMs ?? AWAITING_VERIFY_SETTLE_MS;
    this.minGapMs = deps.minGapMs ?? AWAITING_VERIFY_MIN_GAP_MS;
    this.maxGapMs = deps.maxGapMs ?? AWAITING_VERIFY_MAX_GAP_MS;
  }

  /**
   * Something happened on the pane that may have closed its dialog: stdin
   * input, an output burst, new output. Cheap for a pane that is not awaiting.
   */
  trigger(sessionId: string, cause: 'input' | 'output'): void {
    if (!this.deps.isAwaiting(sessionId) || !this.deps.eligible(sessionId)) {
      this.forget(sessionId);
      return;
    }
    let st = this.states.get(sessionId);
    if (!st) {
      st = {
        inFlight: false, queued: false, streak: 0, lastMark: null,
        lastRunAt: -Infinity, gapMs: this.minGapMs, cancel: null, settleDue: false, renderFailures: 0,
      };
      this.states.set(sessionId, st);
    }
    if (cause === 'input') st.gapMs = this.minGapMs;
    if (st.inFlight) {
      st.queued = true;
      return;
    }
    if (st.cancel) {
      // A run is already scheduled. Keep it, unless a human just typed and
      // the scheduled run is a backed-off one: bring that one forward.
      if (cause !== 'input' || st.settleDue) return;
      st.cancel();
      st.cancel = null;
    }
    this.scheduleRun(sessionId, st, Math.max(0, st.lastRunAt + st.gapMs - this.now()));
  }

  /** Drop a pane's state (answered, gone). Cancels its scheduled run. */
  forget(sessionId: string): void {
    const st = this.states.get(sessionId);
    if (!st) return;
    st.cancel?.();
    this.states.delete(sessionId);
  }

  dispose(): void {
    for (const id of [...this.states.keys()]) this.forget(id);
  }

  /** Test seam: panes with live state. */
  trackedCount(): number {
    return this.states.size;
  }

  private scheduleRun(sessionId: string, st: PaneState, delayMs: number): void {
    st.cancel = this.schedule(() => {
      st.cancel = null;
      this.run(sessionId, st).catch((err: unknown) => {
        // Never an unhandled rejection in the daemon; the pane stays awaiting.
        st.inFlight = false;
        this.deps.log?.('warn', `[awaiting] ${sessionId}: verification failed: ${String(err)}`);
      });
    }, delayMs);
  }

  private async run(sessionId: string, st: PaneState): Promise<void> {
    if (this.states.get(sessionId) !== st) return;
    if (!this.deps.isAwaiting(sessionId) || !this.deps.eligible(sessionId)) {
      this.forget(sessionId);
      return;
    }
    const markBefore = this.deps.outputMark(sessionId);
    if (markBefore === null) {
      this.forget(sessionId);
      return;
    }
    // Nothing new since the frame last verified, and this is not the settle
    // confirmation: the grid would read the same.
    if (st.lastMark !== null && markBefore === st.lastMark && !st.settleDue) return;
    st.settleDue = false;

    st.inFlight = true;
    st.lastRunAt = this.now();
    let frame: AwaitingFrame | null = null;
    try {
      frame = await this.deps.render(sessionId);
    } catch {
      frame = null;
    }
    st.inFlight = false;
    if (this.states.get(sessionId) !== st) return;
    if (!this.deps.isAwaiting(sessionId)) {
      this.forget(sessionId);
      return;
    }

    if (!frame) {
      // A failed render proves nothing and records nothing: the same bytes get
      // another look, a bounded number of times.
      st.streak = 0;
      st.renderFailures += 1;
      if (st.renderFailures <= AWAITING_VERIFY_RENDER_RETRIES && !st.cancel) {
        st.settleDue = true;
        st.gapMs = Math.min(st.gapMs * 2, this.maxGapMs);
        this.scheduleRun(sessionId, st, st.gapMs);
      }
      return;
    }
    st.renderFailures = 0;
    st.lastMark = frame.mark;
    const readable = frame.rows.some((row) => row.trim().length > 0);
    const dialog = readable && screenShowsActiveDialog(frame.rows);

    if (readable && !dialog) {
      st.streak += 1;
      if (st.streak >= 2) {
        // Nothing may have been drawn since the frame just verified.
        if (this.deps.outputMark(sessionId) !== frame.mark) {
          st.streak = 0;
          st.gapMs = this.minGapMs;
          if (!st.cancel) this.scheduleRun(sessionId, st, this.minGapMs);
          return;
        }
        this.forget(sessionId);
        this.deps.log?.('info', `[awaiting] ${sessionId}: dialog gone from the screen, releasing awaiting`);
        this.deps.clear(sessionId);
        return;
      }
      // Confirm after the settle. Output landing meanwhile is read then.
      st.gapMs = this.minGapMs;
      st.queued = false;
      st.settleDue = true;
      this.scheduleRun(sessionId, st, this.settleMs);
      return;
    }

    st.streak = 0;
    // Dialog still up, or nothing readable: back off until a human types.
    st.gapMs = Math.min(st.gapMs * 2, this.maxGapMs);
    if (st.queued) {
      st.queued = false;
      if (!st.cancel) this.scheduleRun(sessionId, st, Math.max(0, st.lastRunAt + st.gapMs - this.now()));
    }
  }
}

/** Bytes of the ring's tail a verification (or a prompt read) replays. */
export const AWAITING_RENDER_WINDOW_BYTES = 256 * 1024;

/** The slice of a daemon pane `renderPaneScreen` reads. `ManagedSession` satisfies it. */
export interface RenderablePane {
  meta: { cols?: number; rows?: number };
  ptyProcess: { cols?: number; rows?: number };
  ringBuffer: { readonly totalBytesWritten: number; readAll(): Buffer };
  bridge: { readonly isMuted: boolean; readonly outputModes?: { preamble(windowStart: number): string } | null };
}

type TextSnapshot = (req: { cols: number; rows: number; scrollback: number; initial: Buffer }) =>
  Promise<{ ok: true; rows: Array<{ text: string }> } | { ok: false }>;

/**
 * The pane's live geometry: the PTY's own size when node-pty reports it (the
 * size the agent is actually drawing at), else the recorded meta size.
 */
function liveGeometry(pane: RenderablePane): { cols: number; rows: number } | null {
  const { cols: ptyCols, rows: ptyRows } = pane.ptyProcess;
  if (typeof ptyCols === 'number' && typeof ptyRows === 'number' && ptyCols > 0 && ptyRows > 0) {
    return { cols: ptyCols, rows: ptyRows };
  }
  const { cols, rows } = pane.meta;
  return typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0 ? { cols, rows } : null;
}

/**
 * Read a pane's visible grid for the verifier. Null — "unreadable", which keeps
 * the pane awaiting — when the pane is gone or muted, its geometry is unknown,
 * the parse failed, or the pane was resized while the render waited in the
 * snapshot queue (the frame then describes a grid the pane no longer has).
 */
export async function renderPaneScreen(
  getPane: () => RenderablePane | undefined,
  snapshot: TextSnapshot,
): Promise<AwaitingFrame | null> {
  const pane = getPane();
  if (!pane || pane.bridge.isMuted) return null;
  const geometry = liveGeometry(pane);
  if (!geometry) return null;
  // The mark is taken at the same instant the ring is read. Only a bounded
  // tail is replayed (the window a phone's stream paints from), prefixed by the
  // terminal-mode preamble so an alt screen entered before the window still is.
  const mark = pane.ringBuffer.totalBytesWritten;
  const tail = capSnapshot(pane.ringBuffer.readAll(), { maxBytes: AWAITING_RENDER_WINDOW_BYTES });
  const preamble = pane.bridge.outputModes?.preamble(mark - tail.bytes.length) ?? '';
  const initial = preamble ? Buffer.concat([Buffer.from(preamble, 'utf8'), tail.bytes]) : tail.bytes;
  const outcome = await snapshot({ ...geometry, scrollback: 0, initial });
  if (!outcome.ok) return null;
  if (getPane() !== pane) return null;
  const after = liveGeometry(pane);
  if (!after || after.cols !== geometry.cols || after.rows !== geometry.rows) return null;
  return { rows: outcome.rows.map((r) => r.text), mark };
}
