import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import type {
  LanLinkConfigurePatch,
  LanLinkStatus,
  LanLinkPairBeginResult,
  LanLinkPairingStatus,
  LanLinkPairJoinArgs,
  LanLinkJoinResult,
  LanLinkSendArgs,
  LanLinkPeersListResult,
} from '../../../shared/lanlink';

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

  // LanLink PR-5 — pairing/peer control plane. Thin pass-throughs (same posture as
  // status/configure above; the daemon control pipe is the trust boundary). These
  // forward to outbound-only RPCs (pair/send) or read-only queries (status/peers).
  ipcMain.removeHandler(IPC.LANLINK_PAIR_BEGIN);
  ipcMain.handle(
    IPC.LANLINK_PAIR_BEGIN,
    wrapHandler(IPC.LANLINK_PAIR_BEGIN, async (): Promise<LanLinkPairBeginResult> => {
      return daemonClient.lanlinkPairBegin();
    }),
  );

  ipcMain.removeHandler(IPC.LANLINK_PAIR_STATUS);
  ipcMain.handle(
    IPC.LANLINK_PAIR_STATUS,
    wrapHandler(IPC.LANLINK_PAIR_STATUS, async (): Promise<LanLinkPairingStatus> => {
      return daemonClient.lanlinkPairStatus();
    }),
  );

  ipcMain.removeHandler(IPC.LANLINK_PAIR_CANCEL);
  ipcMain.handle(
    IPC.LANLINK_PAIR_CANCEL,
    wrapHandler(IPC.LANLINK_PAIR_CANCEL, async (): Promise<{ ok: true }> => {
      return daemonClient.lanlinkPairCancel();
    }),
  );

  ipcMain.removeHandler(IPC.LANLINK_PAIR_JOIN);
  ipcMain.handle(
    IPC.LANLINK_PAIR_JOIN,
    wrapHandler(
      IPC.LANLINK_PAIR_JOIN,
      async (_event, args: LanLinkPairJoinArgs): Promise<LanLinkJoinResult> => {
        return daemonClient.lanlinkPairJoin(args);
      },
    ),
  );

  ipcMain.removeHandler(IPC.LANLINK_SEND);
  ipcMain.handle(
    IPC.LANLINK_SEND,
    wrapHandler(
      IPC.LANLINK_SEND,
      async (_event, args: LanLinkSendArgs): Promise<{ ok: true }> => {
        return daemonClient.lanlinkSend(args);
      },
    ),
  );

  ipcMain.removeHandler(IPC.LANLINK_PEERS_LIST);
  ipcMain.handle(
    IPC.LANLINK_PEERS_LIST,
    wrapHandler(IPC.LANLINK_PEERS_LIST, async (): Promise<LanLinkPeersListResult> => {
      return daemonClient.lanlinkPeersList();
    }),
  );

  ipcMain.removeHandler(IPC.LANLINK_PEERS_REMOVE);
  ipcMain.handle(
    IPC.LANLINK_PEERS_REMOVE,
    wrapHandler(
      IPC.LANLINK_PEERS_REMOVE,
      async (_event, peerUuid: string): Promise<{ ok: true }> => {
        return daemonClient.lanlinkPeersRemove(peerUuid);
      },
    ),
  );

  return () => {
    ipcMain.removeHandler(IPC.LANLINK_STATUS);
    ipcMain.removeHandler(IPC.LANLINK_CONFIGURE);
    ipcMain.removeHandler(IPC.LANLINK_PAIR_BEGIN);
    ipcMain.removeHandler(IPC.LANLINK_PAIR_STATUS);
    ipcMain.removeHandler(IPC.LANLINK_PAIR_CANCEL);
    ipcMain.removeHandler(IPC.LANLINK_PAIR_JOIN);
    ipcMain.removeHandler(IPC.LANLINK_SEND);
    ipcMain.removeHandler(IPC.LANLINK_PEERS_LIST);
    ipcMain.removeHandler(IPC.LANLINK_PEERS_REMOVE);
  };
}
