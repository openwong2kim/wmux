import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { A2A_REMOTE_RPC } from '../../../shared/a2aRemoteDelivery';
import { A2A_SPAWN_OUTGOING_EVENT, SPAWN_REQUEST_KEY_RE, coerceSpawnPolicy, type A2aSpawnUiAsk } from '../../../shared/a2aSpawn';
import { isAgentSlug } from '../../../shared/agentIdentity';
import { getFanOutGuards } from '../../worktask/fanoutGuards';
import type {
  A2aRemoteExposureGetResult,
  A2aRemoteHostStatus,
  A2aRemoteLinkEvent,
  A2aRemoteLinkProposeParams,
  A2aRemoteOfferAcceptParams,
  A2aRemoteOfferEvent,
  A2aRemoteOfferShareParams,
} from '../../../shared/rpc';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import { detectRemote } from '../../github/PrProvider';
import { A2aExposurePublisher, coercePaneSnapshot } from '../../a2aRemote/exposurePublisher';
import type { RemoteA2aBridge } from '../../a2a/RemoteA2aBridge';
import { finalizeSpawnPrompt } from '../../../shared/a2aSpawnPrompt';

// Module scope: the handlers are re-registered on every daemon (re)connect,
// but the last pane snapshot (the gone-pane baseline) must outlive that.
let liveClient: DaemonClient | null = null;
const publisher = new A2aExposurePublisher({
  client: () => liveClient,
  repoKey: async (cwd) => (await detectRemote(cwd))?.key ?? null,
  log: (msg) => console.warn(`[a2a-remote] ${msg}`),
});

// Share offer nudges ride the link channel: the renderer re-reads both lists.
const LINK_EVENTS: ReadonlySet<string> = new Set(['a2a.remote.link.proposed', 'a2a.remote.link.changed', 'a2a.remote.offer.changed', A2A_SPAWN_OUTGOING_EVENT]);

/** How long a call made before the daemon connected waits for it (the
 *  renderer reads the Remote feed at start, racing the boot connect). */
export const A2A_REMOTE_CLIENT_WAIT_MS = 15_000;

/** Calls waiting for the first (or next) daemon client. */
let clientWaiters: Array<(client: DaemonClient) => void> = [];

/** The live client, or the next one within `timeoutMs`; rejects with a
 *  DAEMON_DISCONNECTED error when none arrives. */
