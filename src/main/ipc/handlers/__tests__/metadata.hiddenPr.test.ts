// While the window is hidden the 5 s metadata poll pauses, but the PR routers
// keep running for panes with a known PR: CI every 60 s from the PR cache, the
// review router (which reads gh itself) only once per 5 min, and nothing else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';
import { registerMetadataHandlers, removeBranch, removeCwd, runHiddenPrTick, updateBranch, updateCwd } from '../metadata.handler';

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() },
  BrowserWindow: {},
}));
const { gitBranch, prGet, syncGet, ciNote, reviewNote } = vi.hoisted(() => ({
  gitBranch: vi.fn(async () => null),
  prGet: vi.fn(),
  syncGet: vi.fn(async () => null),
  ciNote: vi.fn(async () => undefined),
  reviewNote: vi.fn(async () => undefined),
}));
vi.mock('../../../metadata/MetadataCollector', () => ({
  MetadataCollector: class {
    getGitBranch = gitBranch;
  },
}));
vi.mock('../../../metadata/PrStatusCache', () => ({ prStatusCache: { get: (...a: unknown[]) => prGet(...a) } }));
vi.mock('../../../metadata/GitSyncStatusCache', () => ({ gitSyncStatusCache: { get: () => syncGet() } }));
vi.mock('../../../metadata/PrCiRouter', () => ({
  PrCiRouter: class {
    note = ciNote;
    forget = vi.fn();
  },
}));
vi.mock('../../../metadata/PrReviewRouter', () => ({
  PrReviewRouter: class {
    note = reviewNote;
    forget = vi.fn();
  },
}));

const PR = { number: 7, state: 'open', checks: 'failing', url: 'https://github.com/o/r/pull/7' } as const;
const mgr = { get: () => undefined } as unknown as PTYManager;

let visible = true;
const send = vi.fn();
const win = {
  isDestroyed: () => false,
  isVisible: () => visible,
  isMinimized: () => false,
  webContents: { isLoading: () => false, send, isDestroyed: () => false },
} as unknown as BrowserWindow;

describe('hidden-window PR routers', () => {
  let dispose: () => void;
  // The hidden cadence is module state: each test starts a day later.
  let day = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2030, 0, 1) + ++day * 86_400_000);
    vi.clearAllMocks();
    prGet.mockResolvedValue(PR);
    visible = true;
    dispose = registerMetadataHandlers(mgr, () => win, { localPtyOwnership: false });
  });
  afterEach(() => {
    dispose();
    removeCwd('pty-h1');
    removeBranch('pty-h1');
    vi.useRealTimers();
  });

  it('visible: the full poll runs; hidden: only the PR routers, CI every 60 s and review every 5 min', async () => {
    updateCwd('pty-h1', '/repo');
    updateBranch('pty-h1', 'feat/a');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncGet).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ciNote).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    visible = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ciNote).toHaveBeenCalledTimes(1);
    expect(reviewNote).toHaveBeenCalledTimes(1);
    expect(prGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(ciNote).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ciNote).toHaveBeenCalledTimes(2);
    expect(reviewNote).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(ciNote).toHaveBeenCalledTimes(6);
    expect(reviewNote).toHaveBeenCalledTimes(2);
    // Nothing else of the poll ran while hidden.
    expect(syncGet).not.toHaveBeenCalled();
    expect(gitBranch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    vi.clearAllMocks();
    visible = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncGet).toHaveBeenCalledTimes(1);
    expect(ciNote).toHaveBeenCalledTimes(1);
    expect(reviewNote).toHaveBeenCalledTimes(1);
  });

  it('hidden: a PR that changed since the last visible poll is left alone', async () => {
    updateCwd('pty-h1', '/repo');
    updateBranch('pty-h1', 'feat/c');
    await vi.advanceTimersByTimeAsync(5_000);
    vi.clearAllMocks();
    prGet.mockResolvedValue({ ...PR, number: 8, url: 'https://github.com/o/r/pull/8' });
    visible = false;
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(prGet).toHaveBeenCalled();
    expect(ciNote).not.toHaveBeenCalled();
    expect(reviewNote).not.toHaveBeenCalled();
  });

  it('hidden: a merged PR is routed once, then not read again until the window is shown', async () => {
    updateCwd('pty-h1', '/repo');
    updateBranch('pty-h1', 'feat/d');
    await vi.advanceTimersByTimeAsync(5_000);
    vi.clearAllMocks();
    prGet.mockResolvedValue({ ...PR, state: 'merged' });
    visible = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(prGet).toHaveBeenCalledTimes(1);
    expect(ciNote).toHaveBeenCalledTimes(1);
  });

  it('does no work at all when no pane has a known PR', async () => {
    updateCwd('pty-h1', '/repo');
    updateBranch('pty-h1', 'feat/b'); // never polled visible: its PR is not known
    visible = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await runHiddenPrTick(Date.now() + 3_600_000);
    expect(prGet).not.toHaveBeenCalled();
    expect(ciNote).not.toHaveBeenCalled();
    expect(reviewNote).not.toHaveBeenCalled();
  });
});
