// @vitest-environment jsdom
//
// Review and squash merge on the PR detail pane: both tied to the head shown,
// merge disabled with its reason, a moved PR keeps the text, and drafts
// written for an older head say so and keep their text.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GitDetail } from '../GitDetail';
import { useStore } from '../../../stores';
import type { PrSummary } from '../../../../shared/prSurface';
import type { PrChecksState, PrCheck, PrReviewHead } from '../../../../shared/prReview';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const prOf = (n: number): PrSummary => ({
  number: n, title: 'Add widgets', state: 'open', author: 'a', headRefName: 'feat/w', updatedAt: 'u',
  url: `https://github.com/o/r/pull/${n}`, reviewDecision: '', checks: null, mergeable: '',
});
const headOf = (n: number, oid: string, over: Partial<PrReviewHead> = {}): PrReviewHead => ({
  number: n, title: 'Add widgets', url: `https://github.com/o/r/pull/${n}`, state: 'OPEN', isDraft: false, headRefOid: oid,
  headRefName: 'feat/w', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ...over,
});
const answer = (head: PrReviewHead, checks: PrCheck[] = []): { ok: true; value: PrChecksState } => ({ ok: true, value: { head, checks } });

let container: HTMLDivElement;
let root: Root;
let gh: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  gh = {
    prList: vi.fn(), prDetail: vi.fn(async () => ({ ok: true, detail: { number: 1, comments: [] } })),
    prChecks: vi.fn(async (_r: string, n: number) => answer(headOf(n, A))),
    prFiles: vi.fn(async () => ({ ok: true, value: { headRefOid: A, files: [], truncated: false } })),
    prThreads: vi.fn(async () => ({ ok: true, value: { threads: [], truncated: false } })),
    prSubmitReview: vi.fn(async () => ({ ok: true })),
    prMerge: vi.fn(async () => ({ ok: true })),
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
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const render = (n: number) => act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '/r', repoLabel: 'r', pr: prOf(n) })));
const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T | null;
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('squash merge', () => {
  it('is disabled with the reason when the PR conflicts', async () => {
    gh.prChecks.mockImplementation(async (_r: string, n: number) => answer(headOf(n, A, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })));
    render(1);
    await flush();
    expect(q<HTMLButtonElement>('[data-pr-squash]')!.disabled).toBe(true);
    expect(q('[data-pr-merge-block="conflicts"]')?.textContent).toBe('Conflicts with the base branch');
  });

  it('is disabled with the reason when a check fails', async () => {
    gh.prChecks.mockImplementation(async (_r: string, n: number) => answer(headOf(n, A), [{ name: 'test', workflow: 'CI', bucket: 'fail', link: '' }]));
    render(2);
    await flush();
    expect(q<HTMLButtonElement>('[data-pr-squash]')!.disabled).toBe(true);
    expect(q('[data-pr-merge-block="checks-failing"]')?.textContent).toBe('Checks are failing');
  });

  it('opens an editor with "<title> (#n)" and an empty body, and merges at the head shown', async () => {
    render(3);
    await flush();
    expect(q('[data-pr-head] code')?.textContent).toBe(A.slice(0, 7));
    act(() => q<HTMLButtonElement>('[data-pr-squash]')!.click());
    expect(q<HTMLInputElement>('[data-pr-merge-subject]')!.value).toBe('Add widgets (#3)');
    expect(q<HTMLTextAreaElement>('[data-pr-merge-body]')!.value).toBe('');
    act(() => q<HTMLButtonElement>('[data-pr-merge-submit]')!.click());
    await flush();
    expect(gh.prMerge).toHaveBeenCalledWith('/r', 3, { expectHead: A, subject: 'Add widgets (#3)', body: '' });
    expect(q('[data-pr-note]')?.textContent).toBe('Merged');
  });

  it('a moved PR warns, keeps the edited text and reads the head again', async () => {
    gh.prMerge.mockResolvedValue({ ok: false, code: 'moved', message: 'moved', headRefOid: B });
    render(4);
    await flush();
    act(() => q<HTMLButtonElement>('[data-pr-squash]')!.click());
    type(q<HTMLInputElement>('[data-pr-merge-subject]')!, 'Widgets, finally');
    type(q<HTMLTextAreaElement>('[data-pr-merge-body]')!, 'Details');
    const reads = gh.prChecks.mock.calls.length;
    act(() => q<HTMLButtonElement>('[data-pr-merge-submit]')!.click());
    await flush();
    expect(q('[data-pr-note]')?.textContent).toBe('The PR changed since you loaded it');
    expect(q<HTMLInputElement>('[data-pr-merge-subject]')!.value).toBe('Widgets, finally');
    expect(q<HTMLTextAreaElement>('[data-pr-merge-body]')!.value).toBe('Details');
    expect(gh.prChecks.mock.calls.length).toBeGreaterThan(reads);
    expect(gh.prChecks).toHaveBeenLastCalledWith('/r', 4, true);
  });
});

