// IPC for pane usage-limit holds (shared/usageLimit). The daemon owns the
// state; this relays its changes to the renderer (and main's mirror), answers
// the renderer's boot list, and forwards the renderer's edits.

import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/constants';
import type { PaneUsageLimit, PaneUsageLimitPatch } from '../../shared/usageLimit';
import type { DaemonClient } from '../DaemonClient';
import {
  forgetPaneUsage,
  notePaneUsageLimit,
  replacePaneUsageLimits,
  setUsageLimitResetFiller,
} from './paneUsageLimits';

export function registerUsageLimitHandlers(
  daemonClient: DaemonClient | undefined,
  getWindow: () => BrowserWindow | null,
): () => void {
  const onChanged = (payload: { sessionId: string; limit: PaneUsageLimit | null }): void => {
    notePaneUsageLimit(payload.sessionId, payload.limit);
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.USAGE_LIMIT_CHANGED, { ptyId: payload.sessionId, limit: payload.limit });
    }
  };
  const onGone = (payload: { sessionId: string }): void => forgetPaneUsage(payload.sessionId);

  ipcMain.removeHandler(IPC.USAGE_LIMIT_LIST);
  ipcMain.handle(IPC.USAGE_LIMIT_LIST, async () => {
    const list = daemonClient ? await daemonClient.listUsageLimits() : [];
    replacePaneUsageLimits(list);
    return list;
  });
  ipcMain.removeHandler(IPC.USAGE_LIMIT_UPDATE);
  ipcMain.handle(IPC.USAGE_LIMIT_UPDATE, async (_event, args: { ptyId?: unknown; patch?: unknown }) => {
    if (!daemonClient || typeof args?.ptyId !== 'string' || !args.patch || typeof args.patch !== 'object') return { ok: false };
    const p = args.patch as Record<string, unknown>;
    // Only the renderer's own verbs; a reset time is main's to fill, not the renderer's.
    const patch: PaneUsageLimitPatch = {
      ...(typeof p.autoResume === 'boolean' ? { autoResume: p.autoResume } : {}),
      ...(p.dismiss === true ? { dismiss: true as const } : {}),
      ...(p.resumeNow === true ? { resumeNow: true as const } : {}),
    };
    return { ok: await daemonClient.updateUsageLimit(args.ptyId, patch) };
  });

  if (daemonClient) {
    daemonClient.on('usageLimit:changed', onChanged);
    daemonClient.on('session:died', onGone);
    daemonClient.on('session:destroyed', onGone);
    setUsageLimitResetFiller((ptyId, resetsAt) => { void daemonClient.updateUsageLimit(ptyId, { resetsAt }); });
    // A reconnect (or a main restart over a living daemon) starts from the daemon's truth.
    void daemonClient.listUsageLimits().then(replacePaneUsageLimits);
  }

  return () => {
    ipcMain.removeHandler(IPC.USAGE_LIMIT_LIST);
    ipcMain.removeHandler(IPC.USAGE_LIMIT_UPDATE);
    setUsageLimitResetFiller(null);
    if (daemonClient) {
      daemonClient.removeListener('usageLimit:changed', onChanged);
      daemonClient.removeListener('session:died', onGone);
      daemonClient.removeListener('session:destroyed', onGone);
    }
  };
}
