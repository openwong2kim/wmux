/**
 * Wheel on the alternate screen (fullscreen TUIs: Grok, vim, less).
 *
 * The alt buffer has no xterm scrollback. xterm.js turns the wheel into
 * Up/Down arrows there (xterm.js#1007). That is right for `less`, but Grok's
 * default focus is the prompt: arrows open prompt history, they do not move
 * the conversation. Grok's own docs (keyboard-shortcuts.md) say PageUp /
 * PageDown scroll the transcript even while the prompt is focused.
 *
 * We take the wheel on the alt screen and emit those page keys instead.
 * Capture + preventDefault so a TUI that enabled mouse tracking cannot
 * swallow the event as unused button-64/65 reports (xterm.js wheel-dead
 * reports on mouse-mode panes).
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

export function attachAltScreenWheel(
  term: AltScreenWheelTerm,
  host: HTMLElement,
  sendKeys: (seq: string) => void,
): () => void {
  let accum = 0;
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
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
