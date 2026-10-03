// @vitest-environment jsdom
//
// The Issues list polls only while it is open on the visible Git page; an
// issue body renders as text (no HTML, no script); a row drags as a typed
// issue ref; the Pull requests | Issues switch remembers its choice.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { IssueSection } from '../IssueSection';
import { GitWorkSection, WORK_VIEW_KEY } from '../GitWorkSection';
import { ISSUE_DRAG_TYPE, parseIssueRef } from '../../../../shared/issueRef';
import type { IssueSummary } from '../../../../shared/issueSurface';

const issue: IssueSummary = {
  number: 12,
  title: 'Crash when the label is long',
  state: 'open',
  author: 'alice',
  labels: [{ name: 'bug' }],
  assignees: [],
  updatedAt: '2026-10-01T00:00:00Z',
  url: 'https://github.com/Acme/Widgets/issues/12',
  comments: 1,
};

let container: HTMLDivElement;
let root: Root;
const issueList = vi.fn(async () => ({ ok: true as const, issues: [issue], repo: { host: 'github.com', owner: 'acme', repo: 'widgets' } }));
const issueDetail = vi.fn(async () => ({
  ok: true as const,
  detail: {
    number: 12, title: issue.title, state: 'open' as const, stateReason: '', author: 'alice',
    body: 'Steps:\n<script>window.__pwned = 1</script>\n<img src=x onerror="window.__pwned = 2">\n**bold**',
    bodyTruncated: false, labels: [{ name: 'bug' }], assignees: [], createdAt: '2026-09-30T00:00:00Z', closedAt: '', url: issue.url,
    comments: [{ author: 'bob', body: '<iframe src="https://evil"></iframe>', createdAt: '2026-10-01T00:00:00Z', url: issue.url, truncated: false }],
  },
}));
const prList = vi.fn(async () => ({ ok: true as const, prs: [] }));

beforeEach(() => {
  vi.useFakeTimers();
  issueList.mockClear();
  issueDetail.mockClear();
  prList.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { github: { issueList, issueDetail, prList, prDetail: vi.fn() } };
  act(() => useStore.setState({ appRoute: 'git' }));
  try { localStorage.removeItem(WORK_VIEW_KEY); } catch { /* none */ }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  delete (window as unknown as { __pwned?: unknown }).__pwned;
});

