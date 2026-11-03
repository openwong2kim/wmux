// The Git page's ship button: the current branch's status and its three
// writes (commit, push, create PR). Renderer-only IPC.
//
// Each write runs under the repo's write lock (shared with the merge
// session's start / land / discard), re-reads the status, checks on disk
// whether a merge session is running, re-checks the ship state machine, and
// refuses unless the branch and HEAD are still the ones the user saw. So a
// stale button cannot push a branch that is behind, open a PR from the
// default branch, commit into a merge, or land on a branch an agent switched
// to while the dialog was open.
import { ensureSecretHook, secretHooks } from '../../git/secretHookHost';
import { setWithholdCredentialsFromAgents, withholdCredentialsFromAgents } from '../../pty/credentialEnvPrefs';
import { ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { isNonLocalPath, isSensitivePath, resolveAccessiblePath } from './fs.handler';
import { mergeStatus, repoLockKeyFor, withRepoLock } from './worktree.handler';
import { shipActions, type ShipActionResult, type ShipExpect, type ShipStatus, type ShipStatusResult } from '../../git/shipActions';
import { shipBlock, type ShipAction, type ShipInput } from '../../../shared/gitShip';

/** The state machine's input from a status and whether a merge session runs. */
export function shipInputOf(st: ShipStatus, mergeActive = false): ShipInput {
  return {
    dirty: st.dirty,
    ahead: st.ahead,
    behind: st.behind,
    hasUpstream: st.upstream !== null,
    detached: st.detached,
    onDefaultBranch: st.branch !== null && st.branch === st.defaultBranch,
    defaultBranchKnown: st.defaultBranch !== null,
    conflicts: st.conflicts,
    inProgress: st.inProgress,
    pr: st.pr,
    mergeActive,
  };
}

/** The pinned branch + HEAD from untrusted input, or null. */
export function parseExpect(raw: unknown): ShipExpect | null {
  if (!raw || typeof raw !== 'object') return null;
  const { branch, head } = raw as { branch?: unknown; head?: unknown };
  if (typeof branch !== 'string' || !branch || branch.length > 255 || /[\s\0]/.test(branch)) return null;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return null;
  return { branch, head };
}

type Deps = {
  status: (cwd: string) => Promise<ShipStatusResult>;
  mergeRunning: (cwd: string) => Promise<boolean>;
};

const defaultDeps: Deps = {
  status: (cwd) => shipActions.status(cwd),
  mergeRunning: async (cwd) => {
    const ms = await mergeStatus(cwd);
    return ms.ok && ms.status !== null;
  },
};

/** The checks every write passes, under the lock. Exported for tests. */
export async function checkWrite(cwd: string, action: ShipAction, expect: ShipExpect, deps: Deps = defaultDeps): Promise<{ ok: true; status: ShipStatus } | { ok: false; error: string }> {
  const res = await deps.status(cwd);
  if (!res.ok) return res;
  const st = res.status;
  if (st.branch !== expect.branch || st.head !== expect.head) {
    return { ok: false, error: 'the branch changed since this was opened; check again' };
  }
  const blocked = shipBlock(action, shipInputOf(st, await deps.mergeRunning(cwd)));
  if (blocked) return { ok: false, error: `cannot ${action} now: ${blocked}` };
  return { ok: true, status: st };
}

/** The refusal for a repo path that does not resolve: its folder is gone, or
 *  it is not one wmux may use. Only a path wmux may use is looked up on disk,
 *  so every other path gets the same answer whether it exists or not. */
function unresolved(repoPath: string): { ok: false; error: string; reason?: 'missing-folder' } {
  if (isNonLocalPath(repoPath) || isSensitivePath(path.resolve(repoPath)) || existsSync(repoPath)) return { ok: false, error: 'repoPath required' };
  return { ok: false, error: 'the folder is not there any more', reason: 'missing-folder' };
}

async function guarded(
  repoPath: unknown,
  rawExpect: unknown,
  action: ShipAction,
  run: (cwd: string, expect: ShipExpect) => Promise<ShipActionResult>,
): Promise<ShipActionResult> {
  if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
  const expect = parseExpect(rawExpect);
  if (!expect) return { ok: false, error: 'the branch and commit to act on are required' };
  const cwd = await resolveAccessiblePath(repoPath);
  if (!cwd) return unresolved(repoPath);
  const key = await repoLockKeyFor(cwd);
  if (!key) return { ok: false, error: 'not a git repository' };
  return withRepoLock(key, async () => {
    const ok = await checkWrite(cwd, action, expect);
    if (!ok.ok) return ok;
    return run(cwd, expect);
  });
}

export function registerGitShipHandlers(): () => void {
  const channels = [IPC.GIT_SHIP_STATUS, IPC.GIT_SHIP_COMMIT, IPC.GIT_SHIP_PUSH, IPC.GIT_SHIP_CREATE_PR, IPC.GIT_SECRET_HOOK_GET, IPC.GIT_SECRET_HOOK_SET, IPC.CREDENTIAL_ENV_GET, IPC.CREDENTIAL_ENV_SET];
  for (const c of channels) ipcMain.removeHandler(c);

  ipcMain.handle(
    IPC.GIT_SECRET_HOOK_GET,
    wrapHandler(IPC.GIT_SECRET_HOOK_GET, async () => ({ autoInstall: secretHooks.autoInstall })),
  );
  ipcMain.handle(
    IPC.GIT_SECRET_HOOK_SET,
    wrapHandler(IPC.GIT_SECRET_HOOK_SET, async (_e: Electron.IpcMainInvokeEvent, on: unknown) => {
      if (typeof on !== 'boolean') throw new Error('on must be a boolean');
      return secretHooks.setAutoInstall(on);
    }),
  );
  // Withhold credentials from agent panes (main/pty/credentialEnvPrefs.ts).
  // Applies to panes spawned after the change; running panes keep their env.
  ipcMain.handle(
    IPC.CREDENTIAL_ENV_GET,
    wrapHandler(IPC.CREDENTIAL_ENV_GET, async () => ({ withholdFromAgents: withholdCredentialsFromAgents() })),
  );
  ipcMain.handle(
    IPC.CREDENTIAL_ENV_SET,
    wrapHandler(IPC.CREDENTIAL_ENV_SET, async (_e: Electron.IpcMainInvokeEvent, on: unknown) => {
      if (typeof on !== 'boolean') throw new Error('on must be a boolean');
      return setWithholdCredentialsFromAgents(on);
    }),
  );

  ipcMain.handle(
    IPC.GIT_SHIP_STATUS,
    wrapHandler(IPC.GIT_SHIP_STATUS, async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown): Promise<ShipStatusResult> => {
      if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
      const cwd = await resolveAccessiblePath(repoPath);
      if (!cwd) return unresolved(repoPath);
      // A repository opened in wmux gets the pre-commit secret check, so a
      // commit from any terminal is checked too (once per repo per run).
      ensureSecretHook(cwd);
      return shipActions.status(cwd);
    }),
  );
  ipcMain.handle(
    IPC.GIT_SHIP_COMMIT,
    wrapHandler(IPC.GIT_SHIP_COMMIT, (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, message: unknown, expect: unknown, opts: unknown) => {
      // Unsigned only when this one call asks for it (the user's click).
      const noSign = !!opts && typeof opts === 'object' && (opts as { noSign?: unknown }).noSign === true;
      return guarded(repoPath, expect, 'commit', (cwd, ex) => shipActions.commit(cwd, typeof message === 'string' ? message : '', ex, noSign ? { noSign: true } : {}));
    }),
  );
  ipcMain.handle(
    IPC.GIT_SHIP_PUSH,
    wrapHandler(IPC.GIT_SHIP_PUSH, (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, expect: unknown) =>
      guarded(repoPath, expect, 'push', (cwd, ex) => shipActions.push(cwd, ex))),
  );
  ipcMain.handle(
    IPC.GIT_SHIP_CREATE_PR,
    wrapHandler(IPC.GIT_SHIP_CREATE_PR, (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, title: unknown, expect: unknown) =>
      guarded(repoPath, expect, 'createPr', (cwd, ex) => shipActions.createPr(cwd, typeof title === 'string' ? title : '', ex))),
  );

  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
