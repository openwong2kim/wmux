// Interrupt-keystroke detection, shared by every process that writes user
// input to a pty.
//
// Live finding (Claude Code 2.1.236): interrupting a turn with Ctrl+C / ESC ESC
// fires NO Stop hook, and `claude` itself stays the foreground command, so
// OSC 133 never reports the shell back at its prompt either.
//
// Both of the pane's settle edges are therefore blind to an interrupt, and the
// turn latch would hold the pane 'running' until its 30-minute expiry. The
// keystroke is the only evidence that exists, so we read it.

/** How long a lone ESC waits for its partner before it stops being half of an
 *  interrupt. Claude Code's own double-ESC is two keypresses, so the window is
 *  a human's double-tap, not a machine's. */
export const DOUBLE_ESC_WINDOW_MS = 500;

const CTRL_C = '\x03';
const ESC = '\x1b';

/**
 * Which written chunks mean "the operator interrupted this pane's agent".
 *
 * Deliberately narrow, because a false positive settles a pane that is still
 * working: the byte 0x03 anywhere in a chunk, the exact chunk `ESC ESC`, or two
 * consecutive chunks that are each exactly one ESC within DOUBLE_ESC_WINDOW_MS.
 * A LONE ESC is never enough on its own — every arrow key and CSI sequence
 * starts with one.
 *
 * State is per-pty and tiny (one timestamp per pane mid-double-tap); `forget`
 * drops it on pane disposal.
 */
export class InterruptKeystrokeDetector {
  private readonly pendingEscAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed one written chunk. True when it completes an interrupt. */
  observe(ptyId: string, data: string): boolean {
    if (!ptyId || typeof data !== 'string' || data.length === 0) return false;
    if (data.includes(CTRL_C)) {
      this.pendingEscAt.delete(ptyId);
      return true;
    }
    if (data === ESC + ESC) {
      this.pendingEscAt.delete(ptyId);
      return true;
    }
    if (data === ESC) {
      const previous = this.pendingEscAt.get(ptyId);
      const at = this.now();
      if (previous !== undefined && at - previous <= DOUBLE_ESC_WINDOW_MS) {
        this.pendingEscAt.delete(ptyId);
        return true;
      }
      this.pendingEscAt.set(ptyId, at);
      return false;
    }
    // Anything else between the two taps (a keystroke, a CSI report) means the
    // operator did something other than double-tap ESC.
    this.pendingEscAt.delete(ptyId);
    return false;
  }

  /** Drop the pane's half-finished double-tap (pane disposal / reuse). */
  forget(ptyId: string): void {
    this.pendingEscAt.delete(ptyId);
  }
}