const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('IssueSection polling', () => {
  it('open on the visible Git page it polls; on another page or a hidden window it stops', async () => {
    const hidden = { value: false };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden.value });
    try {
      act(() => root.render(createElement(IssueSection, { repoPath: '/r', open: true })));
      await tick(0);
      const first = issueList.mock.calls.length;
      expect(first).toBeGreaterThanOrEqual(1);
      await tick(30_000);
      expect(issueList.mock.calls.length).toBe(first + 1);

      act(() => useStore.setState({ appRoute: 'fleet' }));
      const offPage = issueList.mock.calls.length;
      await tick(95_000);
      expect(issueList.mock.calls.length).toBe(offPage);

      act(() => useStore.setState({ appRoute: 'git' }));
      await tick(0);
      hidden.value = true;
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      const whileHidden = issueList.mock.calls.length;
      await tick(95_000);
      expect(issueList.mock.calls.length).toBe(whileHidden);
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });

  it('closed, or lazy and never opened, it reads nothing on a timer', async () => {
    act(() => root.render(createElement(IssueSection, { repoPath: '/r', open: false, lazy: true, poll: false })));
    await tick(95_000);
    expect(issueList).not.toHaveBeenCalled();
    act(() => root.render(createElement(IssueSection, { repoPath: '/r', open: true, lazy: true, poll: false })));
    await tick(0);
    expect(issueList).toHaveBeenCalledTimes(1);
    await tick(95_000);
    expect(issueList).toHaveBeenCalledTimes(1);
  });

  it('passes the chosen filter to main', async () => {
    act(() => root.render(createElement(IssueSection, { repoPath: '/r', open: true, poll: false })));
    await tick(0);
    expect(issueList).toHaveBeenLastCalledWith('/r', { kind: 'all' }, false);
    const select = container.querySelector('[data-issue-filter]') as HTMLSelectElement;
    act(() => {
      select.value = 'assigned';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await tick(0);
    expect(issueList).toHaveBeenLastCalledWith('/r', { kind: 'assigned' }, false);
  });

  it('shows the rate-limit state with its retry time and keeps the list', async () => {
    act(() => root.render(createElement(IssueSection, { repoPath: '/r', open: true, poll: false })));
    await tick(0);
    const retryAt = new Date(2026, 9, 4, 14, 5).getTime();
    issueList.mockResolvedValueOnce({ ok: false, code: 'rate-limited', message: 'GitHub rate limit', retryAt } as never);
    act(() => root.render(createElement(IssueSection, { repoPath: '/r', open: true, poll: false, refreshKey: 1 })));
    await tick(0);
    expect(container.querySelector('[data-issue-rate-limited]')?.textContent).toBe('GitHub rate limit, retrying at 14:05');
    expect(container.querySelectorAll('[data-issue-row]')).toHaveLength(1);
  });

  it('a GitLab remote says issues are GitHub-only', async () => {
    issueList.mockResolvedValueOnce({ ok: false, code: 'unsupported-host', message: 'x', provider: 'gitlab' } as never);
    act(() => root.render(createElement(IssueSection, { repoPath: '/r', open: true, poll: false })));
    await tick(0);
    expect(container.querySelector('[data-git-gate="unsupported-host"]')?.textContent).toBe('Issues are GitHub-only for now.');
  });
});

describe('IssueSection detail', () => {
  it('renders the body and comments as text: no script, img or iframe reaches the DOM', async () => {
    act(() => root.render(createElement(IssueSection, { repoPath: '/r', open: true, poll: false })));
    await tick(0);
    act(() => (container.querySelector('[data-issue-row] button') as HTMLButtonElement).click());
    await tick(0);
    expect(issueDetail).toHaveBeenCalledWith('/r', 12, issue.updatedAt);
    const detail = container.querySelector('[data-issue-detail]')!;
    expect(detail.querySelector('script, img, iframe')).toBeNull();
    expect(detail.textContent).toContain('<script>window.__pwned = 1</script>');
    expect(detail.textContent).toContain('<iframe src="https://evil"></iframe>');
    expect(detail.querySelector('strong')?.textContent).toBe('bold');
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
    expect(container.querySelector('[data-issue-open-github]')).not.toBeNull();
  });

  it('opens from the keyboard (a real button) and marks the row expanded', async () => {
    act(() => root.render(createElement(IssueSection, { repoPath: '/r', open: true, poll: false })));
    await tick(0);
    const row = container.querySelector('[data-issue-row] button') as HTMLButtonElement;
    expect(row.tagName).toBe('BUTTON');
    expect(container.querySelector('ul[data-issue-list] > li')).not.toBeNull();
    act(() => row.click());
    await tick(0);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(row.getAttribute('aria-controls')!)).not.toBeNull();
  });
});

describe('IssueSection drag', () => {
  it('a row drags as an application/x-wmux-issue ref, case kept from the URL', async () => {
    act(() => root.render(createElement(IssueSection, { repoPath: '/r', open: true, poll: false })));
    await tick(0);
    const row = container.querySelector('[data-issue-row] button') as HTMLButtonElement;
    expect(row.getAttribute('draggable')).toBe('true');
    const data = new Map<string, string>();
    const ev = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer: unknown };
    ev.dataTransfer = { setData: (k: string, v: string) => data.set(k, v), effectAllowed: 'all' };
    act(() => { row.dispatchEvent(ev); });
    expect([...data.keys()]).toEqual([ISSUE_DRAG_TYPE]);
    expect(parseIssueRef(data.get(ISSUE_DRAG_TYPE)!)).toEqual({
      host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 12, title: issue.title, url: issue.url,
    });
  });
});

describe('Pull requests | Issues switch', () => {
  it('mounts only the chosen list and remembers the choice', async () => {
    act(() => root.render(createElement(GitWorkSection, { repoPath: '/r', defaultOpen: true, poll: false })));
    await tick(0);
    expect(prList).toHaveBeenCalled();
    expect(issueList).not.toHaveBeenCalled();
    const issuesTab = container.querySelector('[data-git-work-tab="issues"]') as HTMLButtonElement;
    expect(issuesTab.getAttribute('role')).toBe('tab');
    act(() => issuesTab.click());
    await tick(0);
    expect(issuesTab.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-pr-section]')).toBeNull();
    expect(issueList).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(WORK_VIEW_KEY)).toBe('issues');

    act(() => root.unmount());
    root = createRoot(container);
    issueList.mockClear();
    act(() => root.render(createElement(GitWorkSection, { repoPath: '/r', defaultOpen: true, poll: false })));
    await tick(0);
    expect(container.querySelector('[data-git-work="issues"]')).not.toBeNull();
    expect(issueList).toHaveBeenCalledTimes(1);
  });
});
