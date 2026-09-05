// @vitest-environment jsdom
//
// The shared `#` channel jump. What it has to get right is exactly what the
// bare glyph in the task rows got wrong: it has to be reachable (24px box),
// nameable (a tooltip a mouse finds AND a name a screen reader reads, carrying
// the task so a column of them is distinguishable), readable as a control
// (DESIGN.md's jump grammar — muted at rest, steel-blue on hover), and it must
// not take the row's own click with it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ChannelJumpGlyph from '../ChannelJumpGlyph';

let container: HTMLDivElement;
let root: Root;

/** Stand-in translator: echoes the key, interpolating like the real `t`. */
const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}:${Object.values(vars).join(',')}` : key;

const glyph = () => container.querySelector('[data-channel-jump]') as HTMLButtonElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelJumpGlyph', () => {
  it('carries a 24px hit box on a 6px glyph', () => {
    act(() => root.render(createElement(ChannelJumpGlyph, { onOpen: vi.fn(), t })));
    const cls = glyph().className;
    expect(cls).toContain('min-w-[24px]');
    expect(cls).toContain('min-h-[24px]');
    // The refund keeps a dense row's footprint — see hitArea.ts.
    expect(cls).toContain('-m-1.5');
  });

  it('reads as a jump: muted at rest, steel-blue on hover', () => {
    act(() => root.render(createElement(ChannelJumpGlyph, { onOpen: vi.fn(), t })));
    const cls = glyph().className;
    expect(cls).toContain('text-[var(--text-subtle)]');
    expect(cls).toContain('hover:text-[var(--accent-blue)]');
    // Navigation is steel, never warm — warm is reserved for "alive".
    expect(cls).not.toContain('--accent-cursor');
  });

  it('names itself with the task, and keeps the glyph out of the name', () => {
    act(() =>
      root.render(createElement(ChannelJumpGlyph, { onOpen: vi.fn(), name: 'ship the deck', t })),
    );
    expect(glyph().getAttribute('title')).toBe('missions.openChannel');
    expect(glyph().getAttribute('aria-label')).toBe('missions.openChannelFor:ship the deck');
    // The `#` is decoration; the name is the sentence.
    expect(glyph().querySelector('[aria-hidden="true"]')?.textContent).toBe('#');
  });

  it('falls back to the plain verb with no task name', () => {
    act(() => root.render(createElement(ChannelJumpGlyph, { onOpen: vi.fn(), t })));
    expect(glyph().getAttribute('aria-label')).toBe('missions.openChannel');
  });

  it('opens the channel without triggering the row underneath', () => {
    const onOpen = vi.fn();
    const onRowClick = vi.fn();
    act(() =>
      root.render(
        createElement(
          'div',
          { onClick: onRowClick },
          createElement(ChannelJumpGlyph, { onOpen, t }),
        ),
      ),
    );
    act(() => glyph().click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
