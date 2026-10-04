// @vitest-environment jsdom
//
// The PR list reads once for a new repo; it polls only while it is shown and
// the Git page is the one on screen; a failed read keeps the last list and
// says so with a Retry; rows say what each PR needs next and select it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { PrSection } from '../PrSection';

let container: HTMLDivElement;
let root: Root;
const pr = (n: number, over: Record<string, unknown> = {}) => ({
  number: n, title: `t${n}`, state: 'open', author: 'a', headRefName: 'h', updatedAt: '2026-10-01T00:00:00Z', url: `u${n}`,
  reviewDecision: '', checks: null, mergeable: '', ...over,
});
let prList: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  prList = vi.fn(async () => ({ ok: true as const, prs: [] as unknown[] }));
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

describe('PrSection list', () => {
  it('not shown, it reads once and does not poll', async () => {
    act(() => root.render(createElement(PrSection, { repoPath: '/r', shown: false })));
    await tick(0);
    expect(prList).toHaveBeenCalledTimes(1);
    await tick(95_000);
    expect(prList).toHaveBeenCalledTimes(1);
  });

  it('shown on the Git page it polls, and stops on another page', async () => {
    act(() => root.render(createElement(PrSection, { repoPath: '/r' })));
    await tick(0);
    const first = prList.mock.calls.length;
    await tick(30_000);
    expect(prList.mock.calls.length).toBe(first + 1);
    act(() => useStore.setState({ appRoute: 'fleet' }));
    const off = prList.mock.calls.length;
    await tick(95_000);
    expect(prList.mock.calls.length).toBe(off);
  });

  it('stops polling while the window is hidden, and resumes when shown', async () => {
    const hidden = { value: false };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden.value });
    try {
      act(() => root.render(createElement(PrSection, { repoPath: '/r' })));
      await tick(0);
      const shown = prList.mock.calls.length;
      hidden.value = true;
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await tick(95_000);
      expect(prList.mock.calls.length).toBe(shown);
      hidden.value = false;
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await tick(0);
      expect(prList.mock.calls.length).toBeGreaterThan(shown);
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });

  it('lazy (another repo): reads nothing until shown, then once, and never polls', async () => {
    act(() => root.render(createElement(PrSection, { repoPath: '/r', lazy: true, poll: false, shown: false })));
    await tick(0);
    expect(prList).not.toHaveBeenCalled();
    act(() => root.render(createElement(PrSection, { repoPath: '/r', lazy: true, poll: false, shown: true })));
    await tick(0);
    expect(prList).toHaveBeenCalledTimes(1);
    await tick(95_000);
    expect(prList).toHaveBeenCalledTimes(1);
  });

  it('a failed read keeps the last list, says so, and Retry reads past the cache', async () => {
    prList.mockResolvedValueOnce({ ok: true, prs: [pr(1)] });
    act(() => root.render(createElement(PrSection, { repoPath: '/r', poll: false })));
    await tick(0);
    expect(container.querySelector('[data-git-list-fresh]')?.textContent).toBe('Updated just now');
    prList.mockResolvedValueOnce({ ok: false, code: 'error', message: 'HTTP 502' });
    act(() => root.render(createElement(PrSection, { repoPath: '/r', poll: false, refreshKey: 1 })));
    await tick(0);
    expect(container.querySelectorAll('[data-pr-row]')).toHaveLength(1);
    expect(container.querySelector('[data-git-list-stale]')?.textContent).toContain('Could not refresh');
    prList.mockClear();
    prList.mockResolvedValueOnce({ ok: true, prs: [pr(1), pr(2)] });
    act(() => (container.querySelector('[data-git-list-retry]') as HTMLButtonElement).click());
    await tick(0);
    expect(prList).toHaveBeenCalledWith('/r', true);
    expect(container.querySelectorAll('[data-pr-row]')).toHaveLength(2);
    expect(container.querySelector('[data-git-list-stale]')).toBeNull();
  });

  it('rows say what each PR needs next, and a click selects it', async () => {
    prList.mockResolvedValueOnce({ ok: true, prs: [pr(1, { checks: 'failing' }), pr(2, { reviewDecision: 'REVIEW_REQUIRED' })] });
    const onSelect = vi.fn();
    act(() => root.render(createElement(PrSection, { repoPath: '/r', poll: false, selected: 2, onSelect })));
    await tick(0);
    const step = (n: number) => container.querySelector(`[data-pr-row="${n}"] [data-pr-step]`)!;
    expect(step(1).textContent).toBe('CI failing');
    expect(step(1).getAttribute('data-problem')).toBe('true');
    expect(step(2).textContent).toBe('Review requested');
    expect(step(2).getAttribute('data-problem')).toBeNull();
    expect(container.querySelector('[data-pr-row="2"] button')?.getAttribute('aria-current')).toBe('true');
    act(() => (container.querySelector('[data-pr-row="1"] button') as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ number: 1 }));
  });

  it('an answer arriving after unmount lands nowhere', async () => {
    let pending: ((v: unknown) => void) | null = null;
    prList.mockImplementationOnce(() => new Promise((r) => { pending = r; }));
    const onItems = vi.fn();
    act(() => root.render(createElement(PrSection, { repoPath: '/r', poll: false, onItems })));
    await tick(0);
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => { pending!({ ok: true, prs: [pr(1)] }); });
    await tick(0);
    expect(onItems).not.toHaveBeenCalled();
  });
});
