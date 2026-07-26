// Project config IPC (X5 wmux.json) — thin renderer-facing surface over
// ProjectConfigStore. Both channels are renderer-only (no pipe RPC exposure):
// external MCP clients have no business reading or — far worse — GRANTING
// project trust, so the trust mutation stays behind the first-party IPC
// boundary the same way session.save does.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { getProjectConfigStore, type ProjectConfigState } from '../../project/ProjectConfigStore';
import { parseSessionLocation, type SessionLocation } from '../../../shared/sessionLocation';

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

/**
 * Renderer payload → SessionLocation. The wire contract belongs to
 * `parseSessionLocation` (issue #21 — it used to be re-declared here, and this
 * copy rejected `msys`, so a Git Bash pane never got its project config).
 *
 * The only thing left here is the renderer-payload length cap, which is a
 * resource guard on an untrusted string rather than part of the location
 * contract.
 */
function readLocation(raw: unknown): SessionLocation | null {
  const location = parseSessionLocation(
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { location?: unknown }).location
      : raw,
  );
  if (!location) return null;
  return location.cwd.length <= MAX_PATH_LEN ? location : null;
}
