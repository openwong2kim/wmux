// @vitest-environment jsdom
//
// The PR detail pane's checks: buckets as marks, a failed run's log as plain
// text in a <pre> (read once), Rerun only on an explicit click, and the poll
// that runs only while the Git page is on screen and the window is visible.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GitDetail } from '../GitDetail';
import { useStore } from '../../../stores';
import { LIST_POLL_MS } from '../useGitList';
import type { PrSummary } from '../../../../shared/prSurface';
import type { PrChecksState, PrCheck } from '../../../../shared/prReview';

const pr: PrSummary = {
  number: 7, title: 'Add widgets', state: 'open', author: 'a', headRefName: 'feat/w', updatedAt: 'u',
  url: 'https://github.com/o/r/pull/7', reviewDecision: '', checks: 'failing', mergeable: '',
};
const SHA = 'a'.repeat(40);
const check = (name: string, bucket: PrCheck['bucket'], runId?: string): PrCheck => ({
  name, workflow: 'CI', bucket, link: runId ? `https://github.com/o/r/actions/runs/${runId}/job/1` : 'https://example.com/c',
  ...(runId ? { runId } : {}),
});
const state = (checks: PrCheck[]): PrChecksState => ({
  head: {
    number: 7, title: 'Add widgets', url: pr.url, state: 'OPEN', isDraft: false, headRefOid: SHA,
    headRefName: 'feat/w', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  },
  checks,
});

let container: HTMLDivElement;
let root: Root;
let gh: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  gh = {
    prList: vi.fn(), prDetail: vi.fn(async () => ({ ok: true, detail: { number: 7, comments: [] } })),
    prChecks: vi.fn(async () => ({ ok: true, value: state([
      check('lint', 'pass'), check('test', 'fail', '99'), check('build', 'fail', '99'),
      check('deploy', 'pending'), check('docs', 'skipping'), check('e2e', 'cancel'),
    ]) })),
    prRunLog: vi.fn(async () => ({ ok: true, value: { runId: '99', text: 'step 1\n<script>window.__pwned = 1</script>\nboom', truncated: true } })),
    prRerunFailed: vi.fn(async () => ({ ok: true })),
    prFiles: vi.fn(async () => ({ ok: true, value: { headRefOid: SHA, files: [], truncated: false } })),
    prThreads: vi.fn(async () => ({ ok: true, value: { threads: [], truncated: false } })),
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
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  delete (window as unknown as { __pwned?: unknown }).__pwned;
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const render = () => act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '/r', repoLabel: 'r', pr })));
const q = (sel: string) => container.querySelector(sel);

