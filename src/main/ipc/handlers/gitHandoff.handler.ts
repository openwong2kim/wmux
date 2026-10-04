// The Git page's hand-off IPC: an issue or PR to an agent pane, or to a new
// worktree (src/main/git/handoff.ts). Renderer-only; registered once, beside
// the fan-out handler, because it needs the fan-out service and the operator
// RPC lane.
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { resolveAccessiblePath } from './fs.handler';
import { getWorkLinkStore } from '../../workLink/workLinkStore';
import { sendHandoff, startHandoffWorktree, watchHandoffWorktreeLinks, type HandoffDeps } from '../../git/handoff';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import type { FanOutRequest, FanOutResult } from '../../worktask/FanOutService';
import type { HandoffSendResult, HandoffStartResult } from '../../../shared/gitHandoff';

export function registerGitHandoffHandlers(opts: {
  invoke: HandoffDeps['invoke'];
  startFanOut: (req: FanOutRequest) => Promise<FanOutResult>;
}): () => void {
  const store = getWorkLinkStore();
  const deps: HandoffDeps = {
    invoke: opts.invoke,
    links: { list: (f) => store.list(f), upsert: (i) => store.upsert(i), setState: (id, st, why) => store.setState(id, st, why) },
    startFanOut: opts.startFanOut,
  };
  // A worktree hand-off's link follows its fan-out mission (done, closed, …).
  const unwatch = watchHandoffWorktreeLinks(getTaskLedger(), deps.links);
  ipcMain.removeHandler(IPC.GIT_HANDOFF_SEND);
  ipcMain.handle(
    IPC.GIT_HANDOFF_SEND,
    wrapHandler(IPC.GIT_HANDOFF_SEND, (_e: Electron.IpcMainInvokeEvent, req: unknown): Promise<HandoffSendResult> => sendHandoff(deps, req)),
  );
  ipcMain.removeHandler(IPC.GIT_HANDOFF_START_WORKTREE);
  ipcMain.handle(
    IPC.GIT_HANDOFF_START_WORKTREE,
    wrapHandler(IPC.GIT_HANDOFF_START_WORKTREE, async (_e: Electron.IpcMainInvokeEvent, req: unknown): Promise<HandoffStartResult> => {
      const repoPath = (req as { repoPath?: unknown } | null)?.repoPath;
      // F2 (#615): confine the renderer path before it reaches git / the fan-out.
      const safe = typeof repoPath === 'string' ? await resolveAccessiblePath(repoPath) : null;
      if (!safe) return { ok: false, code: 'invalid', message: 'repoPath required' };
      return startHandoffWorktree(deps, { ...(req as object), repoPath: safe });
    }),
  );
  return () => {
    unwatch();
    ipcMain.removeHandler(IPC.GIT_HANDOFF_SEND);
    ipcMain.removeHandler(IPC.GIT_HANDOFF_START_WORKTREE);
  };
}
