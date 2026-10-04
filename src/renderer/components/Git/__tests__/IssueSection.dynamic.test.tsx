// @vitest-environment jsdom
//
// The Issues list polls only while it is shown on the visible Git page; it
// passes its filter to main and reports a new one; a rate limit keeps the
// list; a row selects the issue and drags as a typed issue ref; an answer
// dropped while the window was hidden is read again when it is shown.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { IssueSection } from '../IssueSection';
import { ISSUE_DRAG_TYPE, parseIssueRef } from '../../../../shared/issueRef';
import type { IssueFilter, IssueSummary } from '../../../../shared/issueSurface';

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
let issueList: ReturnType<typeof vi.fn>;
const all: IssueFilter = { kind: 'all' };

beforeEach(() => {
  vi.useFakeTimers();
  issueList = vi.fn(async () => ({ ok: true as const, issues: [issue], repo: { host: 'github.com', owner: 'acme', repo: 'widgets' } }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { github: { issueList, issueDetail: vi.fn() } };
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
const render = (props: Partial<Parameters<typeof IssueSection>[0]> = {}) =>
  act(() => root.render(createElement(IssueSection, { repoPath: '/r', filter: all, ...props })));

describe('IssueSection list', () => {
  it('shown on the visible Git page it polls; on another page or a hidden window it stops', async () => {
    const hidden = { value: false };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden.value });
    try {
      render();
      await tick(0);
      const first = issueList.mock.calls.length;
      await tick(30_000);
      expect(issueList.mock.calls.length).toBe(first + 1);
      act(() => useStore.setState({ appRoute: 'fleet' }));
      const off = issueList.mock.calls.length;
      await tick(95_000);
      expect(issueList.mock.calls.length).toBe(off);
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

  it('lazy and not shown, it reads nothing; shown, it reads once', async () => {
    render({ lazy: true, poll: false, shown: false });
    await tick(95_000);
    expect(issueList).not.toHaveBeenCalled();
    render({ lazy: true, poll: false, shown: true });
    await tick(0);
    expect(issueList).toHaveBeenCalledTimes(1);
    await tick(95_000);
    expect(issueList).toHaveBeenCalledTimes(1);
  });

  it('passes its filter to main and reports a new one', async () => {
    const onFilter = vi.fn();
    render({ filter: { kind: 'assigned' }, poll: false, onFilter });
    await tick(0);
    expect(issueList).toHaveBeenLastCalledWith('/r', { kind: 'assigned' }, false);
    const select = container.querySelector('[data-issue-filter]') as HTMLSelectElement;
    act(() => {
      select.value = 'created';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onFilter).toHaveBeenCalledWith({ kind: 'created' });
  });

  it('shows the rate-limit state with its retry time and keeps the list', async () => {
    render({ poll: false });
    await tick(0);
    const retryAt = new Date(2026, 9, 4, 14, 5).getTime();
    issueList.mockResolvedValueOnce({ ok: false, code: 'rate-limited', message: 'GitHub rate limit', retryAt });
    render({ poll: false, refreshKey: 1 });
    await tick(0);
    expect(container.querySelector('[data-git-list-rate-limited]')?.textContent).toBe('GitHub rate limit, retrying at 14:05');
    expect(container.querySelectorAll('[data-issue-row]')).toHaveLength(1);
  });

  it('a GitLab remote says issues are GitHub-only', async () => {
    issueList.mockResolvedValueOnce({ ok: false, code: 'unsupported-host', message: 'x', provider: 'gitlab' });
    render({ poll: false });
    await tick(0);
    expect(container.querySelector('[data-git-gate="unsupported-host"]')?.textContent).toBe('Issues are GitHub-only for now.');
  });

  it('a row is a button in a list that selects the issue', async () => {
    const onSelect = vi.fn();
    render({ poll: false, onSelect, selected: 12 });
    await tick(0);
    expect(container.querySelector('ul[data-issue-list] > li')).not.toBeNull();
    const row = container.querySelector('[data-issue-row] button') as HTMLButtonElement;
    expect(row.getAttribute('aria-current')).toBe('true');
    act(() => row.click());
    expect(onSelect).toHaveBeenCalledWith(issue);
  });

  it('a row drags as an application/x-wmux-issue ref, case kept from the URL', async () => {
    render({ poll: false });
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

  it('a lazy list answered while hidden is read again when shown', async () => {
    const hidden = { value: false };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden.value });
    try {
      let answer!: (v: unknown) => void;
      issueList.mockImplementationOnce(() => new Promise((res) => { answer = res; }));
      render({ lazy: true, poll: false, shown: true });
      await tick(0);
      expect(issueList).toHaveBeenCalledTimes(1);
      hidden.value = true;
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await act(async () => { answer({ ok: true, issues: [issue], repo: null }); });
      await tick(0);
      expect(container.querySelectorAll('[data-issue-row]')).toHaveLength(0);
      hidden.value = false;
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await tick(0);
      expect(issueList).toHaveBeenCalledTimes(2);
      expect(container.querySelectorAll('[data-issue-row]')).toHaveLength(1);
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });
});
