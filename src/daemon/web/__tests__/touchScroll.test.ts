// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

/**
 * #890 — touch scrolling in the wmux web terminal.
 *
 * The frontend has no bundler: `touchScroll.js` is inlined into terminal.html
 * by scripts/build-daemon-web.mjs. Evaluate the shipped file verbatim, exactly
 * like attentionFormat.test.ts and pairQuery.test.ts, so this covers the bytes
 * the phone actually runs.
 *
 * The terminal is a FAKE, not a real xterm, and deliberately so. xterm 6
 * replaced native viewport scrolling with VS Code's overlay
 * `.xterm-scrollable-element`, which means `.xterm-viewport.scrollTop` is not
 * scroll state and never moves — a real xterm in jsdom would give this suite an
 * unreadable ground truth. The observable contract of this handler is which of
 * `scrollLines` / key bytes / the notice it invokes, and whether it claimed the
 * gesture, so those are what the fake exposes.
 */

type Step = { lines: number; remainder: number };
type Axis = '' | 'vertical' | 'horizontal';
type Attach = (
  term: unknown,
  host: unknown,
  opts?: {
    allowInput?: () => boolean;
    sendKeys?: (seq: string) => void;
    notify?: (title: string, sub: string) => void;
  },
) => void;

let touchDeltaToLines: (accum: number, dy: number, cellHeight: number) => Step;
let decideGestureAxis: (dx: number, dy: number, threshold?: number, current?: Axis) => Axis;
let attachTouchScroll: Attach;

const frontend = (name: string) => join(__dirname, '..', 'frontend', name);

