// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentSelectsOnDrag,
  installPlainDragSelect,
  installWheelClearsSelectionHint,
  __resetWheelHintedPanesForTests,
  isDrag,
  mouseOwnedHintApplies,
  shouldHoldHoverMove,
  shouldInterceptMouseDown,
  type PlainDragMouseDown,
} from '../plainDragSelect';
import { installAltClickTrackingGuard } from '../altClickUnderMouseTracking';

const plain: PlainDragMouseDown = { button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

describe('shouldInterceptMouseDown', () => {
  it('holds a plain left press while the app tracks the mouse', () => {
    expect(shouldInterceptMouseDown(plain, 'any', true)).toBe(true);
    expect(shouldInterceptMouseDown(plain, 'vt200', true)).toBe(true);
  });

  it('leaves a shell prompt (tracking off) alone', () => {
    expect(shouldInterceptMouseDown(plain, 'none', true)).toBe(false);
  });

  it('does nothing with the setting off', () => {
    expect(shouldInterceptMouseDown(plain, 'any', false)).toBe(false);
  });

  it('leaves every modifier to xterm', () => {
    for (const mod of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'] as const) {
      expect(shouldInterceptMouseDown({ ...plain, [mod]: true }, 'any', true), mod).toBe(false);
    }
  });

  it('leaves right and middle buttons alone', () => {
    expect(shouldInterceptMouseDown({ ...plain, button: 1 }, 'any', true)).toBe(false);
    expect(shouldInterceptMouseDown({ ...plain, button: 2 }, 'any', true)).toBe(false);
  });
});

describe('isDrag', () => {
  it('is a click below the threshold and a drag at it', () => {
    const o = { clientX: 100, clientY: 100 };
    expect(isDrag(o, { clientX: 103, clientY: 103 })).toBe(false);
    expect(isDrag(o, { clientX: 105, clientY: 100 })).toBe(true);
    expect(isDrag(o, { clientX: 100, clientY: 92 })).toBe(true);
  });
});

describe('shouldHoldHoverMove', () => {
  it('holds a hover only under any-event tracking, with the setting on and a live selection', () => {
    const hover = { buttons: 0 };
    expect(shouldHoldHoverMove(hover, 'any', true, true)).toBe(true);
    expect(shouldHoldHoverMove(hover, 'any', true, false)).toBe(false);
    expect(shouldHoldHoverMove(hover, 'any', false, true)).toBe(false);
    expect(shouldHoldHoverMove(hover, 'drag', true, true)).toBe(false);
    expect(shouldHoldHoverMove(hover, 'none', true, true)).toBe(false);
    expect(shouldHoldHoverMove({ buttons: 1 }, 'any', true, true)).toBe(false);
  });
});

describe('agentSelectsOnDrag', () => {
  it('leaves drags to Claude Code, which selects and copies on its own', () => {
    expect(agentSelectsOnDrag('claude')).toBe(true);
  });

  it('keeps plain-drag select for apps without their own selection', () => {
    expect(agentSelectsOnDrag('codex')).toBe(false);
    expect(agentSelectsOnDrag(undefined)).toBe(false);
  });
});

describe('mouseOwnedHintApplies', () => {
  it('teaches the modifier only when plain drags do not select', () => {
    expect(mouseOwnedHintApplies('any', false)).toBe(true);
    expect(mouseOwnedHintApplies('any', true)).toBe(false);
    expect(mouseOwnedHintApplies('none', false)).toBe(false);
  });
});

interface Seen { type: string; detail: number; altKey: boolean; shiftKey: boolean; x: number; y: number; buttons: number }

describe('installPlainDragSelect', () => {
  let container: HTMLDivElement;
  let xtermEl: HTMLDivElement;
  let screen: HTMLDivElement;
  let seen: Seen[];
  let docUps: number;
  let enabled: boolean;
  let selection: boolean;
  let term: { modes: { mouseTrackingMode: string }; options: { altClickMovesCursor?: boolean }; focus: ReturnType<typeof vi.fn<() => void>>; element: HTMLElement; hasSelection: () => boolean };
  let teardowns: (() => void)[];

  const record = (e: Event) => {
    const m = e as MouseEvent;
    seen.push({ type: m.type, detail: m.detail, altKey: m.altKey, shiftKey: m.shiftKey, x: m.clientX, y: m.clientY, buttons: m.buttons });
  };
  const onDocUp = () => { docUps++; };

  function install(isMac: boolean) {
    // Same order as useTerminal: the alt-click guard first, then this.
    teardowns.push(installAltClickTrackingGuard(container, term));
    teardowns.push(installPlainDragSelect(container, term, { isEnabled: () => enabled, isMac }));
  }

  const fire = (target: EventTarget, type: string, init: MouseEventInit) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));

  beforeEach(() => {
    container = document.createElement('div');
    xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    screen = document.createElement('div');
    screen.className = 'xterm-screen';
    xtermEl.appendChild(screen);
    container.appendChild(xtermEl);
    document.body.appendChild(container);
    // Stand-in for xterm's own listeners on its element.
    xtermEl.addEventListener('mousedown', record);
    xtermEl.addEventListener('mouseup', record);
    xtermEl.addEventListener('mousemove', record);
    document.addEventListener('mouseup', onDocUp, true);
    seen = [];
    docUps = 0;
    enabled = true;
    selection = false;
    term = { modes: { mouseTrackingMode: 'any' }, options: { altClickMovesCursor: true }, focus: vi.fn<() => void>(), element: xtermEl, hasSelection: () => selection };
    teardowns = [];
  });

  afterEach(() => {
    teardowns.forEach((t) => t());
    document.removeEventListener('mouseup', onDocUp, true);
    container.remove();
  });

  it('holds the press back and focuses the terminal', () => {
    install(true);
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 10, clientY: 10 });
    screen.dispatchEvent(ev);
    expect(seen).toEqual([]);
    expect(ev.defaultPrevented).toBe(true);
    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it('a drag replays a force-selection mousedown (Option on macOS) at the original point', () => {
    install(true);
    fire(screen, 'mousedown', { buttons: 1, clientX: 10, clientY: 10 });
    fire(screen, 'mousemove', { buttons: 1, clientX: 12, clientY: 11 });
    expect(seen.filter((s) => s.type === 'mousedown')).toEqual([]);
    fire(screen, 'mousemove', { buttons: 1, clientX: 30, clientY: 10 });
    const downs = seen.filter((s) => s.type === 'mousedown');
    expect(downs).toEqual([{ type: 'mousedown', detail: 1, altKey: true, shiftKey: false, x: 10, y: 10, buttons: 1 }]);
    const replayedMove = seen.find((s) => s.type === 'mousemove' && s.detail === 1);
    expect(replayedMove).toMatchObject({ x: 30, y: 10, buttons: 1 });
    // The forced Option press must not re-enable click-to-move-cursor.
    expect(term.options.altClickMovesCursor).toBe(false);
    // Handed off: the real release flows through untouched.
    fire(screen, 'mouseup', { buttons: 0, clientX: 30, clientY: 10 });
    expect(seen.filter((s) => s.type === 'mouseup')).toHaveLength(1);
    expect(seen.filter((s) => s.type === 'mousedown')).toHaveLength(1);
  });

  it('keeps a double press as a double press, so drag-select goes by word', () => {
    install(true);
    fire(screen, 'mousedown', { buttons: 1, detail: 2, clientX: 10, clientY: 10 });
    fire(screen, 'mousemove', { buttons: 1, clientX: 40, clientY: 10 });
    expect(seen.find((s) => s.type === 'mousedown')).toMatchObject({ detail: 2, altKey: true });
  });

  it('leaves a press on the scrollbar beside the text area alone', () => {
    install(true);
    const scrollbar = document.createElement('div');
    scrollbar.className = 'xterm-scrollable-element';
    xtermEl.appendChild(scrollbar);
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 10, clientY: 10 });
    scrollbar.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(seen.filter((s) => s.type === 'mousedown')).toHaveLength(1);
  });

  it('uses Shift as the force-selection modifier off macOS', () => {
    install(false);
    fire(screen, 'mousedown', { buttons: 1, clientX: 10, clientY: 10 });
    fire(document, 'mousemove', { buttons: 1, clientX: 10, clientY: 40 });
    expect(seen.find((s) => s.type === 'mousedown')).toMatchObject({ detail: 1, shiftKey: true, altKey: false });
  });

  it('a click replays a plain mousedown + mouseup for the app and swallows the real release', () => {
    install(true);
    fire(screen, 'mousedown', { buttons: 1, clientX: 10, clientY: 10 });
    fire(screen, 'mousemove', { buttons: 1, clientX: 12, clientY: 12 });
    fire(screen, 'mouseup', { buttons: 0, clientX: 12, clientY: 12 });
    const replayed = seen.filter((s) => s.type !== 'mousemove');
    expect(replayed).toEqual([
      { type: 'mousedown', detail: 1, altKey: false, shiftKey: false, x: 10, y: 10, buttons: 1 },
      { type: 'mouseup', detail: 1, altKey: false, shiftKey: false, x: 12, y: 12, buttons: 0 },
    ]);
    // Exactly one release reaches the document (the replayed one), so the
    // #582 drag flag and xterm's document mouseup still disarm.
    expect(docUps).toBe(1);
  });

  it('passes through with tracking off, the setting off, or a modifier held', () => {
    install(true);
    term.modes.mouseTrackingMode = 'none';
    fire(screen, 'mousedown', { buttons: 1, clientX: 1, clientY: 1 });
    term.modes.mouseTrackingMode = 'any';
    enabled = false;
    fire(screen, 'mousedown', { buttons: 1, clientX: 1, clientY: 1 });
    enabled = true;
    fire(screen, 'mousedown', { buttons: 1, shiftKey: true, clientX: 1, clientY: 1 });
    fire(screen, 'mousedown', { button: 2, buttons: 2, clientX: 1, clientY: 1 });
    expect(seen.filter((s) => s.type === 'mousedown')).toHaveLength(4);
    expect(term.focus).not.toHaveBeenCalled();
  });

  it('drops the pending press on window blur and on a release it never saw', () => {
    install(true);
    fire(screen, 'mousedown', { buttons: 1, clientX: 10, clientY: 10 });
    window.dispatchEvent(new Event('blur'));
    fire(screen, 'mousemove', { buttons: 1, clientX: 50, clientY: 50 });
    expect(seen.filter((s) => s.type === 'mousedown')).toEqual([]);

    fire(screen, 'mousedown', { buttons: 1, clientX: 10, clientY: 10 });
    fire(document, 'mousemove', { buttons: 0, clientX: 50, clientY: 50 });
    fire(screen, 'mousemove', { buttons: 1, clientX: 80, clientY: 80 });
    expect(seen.filter((s) => s.type === 'mousedown')).toEqual([]);
  });

  it('replays on the screen element when the pressed node was re-rendered away', () => {
    install(true);
    const row = document.createElement('span');
    screen.appendChild(row);
    fire(row, 'mousedown', { buttons: 1, clientX: 10, clientY: 10 });
    row.remove();
    fire(document, 'mousemove', { buttons: 1, clientX: 40, clientY: 10 });
    expect(seen.find((s) => s.type === 'mousedown')).toMatchObject({ altKey: true, detail: 1 });
  });

  // Windows sends a buttonless mousemove at the release point right after the
  // mouseup; under ?1003 xterm reported it as hover, and a mouse report counts
  // as user input, which cleared the fresh selection before it was copied.
  it('keeps hover moves from xterm while a selection is alive under any-event tracking', () => {
    install(false);
    const moves = () => seen.filter((s) => s.type === 'mousemove' && s.buttons === 0).length;
    selection = true;
    fire(screen, 'mousemove', { buttons: 0, clientX: 40, clientY: 10 });
    expect(moves()).toBe(0);

    // Dragging (a button held) is never held back.
    fire(screen, 'mousemove', { buttons: 1, clientX: 41, clientY: 10 });
    expect(seen.filter((s) => s.type === 'mousemove' && s.buttons === 1)).toHaveLength(1);

    // Hover reporting resumes once the selection is gone.
    selection = false;
    fire(screen, 'mousemove', { buttons: 0, clientX: 42, clientY: 10 });
    expect(moves()).toBe(1);
  });

  it('passes hover moves through with the setting off or without any-event tracking', () => {
    install(false);
    selection = true;
    enabled = false;
    fire(screen, 'mousemove', { buttons: 0, clientX: 40, clientY: 10 });
    enabled = true;
    term.modes.mouseTrackingMode = 'drag';
    fire(screen, 'mousemove', { buttons: 0, clientX: 41, clientY: 10 });
    term.modes.mouseTrackingMode = 'none';
    fire(screen, 'mousemove', { buttons: 0, clientX: 42, clientY: 10 });
    expect(seen.filter((s) => s.type === 'mousemove')).toHaveLength(3);
  });

  it('teardown stops intercepting', () => {
    install(true);
    teardowns.forEach((t) => t());
    teardowns = [];
    fire(screen, 'mousedown', { buttons: 1, clientX: 1, clientY: 1 });
    expect(seen.filter((s) => s.type === 'mousedown')).toHaveLength(1);
    selection = true;
    fire(screen, 'mousemove', { buttons: 0, clientX: 5, clientY: 1 });
    expect(seen.filter((s) => s.type === 'mousemove')).toHaveLength(1);
  });
});

