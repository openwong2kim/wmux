// @vitest-environment jsdom
//
// The PR detail is pinned to the head it first showed: a poll that brings a
// newer head turns every write off behind a Reload line, a click racing that
// poll is refused before it reaches the bridge, Reload re-pins and reads again,
// and a closed or merged PR takes no writes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GitDetail } from '../GitDetail';
import { useStore } from '../../../stores';
import { LIST_POLL_MS } from '../useGitList';
import type { PrSummary } from '../../../../shared/prSurface';
import type { PrReviewHead, PrReviewThread } from '../../../../shared/prReview';
import type { DiffFile } from '../../../../shared/diffParse';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const prOf = (n: number): PrSummary => ({
  number: n, title: 'Add widgets', state: 'open', author: 'a', headRefName: 'feat/w', updatedAt: 'u',
  url: `https://github.com/o/r/pull/${n}`, reviewDecision: '', checks: null, mergeable: '',
});
const headOf = (n: number, oid: string, over: Partial<PrReviewHead> = {}): PrReviewHead => ({
  number: n, title: 'Add widgets', url: prOf(n).url, state: 'OPEN', isDraft: false, headRefOid: oid,
  headRefName: 'feat/w', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ...over,
});
const file: DiffFile = {
  path: 'src/a.ts', oldPath: 'src/a.ts', newPath: 'src/a.ts', kind: 'modify', hunkSelectable: true, headerBlock: '',
  hunks: [{ header: '@@ -1,2 +1,2 @@', oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, section: '', bodyLines: [' one', '-two', '+TWO'] }],
};
const thread: PrReviewThread = {
  id: 't1', path: 'src/a.ts', subject: 'line', line: 2, side: 'RIGHT', isResolved: false, isOutdated: false,
  comments: [{ id: 101, author: 'rev', body: 'why?', createdAt: '' }],
};

let container: HTMLDivElement;
let root: Root;
let gh: Record<string, ReturnType<typeof vi.fn>>;
let headNow: PrReviewHead['headRefOid'];
let headOver: Partial<PrReviewHead>;

beforeEach(() => {
  headNow = A;
  headOver = {};
  gh = {
    prList: vi.fn(), prDetail: vi.fn(async () => ({ ok: true, detail: { number: 1, comments: [] } })),
    prChecks: vi.fn(async (_r: string, url: string) => ({ ok: true, value: { head: headOf(Number(url.split('/').pop()), headNow, headOver), checks: [] } })),
    prFiles: vi.fn(async (_r: string, _u: string, head: string) => ({ ok: true, value: { headRefOid: head, files: [file], truncated: false } })),
    prThreads: vi.fn(async (_r: string, _u: string, head: string) => ({ ok: true, value: { headRefOid: head, threads: [thread], truncated: false } })),
    prSubmitReview: vi.fn(async () => ({ ok: true })),
    prMerge: vi.fn(async () => ({ ok: true })),
    prComment: vi.fn(async () => ({ ok: true })),
    prReply: vi.fn(async () => ({ ok: true })),
    prRunLog: vi.fn(), prRerunFailed: vi.fn(),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { github: gh };
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

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T | null;
const btn = (sel: string) => q<HTMLButtonElement>(sel)!;
const type = (el: HTMLTextAreaElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const show = async (n: number) => {
  act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '/r', repoLabel: 'r', pr: prOf(n) })));
  await flush();
  act(() => btn('[data-pr-file="src/a.ts"] > button').click());
};
const poll = async () => {
  await act(async () => { vi.advanceTimersByTime(LIST_POLL_MS); });
  await flush();
};

