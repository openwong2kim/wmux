// The PR proof the PR owner nudge's main-side re-check reads
// (currentPrOfPty): set by the poll, dropped on a cwd or branch change, and
// never put back by a poll lookup that started before the change.
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';
import { EventEmitter } from 'node:events';
import { currentPrOfPty, resetPollCacheOnRendererLoad, runMetadataPollTick, updateBranch, updateCwd, removeCwd } from '../metadata.handler';

vi.mock('electron', () => ({ ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, BrowserWindow: {} }));
vi.mock('../../../metadata/MetadataCollector', () => ({
  MetadataCollector: class {
    async getGitBranch(): Promise<string | null> { return null; }
  },
}));
const prGet = vi.fn();
vi.mock('../../../metadata/PrStatusCache', () => ({ prStatusCache: { get: (...a: unknown[]) => prGet(...a) } }));
vi.mock('../../../metadata/GitSyncStatusCache', () => ({ gitSyncStatusCache: { get: vi.fn(async () => null) } }));

const PR = { number: 7, state: 'open', checks: 'failing', url: 'https://github.com/o/r/pull/7' } as const;
const win = { isDestroyed: () => false, webContents: { send: () => undefined } } as unknown as BrowserWindow;
const mgr = { get: () => ({ process: { pid: 1 } }) } as unknown as PTYManager;

describe('PR proof for the owner nudge', () => {
  it('is set by the poll and dropped at once by a branch or cwd change', async () => {
    prGet.mockResolvedValue(PR);
    updateCwd('pty-p1', '/repo');
    updateBranch('pty-p1', 'feat/a');
    await runMetadataPollTick(mgr, win, true);
    expect(currentPrOfPty('pty-p1')).toEqual({ number: 7, url: PR.url });
    updateBranch('pty-p1', 'feat/b');
    expect(currentPrOfPty('pty-p1')).toBeNull();
    await runMetadataPollTick(mgr, win, true);
    expect(currentPrOfPty('pty-p1')).toEqual({ number: 7, url: PR.url });
    updateCwd('pty-p1', '/elsewhere');
    expect(currentPrOfPty('pty-p1')).toBeNull();
    removeCwd('pty-p1');
  });

  it('a lookup in flight across a branch change cannot put the old PR back', async () => {
    let resolveOld: ((v: unknown) => void) | null = null;
    prGet.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    updateCwd('pty-p2', '/repo2');
    updateBranch('pty-p2', 'feat/old');
    const tick = runMetadataPollTick(mgr, win, true);
    await vi.waitFor(() => expect(resolveOld).not.toBeNull());
    updateBranch('pty-p2', 'feat/new'); // the pane moved while gh was answering
    resolveOld!(PR);
    await tick;
    expect(currentPrOfPty('pty-p2')).toBeNull();
    removeCwd('pty-p2');
  });

  it('a renderer reload makes the next poll send every pane again (inactive panes refill their PR)', async () => {
    prGet.mockResolvedValue(PR);
    const sent: unknown[][] = [];
    const webContents = Object.assign(new EventEmitter(), { send: (...a: unknown[]) => { sent.push(a); } });
    const w = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
    resetPollCacheOnRendererLoad(w);
    updateCwd('pty-p3', '/repo3');
    updateBranch('pty-p3', 'feat/c');
    await runMetadataPollTick(mgr, w, true);
    await runMetadataPollTick(mgr, w, true);
    const forP3 = () => sent.filter((a) => (a[1] as { ptyId?: string }).ptyId === 'pty-p3').length;
    expect(forP3()).toBe(1); // unchanged: the poll skips it
    webContents.emit('did-finish-load');
    await runMetadataPollTick(mgr, w, true);
    expect(forP3()).toBe(2);
    removeCwd('pty-p3');
  });
});