beforeAll(() => {
  const src = readFileSync(frontend('touchScroll.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  runInNewContext(src, sandbox);
  const mod = sandbox.wmuxTouchScroll as Record<string, unknown>;
  touchDeltaToLines = mod.touchDeltaToLines as typeof touchDeltaToLines;
  decideGestureAxis = mod.decideGestureAxis as typeof decideGestureAxis;
  attachTouchScroll = mod.attachTouchScroll as Attach;
});

// ── pure: touchDeltaToLines ──────────────────────────────────────────────────

describe('touchDeltaToLines', () => {
  const CELL = 10;

  it('★ returns no lines for a sub-cell move but KEEPS the remainder', () => {
    // The whole reason the accumulator exists. Every individual touchmove on a
    // high-DPR phone is a few pixels; dropping the leftover would mean a slow
    // drag scrolls nothing at all, forever, which is indistinguishable from the
    // bug this fixes.
    const first = touchDeltaToLines(0, 4, CELL);
    expect(first).toEqual({ lines: 0, remainder: 4 });

    const second = touchDeltaToLines(first.remainder, 4, CELL);
    expect(second).toEqual({ lines: 0, remainder: 8 });

    // Third small move finally crosses a cell boundary — only because the two
    // before it were carried.
    expect(touchDeltaToLines(second.remainder, 4, CELL)).toEqual({ lines: 1, remainder: 2 });
  });

  it('splits 3.7 cells into 3 lines and 0.7 of a cell left over', () => {
    expect(touchDeltaToLines(0, 37, CELL)).toEqual({ lines: 3, remainder: 7 });
  });

  it('★ is symmetric in the negative direction', () => {
    // trunc, not floor: with floor, an upward drag of the same speed would move
    // one line further than a downward one and the pane would feel lopsided.
    expect(touchDeltaToLines(0, -37, CELL)).toEqual({ lines: -3, remainder: -7 });
    expect(touchDeltaToLines(0, -4, CELL)).toEqual({ lines: 0, remainder: -4 });
    expect(touchDeltaToLines(-4, -4, CELL)).toEqual({ lines: 0, remainder: -8 });
  });

  it('★ cannot divide by zero when the pane reports no cell height', () => {
    // A hidden or not-yet-measured pane measures 0. Infinity lines would be a
    // crash; carrying the delta would fire the entire swipe in one jump the
    // moment the pane is measured again. Neither: drop it.
    expect(touchDeltaToLines(0, 40, 0)).toEqual({ lines: 0, remainder: 0 });
    expect(touchDeltaToLines(12, 40, 0)).toEqual({ lines: 0, remainder: 0 });
    expect(touchDeltaToLines(0, 40, -5)).toEqual({ lines: 0, remainder: 0 });
    expect(touchDeltaToLines(0, 40, NaN)).toEqual({ lines: 0, remainder: 0 });
  });

  it('treats a non-finite accumulator or delta as zero rather than poisoning the state', () => {
    expect(touchDeltaToLines(NaN, 37, CELL)).toEqual({ lines: 3, remainder: 7 });
    expect(touchDeltaToLines(0, NaN, CELL)).toEqual({ lines: 0, remainder: 0 });
  });
});

// ── pure: decideGestureAxis ──────────────────────────────────────────────────

describe('decideGestureAxis', () => {
  const T = 8;

  it('stays undecided until the finger has travelled past the threshold', () => {
    // A tap wobbles a few pixels. Committing there would swallow the tap that
    // raises the soft keyboard.
    expect(decideGestureAxis(0, 0, T, '')).toBe('');
    expect(decideGestureAxis(3, 5, T, '')).toBe('');
    expect(decideGestureAxis(-7, 7, T, '')).toBe('');
  });

  it('locks vertical when the movement is mostly up or down', () => {
    expect(decideGestureAxis(2, 20, T, '')).toBe('vertical');
    expect(decideGestureAxis(-2, -20, T, '')).toBe('vertical');
  });

  it('locks horizontal when the movement is mostly sideways', () => {
    expect(decideGestureAxis(20, 2, T, '')).toBe('horizontal');
    expect(decideGestureAxis(-20, 2, T, '')).toBe('horizontal');
  });

  it('★ gives an exact diagonal to HORIZONTAL', () => {
    // #stage's horizontal pan is what zoom mode is steered with and it works
    // today. Losing one ambiguous swipe costs a repeat; stealing the pan breaks
    // a working affordance.
    expect(decideGestureAxis(20, 20, T, '')).toBe('horizontal');
    expect(decideGestureAxis(-20, 20, T, '')).toBe('horizontal');
  });

  it('★ is sticky: a decided gesture never flips mid-swipe', () => {
    expect(decideGestureAxis(200, 1, T, 'vertical')).toBe('vertical');
    expect(decideGestureAxis(1, 200, T, 'horizontal')).toBe('horizontal');
    // Sticky even below the threshold, where a fresh call would say "undecided".
    expect(decideGestureAxis(0, 0, T, 'vertical')).toBe('vertical');
  });

  it('falls back to the built-in threshold when none is supplied', () => {
    expect(decideGestureAxis(2, 20)).toBe('vertical');
    expect(decideGestureAxis(1, 1)).toBe('');
  });
});

// ── wiring ───────────────────────────────────────────────────────────────────

/**
 * The fake reports 240px over 24 rows, so one cell is 10px and every pixel
 * distance in the tests below reads directly as tenths of a line.
 */
type FakeTerm = {
  rows: number;
  element: { getBoundingClientRect: () => { height: number } };
  buffer: { active: { type: string; baseY: number; viewportY: number } };
  modes?: { applicationCursorKeysMode: boolean };
  setDecckm: (on: boolean) => void;
  scrollLines: ReturnType<typeof vi.fn>;
  onResize: (cb: () => void) => void;
  fireResize: () => void;
};

/** Both arrow encodings are three characters: ESC [ A and ESC O A. */
const ARROW_LEN = 3;

/** The single arrow sequence a payload repeats, or '' if it is not uniform. */
function arrowEncoding(sent: string): string {
  if (sent.length === 0 || sent.length % ARROW_LEN !== 0) return '';
  const seq = sent.slice(0, ARROW_LEN);
  for (let i = ARROW_LEN; i < sent.length; i += ARROW_LEN) {
    if (sent.slice(i, i + ARROW_LEN) !== seq) return '';
  }
  return seq;
}

function lastSent(fn: ReturnType<typeof vi.fn>): string {
  const call = fn.mock.lastCall;
  return call ? String(call[0]) : '';
}

type TermOpts = {
  alt?: boolean;
  baseY?: number;
  viewportY?: number;
  height?: number;
  decckm?: boolean;
  noModes?: boolean;
};

function makeTerm(opts: TermOpts = {}): FakeTerm {
  let onResize: (() => void) | null = null;
  const term: FakeTerm = {
    rows: 24,
    element: { getBoundingClientRect: () => ({ height: opts.height ?? 240 }) },
    buffer: {
      active: {
        type: opts.alt ? 'alternate' : 'normal',
        // Parked mid-scrollback by default, so both directions have somewhere
        // to go. A pane with no scrollback, and a pane clamped against either
        // end, deliberately decline the gesture — covered separately.
        baseY: opts.baseY ?? 500,
        viewportY: opts.viewportY ?? 250,
      },
    },
    setDecckm: (on) => { if (term.modes) term.modes.applicationCursorKeysMode = on; },
    scrollLines: vi.fn(),
    onResize: (cb) => { onResize = cb; },
    fireResize: () => { if (onResize) onResize(); },
  };
  // `noModes` stands in for a terminal that predates IModes — the fallback has
  // to be the unmodified CSI form, not a crash.
  if (!opts.noModes) term.modes = { applicationCursorKeysMode: opts.decckm === true };
  return term;
}

function makeRig(termOpts: TermOpts = {}, allowInput = false) {
  const term = makeTerm(termOpts);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const sendKeys = vi.fn();
  const notify = vi.fn();
  attachTouchScroll(term, host, { allowInput: () => allowInput, sendKeys, notify });
  return { term, host, sendKeys, notify };
}

/**
 * Dispatch a touch event carrying `points`.
 *
 * jsdom has no TouchEvent constructor worth using, and the handler only ever
 * reads `e.touches[i].clientX/clientY`, `e.cancelable` and `e.preventDefault` —
 * so a real Event with a `touches` list gives real preventDefault semantics
 * (which is the thing under test) without pretending to be a device.
 */
function touch(host: HTMLElement, type: string, points: Array<[number, number]>): Event {
  const e = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(e, 'touches', {
    value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
  });
  host.dispatchEvent(e);
  return e;
}

describe('attachTouchScroll — normal buffer', () => {
  it('★ scrolls the buffer, and carries the sub-cell remainder between moves', () => {
    const { term, host } = makeRig();

    touch(host, 'touchstart', [[50, 100]]);
    // 12px down: past the 8px axis threshold, one whole cell plus 2px over.
    touch(host, 'touchmove', [[50, 112]]);
    // 8px more. On its own that is less than a cell — it only crosses one
    // because the 2px left over from the first move was carried.
    touch(host, 'touchmove', [[50, 120]]);

    // Negative: the finger moved DOWN, so the content follows it and the view
    // walks UP into history. That is the whole feature.
    expect(term.scrollLines.mock.calls).toEqual([[-1], [-1]]);
  });

  it('scrolls forward when the finger goes up', () => {
    const { term, host } = makeRig();
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 80]]);
    expect(term.scrollLines.mock.calls).toEqual([[2]]);
  });

  it('★ claims the gesture for the whole vertical lock, including sub-cell moves', () => {
    // Without this, the moves between cell boundaries fall through to #stage and
    // the pane slides under the finger. It is also the guard against
    // double-scrolling if a future xterm grows its own touch handling.
    const { host } = makeRig();
    touch(host, 'touchstart', [[50, 100]]);
    const lock = touch(host, 'touchmove', [[50, 112]]);
    expect(lock.defaultPrevented).toBe(true);
    const subCell = touch(host, 'touchmove', [[50, 115]]);
    expect(subCell.defaultPrevented).toBe(true);
  });

  it('leaves the gesture to #stage when the pane has no history above the viewport', () => {
    // A fresh pane cannot scroll back, but it CAN be taller than the phone in
    // zoom mode — and panning it into view is the only useful vertical motion
    // there. Claiming the gesture would kill that for nothing.
    const { term, host } = makeRig({ baseY: 0, viewportY: 0 });
    touch(host, 'touchstart', [[50, 100]]);
    const e = touch(host, 'touchmove', [[50, 140]]);
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('does not scroll a pane that reports no cell height', () => {
    const term = makeTerm({ height: 0 });
    const host = document.createElement('div');
    attachTouchScroll(term, host, { allowInput: () => false });
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 200]]);
    expect(term.scrollLines).not.toHaveBeenCalled();
  });
});

