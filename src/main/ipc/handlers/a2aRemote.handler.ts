import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { A2A_REMOTE_RPC } from '../../../shared/a2aRemoteDelivery';
import type { A2aRemoteHostStatus, A2aRemoteLinkEvent, A2aRemoteLinkProposeParams } from '../../../shared/rpc';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import { detectRemote } from '../../github/PrProvider';
import { A2aExposurePublisher, coercePaneSnapshot } from '../../a2aRemote/exposurePublisher';
import type { RemoteA2aBridge } from '../../a2a/RemoteA2aBridge';

// Module scope: the handlers are re-registered on every daemon (re)connect,
// but the last pane snapshot (the gone-pane baseline) must outlive that.
let liveClient: DaemonClient | null = null;
const publisher = new A2aExposurePublisher({
  client: () => liveClient,
  repoKey: async (cwd) => (await detectRemote(cwd))?.key ?? null,
  log: (msg) => console.warn(`[a2a-remote] ${msg}`),
});

const LINK_EVENTS: ReadonlySet<string> = new Set(['a2a.remote.link.proposed', 'a2a.remote.link.changed']);

/** main's delivery bridge (set per daemon connection): the only path that may retry a hold. */
let remoteBridge: RemoteA2aBridge | null = null;
export function setA2aRemoteBridge(bridge: RemoteA2aBridge | null): void {
  remoteBridge = bridge;
}

/**
 * Cross-host A2A — Settings ↔ daemon control-plane IPC. Thin pass-throughs
 * to the daemon's `a2a.remote.*` control-pipe RPCs (lanlink.handler.ts
 * precedent): every renderer-supplied value is re-validated daemon-side.
 * Daemon-mode only; without a DaemonClient the Settings section shows itself
 * as unavailable.
 */
export function registerA2aRemoteHandlers(daemonClient: DaemonClient): () => void {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const handlers: Array<[string, (...args: unknown[]) => Promise<unknown>]> = [
    [IPC.A2A_REMOTE_STATUS, () => daemonClient.a2aRemoteStatus()],
    [
      IPC.A2A_REMOTE_CONFIGURE,
      (patch) => daemonClient.a2aRemoteConfigure((patch ?? {}) as { enabled?: boolean; port?: number }),
    ],
    [IPC.A2A_REMOTE_PAIR_BEGIN, () => daemonClient.a2aRemotePairBegin()],
    [IPC.A2A_REMOTE_PAIR_CANCEL, () => daemonClient.a2aRemotePairCancel()],
    [IPC.A2A_REMOTE_PAIR_STATUS, () => daemonClient.a2aRemotePairStatus()],
    [IPC.A2A_REMOTE_JOIN, (invite) => daemonClient.a2aRemoteJoin(str(invite))],
    [IPC.A2A_REMOTE_HOSTS_LIST, () => daemonClient.a2aRemoteHostsList()],
    [IPC.A2A_REMOTE_HOSTS_REMOVE, (hostId) => daemonClient.a2aRemoteHostsRemove(str(hostId))],
    [IPC.A2A_REMOTE_PEERS_LIST, () => daemonClient.a2aRemotePeersList()],
    [IPC.A2A_REMOTE_PEERS_REVOKE, (peerId) => daemonClient.a2aRemotePeersRevoke(str(peerId))],
    [
      IPC.A2A_REMOTE_SNAPSHOT,
      async (snapshot) => {
        const parsed = coercePaneSnapshot(snapshot);
        if (parsed) await publisher.accept(parsed);
        return { ok: parsed !== null };
      },
    ],
    [IPC.A2A_REMOTE_EXPOSURE_GET, (hostId) => daemonClient.a2aRemoteExposureGet(str(hostId))],
    [
      IPC.A2A_REMOTE_EXPOSURE_SET,
      async (hostId, workspaceIds, paneIds, brain) => {
        const result = await daemonClient.a2aRemoteExposureSet(
          str(hostId),
          Array.isArray(workspaceIds) ? workspaceIds.filter((w): w is string => typeof w === 'string') : [],
          (paneIds ?? {}) as Record<string, string[]>,
          brain === true,
        );
        // A newly exposed workspace's panes must be listed before the other PC looks.
        await publisher.republish();
        return result;
      },
    ],
    [IPC.A2A_REMOTE_HOSTS_EXPOSED, (hostId) => daemonClient.a2aRemoteHostsExposed(str(hostId))],
    [IPC.A2A_REMOTE_LINKS_LIST, () => daemonClient.a2aRemoteLinksList()],
    [IPC.A2A_REMOTE_LINKS_PROPOSE, (params) => daemonClient.a2aRemoteLinksPropose((params ?? {}) as A2aRemoteLinkProposeParams)],
    [IPC.A2A_REMOTE_LINKS_ACCEPT, (linkId) => daemonClient.a2aRemoteLinkAction('accept', str(linkId))],
    [IPC.A2A_REMOTE_LINKS_REJECT, (linkId) => daemonClient.a2aRemoteLinkAction('reject', str(linkId))],
    [IPC.A2A_REMOTE_LINKS_REVOKE, (linkId) => daemonClient.a2aRemoteLinkAction('revoke', str(linkId))],
    [IPC.A2A_REMOTE_LINKS_REFRESH, (linkId) => daemonClient.a2aRemoteLinkAction('refresh', str(linkId))],
    [IPC.A2A_REMOTE_HOSTS_STATUS, () => daemonClient.rpc('a2a.remote.hosts.status', {})],
    [IPC.A2A_REMOTE_HELD_LIST, () => daemonClient.rpc(A2A_REMOTE_RPC.held, {})],
    [
      IPC.A2A_REMOTE_HELD_RETRY,
      async (taskId) => remoteBridge ? remoteBridge.retryHeld(str(taskId)) : { ok: false, results: [], error: 'unavailable' },
    ],
    // A person's reject from the held list.
    [IPC.A2A_REMOTE_HELD_REJECT, (taskId) => daemonClient.rpc(A2A_REMOTE_RPC.rejectHeld, { taskId: str(taskId), reason: 'rejected-by-person' })],
  ];
  for (const [channel, fn] of handlers) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, (_event, ...args: unknown[]) => fn(...args)));
  }
  // Daemon link nudges → every window (the renderer re-reads the link list).
  const onEvent = (event: { type?: unknown; data?: unknown }): void => {
    if (typeof event.type !== 'string') return;
    let channel: string;
    if (LINK_EVENTS.has(event.type)) channel = IPC.A2A_REMOTE_LINK_EVENT;
    else if (event.type === 'a2a.remote.hosts.status') channel = IPC.A2A_REMOTE_HOST_STATUS_EVENT;
    else return;
    const payload = event.data as A2aRemoteLinkEvent | A2aRemoteHostStatus;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };
  daemonClient.on('event', onEvent);
  liveClient = daemonClient;
  // A restarted daemon starts with an empty exposure snapshot.
  void publisher.republish();
  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
    daemonClient.off('event', onEvent);
    if (liveClient === daemonClient) liveClient = null;
  };
}
