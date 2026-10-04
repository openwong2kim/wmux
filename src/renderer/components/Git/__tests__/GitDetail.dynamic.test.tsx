// @vitest-environment jsdom
//
// The detail pane: an issue body renders as text (no HTML, nothing runs) with
// real http(s) links and read-only task boxes; answers for a previous
// selection never land under the current one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GitDetail } from '../GitDetail';
import type { IssueSummary } from '../../../../shared/issueSurface';
import type { PrSummary } from '../../../../shared/prSurface';

const issue: IssueSummary = {
  number: 12, title: 'Crash', state: 'open', author: 'alice', labels: [{ name: 'bug' }], assignees: [],
  updatedAt: '2026-10-01T00:00:00Z', url: 'https://github.com/Acme/Widgets/issues/12', comments: 1,
};
const pr = (n: number): PrSummary => ({
  number: n, title: `PR ${n}`, state: 'open', author: 'a', headRefName: `b${n}`, updatedAt: 'u', url: `https://github.com/o/r/pull/${n}`,
  reviewDecision: '', checks: null, mergeable: '',
});

let container: HTMLDivElement;
let root: Root;
let issueDetail: ReturnType<typeof vi.fn>;
let prDetail: ReturnType<typeof vi.fn>;

beforeEach(() => {
  issueDetail = vi.fn(async () => ({
    ok: true,
    detail: {
      number: 12, title: 'Crash', state: 'open', stateReason: '', author: 'alice',
      body: 'Steps:\n<script>window.__pwned = 1</script>\n<img src=x onerror="window.__pwned = 2">\n- [x] seen on main\nSee https://example.com/log.',
      bodyTruncated: false, labels: [{ name: 'bug' }], assignees: [], createdAt: '2026-09-30T00:00:00Z', closedAt: '', url: issue.url,
      comments: [{ author: 'bob', body: '<iframe src="https://evil"></iframe>', createdAt: '2026-10-01T00:00:00Z', url: issue.url, truncated: false }],
    },
  }));
  prDetail = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = { github: { issueList: vi.fn(), issueDetail, prList: vi.fn(), prDetail } };
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

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe('GitDetail', () => {
  it('renders an issue as text: no script, img or iframe; real links; read-only task boxes', async () => {
    act(() => root.render(createElement(GitDetail, { kind: 'issue', repoPath: '/r', repoLabel: 'widgets', issue })));
    await flush();
    expect(issueDetail).toHaveBeenCalledWith('/r', 12, issue.updatedAt);
    const body = container.querySelector('[data-issue-detail]')!;
    expect(body.querySelector('script, img, iframe')).toBeNull();
    expect(body.textContent).toContain('<script>window.__pwned = 1</script>');
    expect(body.textContent).toContain('<iframe src="https://evil"></iframe>');
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
    expect(body.querySelector('a')?.getAttribute('href')).toBe('https://example.com/log');
    const box = body.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect([box.checked, box.disabled]).toEqual([true, true]);
    const head = container.querySelector('[data-git-detail-head]')!;
    expect(head.textContent).toContain('Crash');
    expect(head.textContent).toContain('widgets');
    expect(head.querySelector('[data-git-open-github]')).not.toBeNull();
  });

  it('comments for PR A arriving after B was selected never show under B', async () => {
    const pending = new Map<number, (v: unknown) => void>();
    prDetail.mockImplementation((_r: string, n: number) => new Promise((res) => { pending.set(n, res); }));
    const answer = (n: number) => ({ ok: true, detail: { number: n, comments: [{ author: 'x', body: `on ${n}`, createdAt: '', url: 'c', kind: 'comment', reviewState: '', truncated: false }] } });
    act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '/r', repoLabel: 'r', pr: pr(1) })));
    act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '/r', repoLabel: 'r', pr: pr(2) })));
    await act(async () => { pending.get(2)!(answer(2)); });
    await act(async () => { pending.get(1)!(answer(1)); });
    await flush();
    expect(container.querySelector('[data-git-detail-head]')?.textContent).toContain('PR 2');
    expect(container.textContent).toContain('on 2');
    expect(container.textContent).not.toContain('on 1');
  });

  it('nothing selected: a quiet empty state', () => {
    act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '', repoLabel: '' })));
    expect(container.querySelector('[data-git-detail-empty]')).not.toBeNull();
  });
});
