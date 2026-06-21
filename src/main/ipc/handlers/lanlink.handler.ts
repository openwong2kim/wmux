import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import type { LanLinkConfigurePatch, LanLinkStatus } from '../../../shared/lanlink';

/**
 * LanLink PR-3 — Settings ↔ daemon control-plane IPC. Forwards the renderer's
 * status read and configure write to the daemon control pipe (DaemonClient), which
 * is the single source of truth for the enable/NIC state. Mirrors mcp.handler.ts.
 *
 * Daemon-mode only: registered just when a DaemonClient exists. The handlers are
 * thin pass-throughs — all validation/persistence lives daemon-side in
 * LanLinkController (the renderer-supplied patch is re-validated there via
 * coerceLanLinkPatch, so a malformed payload is rejected at the trust boundary).
 *
 * @param daemonClient The connected DaemonClient (control pipe to the daemon).
 */
export function registerLanLinkHandlers(daemonClient: DaemonClient): () => void {
  ipcMain.removeHandler(IPC.LANLINK_STATUS);
  ipcMain.handle(
    IPC.LANLINK_STATUS,
    wrapHandler(IPC.LANLINK_STATUS, async (): Promise<LanLinkStatus> => {
      return daemonClient.lanlinkStatus();
    }),
  );

  ipcMain.removeHandler(IPC.LANLINK_CONFIGURE);
  ipcMain.handle(
    IPC.LANLINK_CONFIGURE,
    wrapHandler(
      IPC.LANLINK_CONFIGURE,
      async (_event, patch: LanLinkConfigurePatch): Promise<LanLinkStatus> => {
        return daemonClient.lanlinkConfigure(patch);
      },
    ),
  );

  return () => {
    ipcMain.removeHandler(IPC.LANLINK_STATUS);
    ipcMain.removeHandler(IPC.LANLINK_CONFIGURE);
  };
}