describe('PR checks', () => {
  it('lists each check with a mark for its bucket and an Open link', async () => {
    render();
    await flush();
    expect(gh.prChecks).toHaveBeenCalledWith('/r', 7, false);
    const rows = [...container.querySelectorAll('[data-check-bucket]')].map((r) => r.getAttribute('data-check-bucket'));
    expect(rows).toEqual(['pass', 'fail', 'fail', 'pending', 'skipping', 'cancel']);
    expect(q('[data-check-bucket="pass"] [role="img"]')?.getAttribute('aria-label')).toBe('Passed');
    expect(q('[data-check-bucket="fail"] [role="img"]')?.getAttribute('aria-label')).toBe('Failed');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    act(() => (q('[data-check-bucket="pass"] [data-check-open]') as HTMLButtonElement).click());
    expect(open).toHaveBeenCalledWith('https://example.com/c', '_blank');
    open.mockRestore();
  });

  it('shows one block per failed run; its log is plain text in a pre, read once, with the tail note', async () => {
    render();
    await flush();
    expect(container.querySelectorAll('[data-run-id]')).toHaveLength(1);
    const toggle = q('[data-run-log-toggle]') as HTMLButtonElement;
    act(() => toggle.click());
    await flush();
    expect(gh.prRunLog).toHaveBeenCalledWith('/r', '99');
    const pre = q('pre[data-run-log]')!;
    expect(pre.textContent).toContain('<script>window.__pwned = 1</script>');
    expect(pre.querySelector('script')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
    expect(q('[data-run-log-truncated]')?.textContent).toBe('Showing the last lines');
    act(() => toggle.click());
    act(() => toggle.click());
    await flush();
    expect(gh.prRunLog).toHaveBeenCalledTimes(1);
  });

  it('a log too large to read says so with the Open link', async () => {
    gh.prRunLog.mockResolvedValue({ ok: true, value: { runId: '99', text: '', truncated: false, tooLarge: true } });
    render();
    await flush();
    act(() => (q('[data-run-log-toggle]') as HTMLButtonElement).click());
    await flush();
    expect(q('[data-run-log-too-large]')?.textContent).toContain('too large');
    expect(q('[data-run-log-too-large] button')).not.toBeNull();
    expect(q('pre[data-run-log]')).toBeNull();
  });

  it('reruns failed jobs only on a click, once, disabled while it runs', async () => {
    let finish!: (v: unknown) => void;
    gh.prRerunFailed.mockImplementation(() => new Promise((res) => { finish = res; }));
    render();
    await flush();
    expect(gh.prRerunFailed).not.toHaveBeenCalled();
    const btn = q('[data-run-rerun]') as HTMLButtonElement;
    act(() => btn.click());
    expect(btn.disabled).toBe(true);
    act(() => btn.click());
    expect(gh.prRerunFailed).toHaveBeenCalledTimes(1);
    expect(gh.prRerunFailed).toHaveBeenCalledWith('/r', '99');
    await act(async () => { finish({ ok: true }); });
    await flush();
    expect(q('[data-run-rerun-result]')?.textContent).toBe('Rerun requested');
  });

  it('a rerun refused shows why', async () => {
    gh.prRerunFailed.mockResolvedValue({ ok: false, code: 'error', message: 'no permission' });
    render();
    await flush();
    act(() => (q('[data-run-rerun]') as HTMLButtonElement).click());
    await flush();
    expect(q('[data-run-rerun-result]')?.textContent).toBe('no permission');
    expect((q('[data-run-rerun]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('polls every 30s only while the Git page is shown and the window visible', async () => {
    vi.useFakeTimers();
    render();
    await flush();
    const base = gh.prChecks.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(LIST_POLL_MS); });
    await flush();
    expect(gh.prChecks.mock.calls.length).toBe(base + 1);

    act(() => useStore.setState({ appRoute: 'fleet' }));
    await act(async () => { vi.advanceTimersByTime(LIST_POLL_MS * 3); });
    await flush();
    expect(gh.prChecks.mock.calls.length).toBe(base + 1);

    act(() => useStore.setState({ appRoute: 'git' }));
    await flush();
    const back = gh.prChecks.mock.calls.length;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { vi.advanceTimersByTime(LIST_POLL_MS * 3); });
    await flush();
    expect(gh.prChecks.mock.calls.length).toBe(back);
  });

  it('does not poll a merged PR', async () => {
    vi.useFakeTimers();
    gh.prChecks.mockResolvedValue({ ok: true, value: { ...state([]), head: { ...state([]).head, state: 'MERGED' } } });
    render();
    await flush();
    const base = gh.prChecks.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(LIST_POLL_MS * 2); });
    await flush();
    expect(gh.prChecks.mock.calls.length).toBe(base);
  });

  it('a rate limit says when it retries', async () => {
    gh.prChecks.mockResolvedValue({ ok: false, code: 'rate-limited', message: 'rl', retryAt: new Date(2026, 9, 4, 13, 5).getTime() });
    render();
    await flush();
    expect(q('[data-pr-checks] [data-git-list-rate-limited]')?.textContent).toBe('GitHub rate limit, retrying at 13:05');
  });
});
