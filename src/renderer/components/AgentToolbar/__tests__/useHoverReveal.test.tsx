// @vitest-environment jsdom
//
// The reveal rules exist to keep the bar off the terminal's prompt line. Each
// test here is one of the failure modes that made "just show it on hover"
// unacceptable: a pointer passing through, a drag-select of the last output
// row, and typing while the pointer happens to rest low.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useHoverReveal,
  HOVER_REVEAL_DELAY_MS,
  HOVER_HIDE_DELAY_MS,
  HOVER_TRIGGER_ZONE_PX,
} from '../useHoverReveal';

let container: HTMLDivElement;
let root: Root;
let revealed = false;

/** Host rect: a 800×600 column whose bottom edge owns the trigger band. */
const HOST_RECT = {
  top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0,
  toJSON: () => ({}),
} as DOMRect;

/** Mirrors ToolbarHost: the 36px bar plus its 8px margin. */
const KEEP_ALIVE_PX = 44;

let focusReveal: (() => void) | null = null;

function Probe({ pinned = false, hold = false }: { pinned?: boolean; hold?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const r = useHoverReveal({ pinned, hold, hostRef, keepAlivePx: KEEP_ALIVE_PX });
  focusReveal = r.revealForFocus;
  revealed = r.revealed;
  return createElement('div', {
    ref: (el: HTMLDivElement | null) => {
      if (el) el.getBoundingClientRect = () => HOST_RECT;
      hostRef.current = el;
    },
  });
}

/** `buttons` matters: a real drag-move reports a held button, and the hook
 *  treats a move with none as proof the press ended (jsdom has no
 *  PointerEvent, so MouseEvent carries the same fields the hook reads). */
function movePointerTo(clientX: number, clientY: number, buttons = 0): void {
  act(() => {
    document.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY, buttons, bubbles: true }));
  });
}

function advance(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  revealed = false;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function mount(props: { pinned?: boolean; hold?: boolean } = {}): void {
  act(() => root.render(createElement(Probe, props)));
}

describe('useHoverReveal', () => {
  it('reveals after the dwell delay when the pointer rests in the bottom band', () => {
    mount();
    movePointerTo(400, 600 - HOVER_TRIGGER_ZONE_PX + 1);
    expect(revealed).toBe(false);
    advance(HOVER_REVEAL_DELAY_MS + 1);
    expect(revealed).toBe(true);
  });

  it('does not reveal for a pointer that only crosses the band', () => {
    mount();
    movePointerTo(400, 598);
    advance(HOVER_REVEAL_DELAY_MS - 50);
    movePointerTo(400, 200);          // left again before the dwell elapsed
    advance(HOVER_REVEAL_DELAY_MS + 1);
    expect(revealed).toBe(false);
  });

  it('stays hidden while a pointer button is held (drag-select of the last row)', () => {
    mount();
    act(() => { document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    movePointerTo(400, 598, 1);   // button still held
    advance(HOVER_REVEAL_DELAY_MS + 1);
    expect(revealed).toBe(false);
  });

  it('retreats on a keystroke so it never covers the prompt line', () => {
    mount();
    movePointerTo(400, 598);
    advance(HOVER_REVEAL_DELAY_MS + 1);
    expect(revealed).toBe(true);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); });
    expect(revealed).toBe(false);
  });

  it('ignores bare modifier presses — ⌘/Ctrl chords must not make it flinch', () => {
    mount();
    movePointerTo(400, 598);
    advance(HOVER_REVEAL_DELAY_MS + 1);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', bubbles: true })); });
    expect(revealed).toBe(true);
  });

  it('stays up while the pointer moves onto the revealed bar', () => {
    // The reported failure: the bar armed on the 8px band, then the pointer
    // rose onto a button ~20px up, left that band, and the bar hid itself out
    // from under the cursor. The keep-alive band covers the bar's height.
    mount();
    movePointerTo(400, 598);
    advance(HOVER_REVEAL_DELAY_MS + 1);
    expect(revealed).toBe(true);
    movePointerTo(400, 600 - KEEP_ALIVE_PX + 4);   // a button mid-bar
    advance(HOVER_HIDE_DELAY_MS + 1);
    expect(revealed).toBe(true);
  });

  it('hides after the grace period once the pointer clears the keep-alive band', () => {
    mount();
    movePointerTo(400, 598);
    advance(HOVER_REVEAL_DELAY_MS + 1);
    movePointerTo(400, 100);
    advance(HOVER_HIDE_DELAY_MS + 1);
    expect(revealed).toBe(false);
  });

  it('still needs the thin band to arm — the wide band only keeps it up', () => {
    mount();
    movePointerTo(400, 600 - KEEP_ALIVE_PX + 4);   // inside keep-alive, not arming
    advance(HOVER_REVEAL_DELAY_MS + 1);
    expect(revealed).toBe(false);
  });

  it('stays revealed while pinned, whatever the pointer does', () => {
    mount({ pinned: true });
    expect(revealed).toBe(true);
    movePointerTo(400, 100);
    advance(HOVER_HIDE_DELAY_MS + 1);
    expect(revealed).toBe(true);
  });

  it('stays revealed while a popover holds it open', () => {
    mount({ hold: true });
    movePointerTo(400, 100);
    advance(HOVER_HIDE_DELAY_MS + 1);
    expect(revealed).toBe(true);
  });

  // Panel review (3 models): a pointerup that never arrives used to leave the
  // drag guard latched, and onMove returns early while it is — the bar could
  // never appear again for the rest of the session.
  it('recovers from a press whose pointerup never arrives', () => {
    mount();
    act(() => { document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    // No pointerup — the release happened outside the window. A later move
    // with no button held proves the drag is over.
    movePointerTo(400, 598, 0);
    advance(HOVER_REVEAL_DELAY_MS + 1);
    expect(revealed).toBe(true);
  });

  it('recovers from a cancelled press (touch gesture, context menu)', () => {
    mount();
    act(() => { document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    act(() => { document.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true })); });
    movePointerTo(400, 598);
    advance(HOVER_REVEAL_DELAY_MS + 1);
    expect(revealed).toBe(true);
  });

  it('recovers when the window loses focus mid-press', () => {
    mount();
    act(() => { document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    act(() => { window.dispatchEvent(new Event('blur')); });
    movePointerTo(400, 598);
    advance(HOVER_REVEAL_DELAY_MS + 1);
    expect(revealed).toBe(true);
  });

  it('does not retreat when the keystroke lands inside the bar', () => {
    // Typing into Rich Input must not hide the bar you are typing into.
    mount();
    movePointerTo(400, 598);
    advance(HOVER_REVEAL_DELAY_MS + 1);
    const inBar = document.createElement('div');
    inBar.setAttribute('data-testid', 'agent-toolbar');
    const field = document.createElement('textarea');
    inBar.appendChild(field);
    document.body.appendChild(inBar);
    act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); });
    expect(revealed).toBe(true);
    inBar.remove();
  });

  it('reveals when focus arrives — the keyboard route in', () => {
    mount();
    expect(revealed).toBe(false);
    act(() => { focusReveal?.(); });
    expect(revealed).toBe(true);
  });
});
