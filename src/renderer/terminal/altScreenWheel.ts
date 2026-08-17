/**
 * Wheel on the alternate screen, for the few agents whose prompt eats arrows.
 *
 * The alt buffer has no xterm scrollback. xterm.js turns the wheel into
 * Up/Down arrows there (xterm.js#1007). That is right for `less`, `vim` and
 * `htop` — arrows are exactly how you move in them — so this must NOT fire for
 * every fullscreen TUI. Grok is the exception: its default focus is the
 * prompt, where arrows open prompt history instead of moving the conversation,
 * and its own docs (keyboard-shortcuts.md) name PageUp / PageDown as the keys
 * that scroll the transcript while the prompt holds focus.
 *
 * So the wheel is only re-mapped when the pane is running an agent known to
 * behave that way. The gate is evaluated per event, not at attach time: one
 * pane runs grok, then vim, then grok again over its life.
 *
 * Capture + preventDefault so a TUI that enabled mouse tracking cannot swallow
 * the event as unused button-64/65 reports (xterm.js wheel-dead reports on
 * mouse-mode panes).
 */

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const MAX_PAGES_PER_EVENT = 3;
/** Pixel threshold ≈ one mouse notch, or three terminal rows. */
const PIXEL_PAGE = 96;

export interface AltScreenWheelTerm {
  buffer?: { active?: { type?: string } };
}

export function isAltScreen(term: AltScreenWheelTerm | null | undefined): boolean {
  try {
    return term?.buffer?.active?.type === 'alternate';
  } catch {
    return false;
  }
}

/** CSI PageUp / PageDown. `up` is the wheel direction (finger/content up). */
export function pageKeyFor(up: boolean): string {
  return up ? PAGE_UP : PAGE_DOWN;
}

export function wheelDeltaToPages(
  accum: number,
  deltaY: number,
  deltaMode: number,
): { pages: number; remainder: number } {
  // deltaMode: 0 = pixels, 1 = lines, 2 = pages.
  if (deltaMode === 2) {
    const pages = clampPages(Math.trunc(deltaY));
    return { pages, remainder: 0 };
  }
  if (deltaMode === 1) {
    // One line-notch → one page. Trackpads rarely use this mode.
    const pages = clampPages(Math.trunc(deltaY));
    return { pages, remainder: 0 };
  }
  const next = accum + deltaY;
  const pages = clampPages(Math.trunc(next / PIXEL_PAGE));
  return { pages, remainder: next - pages * PIXEL_PAGE };
}

function clampPages(n: number): number {
  if (n > MAX_PAGES_PER_EVENT) return MAX_PAGES_PER_EVENT;
  if (n < -MAX_PAGES_PER_EVENT) return -MAX_PAGES_PER_EVENT;
  return n === 0 ? 0 : n;
}

/**
 * Agents whose alt-screen prompt swallows arrows, so the wheel has to be sent
 * as page keys instead. Keep this list evidence-based — an entry belongs here
 * only when that agent documents (or is measured to use) PageUp / PageDown for
 * transcript scrolling. Everything absent keeps xterm's arrow behaviour, which
 * is what a normal fullscreen TUI wants.
 */
export const PAGE_SCROLL_AGENTS: ReadonlySet<string> = new Set(['grok']);

export function attachAltScreenWheel(
  term: AltScreenWheelTerm,
  host: HTMLElement,
  sendKeys: (seq: string) => void,
  /** Per-event gate. Returns false → the wheel is left entirely to xterm. */
  shouldPage: () => boolean,
): () => void {
  let accum = 0;
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!shouldPage()) {
      accum = 0;
      return;
    }
    if (!isAltScreen(term)) {
      accum = 0;
      return;
    }
    const step = wheelDeltaToPages(accum, e.deltaY, e.deltaMode);
    accum = step.remainder;
    if (step.pages === 0) {
      if (e.cancelable) e.preventDefault();
      return;
    }
    const key = pageKeyFor(step.pages < 0);
    let out = '';
    const n = Math.abs(step.pages);
    for (let i = 0; i < n; i++) out += key;
    sendKeys(out);
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
  };
  host.addEventListener('wheel', onWheel, { passive: false, capture: true });
  return () => host.removeEventListener('wheel', onWheel, true);
}
