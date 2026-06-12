// Project config IPC (X5 wmux.json) — thin renderer-facing surface over
// ProjectConfigStore. Both channels are renderer-only (no pipe RPC exposure):
// external MCP clients have no business reading or — far worse — GRANTING
// project trust, so the trust mutation stays behind the first-party IPC
// boundary the same way session.save does.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { getProjectConfigStore, type ProjectConfigState } from '../../project/ProjectConfigStore';

const MAX_PATH_LEN = 4096;

export function registerProjectConfigHandlers(): () => void {
  ipcMain.removeHandler(IPC.PROJECT_CONFIG_GET);
  ipcMain.handle(IPC.PROJECT_CONFIG_GET, wrapHandler(IPC.PROJECT_CONFIG_GET, async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: unknown,
  ): Promise<ProjectConfigState> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_LEN) {
      return { found: false };
    }
    return getProjectConfigStore().getState(cwd);
  }));

  ipcMain.removeHandler(IPC.PROJECT_CONFIG_SET_TRUST);
  ipcMain.handle(IPC.PROJECT_CONFIG_SET_TRUST, wrapHandler(IPC.PROJECT_CONFIG_SET_TRUST, async (
    _event: Electron.IpcMainInvokeEvent,
    root: unknown,
    decision: unknown,
    contentHash: unknown,
  ): Promise<{ ok: boolean }> => {
    if (typeof root !== 'string' || root.length === 0 || root.length > MAX_PATH_LEN) {
      throw new Error('Invalid project root');
    }
    const store = getProjectConfigStore();
    if (decision === 'clear') {
      await store.clearDecision(root);
      return { ok: true };
    }
    if (decision !== 'trusted' && decision !== 'denied') {
      throw new Error('Invalid trust decision');
    }
    if (typeof contentHash !== 'string') throw new Error('Invalid content hash');
    await store.setDecision(root, decision, contentHash);
    return { ok: true };
  }));

  return () => {
    ipcMain.removeHandler(IPC.PROJECT_CONFIG_GET);
    ipcMain.removeHandler(IPC.PROJECT_CONFIG_SET_TRUST);
  };
}
