// @vitest-environment jsdom
//
// The PR row reads once for its count; it polls only while it is open and the
// Git page is the one on screen.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { PrSection } from '../PrSection';

let container: HTMLDivElement;
let root: Root;
const prList = vi.fn(async () => ({ ok: true as const, prs: [] }));

beforeEach(() => {
  vi.useFakeTimers();
  prList.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { github: { prList, prDetail: vi.fn() } };
  act(() => useStore.setState({ appRoute: 'git' }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('PrSection polling', () => {
  it('folded, it reads once and does not poll', async () => {
    act(() => root.render(createElement(PrSection, { repoPath: '/r' })));
    await tick(0);
    expect(prList).toHaveBeenCalledTimes(1);
    await tick(95_000);
    expect(prList).toHaveBeenCalledTimes(1);
  });

  it('open on the Git page it polls, and stops on another page', async () => {
    act(() => root.render(createElement(PrSection, { repoPath: '/r' })));
    await tick(0);
    act(() => (container.querySelector('[data-pr-toggle]') as HTMLButtonElement).click());
    await tick(0);
    const afterOpen = prList.mock.calls.length;
    await tick(30_000);
    expect(prList.mock.calls.length).toBe(afterOpen + 1);

    act(() => useStore.setState({ appRoute: 'fleet' }));
    const behindPage = prList.mock.calls.length;
    await tick(95_000);
    expect(prList.mock.calls.length).toBe(behindPage);
  });
});