function waitForClient(timeoutMs: number): Promise<DaemonClient> {
  if (liveClient) return Promise.resolve(liveClient);
  return new Promise((resolve, reject) => {
    const onClient = (client: DaemonClient): void => {
      clearTimeout(timer);
      resolve(client);
    };
    const timer = setTimeout(() => {
      clientWaiters = clientWaiters.filter((w) => w !== onClient);
      reject(Object.assign(new Error('the daemon is not connected'), { code: 'DAEMON_DISCONNECTED' }));
    }, timeoutMs);
    timer.unref?.();
    clientWaiters.push(onClient);
  });
}

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
export function registerA2aRemoteHandlers(daemonClient: DaemonClient | null, opts: { clientWaitMs?: number } = {}): () => void {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  // Reads wait for a client that is about to connect; an action the owner
  // took is refused at once instead of running seconds later.
  const client = (): Promise<DaemonClient> => waitForClient(opts.clientWaitMs ?? A2A_REMOTE_CLIENT_WAIT_MS);
  const clientNow = (): Promise<DaemonClient> => waitForClient(0);
  const handlers: Array<[string, (...args: unknown[]) => Promise<unknown>]> = [
    [IPC.A2A_REMOTE_STATUS, async () => (await client()).a2aRemoteStatus()],
    [
      IPC.A2A_REMOTE_CONFIGURE,
      async (patch) => (await clientNow()).a2aRemoteConfigure((patch ?? {}) as { enabled?: boolean; port?: number }),
    ],
    [IPC.A2A_REMOTE_PAIR_BEGIN, async () => (await clientNow()).a2aRemotePairBegin()],
    [IPC.A2A_REMOTE_PAIR_CANCEL, async () => (await clientNow()).a2aRemotePairCancel()],
    [IPC.A2A_REMOTE_PAIR_STATUS, async () => (await client()).a2aRemotePairStatus()],
    [IPC.A2A_REMOTE_JOIN, async (invite) => (await clientNow()).a2aRemoteJoin(str(invite))],
    [IPC.A2A_REMOTE_HOSTS_LIST, async () => (await client()).a2aRemoteHostsList()],
    [IPC.A2A_REMOTE_HOSTS_REMOVE, async (hostId) => (await clientNow()).a2aRemoteHostsRemove(str(hostId))],
    [IPC.A2A_REMOTE_PEERS_LIST, async () => (await client()).a2aRemotePeersList()],
    [IPC.A2A_REMOTE_PEERS_REVOKE, async (peerId) => (await clientNow()).a2aRemotePeersRevoke(str(peerId))],
    [
      IPC.A2A_REMOTE_SNAPSHOT,
      async (snapshot) => {
        const parsed = coercePaneSnapshot(snapshot);
        if (parsed) await publisher.accept(parsed);
        return { ok: parsed !== null };
      },
    ],
    [IPC.A2A_REMOTE_EXPOSURE_GET, async (hostId) => (await client()).a2aRemoteExposureGet(str(hostId))],
    [
      IPC.A2A_REMOTE_EXPOSURE_SET,
      async (hostId, workspaceIds, paneIds, brain, expected) => {
        const result = await (await clientNow()).a2aRemoteExposureSet(
          str(hostId),
          Array.isArray(workspaceIds) ? workspaceIds.filter((w): w is string => typeof w === 'string') : [],
          (paneIds ?? {}) as Record<string, string[]>,
          brain === true,
          // The daemon compares it field by field; anything else means "no list saved".
          expected === undefined ? undefined : (expected as A2aRemoteExposureGetResult['exposure']),
        );
        // A newly exposed workspace's panes must be listed before the other PC looks.
        if (!result.conflict) await publisher.republish();
        return result;
      },
    ],
    [IPC.A2A_REMOTE_HOSTS_EXPOSED, async (hostId) => (await client()).a2aRemoteHostsExposed(str(hostId))],
    [IPC.A2A_REMOTE_LINKS_LIST, async () => (await client()).a2aRemoteLinksList()],
    [IPC.A2A_REMOTE_LINKS_PROPOSE, async (params) => (await clientNow()).a2aRemoteLinksPropose((params ?? {}) as A2aRemoteLinkProposeParams)],
    [IPC.A2A_REMOTE_LINKS_ACCEPT, async (linkId) => (await clientNow()).a2aRemoteLinkAction('accept', str(linkId))],
    [IPC.A2A_REMOTE_LINKS_REJECT, async (linkId) => (await clientNow()).a2aRemoteLinkAction('reject', str(linkId))],
    [IPC.A2A_REMOTE_LINKS_REVOKE, async (linkId) => (await clientNow()).a2aRemoteLinkAction('revoke', str(linkId))],
    [IPC.A2A_REMOTE_LINKS_REFRESH, async (linkId) => (await clientNow()).a2aRemoteLinkAction('refresh', str(linkId))],
    [IPC.A2A_REMOTE_OFFERS_LIST, async () => (await client()).a2aRemoteOffersList()],
    [
      IPC.A2A_REMOTE_OFFERS_ACCEPT,
      async (params) => {
        const p = (params ?? {}) as A2aRemoteOfferAcceptParams;
        // This PC's end must be a pane in this PC's own tree, whatever the renderer sent.
        if (typeof p.local?.workspaceId !== 'string' || typeof p.local?.paneId !== 'string' || !publisher.hasPane(p.local.workspaceId, p.local.paneId)) {
          return { ok: false, error: 'bad-request', message: 'that pane is not open on this PC' };
        }
        return (await clientNow()).a2aRemoteOfferAccept(p);
      },
    ],
    [IPC.A2A_REMOTE_OFFERS_DECLINE, async (offerId) => (await clientNow()).a2aRemoteOfferDecline(str(offerId))],
    [
      IPC.A2A_REMOTE_OFFERS_CREATE,
      async (params) => {
        const p = (params ?? {}) as A2aRemoteOfferShareParams;
        const c = await clientNow();
        // What the other PC sees comes from this PC's own tree, never from the renderer's words.
        const end = await publisher.candidateFor(str(p.workspaceId), str(p.paneId));
        if (!end) return { ok: false, error: 'bad-request', message: 'that pane is not open on this PC' };
        const allow = { outbound: p.allow?.outbound === true, inbound: p.allow?.inbound === true };
        const result = await c.a2aRemoteOfferCreate({ hostId: str(p.hostId), end, allow });
        // The pane is listed to that PC too (GET /exposed) once the snapshot is republished.
        if (result.ok) await publisher.republish();
        return result;
      },
    ],
    [IPC.A2A_REMOTE_OFFERS_WITHDRAW, async (offerId) => (await clientNow()).a2aRemoteOfferWithdraw(str(offerId))],
    [IPC.A2A_REMOTE_HOSTS_STATUS, async () => (await client()).rpc('a2a.remote.hosts.status', {})],
    [IPC.A2A_REMOTE_HELD_LIST, async () => (await client()).rpc(A2A_REMOTE_RPC.held, {})],
    [
      IPC.A2A_REMOTE_HELD_RETRY,
      async (taskId) => remoteBridge ? remoteBridge.retryHeld(str(taskId)) : { ok: false, results: [], error: 'unavailable' },
    ],
    // A person's reject from the held list.
    [IPC.A2A_REMOTE_HELD_REJECT, async (taskId) => (await clientNow()).rpc(A2A_REMOTE_RPC.rejectHeld, { taskId: str(taskId), reason: 'rejected-by-person' })],
    // Starting new agents from another PC. A policy that is not exactly one
    // is refused here, before it reaches the daemon (which checks it again).
    [IPC.A2A_REMOTE_SPAWN_POLICY_GET, async () => (await client()).a2aSpawnPolicyGet()],
    [
      IPC.A2A_REMOTE_SPAWN_POLICY_SET,
      async (raw) => {
        const policy = coerceSpawnPolicy(raw);
        if (!policy) return { ok: false, error: 'bad-request' };
        return (await clientNow()).a2aSpawnPolicySet(policy);
      },
    ],
    [IPC.A2A_REMOTE_SPAWN_REQUESTS_LIST, async () => (await client()).a2aSpawnRequestsList()],
    [
      IPC.A2A_REMOTE_SPAWN_ASK,
      async (params) => {
        const p = (params ?? {}) as Partial<A2aSpawnUiAsk>;
        const c = await clientNow();
        // The reply pane comes from this PC's own tree, never from the renderer's words.
        const workspaceId = str(p.end?.workspaceId);
        const paneId = str(p.end?.paneId);
        if (!publisher.hasPane(workspaceId, paneId)) return { ok: false, error: 'bad-request', message: 'that pane is not open on this PC' };
        // Depth 1, as for an agent's ask: replies do not go to a fan-out task or an agent another PC started.
        let owner: string | null;
        try {
          owner = getFanOutGuards().fanoutOwnerOf(workspaceId);
        } catch {
          return { ok: false, error: 'unavailable', message: 'could not tell whether that pane was itself started for someone' };
        }
        if (owner !== null) return { ok: false, error: 'bad-request', message: 'replies cannot go to a pane that was itself started for someone' };
        if (!isAgentSlug(p.agent) || typeof p.text !== 'string' || typeof p.folder?.root !== 'string') return { ok: false, error: 'bad-request' };
        if (p.expiresInHours !== undefined && !(Number.isInteger(p.expiresInHours) && p.expiresInHours >= 1 && p.expiresInHours <= 72)) return { ok: false, error: 'bad-request' };
        if (p.requestKey !== undefined && (typeof p.requestKey !== 'string' || !SPAWN_REQUEST_KEY_RE.test(p.requestKey))) return { ok: false, error: 'bad-request' };
        // The dialog shows the prompt as finalizeSpawnPrompt makes it. One this
        // pass would still change was not what the person saw: it is refused,
        // never sent changed.
        if (finalizeSpawnPrompt(p.text).text !== p.text) {
          return { ok: false, error: 'needs-review', message: 'the prompt changes when it is checked for sending; review it and send again' };
        }
        return c.a2aSpawnAsk({
          pc: str(p.hostId),
          agent: p.agent,
          folder: { root: p.folder.root, ...(typeof p.folder.sub === 'string' && p.folder.sub ? { sub: p.folder.sub } : {}) },
          text: p.text,
          ...(typeof p.expiresInHours === 'number' ? { expiresInHours: p.expiresInHours } : {}),
          from: { kind: 'pane', workspaceId, paneId },
          // Per pane, as for an agent: the pane that gets the replies.
          callerKey: paneId,
          ...(p.requestKey !== undefined ? { requestKey: p.requestKey } : {}),
        });
      },
    ],
    [IPC.A2A_REMOTE_SPAWN_OUTGOING, async () => (await client()).a2aSpawnOutgoing()],
  ];
  for (const [channel, fn] of handlers) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, (_event, ...args: unknown[]) => fn(...args)));
  }
  // Without a daemon (yet) the handlers are still registered, so a renderer
  // read that races the boot connect waits for it instead of meeting a
  // missing handler; nothing else is wired until a client arrives.
  if (!daemonClient) {
    return () => {
      for (const [channel] of handlers) ipcMain.removeHandler(channel);
    };
  }
  // Daemon link nudges → every window (the renderer re-reads the link list).
  const onEvent = (event: { type?: unknown; data?: unknown }): void => {
    if (typeof event.type !== 'string') return;
    let channel: string;
    if (LINK_EVENTS.has(event.type)) channel = IPC.A2A_REMOTE_LINK_EVENT;
    else if (event.type === 'a2a.remote.hosts.status') channel = IPC.A2A_REMOTE_HOST_STATUS_EVENT;
    else return;
    const payload = event.data as A2aRemoteLinkEvent | A2aRemoteOfferEvent | A2aRemoteHostStatus;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };
  daemonClient.on('event', onEvent);
  liveClient = daemonClient;
  const waiting = clientWaiters;
  clientWaiters = [];
  for (const resolve of waiting) resolve(daemonClient);
  // A restarted daemon starts with an empty exposure snapshot.
  void publisher.republish();
  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
    daemonClient.off('event', onEvent);
    if (liveClient === daemonClient) liveClient = null;
  };
}