describe('attachTouchScroll — clamped at either end of the scrollback', () => {
  // The dead zone GLM-5.2 found. Asking only "does scrollback exist" claims the
  // gesture at both ends, where xterm clamps scrollLines to a no-op — so
  // nothing moves AND #stage cannot pan. Direction has to be part of the
  // question, and it is knowable from `dy` before any line arithmetic.

  it('★ at the bottom, a swipe UP claims nothing', () => {
    const { term, host } = makeRig({ baseY: 500, viewportY: 500 });
    touch(host, 'touchstart', [[50, 100]]);
    const e = touch(host, 'touchmove', [[50, 60]]);   // finger up → toward the bottom
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('★ at the bottom, a swipe DOWN still scrolls back into history', () => {
    const { term, host } = makeRig({ baseY: 500, viewportY: 500 });
    touch(host, 'touchstart', [[50, 100]]);
    const e = touch(host, 'touchmove', [[50, 140]]);
    expect(term.scrollLines).toHaveBeenCalledWith(-4);
    expect(e.defaultPrevented).toBe(true);
  });

  it('★ at the top, a swipe DOWN claims nothing', () => {
    const { term, host } = makeRig({ baseY: 500, viewportY: 0 });
    touch(host, 'touchstart', [[50, 100]]);
    const e = touch(host, 'touchmove', [[50, 140]]);   // finger down → further back
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('★ at the top, a swipe UP still returns toward the bottom', () => {
    const { term, host } = makeRig({ baseY: 500, viewportY: 0 });
    touch(host, 'touchstart', [[50, 100]]);
    const e = touch(host, 'touchmove', [[50, 60]]);
    expect(term.scrollLines).toHaveBeenCalledWith(4);
    expect(e.defaultPrevented).toBe(true);
  });

  it('mid-scrollback claims and scrolls in BOTH directions', () => {
    const { term, host } = makeRig({ baseY: 500, viewportY: 250 });
    touch(host, 'touchstart', [[50, 100]]);
    expect(touch(host, 'touchmove', [[50, 140]]).defaultPrevented).toBe(true);
    expect(touch(host, 'touchmove', [[50, 100]]).defaultPrevented).toBe(true);
    expect(term.scrollLines.mock.calls).toEqual([[-4], [4]]);
  });

  it('★ zoom mode: a pane WITH scrollback can still be panned at its edges', () => {
    // The regression this guard protects. A tall pane parked at the bottom used
    // to swallow every upward swipe, so #stage could never scroll down to the
    // rows below the fold.
    const { host } = makeRig({ baseY: 500, viewportY: 500 });
    touch(host, 'touchstart', [[50, 400]]);
    const a = touch(host, 'touchmove', [[50, 300]]);
    const b = touch(host, 'touchmove', [[50, 200]]);
    expect(a.defaultPrevented).toBe(false);
    expect(b.defaultPrevented).toBe(false);
  });

  it('reads the clamp live, so scrolling stops exactly at the end', () => {
    const { term, host } = makeRig({ baseY: 500, viewportY: 250 });
    touch(host, 'touchstart', [[50, 100]]);
    expect(touch(host, 'touchmove', [[50, 140]]).defaultPrevented).toBe(true);

    term.buffer.active.viewportY = 0;   // xterm has reached the top
    expect(touch(host, 'touchmove', [[50, 180]]).defaultPrevented).toBe(false);
    expect(term.scrollLines).toHaveBeenCalledTimes(1);
  });

  it('declines a zero-delta move rather than claiming it', () => {
    const { term, host } = makeRig();
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 140]]);          // lock vertical
    term.scrollLines.mockClear();
    const e = touch(host, 'touchmove', [[50, 140]]);   // finger held still
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('attachTouchScroll — multi-touch', () => {
  it('★ bails on a two-finger gesture instead of scrolling', () => {
    // Pinch-zoom and the two-finger stage pan belong to the browser.
    const { term, host } = makeRig();
    touch(host, 'touchstart', [[40, 100], [60, 100]]);
    const e = touch(host, 'touchmove', [[40, 140], [60, 140]]);
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('stays bailed for the rest of the gesture even if one finger lifts', () => {
    const { term, host } = makeRig();
    touch(host, 'touchstart', [[40, 100], [60, 100]]);
    const e = touch(host, 'touchmove', [[40, 160]]);
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('drops a gesture the moment a second finger joins it', () => {
    const { term, host } = makeRig();
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 120]]);
    term.scrollLines.mockClear();
    touch(host, 'touchmove', [[50, 160], [80, 160]]);
    expect(term.scrollLines).not.toHaveBeenCalled();
  });
});

describe('attachTouchScroll — alt screen', () => {
  it('★ sends arrow keys instead of scrollLines when input is allowed', () => {
    // A full-screen app keeps no scrollback, so scrollLines is meaningless
    // there. The arrow keys let the TUI scroll itself — the same translation
    // xterm applies to the wheel on the alt screen (xterm.js#1007).
    const { term, host, sendKeys } = makeRig({ alt: true }, true);
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 125]]);   // 25px down → 2 whole cells
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith('\x1b[A\x1b[A');
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it('sends Down when the finger goes up', () => {
    const { host, sendKeys } = makeRig({ alt: true }, true);
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 75]]);
    expect(sendKeys).toHaveBeenCalledWith('\x1b[B\x1b[B');
  });

  it('★ DECCKM on: sends the SS3 form the TUI is actually listening for', () => {
    // The T5 dogfood failure. Git for Windows `less` turns on keypad-transmit
    // (terminfo smkx → DECCKM), so it expects SS3 and reads CSI as noise: the
    // handler claimed all 14 touchmoves of a swipe and less did not move a row.
    const { host, sendKeys } = makeRig({ alt: true, decckm: true }, true);
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 125]]);
    expect(sendKeys).toHaveBeenCalledWith('\x1bOA\x1bOA');

    sendKeys.mockClear();
    touch(host, 'touchend', []);
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 75]]);
    expect(sendKeys).toHaveBeenCalledWith('\x1bOB\x1bOB');
  });

  it('★ reads DECCKM live, so a pane that flips mode mid-gesture keeps working', () => {
    // An app can set or clear DECCKM at any moment, and the handler is not
    // re-attached when it does. Caching the encoding would resurrect this bug
    // the first time a pane changed its mind.
    // Asserts the ENCODING, not the key count — how many arrows each move is
    // worth depends on the carried remainder, which is a different test's job.
    const { term, host, sendKeys } = makeRig({ alt: true }, true);
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 125]]);
    expect(arrowEncoding(lastSent(sendKeys))).toBe('\x1b[A');

    term.setDecckm(true);
    touch(host, 'touchmove', [[50, 150]]);
    expect(arrowEncoding(lastSent(sendKeys))).toBe('\x1bOA');
  });

  it('★ a terminal without IModes falls back to CSI rather than throwing', () => {
    const { host, sendKeys } = makeRig({ alt: true, noModes: true }, true);
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 125]]);
    expect(sendKeys).toHaveBeenCalledWith('\x1b[A\x1b[A');
  });

  it('survives a terminal whose modes accessor throws', () => {
    const term = makeTerm({ alt: true, noModes: true });
    Object.defineProperty(term, 'modes', {
      get() { throw new Error('disposed'); },
    });
    const host = document.createElement('div');
    const sendKeys = vi.fn();
    attachTouchScroll(term, host, { allowInput: () => true, sendKeys });
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 125]]);
    expect(sendKeys).toHaveBeenCalledWith('\x1b[A\x1b[A');
  });

  it('caps one move at a fixed number of keystrokes, in either encoding', () => {
    // Each line is a keystroke POSTed at a live TUI. A pathological delta (a
    // finger re-entering the element, a synthetic event) must not hammer it.
    const csi = makeRig({ alt: true }, true);
    touch(csi.host, 'touchstart', [[50, 1000]]);
    touch(csi.host, 'touchmove', [[50, 0]]);   // 100 cells' worth
    expect(arrowEncoding(lastSent(csi.sendKeys))).toBe('\x1b[B');
    expect(lastSent(csi.sendKeys).length / ARROW_LEN).toBe(24);

    const ss3 = makeRig({ alt: true, decckm: true }, true);
    touch(ss3.host, 'touchstart', [[50, 1000]]);
    touch(ss3.host, 'touchmove', [[50, 0]]);
    expect(arrowEncoding(lastSent(ss3.sendKeys))).toBe('\x1bOB');
    expect(lastSent(ss3.sendKeys).length / ARROW_LEN).toBe(24);
  });

  it('★ read-only + alt screen: says so ONCE, and does nothing else', () => {
    // The accepted limit from the plan: no scrollback to move, no permission to
    // send the keys. A silent no-op is indistinguishable from a hang, and is
    // what produced this issue.
    const { term, host, sendKeys, notify } = makeRig({ alt: true }, false);
    touch(host, 'touchstart', [[50, 100]]);
    const first = touch(host, 'touchmove', [[50, 140]]);
    touch(host, 'touchmove', [[50, 180]]);
    touch(host, 'touchend', []);
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 140]]);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    // Nothing was handled, so the page keeps its own scrolling.
    expect(first.defaultPrevented).toBe(false);
  });

  it('★ the notice does not nudge the operator toward enabling input', () => {
    // D6: read-only is a security posture chosen on the server. Explaining the
    // limit is the job; lobbying against it is not.
    const { host, notify } = makeRig({ alt: true }, false);
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 140]]);
    const text = (notify.mock.calls[0] as string[]).join(' ');
    expect(text).not.toMatch(/enabl|allow-input|allow input|turn on|--allow/i);
    expect(text).toMatch(/read-only/i);
  });

  it('★ read-only + alt screen clears the accumulator instead of banking it', () => {
    // Nothing on that path will ever spend those pixels, and a pane that leaves
    // the alt screen should not inherit a swipe the user made while it was
    // refusing to move.
    // Has to START on the normal buffer, or there is nothing banked to clear
    // and the test passes either way.
    const { term, host } = makeRig({}, false);
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 109]]);    // locks vertical, banks 9px
    expect(term.scrollLines).not.toHaveBeenCalled();

    term.buffer.active.type = 'alternate';
    touch(host, 'touchmove', [[50, 149]]);    // 40px the read-only alt path declines

    term.buffer.active.type = 'normal';
    touch(host, 'touchmove', [[50, 150]]);    // 1px — a whole line only if the 9 survived
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it('reads the buffer type live, so a pane that leaves the alt screen scrolls again', () => {
    const { term, host, sendKeys } = makeRig({ alt: true }, true);
    term.buffer.active.type = 'normal';
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 125]]);
    expect(term.scrollLines).toHaveBeenCalledWith(-2);
    expect(sendKeys).not.toHaveBeenCalled();
  });
});

