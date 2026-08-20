/**
 * Resting-cursor guard for synchronized-output frame writers (#929).
 *
 * Codex (and TUIs of its shape) repaint through `?2026` synchronized-output
 * frames, but some frames — status-line ticks, the "Working" shimmer — END
 * with the hardware cursor parked wherever the frame's last text write
 * finished: after the model/cwd status text, next to the spinner. The frame is
 * complete (`?2026l`, cursor visible), so honoring `?2026` does not help; a
 * faithful renderer briefly paints the cursor there. Byte-timestamped capture
 * shows those states holding 17–23 ms on a fast machine and a full video
 * frame (≥42 ms) on the reporter's — quasi-periodic flashes that read as a
 * second blinking caret (upstream: openai/codex#9081, #32546).
 *
 * The guard renders the cursor only at REST: every chunk that carries a
 * `?2026` marker gets `?25l` appended, and the cursor is re-shown only after
 * RESTING_DELAY_MS with no further frame traffic — and only if the
 * application itself last asked for a visible cursor (its own DECTCEM state
 * is tracked and never overridden at rest). Measured over a real codex
 * session, this cuts stray-position cursor visibility by ~93% while the
 * composer caret keeps its resting visibility.
 *
 * Scope is deliberately behavioral, not per-agent: only chunks containing
 * `?2026` arm the guard, so classic TUIs that never bracket frames (vim,
 * less, htop) are untouched — their cursor keeps xterm's default behavior.
 * 32 ms matches the ImeAnchor resting threshold (#888), the same "the cursor's
 * resting cell is the truthful one" reading applied to rendering.
 */

export const RESTING_DELAY_MS = 32;
export const CURSOR_HIDE = '\x1b[?25l';
export const CURSOR_SHOW = '\x1b[?25h';

// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
const SYNC_MARK = /\x1b\[\?2026[hl]/;
// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
const DECTCEM = /\x1b\[\?25([hl])/g;

export class RestingCursorGuard {
  /** The application's own DECTCEM intent — the state restored at rest. */
  private appCursorVisible = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    /** Writes a sequence to the SAME terminal through the SAME ordered write
     *  path as PTY output (ordering with queued chunks must hold). */
    private readonly inject: (seq: string) => void,
    private readonly delayMs: number = RESTING_DELAY_MS,
  ) {}

  /**
   * Transform one PTY output chunk about to be written to the terminal.
   * Chunks without a `?2026` marker pass through untouched.
   */
  process(data: string): string {
    // Track the app's own show/hide intent BEFORE appending anything of ours,
    // so an injected hide is never mistaken for the app's.
    DECTCEM.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last: string | null = null;
    while ((match = DECTCEM.exec(data)) !== null) last = match[1];
    if (last !== null) this.appCursorVisible = last === 'h';

    if (this.disposed || !SYNC_MARK.test(data)) return data;
    this.arm();
    return data + CURSOR_HIDE;
  }

  private arm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.disposed && this.appCursorVisible) this.inject(CURSOR_SHOW);
    }, this.delayMs);
  }

  /** Cancel any pending show. Call before the terminal is disposed — a late
   *  inject into a disposed xterm is the #582 class of bug. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
