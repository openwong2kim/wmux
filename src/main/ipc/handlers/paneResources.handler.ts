import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import { collectPaneResources, type PaneResources } from '../../perf/paneResources';

/**
 * TASK-6 — Fleet View per-pane resource attribution.
 *
 * Renderer (only while Fleet View is visible) invokes PANE_RESOURCES with the
 * list of ptyIds currently shown as cards. This handler:
 *   1. asks the daemon for the live session list (ptyId === session id → pid),
 *   2. maps each requested ptyId to its shell PID,
 *   3. takes ONE Win32_Process snapshot and walks each pane's descendant tree
 *      (see perf/paneResources.ts), summing RAM and picking the heaviest child
 *      image as the chip label.
 *
 * All polling cadence and the visibility gate live in the renderer — this
 * handler is a pure request/response and does nothing on its own, so a closed
 * cockpit issues zero CIM snapshots (plan acceptance criterion).
 *
 * Fail-soft everywhere: no daemon, non-Windows, or a failed snapshot returns
 * `{}` and the renderer renders no chips.
 */
export function registerPaneResourcesHandlers(daemonClient?: DaemonClient): () => void {
  ipcMain.removeHandler(IPC.PANE_RESOURCES);
  ipcMain.handle(
    IPC.PANE_RESOURCES,
    wrapHandler(
      IPC.PANE_RESOURCES,
      async (_event: Electron.IpcMainInvokeEvent, ptyIds: string[]): Promise<Record<string, PaneResources>> => {
        if (!daemonClient || !Array.isArray(ptyIds) || ptyIds.length === 0) return {};
        // Resolve ptyId → shell PID from the daemon's authoritative session list.
        const sessions = (await daemonClient.rpc('daemon.listSessions', {})) as Array<{
          id: string;
          pid?: number;
          state?: string;
        }>;
        const wanted = new Set(ptyIds);
        const paneRoots = new Map<string, number>();
        for (const s of sessions) {
          if (!wanted.has(s.id)) continue;
          if (s.state === 'dead' || s.state === 'suspended') continue;
          if (typeof s.pid === 'number' && s.pid > 0) paneRoots.set(s.id, s.pid);
        }
        return collectPaneResources(paneRoots);
      },
    ),
  );
  return () => ipcMain.removeHandler(IPC.PANE_RESOURCES);
}
