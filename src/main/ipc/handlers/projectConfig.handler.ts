// Project config IPC (X5 wmux.json) — thin renderer-facing surface over
// ProjectConfigStore. Both channels are renderer-only (no pipe RPC exposure):
// external MCP clients have no business reading or — far worse — GRANTING
// project trust, so the trust mutation stays behind the first-party IPC
// boundary the same way session.save does.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { getProjectConfigStore, type ProjectConfigState } from '../../project/ProjectConfigStore';
import type { SessionLocation } from '../../../shared/sessionLocation';

const MAX_PATH_LEN = 4096;

export function registerProjectConfigHandlers(): () => void {
  ipcMain.removeHandler(IPC.PROJECT_CONFIG_GET);
  ipcMain.handle(IPC.PROJECT_CONFIG_GET, wrapHandler(IPC.PROJECT_CONFIG_GET, async (
    _event: Electron.IpcMainInvokeEvent,
    raw: unknown,
  ): Promise<ProjectConfigState> => {
    const location = readLocation(raw);
    if (!location) {
      return { found: false };
    }
    return getProjectConfigStore().getState(location);
  }));

  ipcMain.removeHandler(IPC.PROJECT_CONFIG_SET_TRUST);
  ipcMain.handle(IPC.PROJECT_CONFIG_SET_TRUST, wrapHandler(IPC.PROJECT_CONFIG_SET_TRUST, async (
    _event: Electron.IpcMainInvokeEvent,
    root: unknown,
    decision: unknown,
    contentHash: unknown,
    unattended: unknown,
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
    // Unattended reboot-survival consent is a strict opt-in boolean; anything
    // that isn't literally true (absent, non-boolean) is treated as no consent.
    await store.setDecision(root, decision, contentHash, unattended === true);
    return { ok: true };
  }));

  return () => {
    ipcMain.removeHandler(IPC.PROJECT_CONFIG_GET);
    ipcMain.removeHandler(IPC.PROJECT_CONFIG_SET_TRUST);
  };
}

function readLocation(raw: unknown): string | SessionLocation | null {
  if (typeof raw === 'string') {
    return raw.length > 0 && raw.length <= MAX_PATH_LEN ? raw : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const location = (raw as { location?: unknown }).location;
  if (!location || typeof location !== 'object' || Array.isArray(location)) return null;
  const candidate = location as Partial<SessionLocation>;
  if (
    (candidate.domain !== 'host' && candidate.domain !== 'wsl')
    || typeof candidate.cwd !== 'string'
    || candidate.cwd.length === 0
    || candidate.cwd.length > MAX_PATH_LEN
    || typeof candidate.shell !== 'string'
  ) return null;
  if (candidate.domain === 'wsl' && candidate.distro !== undefined && typeof candidate.distro !== 'string') {
    return null;
  }
  return candidate as SessionLocation;
}