describe('attachTouchScroll — horizontal and taps', () => {
  it('★ never preventDefaults a horizontal swipe, so the #stage pan survives', () => {
    const { term, host } = makeRig();
    touch(host, 'touchstart', [[50, 100]]);
    const e = touch(host, 'touchmove', [[90, 102]]);
    expect(e.defaultPrevented).toBe(false);
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it('keeps ignoring a locked-horizontal gesture even once it drifts vertically', () => {
    const { term, host } = makeRig();
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[90, 102]]);      // locks horizontal
    const e = touch(host, 'touchmove', [[92, 220]]);
    expect(e.defaultPrevented).toBe(false);
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it('★ never preventDefaults a tap, which is what raises the soft keyboard', () => {
    // focusFromGesture hangs off `click`, and iOS only opens the keyboard for a
    // focus made inside a real gesture. Swallowing the tap would trade one bug
    // for a worse one.
    const { host } = makeRig();
    const start = touch(host, 'touchstart', [[50, 100]]);
    const wobble = touch(host, 'touchmove', [[52, 103]]);
    const end = touch(host, 'touchend', []);
    expect(start.defaultPrevented).toBe(false);
    expect(wobble.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
  });

  it('ignores a touchmove that arrives without a touchstart', () => {
    const { term, host } = makeRig();
    touch(host, 'touchmove', [[50, 200]]);
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it('★ keeps tracking the finger through moves it declines to act on', () => {
    // `lastY` has to advance even on a declined event. It used to sit behind
    // the defaultPrevented return, so a downstream handler claiming a few moves
    // left `lastY` several moves stale and the next delta arrived as one lurch.
    const { term, host } = makeRig();
    const inner = document.createElement('div');
    host.appendChild(inner);
    let claim = true;
    inner.addEventListener('touchmove', (e) => { if (claim) e.preventDefault(); });

    const move = (y: number) => {
      const e = new Event('touchmove', { cancelable: true, bubbles: true });
      Object.defineProperty(e, 'touches', { value: [{ clientX: 50, clientY: y }] });
      inner.dispatchEvent(e);
    };

    touch(host, 'touchstart', [[50, 100]]);
    move(140);          // claimed downstream — we act on none of it
    move(180);          // still claimed
    expect(term.scrollLines).not.toHaveBeenCalled();

    claim = false;
    move(190);          // 10px since the LAST move, not 90px since touchstart
    expect(term.scrollLines).toHaveBeenCalledWith(-1);
  });

  it('★ stands down when something closer to the target already claimed the gesture', () => {
    // The double-scroll guard. Nothing does this today; a future xterm that
    // grows its own touch handling would, and it renders inside our host, so
    // its handler runs first.
    const { term, host } = makeRig();
    const inner = document.createElement('div');
    host.appendChild(inner);
    inner.addEventListener('touchmove', (e) => e.preventDefault());

    touch(host, 'touchstart', [[50, 100]]);
    const e = new Event('touchmove', { cancelable: true, bubbles: true });
    Object.defineProperty(e, 'touches', { value: [{ clientX: 50, clientY: 200 }] });
    inner.dispatchEvent(e);

    expect(term.scrollLines).not.toHaveBeenCalled();
  });
});

describe('attachTouchScroll — re-attaching to a host that outlived its terminal', () => {
  it('★ swaps the terminal instead of stacking a second handler', () => {
    // The 1-up view disposes `term` on the way into split view and builds a new
    // one on the way back, into the SAME #term element. Stacking would mean two
    // accumulators and two scrollLines per swipe after one round trip — and the
    // older closure would be calling scrollLines on a disposed terminal.
    const first = makeTerm();
    const second = makeTerm();
    const host = document.createElement('div');
    document.body.appendChild(host);

    attachTouchScroll(first, host, { allowInput: () => false });
    attachTouchScroll(second, host, { allowInput: () => false });

    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 120]]);

    expect(second.scrollLines.mock.calls).toEqual([[-2]]);
    expect(first.scrollLines).not.toHaveBeenCalled();
  });

  it('re-arms the one-shot notice for the new pane', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const notify = vi.fn();

    attachTouchScroll(makeTerm({ alt: true }), host, { allowInput: () => false, notify });
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 140]]);
    expect(notify).toHaveBeenCalledTimes(1);

    attachTouchScroll(makeTerm({ alt: true }), host, { allowInput: () => false, notify });
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 140]]);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('attachTouchScroll — resize mid-gesture', () => {
  it('★ drops the accumulator on resize, because the cell height it counted is gone', () => {
    const { term, host } = makeRig();
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 109]]);   // locks vertical, 9px carried
    term.fireResize();
    touch(host, 'touchmove', [[50, 114]]);   // +5px — 5 on its own, 14 if carried
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it('control: the same two moves DO cross a cell when no resize intervenes', () => {
    // Without this pair the test above would pass even if the accumulator never
    // worked at all.
    const { term, host } = makeRig();
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 109]]);
    touch(host, 'touchmove', [[50, 114]]);
    expect(term.scrollLines.mock.calls).toEqual([[-1]]);
  });

  it('★ drops the accumulator when #scaler re-scales, which fires no event at all', () => {
    // The zoom buttons and the Fit toggle change `#scaler`'s transform. xterm
    // knows nothing about it, so onResize never fires — but every cell just
    // changed visual height, and pixels banked at the old scale would be spent
    // at the new one. Comparing the measurement is the only signal there is.
    let height = 240;                                   // 24 rows → 10px cells
    const term = makeTerm();
    term.element.getBoundingClientRect = () => ({ height });
    const host = document.createElement('div');
    attachTouchScroll(term, host, { allowInput: () => false });

    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 109]]);              // locks vertical, banks 9px
    expect(term.scrollLines).not.toHaveBeenCalled();

    height = 480;                                       // "A+" pressed: 20px cells
    touch(host, 'touchmove', [[50, 120]]);              // 11px at the new scale
    // 9 + 11 = 20 would be a whole line at the NEW height if the stale pixels
    // carried. They must not.
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it('control: without a re-scale those same two moves do cross a cell', () => {
    const { term, host } = makeRig();
    touch(host, 'touchstart', [[50, 100]]);
    touch(host, 'touchmove', [[50, 109]]);
    touch(host, 'touchmove', [[50, 120]]);
    expect(term.scrollLines).toHaveBeenCalledWith(-2);
  });

  it('survives a terminal that exposes no onResize at all', () => {
    const host = document.createElement('div');
    expect(() => attachTouchScroll({ rows: 24 }, host, {})).not.toThrow();
  });

  it('is a no-op for a missing terminal or host', () => {
    expect(() => attachTouchScroll(null, document.createElement('div'), {})).not.toThrow();
    expect(() => attachTouchScroll(makeTerm(), null, {})).not.toThrow();
  });
});

