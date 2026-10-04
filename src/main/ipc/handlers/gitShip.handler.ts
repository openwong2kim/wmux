// The Git page's ship button: the current branch's status and its three
// writes (commit, push, create PR). Renderer-only IPC. Each write re-reads the
// status and re-checks the ship state machine here, so a stale button cannot
// push a branch that is behind or open a PR from the default branch.
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { resolveAccessiblePath } from './fs.handler';
import { shipActions, type ShipActionResult, type ShipStatus, type ShipStatusResult } from '../../git/shipActions';
import { shipBlock, type ShipAction, type ShipInput } from '../../../shared/gitShip';

/** The state machine's input from a status (the merge session is the page's to report). */
export function shipInputOf(st: ShipStatus): ShipInput {
  return {
    dirty: st.dirty,
    ahead: st.ahead,
    behind: st.behind,
    hasUpstream: st.upstream !== null,
    detached: st.detached,
    onDefaultBranch: st.branch !== null && st.branch === (st.defaultBranch ?? ''),
    pr: st.pr,
    mergeActive: false,
  };
}

async function guarded(repoPath: unknown, action: ShipAction, run: (cwd: string, st: ShipStatus) => Promise<ShipActionResult>): Promise<ShipActionResult> {
  if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
  const cwd = await resolveAccessiblePath(repoPath);
  if (!cwd) return { ok: false, error: 'repoPath required' };
  const res = await shipActions.status(cwd);
  if (!res.ok) return res;
  const blocked = shipBlock(action, shipInputOf(res.status));
  if (blocked) return { ok: false, error: `cannot ${action} now: ${blocked}` };
  return run(cwd, res.status);
}

export function registerGitShipHandlers(): () => void {
  const channels = [IPC.GIT_SHIP_STATUS, IPC.GIT_SHIP_COMMIT, IPC.GIT_SHIP_PUSH, IPC.GIT_SHIP_CREATE_PR];
  for (const c of channels) ipcMain.removeHandler(c);

  ipcMain.handle(
    IPC.GIT_SHIP_STATUS,
    wrapHandler(IPC.GIT_SHIP_STATUS, async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown): Promise<ShipStatusResult> => {
      if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
      const cwd = await resolveAccessiblePath(repoPath);
      if (!cwd) return { ok: false, error: 'repoPath required' };
      return shipActions.status(cwd);
    }),
  );
  ipcMain.handle(
    IPC.GIT_SHIP_COMMIT,
    wrapHandler(IPC.GIT_SHIP_COMMIT, (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, message: unknown) =>
      guarded(repoPath, 'commit', (cwd) => shipActions.commit(cwd, typeof message === 'string' ? message : ''))),
  );
  ipcMain.handle(
    IPC.GIT_SHIP_PUSH,
    wrapHandler(IPC.GIT_SHIP_PUSH, (_e: Electron.IpcMainInvokeEvent, repoPath: unknown) =>
      guarded(repoPath, 'push', (cwd) => shipActions.push(cwd))),
  );
  ipcMain.handle(
    IPC.GIT_SHIP_CREATE_PR,
    wrapHandler(IPC.GIT_SHIP_CREATE_PR, (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, title: unknown) =>
      guarded(repoPath, 'createPr', (cwd, st) => shipActions.createPr(cwd, st.branch ?? '', typeof title === 'string' ? title : ''))),
  );

  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
