// @vitest-environment jsdom
//
// The scroll-to-bottom button re-checks the viewport on every write, scroll
// and resize. React queues every state set on the hook until the component's
// next render, a same-value set included, and terminal output never
// re-renders this component: each set it made while following output stayed
// queued for the pane's lifetime (about 0.3 MiB per minute per visible pane
// at 2 KB/s in a heap snapshot). Only a change of the value may reach React.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Terminal } from '@xterm/xterm';

// Counts the sets the component hands to React: a wrapper around the real
// useState, so state and rendering stay React's own.
const sets = vi.hoisted(() => ({ count: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useState = ((init: unknown) => {
    const [value, set] = actual.useState(init);
    return [value, (next: unknown) => { sets.count++; set(next); }];
  }) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: string) => key }));

import ScrollToBottomButton from '../ScrollToBottomButton';

type Listener = () => void;
function fakeTerminal() {
  const listeners = { scroll: new Set<Listener>(), writeParsed: new Set<Listener>(), resize: new Set<Listener>() };
  const on = (set: Set<Listener>) => (fn: Listener) => { set.add(fn); return { dispose: () => set.delete(fn) }; };
  const active = { baseY: 0, viewportY: 0 };
  const term = {
    buffer: { active },
    onScroll: on(listeners.scroll),
    onWriteParsed: on(listeners.writeParsed),
    onResize: on(listeners.resize),
    scrollToBottom: () => { active.viewportY = active.baseY; listeners.scroll.forEach((f) => f()); },
  };
  return {
    term: term as unknown as Terminal,
    /** Output that keeps the viewport following the bottom: baseY grows, viewportY with it. */
    write(lines: number) {
      for (let i = 0; i < lines; i++) {
        active.baseY++;
        if (active.viewportY === active.baseY - 1) active.viewportY = active.baseY;
        listeners.scroll.forEach((f) => f());
      }
      listeners.writeParsed.forEach((f) => f());
    },
    scrollTo(y: number) { active.viewportY = y; listeners.scroll.forEach((f) => f()); },
  };
}

describe('ScrollToBottomButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sets.count = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const button = () => container.querySelector('button');

  it('hands React no state set while output keeps the viewport at the bottom', () => {
    const t = fakeTerminal();
    act(() => root.render(<ScrollToBottomButton terminal={t.term} />));
    act(() => { for (let i = 0; i < 200; i++) t.write(5); });
    expect(sets.count).toBe(0);
    expect(button()).toBeNull();
  });

  it('still appears when scrolled up and goes away at the bottom, once per change', () => {
    const t = fakeTerminal();
    act(() => root.render(<ScrollToBottomButton terminal={t.term} />));
    act(() => t.write(50));
    act(() => t.scrollTo(10));
    expect(button()).not.toBeNull();
    // More output while scrolled up: still up, no further set.
    act(() => t.write(20));
    expect(button()).not.toBeNull();
    act(() => button()!.click());
    expect(button()).toBeNull();
    act(() => t.scrollTo(3));
    expect(button()).not.toBeNull();
    expect(sets.count).toBe(3);
  });
});