describe('review', () => {
  it('Approve sends APPROVE tied to the head shown', async () => {
    render(5);
    await flush();
    act(() => q<HTMLButtonElement>('[data-pr-review-event="APPROVE"]')!.click());
    await flush();
    expect(gh.prSubmitReview).toHaveBeenCalledWith('/r', 5, { expectHead: A, event: 'APPROVE', body: '' });
    expect(q('[data-pr-note]')?.textContent).toBe('Review sent');
  });

  it('Request changes needs a body', async () => {
    render(6);
    await flush();
    const btn = q<HTMLButtonElement>('[data-pr-review-event="REQUEST_CHANGES"]')!;
    expect(btn.disabled).toBe(true);
    act(() => btn.click());
    expect(gh.prSubmitReview).not.toHaveBeenCalled();
    type(q<HTMLTextAreaElement>('[data-pr-review-body]')!, 'Please split this');
    expect(btn.disabled).toBe(false);
    act(() => btn.click());
    await flush();
    expect(gh.prSubmitReview).toHaveBeenCalledWith('/r', 6, { expectHead: A, event: 'REQUEST_CHANGES', body: 'Please split this' });
  });

  it('a moved review keeps the text', async () => {
    gh.prSubmitReview.mockResolvedValue({ ok: false, code: 'moved', message: 'moved' });
    render(7);
    await flush();
    type(q<HTMLTextAreaElement>('[data-pr-review-body]')!, 'Looks good');
    act(() => q<HTMLButtonElement>('[data-pr-review-event="COMMENT"]')!.click());
    await flush();
    expect(q('[data-pr-note]')?.textContent).toBe('The PR changed since you loaded it');
    expect(q<HTMLTextAreaElement>('[data-pr-review-body]')!.value).toBe('Looks good');
  });
});

describe('drafts', () => {
  it('a draft written at head A warns at head B, keeps its text and is sent against B', async () => {
    render(8);
    await flush();
    type(q<HTMLTextAreaElement>('[data-pr-review-body]')!, 'Half-written thought');
    expect(q('[data-pr-draft-old]')).toBeNull();
    // Leave the page, and come back after the PR moved.
    act(() => root.render(createElement('div')));
    gh.prChecks.mockImplementation(async (_r: string, n: number) => answer(headOf(n, B)));
    render(8);
    await flush();
    expect(q<HTMLTextAreaElement>('[data-pr-review-body]')!.value).toBe('Half-written thought');
    expect(q('[data-pr-draft-old]')?.textContent).toBe('This draft was written for an older version of the PR (aaaaaaa)');
    act(() => q<HTMLButtonElement>('[data-pr-review-event="COMMENT"]')!.click());
    await flush();
    expect(gh.prSubmitReview).toHaveBeenCalledWith('/r', 8, { expectHead: B, event: 'COMMENT', body: 'Half-written thought' });
  });
});