describe('PR head pinning', () => {
  it('a poll with a new head shows Reload and turns every write off', async () => {
    vi.useFakeTimers();
    await show(1);
    act(() => btn('[data-line-comment="RIGHT:2"]').click());
    type(q('[data-line-composer-body]') as HTMLTextAreaElement, 'Hmm');
    type(q('[data-pr-review-body]') as HTMLTextAreaElement, 'Looks fine');
    type(q('[data-thread-reply-body]') as HTMLTextAreaElement, 'Sure');
    expect(q('[data-pr-moved]')).toBeNull();
    headNow = B;
    await poll();
    expect(q('[data-pr-moved]')?.textContent).toContain('New commits were pushed');
    expect(q('[data-pr-head] code')?.textContent).toBe(A.slice(0, 7));
    for (const ev of ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']) expect(btn(`[data-pr-review-event="${ev}"]`).disabled).toBe(true);
    expect(btn('[data-pr-squash]').disabled).toBe(true);
    expect(btn('[data-line-composer-send]').disabled).toBe(true);
    expect(btn('[data-thread-reply]').disabled).toBe(true);
    expect(q('[data-line-comment]')).toBeNull();
    // The text is kept.
    expect(q<HTMLTextAreaElement>('[data-pr-review-body]')!.value).toBe('Looks fine');
  });

  it('a click racing the new head is refused before it reaches the bridge', async () => {
    await show(2);
    act(() => useStore.setState({ appRoute: 'fleet' }));
    let answer: ((v: unknown) => void) | undefined;
    gh.prChecks.mockImplementationOnce(() => new Promise((res) => { answer = res; }));
    // Back on the Git page: a checks read starts.
    act(() => useStore.setState({ appRoute: 'git' }));
    expect(answer).toBeDefined();
    const approve = btn('[data-pr-review-event="APPROVE"]');
    // The PR moved: the answer arrives, and before it is drawn the person clicks.
    headNow = B;
    await act(async () => {
      answer!({ ok: true, value: { head: headOf(2, B), checks: [] } });
      for (let i = 0; i < 4; i++) await Promise.resolve();
      approve.click();
    });
    await flush();
    expect(gh.prSubmitReview).not.toHaveBeenCalled();
    expect(q('[data-pr-note]')?.textContent).toBe('The PR changed since you loaded it');
    expect(q('[data-pr-moved]')).not.toBeNull();
  });

  it('Reload re-pins to the new head and reads files, threads and checks again', async () => {
    vi.useFakeTimers();
    await show(3);
    headNow = B;
    await poll();
    const checks = gh.prChecks.mock.calls.length;
    act(() => btn('[data-pr-reload]').click());
    await flush();
    expect(q('[data-pr-moved]')).toBeNull();
    expect(q('[data-pr-head] code')?.textContent).toBe(B.slice(0, 7));
    expect(gh.prChecks.mock.calls.length).toBeGreaterThan(checks);
    expect(gh.prChecks).toHaveBeenLastCalledWith('/r', prOf(3).url, true);
    expect(gh.prFiles).toHaveBeenLastCalledWith('/r', prOf(3).url, B);
    expect(gh.prThreads).toHaveBeenLastCalledWith('/r', prOf(3).url, B, true);
    act(() => btn('[data-pr-review-event="APPROVE"]').click());
    await flush();
    expect(gh.prSubmitReview).toHaveBeenCalledWith('/r', prOf(3).url, { expectHead: B, event: 'APPROVE', body: '' });
  });
});

describe('closed PRs', () => {
  it('a merged PR says so and takes no review or line comment', async () => {
    headOver = { state: 'MERGED' };
    await show(5);
    expect(q('[data-pr-closed]')?.textContent).toBe('This pull request is merged');
    for (const ev of ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']) expect(btn(`[data-pr-review-event="${ev}"]`).disabled).toBe(true);
    expect(q('[data-line-comment]')).toBeNull();
    expect(q('[data-pr-merge-block]')).toBeNull();
  });

  it('a write refused as not open says the PR is closed or merged', async () => {
    gh.prSubmitReview.mockResolvedValue({ ok: false, code: 'blocked', reason: 'not-open', message: 'closed' });
    await show(6);
    act(() => btn('[data-pr-review-event="APPROVE"]').click());
    await flush();
    expect(q('[data-pr-note]')?.textContent).toBe('This pull request is closed or merged');
  });
});

describe('drafts per field', () => {
  it('each field warns for the head it was written at', async () => {
    await show(7);
    type(q('[data-pr-review-body]') as HTMLTextAreaElement, 'Half a thought');
    act(() => root.render(createElement('div')));
    headNow = B;
    await show(7);
    act(() => btn('[data-pr-squash]').click());
    const warnings = [...container.querySelectorAll('[data-pr-draft-old]')];
    expect(warnings).toHaveLength(1);
    expect(warnings[0].closest('[data-pr-merge-editor]')).toBeNull();
    expect(warnings[0].textContent).toContain('aaaaaaa');
    expect(q<HTMLTextAreaElement>('[data-pr-review-body]')!.value).toBe('Half a thought');
  });
});
