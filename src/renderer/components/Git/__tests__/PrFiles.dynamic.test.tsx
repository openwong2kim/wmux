// @vitest-environment jsdom
//
// A PR's files on the detail pane: hunks with old/new line numbers, review
// threads under their line (outdated ones under the file), replies to a
// thread's first comment, and a line comment from the gutter tied to the head.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GitDetail } from '../GitDetail';
import { useStore } from '../../../stores';
import type { PrSummary } from '../../../../shared/prSurface';
import type { PrReviewThread } from '../../../../shared/prReview';
import type { DiffFile } from '../../../../shared/diffParse';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const prOf = (n: number): PrSummary => ({
  number: n, title: 'Add widgets', state: 'open', author: 'a', headRefName: 'feat/w', updatedAt: 'u',
  url: `https://github.com/o/r/pull/${n}`, reviewDecision: '', checks: null, mergeable: '',
});
const file: DiffFile = {
  path: 'src/a.ts', oldPath: 'src/a.ts', newPath: 'src/a.ts', kind: 'modify', hunkSelectable: true, headerBlock: '',
  hunks: [{ header: '@@ -1,3 +1,4 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, section: '', bodyLines: [' one', '-two', '+TWO', '+three', ' four'] }],
};
const thread = (id: string, line: number | null, side: 'LEFT' | 'RIGHT', extra: Partial<PrReviewThread> = {}): PrReviewThread => ({
  id, path: 'src/a.ts', subject: 'line', line, side, isResolved: false, isOutdated: line === null,
  comments: [
    { id: Number(id.slice(1)) * 100 + 1, author: 'rev', body: `first on ${id} <img src=x onerror="window.__pwned=1">`, createdAt: '2026-10-01T00:00:00Z' },
    { id: Number(id.slice(1)) * 100 + 2, author: 'me', body: `second on ${id}`, createdAt: '2026-10-01T00:00:00Z' },
  ],
  ...extra,
});

let container: HTMLDivElement;
let root: Root;
let gh: Record<string, ReturnType<typeof vi.fn>>;
// The head GitHub reports now (checks and files follow it).
let headNow = A;
let files: DiffFile[] = [file];

beforeEach(() => {
  headNow = A;
  files = [file];
  gh = {
    prList: vi.fn(), prDetail: vi.fn(async () => ({ ok: true, detail: { number: 1, comments: [] } })),
    prChecks: vi.fn(async (_r: string, n: number) => ({ ok: true, value: { head: {
      number: n, title: 'Add widgets', url: '', state: 'OPEN', isDraft: false, headRefOid: headNow,
      headRefName: 'feat/w', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    }, checks: [] } })),
    prFiles: vi.fn(async (_r: string, _u: string, head: string) => ({ ok: true, value: { headRefOid: head, files, truncated: false } })),
    prThreads: vi.fn(async () => ({ ok: true, value: { threads: [
      thread('t1', 3, 'RIGHT'), thread('t2', null, 'RIGHT'), thread('t3', 2, 'LEFT', { isResolved: true }),
    ], truncated: false } })),
    prReply: vi.fn(async () => ({ ok: true })),
    prComment: vi.fn(async () => ({ ok: true })),
    prSubmitReview: vi.fn(), prMerge: vi.fn(), prRunLog: vi.fn(), prRerunFailed: vi.fn(),
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
  delete (window as unknown as { __pwned?: unknown }).__pwned;
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T | null;
const type = (el: HTMLTextAreaElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const show = async (n: number) => {
  act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '/r', repoLabel: 'r', pr: prOf(n) })));
  await flush();
};
const openFile = async (n: number) => {
  await show(n);
  act(() => q<HTMLButtonElement>('[data-pr-file="src/a.ts"] > button')!.click());
};

describe('PR files', () => {
  it('lists the file folded with its +/- counts, and draws numbered hunks when opened', async () => {
    act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '/r', repoLabel: 'r', pr: prOf(1) })));
    await flush();
    expect(gh.prFiles).toHaveBeenCalledWith('/r', prOf(1).url, A);
    const head = q('[data-pr-file="src/a.ts"] > button')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('+2');
    expect(head.textContent).toContain('−1');
    expect(q('[data-hunk-line]')).toBeNull();
    act(() => (head as HTMLButtonElement).click());
    const rows = [...container.querySelectorAll('[data-hunk-line] .wmux-hunk-row')].map((r) => r.textContent);
    expect(rows).toEqual(['11 one', '2-two', '2+TWO', '3+three', '34 four']);
  });

  it('puts a thread under its line, an outdated one under the file, resolved ones folded; bodies stay text', async () => {
    await openFile(2);
    const t1 = q('[data-thread-id="t1"]')!;
    expect(t1.closest('[data-hunk-line]')!.querySelector('.wmux-hunk-text')!.textContent).toBe('+three');
    expect(t1.textContent).toContain('first on t1');
    expect(t1.querySelector('img')).toBeNull();
    expect(q('[data-pr-outdated] [data-thread-id="t2"]')).not.toBeNull();
    const t3 = q('[data-thread-id="t3"]')!;
    expect(t3.closest('[data-hunk-line]')!.querySelector('.wmux-hunk-text')!.textContent).toBe('-two');
    expect(t3.textContent).not.toContain('first on t3');
    act(() => (t3.querySelector('[data-thread-toggle]') as HTMLButtonElement).click());
    expect(t3.textContent).toContain('first on t3');
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it('a reply goes to the thread\'s first comment, then threads are read again past the cache', async () => {
    await openFile(3);
    const t1 = q('[data-thread-id="t1"]')!;
    type(t1.querySelector('[data-thread-reply-body]') as HTMLTextAreaElement, 'Because of X');
    act(() => (t1.querySelector('[data-thread-reply]') as HTMLButtonElement).click());
    await flush();
    expect(gh.prReply).toHaveBeenCalledWith('/r', prOf(3).url, 101, 'Because of X');
    expect(gh.prThreads).toHaveBeenLastCalledWith('/r', prOf(3).url, A, true);
  });

  it('the gutter opens a composer under that line; sending uses the line\'s anchor and the head', async () => {
    await openFile(4);
    const gutter = q<HTMLButtonElement>('[data-line-comment="LEFT:2"]')!;
    expect(gutter.getAttribute('aria-label')).toBe('Comment on src/a.ts, old line 2');
    expect(q('[data-line-comment="RIGHT:3"]')!.getAttribute('aria-label')).toBe('Comment on src/a.ts, new line 3');
    act(() => gutter.click());
    const composer = q('[data-line-composer]')!;
    expect(composer.closest('[data-hunk-line]')!.querySelector('.wmux-hunk-text')!.textContent).toBe('-two');
    type(composer.querySelector('[data-line-composer-body]') as HTMLTextAreaElement, 'Why remove this?');
    act(() => (composer.querySelector('[data-line-composer-send]') as HTMLButtonElement).click());
    await flush();
    expect(gh.prComment).toHaveBeenCalledWith('/r', prOf(4).url, { expectHead: A, path: 'src/a.ts', line: 2, side: 'LEFT', body: 'Why remove this?' });
    expect(q('[data-line-composer]')).toBeNull();
    expect(gh.prThreads).toHaveBeenLastCalledWith('/r', prOf(4).url, A, true);
  });

  it('a moved PR keeps the comment text and warns', async () => {
    gh.prComment.mockResolvedValue({ ok: false, code: 'moved', message: 'moved' });
    await openFile(5);
    act(() => q<HTMLButtonElement>('[data-line-comment="RIGHT:3"]')!.click());
    type(q('[data-line-composer-body]') as HTMLTextAreaElement, 'Nit');
    act(() => q<HTMLButtonElement>('[data-line-composer-send]')!.click());
    await flush();
    expect(q<HTMLTextAreaElement>('[data-line-composer-body]')!.value).toBe('Nit');
    expect(q('[data-line-composer]')!.textContent).toContain('The PR changed since you loaded it');
  });

  it('file comments head the file; an outdated thread goes under Outdated even with a line', async () => {
    gh.prThreads.mockResolvedValue({ ok: true, value: { headRefOid: A, truncated: false, threads: [
      thread('t4', null, 'RIGHT', { subject: 'file' }),
      thread('t5', 3, 'RIGHT', { isOutdated: true }),
    ] } });
    await openFile(6);
    const body = q('[data-pr-file="src/a.ts"] .wmux-git-file-body')!;
    expect(body.firstElementChild!.matches('[data-pr-file-comments]')).toBe(true);
    expect(q('[data-pr-file-comments] [data-thread-id="t4"]')).not.toBeNull();
    expect(q('[data-pr-outdated] [data-thread-id="t5"]')).not.toBeNull();
    expect(q('[data-hunk-line] [data-thread-id="t5"]')).toBeNull();
  });

  it('a gutter click on another line moves the open composer with its text', async () => {
    await openFile(7);
    act(() => q<HTMLButtonElement>('[data-line-comment="LEFT:2"]')!.click());
    type(q('[data-line-composer-body]') as HTMLTextAreaElement, 'Keep me');
    act(() => q<HTMLButtonElement>('[data-line-comment="RIGHT:3"]')!.click());
    const composers = container.querySelectorAll('[data-line-composer]');
    expect(composers).toHaveLength(1);
    expect(composers[0].closest('[data-hunk-line]')!.querySelector('.wmux-hunk-text')!.textContent).toBe('+three');
    expect((composers[0].querySelector('[data-line-composer-body]') as HTMLTextAreaElement).value).toBe('Keep me');
  });

  it('a comment drafted on an older head is not sent; Re-anchor rebinds it to the pinned head', async () => {
    await openFile(8);
    act(() => q<HTMLButtonElement>('[data-line-comment="RIGHT:3"]')!.click());
    type(q('[data-line-composer-body]') as HTMLTextAreaElement, 'Old thought');
    act(() => root.render(createElement('div')));
    headNow = B;
    await show(8);
    const composer = q('[data-line-composer]')!;
    expect(composer.getAttribute('data-stale')).toBe('true');
    expect(q('[data-pr-draft-old]')?.textContent).toBe('This comment was written on an older version of the PR (aaaaaaa)');
    expect(q('[data-line-composer-send]')).toBeNull();
    act(() => q<HTMLButtonElement>('[data-pr-draft-reanchor]')!.click());
    expect(q('[data-line-composer]')!.getAttribute('data-stale')).toBeNull();
    expect(q<HTMLTextAreaElement>('[data-line-composer-body]')!.value).toBe('Old thought');
    act(() => q<HTMLButtonElement>('[data-line-composer-send]')!.click());
    await flush();
    expect(gh.prComment).toHaveBeenCalledWith('/r', prOf(8).url, { expectHead: B, path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Old thought' });
  });

  it('Discard drops a comment drafted on an older head', async () => {
    await openFile(9);
    act(() => q<HTMLButtonElement>('[data-line-comment="RIGHT:3"]')!.click());
    type(q('[data-line-composer-body]') as HTMLTextAreaElement, 'Old thought');
    act(() => root.render(createElement('div')));
    headNow = B;
    await show(9);
    act(() => q<HTMLButtonElement>('[data-pr-draft-discard]')!.click());
    expect(q('[data-line-composer]')).toBeNull();
    act(() => root.render(createElement('div')));
    await show(9);
    expect(q('[data-line-composer]')).toBeNull();
    expect(gh.prComment).not.toHaveBeenCalled();
  });

  it('a draft whose line left the diff shows as a draft for a removed line, with Discard', async () => {
    await openFile(10);
    act(() => q<HTMLButtonElement>('[data-line-comment="RIGHT:3"]')!.click());
    type(q('[data-line-composer-body]') as HTMLTextAreaElement, 'About three');
    act(() => root.render(createElement('div')));
    headNow = B;
    files = [{ ...file, hunks: [{ ...file.hunks[0], bodyLines: [' one', '-two', ' four'], newLines: 2 }] }];
    await show(10);
    expect(q('[data-line-composer]')).toBeNull();
    const orphan = q('[data-pr-orphan-draft]')!;
    expect(orphan.textContent).toContain('Draft for a removed line (src/a.ts, line 3)');
    expect(orphan.textContent).toContain('About three');
    act(() => q<HTMLButtonElement>('[data-pr-orphan-draft] [data-pr-draft-discard]')!.click());
    expect(q('[data-pr-orphan-draft]')).toBeNull();
  });

  it('duplicate and unknown paths each get their own row', async () => {
    files = [file, { ...file }, { ...file, path: '(unknown)', kind: 'binary', hunks: [] }];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '/r', repoLabel: 'r', pr: prOf(11) })));
    await flush();
    expect(container.querySelectorAll('[data-pr-file="src/a.ts"]')).toHaveLength(2);
    expect(q('[data-pr-file="(unknown)"]')?.textContent).toContain('(unknown)');
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
  });
});
