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

  it('stops polling while the window is hidden, and resumes when shown', async () => {
    const hidden = { value: false };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden.value });
    try {
      act(() => root.render(createElement(PrSection, { repoPath: '/r', defaultOpen: true })));
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

  it('lazy (another repo): reads nothing until opened, then once, and never polls', async () => {
    act(() => root.render(createElement(PrSection, { repoPath: '/r', lazy: true, poll: false })));
    await tick(0);
    expect(prList).not.toHaveBeenCalled();
    act(() => (container.querySelector('[data-pr-toggle]') as HTMLButtonElement).click());
    await tick(0);
    expect(prList).toHaveBeenCalledTimes(1);
    await tick(95_000);
    expect(prList).toHaveBeenCalledTimes(1);
  });

  it('a list answer arriving after the page is left lands nowhere and fetches no comments', async () => {
    const pr = (updatedAt: string) => ({ number: 1, title: 't', state: 'open', author: 'a', headRefName: 'h', updatedAt, url: 'u', reviewDecision: '', checks: null, mergeable: '' });
    let pending: ((v: unknown) => void) | null = null;
    let first = true;
    const prList = vi.fn(() => {
      if (first) { first = false; return Promise.resolve({ ok: true, prs: [pr('x')] }); }
      return new Promise((r) => { pending = r; });
    });
    const prDetail = vi.fn(async () => ({ ok: true, detail: { number: 1, comments: [] } }));
    (window as unknown as { electronAPI: { github: unknown } }).electronAPI.github = { prList, prDetail };
    act(() => root.render(createElement(PrSection, { repoPath: '/r', defaultOpen: true, poll: false, refreshKey: 0 })));
    await tick(0);
    // Expand the PR: one comment fetch.
    act(() => (container.querySelector('[data-pr-row] button') as HTMLButtonElement).click());
    await tick(0);
    expect(prDetail).toHaveBeenCalledTimes(1);
    // A refresh starts a list read; the page is left before it answers.
    act(() => root.render(createElement(PrSection, { repoPath: '/r', defaultOpen: true, poll: false, refreshKey: 1 })));
    await tick(0);
    expect(pending).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    // The late answer says the PR changed — it would refetch comments if it landed.
    await act(async () => { pending!({ ok: true, prs: [pr('y')] }); });
    await tick(0);
    expect(prDetail).toHaveBeenCalledTimes(1);
  });

  it('comment answers arriving B then A leave the comments of B under B', async () => {
    const pr = (n: number) => ({ number: n, title: `t${n}`, state: 'open', author: 'a', headRefName: 'h', updatedAt: 'u', url: `u${n}`, reviewDecision: '', checks: null, mergeable: '' });
    const prList = vi.fn(async () => ({ ok: true, prs: [pr(1), pr(2)] }));
    const pending = new Map<number, (v: unknown) => void>();
    const prDetail = vi.fn((_r: string, n: number) => new Promise((res) => { pending.set(n, res); }));
    (window as unknown as { electronAPI: { github: unknown } }).electronAPI.github = { prList, prDetail };
    act(() => root.render(createElement(PrSection, { repoPath: '/r', defaultOpen: true, poll: false })));
    await tick(0);
    const rows = container.querySelectorAll('[data-pr-row] > button');
    act(() => (rows[0] as HTMLButtonElement).click());
    act(() => (rows[1] as HTMLButtonElement).click());
    const answer = (n: number) => ({ ok: true, detail: { number: n, comments: [{ author: 'x', body: `comment on ${n}`, createdAt: '', url: 'c', kind: 'comment', reviewState: '', truncated: false }] } });
    await act(async () => { pending.get(2)!(answer(2)); });
    await act(async () => { pending.get(1)!(answer(1)); });
    await tick(0);
    const shown = container.querySelectorAll('[data-pr-comments]');
    expect(shown).toHaveLength(1);
    expect(shown[0].closest('[data-pr-row]')).toBe(container.querySelectorAll('[data-pr-row]')[1]);
    expect(shown[0].textContent).toContain('comment on 2');
    expect(container.textContent).not.toContain('comment on 1');
  });
});
