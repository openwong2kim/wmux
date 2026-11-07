/**
 * Holds a freshly mounted terminal's first PTY resize, and its reattach, until
 * the grid it computes is the one the pane will keep.
 *
 * A pane restored right after boot opens before the bundled webfont has
 * loaded. Its first fit uses the fallback font's cell (Consolas on Windows), so
 * the grid comes out wrong. Here, 122x40 instead of 118x44. Then WebGL rounds
 * the cell to whole device pixels and the grid moves again (115 to 118
 * columns). Sending those sizes resized the PTY to a grid nothing ever showed.
 * Worse, the daemon served the reattach's snapshot at that size, about 40 ms
 * before the real fit. The size was also recorded in the ring's geometry
 * history, so every later restore replayed it. A restore through a short dip
 * cut the rows below the cursor: a Claude Code pane's input box and status
 * line.
 *
 * The gate opens once:
 * - the terminal's own font is loaded;
 * - no WebGL upgrade is still due;
 * - the fitted size has held for one more frame.
 * It also opens when the bound passes, so a font that never loads cannot
 * stall a reattach. A pane whose font is in but whose WebGL build is still
 * queued (a multi-pane restore builds one per frame) waits up to a longer
 * renderer bound: it stays hidden until that build anyway
 * (WEBGL_UPGRADE_HIDE_MAX_MS), so the wait shows nothing. A pane that cannot measure itself at
 * mount (a background workspace, a container still being laid out) opens at
 * once: it makes no mount-time fit, so it has no wrong size to send, and its
 * reattach must not wait on a font it is not drawing yet.
 */

export type FirstResizeGateOutcome = 'immediate' | 'settled' | 'bound' | 'disposed';

export interface FirstResizeGateDeps {
  /** False for a pane mounted hidden: the gate then opens at once. */
  shown(): boolean;
  /** True when the terminal's own font face is loaded (or is a system font). */
  fontReady(): boolean;
  /** True while a WebGL upgrade is still due to change the cell. */
  rendererPending(): boolean;
  /** The size a fit would give now, as a comparable key; null when the pane
   *  cannot measure itself (hidden, or below the safe floor). */
  proposal(): string | null;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

export interface FirstResizeGate {
  /** False until the gate opens; a closed gate means "send no PTY resize". */
  readonly isOpen: boolean;
  /** Settles once, with how the gate opened. */
  readonly opened: Promise<FirstResizeGateOutcome>;
  /** Opens the gate as 'disposed' and stops waiting (unmount, new ptyId). */
  dispose(): void;
}

/** About one webfont load on a cold start; past it the pane goes with what it measured. */
export const FIRST_RESIZE_GATE_BOUND_MS = 500;

export function createFirstResizeGate(
  deps: FirstResizeGateDeps,
  boundMs = FIRST_RESIZE_GATE_BOUND_MS,
  /** Total wait, from creation, for a pane whose font is in but whose WebGL build is still due. */
  rendererBoundMs = boundMs,
): FirstResizeGate {
  let isOpen = false;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolve!: (outcome: FirstResizeGateOutcome) => void;
  const opened = new Promise<FirstResizeGateOutcome>((r) => { resolve = r; });

  const open = (outcome: FirstResizeGateOutcome) => {
    if (isOpen) return;
    isOpen = true;
    if (frame !== null) { deps.cancelFrame(frame); frame = null; }
    if (timer !== null) { deps.clearTimer(timer); timer = null; }
    resolve(outcome);
  };

  // Nothing measured at mount: no fit runs before the reveal's or the layout's.
  if (!deps.shown() || deps.proposal() === null) {
    open('immediate');
  } else {
    let previous: string | null = null;
    const check = () => {
      frame = null;
      const ready = deps.fontReady() && !deps.rendererPending();
      const now = deps.proposal();
      if (ready && now !== null && now === previous) { open('settled'); return; }
      previous = ready ? now : null;
      frame = deps.requestFrame(check);
    };
    timer = deps.setTimer(() => {
      timer = null;
      const rest = rendererBoundMs - boundMs;
      if (rest > 0 && deps.fontReady() && deps.rendererPending()) {
        timer = deps.setTimer(() => { timer = null; open('bound'); }, rest);
        return;
      }
      open('bound');
    }, boundMs);
    check();
  }

  return {
    get isOpen() { return isOpen; },
    opened,
    dispose: () => open('disposed'),
  };
}

/**
 * Whether `fontFamily`'s first family is loaded at `fontSize`. Only the first
 * family counts: the rest of the chain is fallbacks that may never be used,
 * and so never loaded. A system font has no face to load and reads as loaded.
 */
export function primaryFontLoaded(fonts: Pick<FontFaceSet, 'check'>, fontFamily: string | undefined, fontSize: number | undefined): boolean {
  const first = (fontFamily ?? '').split(',')[0]?.trim();
  if (!first) return true;
  try {
    return fonts.check(`${fontSize ?? 14}px ${first}`);
  } catch {
    // An unparsable family: nothing to wait for.
    return true;
  }
}