// ── source invariants (the drift guard) ──────────────────────────────────────

describe('source invariants', () => {
  const app = () => readFileSync(frontend('app.js'), 'utf8');

  /** Body of a top-level `function name(` in app.js, up to the next one. */
  function bodyOf(src: string, name: string): string {
    const start = src.indexOf(`\n  function ${name}(`);
    expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
    const next = src.indexOf('\n  function ', start + 1);
    return src.slice(start, next === -1 ? src.length : next);
  }

  it('★ BOTH terminal-creation sites attach the SAME touch handler', () => {
    // Two copies of this wiring is exactly the drift this guard exists for: the
    // split tiles are where a swipe matters most and are also the site most
    // likely to be forgotten.
    const src = app();
    expect(bodyOf(src, 'ensureTerm')).toContain('attachTouchScroll(');
    expect(bodyOf(src, 'makeTile')).toContain('attachTouchScroll(');
    // One function, called twice — not two implementations.
    expect(src.match(/attachTouchScroll\(/g)).toHaveLength(2);
  });

  it('★ newTerm() passes both scroll-feel options to xterm', () => {
    // The wheel moved exactly one line per notch before these. Both are public
    // xterm options on purpose — a hand-rolled wheel listener would
    // double-scroll the day xterm changes how it handles the wheel.
    const body = bodyOf(app(), 'newTerm');
    expect(body).toMatch(/scrollSensitivity:\s*\d+/);
    expect(body).toMatch(/smoothScrollDuration:\s*\d+/);
  });

  it('★ no rule is left pointing at the scrollbar xterm 6 stopped drawing', () => {
    // Comments are stripped first: the replacement block explains what the old
    // selector was and why it died, and a guard that cannot tell a rule from a
    // sentence about a rule would forbid saying so.
    const css = readFileSync(frontend('styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/\.xterm-viewport\s*(::|\{|,)/);
    expect(css).toContain('.xterm-scrollable-element > .scrollbar.vertical');
  });

  it('★ touchScroll.js is actually inlined into the page the daemon serves', () => {
    // There is no bundler and no module loader: a frontend file that no marker
    // pulls in simply never runs, and the CSP gate counts the blocks it expects.
    const html = readFileSync(frontend('index.html'), 'utf8');
    expect(html).toContain('/*__TOUCH_SCROLL_JS__*/');
    const build = readFileSync(join(__dirname, '..', '..', '..', '..', 'scripts', 'build-daemon-web.mjs'), 'utf8');
    expect(build).toContain("inject(html, '/*__TOUCH_SCROLL_JS__*/', touchScrollJs)");
    expect(build).toContain('blocks.scripts.length !== 7');
  });
});