describe('installWheelClearsSelectionHint (#2293)', () => {
  // A fake xterm whose wheel handler does what xterm's does under tracking:
  // a wheel it acts on is user input and clears the selection (firing the
  // selection event synchronously); `ignores` stands for a wheel it drops
  // (Shift+wheel, a sub-line delta).
  let pane = 0;
  function setup(opts: { tracking?: string; buffer?: string; exempt?: boolean; id?: string } = {}) {
    const container = document.createElement('div');
    const screen = document.createElement('div');
    container.appendChild(screen);
    document.body.appendChild(container);
    const listeners = new Set<() => void>();
    const term = {
      modes: { mouseTrackingMode: opts.tracking ?? 'any' },
      buffer: { active: { type: opts.buffer ?? 'alternate' } },
      selection: true,
      ignores: false,
      hasSelection(): boolean { return this.selection; },
      onSelectionChange(fn: () => void) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
      clearSelection(): void { this.selection = false; listeners.forEach((fn) => fn()); },
    };
    screen.addEventListener('wheel', (e) => {
      if (term.modes.mouseTrackingMode === 'none' || term.ignores) return;
      term.clearSelection();
      e.preventDefault();
      e.stopPropagation();
    });
    const show = vi.fn();
    const id = opts.id ?? `pty-${++pane}`;
    const install = () => installWheelClearsSelectionHint(container, term, {
      show,
      paneId: () => id,
      isExempt: () => opts.exempt === true,
    });
    let detach = install();
    const wheel = (): void => {
      screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));
    };
    return { term, show, wheel, detach: () => detach(), reinstall: () => { detach(); detach = install(); } };
  }

  beforeEach(() => __resetWheelHintedPanesForTests());
  afterEach(() => { document.body.innerHTML = ''; });

  it('says why once per pane, when a wheel in a tracking alternate-screen app clears the selection', () => {
    const s = setup();
    s.wheel();
    expect(s.show).toHaveBeenCalledTimes(1);
    s.term.selection = true;
    s.wheel();
    // A re-mount or adoption of the same pane stays quiet too.
    s.reinstall();
    s.term.selection = true;
    s.wheel();
    expect(s.show).toHaveBeenCalledTimes(1);
  });

  it('stays quiet without a selection, off the alternate screen, without tracking, or for Claude Code', () => {
    const none = setup();
    none.term.selection = false;
    none.wheel();
    expect(none.show).not.toHaveBeenCalled();
    for (const opts of [{ buffer: 'normal' }, { tracking: 'none' }, { exempt: true }]) {
      const s = setup(opts);
      s.wheel();
      expect(s.show).not.toHaveBeenCalled();
    }
  });

  it('counts only a clear made by the wheel itself, and nothing after teardown', () => {
    const ignored = setup();
    ignored.term.ignores = true;
    ignored.wheel();
    // A clear from something else, after the wheel's dispatch, is not the wheel's.
    ignored.term.clearSelection();
    expect(ignored.show).not.toHaveBeenCalled();
    const gone = setup();
    gone.detach();
    gone.wheel();
    expect(gone.show).not.toHaveBeenCalled();
  });
});
