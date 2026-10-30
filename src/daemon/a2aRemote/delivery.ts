import crypto from 'node:crypto';
import path from 'node:path';
import {
  A2A_FEATURE_IMAGES,
  A2A_REMOTE_IMAGE_LIMITS,
  A2A_REMOTE_PROTOCOL,
  parseA2aRemoteImageRefs,
  type A2aLinkRecordV1,
  type A2aOutboxRecordV1,
  type A2aRemoteDeliverResponse,
  type A2aRemoteEnvelope,
  type A2aRemoteErrorCode,
  type A2aRemoteHostRecordV1,
  type HostId,
  type PeerCredential,
} from '../../shared/a2aRemote';
import { A2A_REMOTE_RPC, isLegacyHeldReason, isWaitingCause, readHeldReason, type A2aRemoteHeldReason, type A2aRemoteWaitingCause } from '../../shared/a2aRemoteDelivery';
import type { A2aRemoteHostStatus, A2aRemoteHostsStatusResult } from '../../shared/rpc';
import { prepareA2aImage, type A2aImageInfo, type A2aImageRefusal } from '../../shared/a2aImages';
import { TERMINAL_STATES } from '../../shared/types';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import { failTasksForLink, expireHeld, rejectHeld, type HeldDeps } from './held';
import { remoteTaskId } from './ids';
import { A2aImageStore, sha256 } from './imageStore';
import { registerImageRoutes } from './imageRoutes';
import { imageRoots, imageSourceMessage, readImageSource } from './imageSource';
import { PeerTaskBudget, acceptInbound, type ImagePull, type InboundDeps } from './inbound';
import type { NotifyLinkChange } from './linkRpc';
import type { LinkStore } from './linkStore';
import type { A2aOffers } from './offers';
import { aliasTable, imageRefsOf, linkAlias, listRemoteTargets, sendRemoteReply, sendRemoteState, sendRemoteTask, syncRemoteTask, type ImageCaller, type OutboundDeps, type PreparedImage } from './outbound';
import { OutboxStore } from './outboxStore';
import { PeerFeatureStore } from './peerFeatureStore';
import type { A2aRouteTable } from './routes';
import { addressPromoter } from './remoteHostStore';
import { JoinerSession, taskOfEnvelope, type SessionClient, type SessionTiming } from './session';
import type { PinnedClientOptions } from './pinnedClient';
import { A2aStreamHub } from './streamHub';
import { errMsg, isPlainObject, isSafeId } from './storeFile';

/**
 * Cross-host A2A delivery layer, assembled: the outbox, inbound / outbound
 * application, holds, the server-side stream routes and one joiner session per
 * server this PC joined. The daemon builds one of these and registers its RPCs
 * and routes; the in-process end-to-end test builds two.
 *
 * Role per paired PC: in the remote-host store → this PC is the JOINER (its
 * session POSTs our outbox and holds the stream open); only in the peer store
 * → this PC is the SERVER (it serves the stream and takes POSTs). Both
 * (mutual pairing) → the joiner role wins and the stream we serve stays empty.
 */

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

export interface A2aRemoteDeliveryDeps {
  /** `<wmux dir>/a2a` — the outbox lives here. */
  dir: string;
  links: LinkStore;
  taskService: A2aTaskService;
  peers: { list(): Array<{ hostId: HostId; name: string; revokedAt?: string }> };
  remoteHosts: {
    list(): A2aRemoteHostRecordV1[];
    get(hostId: HostId): A2aRemoteHostRecordV1 | undefined;
    credentialFor(hostId: HostId): PeerCredential | null;
    promoteAddress?(hostId: HostId, address: string): boolean;
  };
  /** Daemon broadcast (`pipeServer.broadcast`). */
  broadcast: (event: { type: string; sessionId: string; data: unknown }) => void;
  /** `a2a.remote.links.refresh` — fold the server's view of one link into ours. */
  refreshLink: (linkId: string) => Promise<unknown>;
  localWorkspaceName?: (workspaceId: string) => string | undefined;
  /** Share offers: received as link envelopes, refused by older builds, ended when a peer stops supporting them. */
  offers?: A2aOffers;
  /** Remote spawn requests, results and targets (link envelopes; see `spawnReceiver.ts`). */
  spawn?: InboundDeps['spawn'];
  /** Conversations other PCs continue here (link envelopes; see `continueReceiver.ts`). */
  continue?: InboundDeps['continue'];
  /** Links a remote start made here (spawnStarter.ts): redacted, no images, follow-ups held for their card. */
  spawnLinks?: NonNullable<InboundDeps['spawnLinks']>;
  /** This PC's requests to start agents on other PCs (spawnRequester.ts): told when the other PC refuses one for good. */
  spawnAsks?: { onRefused(hostId: HostId, envelope: A2aRemoteEnvelope, code: A2aRemoteErrorCode): void };
  /** Optional features this PC advertises: on its streams to the servers it joined, and in its own streams' `hello`. */
  features?: readonly string[];
  /**
   * `<wmux dir>/uploads`: images on messages (`images.1`) are received into
   * its `a2a/` folder and may be attached from it. Absent: no images either way.
   */
  uploadsRoot?: string;
  /**
   * The spawn folder of a pane, by its pty id: the folder its agent may
   * attach images from. Undefined unless that terminal belongs to
   * `workspaceId` (the sender's, as main verified it): this daemon knows a
   * terminal's workspace, not its pane.
   */
  spawnCwdOf?: (ptyId: string, workspaceId: string) => string | undefined;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Test seams. */
  timing?: Partial<SessionTiming>;
  heartbeatMs?: number;
  client?: (opts: PinnedClientOptions) => SessionClient;
  /** How often the session set follows the remote-host store. Default 5 s. */
  syncMs?: number;
}

const SYNC_MS = 5_000;
const MAINTENANCE_MS = 60_000;
const HELD_REASONS: ReadonlySet<string> = new Set<A2aRemoteHeldReason>([
  'occupant-changed', 'pane-missing', 'link-not-active', 'delivery-unconfirmed', 'no-agent', 'awaiting-approval',
]);
/** What the sender's ledger shows while our pane has no agent to take its task. */
export const NO_AGENT_SUMMARY = 'The linked pane on the receiving PC has no agent running; the task is held until someone there acts.';
/** What the sender's ledger shows while our pane's agent is there but cannot take its task yet (not a hold). */
export const WAITING_SUMMARY: Readonly<Record<A2aRemoteWaitingCause, string>> = {
  'agent-prompt': 'The agent on the receiving PC is waiting on a prompt there; the task is delivered once the prompt is answered.',
  'user-typing': 'Someone is typing in the linked pane on the receiving PC; the task is delivered once they stop.',
};
const STATES: ReadonlySet<string> = new Set(['working', 'input-required', 'completed', 'failed', 'canceled']);
const TERMINAL_LINK: ReadonlySet<string> = new Set(['revoked', 'broken']);

/**
 * The `features` a share offer (`A2aOffers`) gates on: what `hostId`
 * advertised on its own stream to this PC (it is our joiner), while that
 * stream is up. Without it (never up since this daemon started, or closed
 * since: the hub keeps the last features after a stream ends) an offer would
 * show the pane while its envelope could only wait, and perhaps expire, in
 * the outbox, so the offer is refused as not connected. The daemon and its
 * tests wire this one.
 */
export function shareOfferFeatures(delivery: () => A2aRemoteDelivery | null): (hostId: HostId) => ReadonlySet<string> | undefined {
  return (hostId) => {
    const hub = delivery()?.hub;
    return hub?.isConnected(hostId) ? hub.featuresOf(hostId) : undefined;
  };
}

export class A2aRemoteDelivery {
  readonly outbox: OutboxStore;
  readonly hub: A2aStreamHub;
  /** What each paired PC last advertised, kept across restarts (see `peerFeatures`). */
  readonly peerFeatureStore: PeerFeatureStore;
  /** Image files of messages; null when `uploadsRoot` is not given. */
  readonly images: A2aImageStore | null;
  /** What this PC advertises (`deps.features`, without `images.1` when it has no image store). */
  private readonly features: readonly string[] | undefined;
  /** Failed image fetches from the servers this PC joined (`InboundImages.pullAttempts`). */
  private readonly pullAttempts = new Map<string, number>();
  /** New tasks each PC sent this one in the last hour (the inbound limit). */
  private readonly taskBudget = new PeerTaskBudget();
  private readonly deps: A2aRemoteDeliveryDeps;
  private readonly sessions = new Map<HostId, { session: JoinerSession; fingerprint: string; port: number }>();
  /** Server-side status, last announced. */
  private readonly served = new Map<HostId, A2aRemoteHostStatus['state']>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: A2aRemoteDeliveryDeps) {
    this.deps = deps;
    this.outbox = new OutboxStore({ dir: deps.dir, log: deps.log, onEnqueue: (rec) => this.onEnqueue(rec), onAck: (recs) => this.onAck(recs) });
    this.peerFeatureStore = new PeerFeatureStore({ dir: deps.dir, log: deps.log });
    this.images = deps.uploadsRoot ? new A2aImageStore({ a2aDir: deps.dir, uploadsRoot: deps.uploadsRoot, log: deps.log }) : null;
    // `images.1` is a promise to take images: only with somewhere to keep them.
    this.features = deps.features?.filter((f) => f !== A2A_FEATURE_IMAGES || this.images !== null);
    this.hub = new A2aStreamHub({
      outbox: this.outbox,
      accept: (env, peer) => this.acceptFromJoiner(env, peer),
      serves: (hostId) => !deps.remoteHosts.get(hostId),
      onStatus: (hostId) => this.announceServed(hostId),
      onFeatures: (hostId, features) => {
        this.peerFeatureStore.record(hostId, 'asJoiner', features);
        deps.offers?.onPeerFeatures(hostId, features);
      },
      ...(this.features ? { features: this.features } : {}),
      ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
      log: deps.log,
    });
  }

  // --- composition ----------------------------------------------------------

  /** The PC name for a host: the server we joined, else the peer that joined us. */
  hostName(hostId: HostId): string | undefined {
    return this.deps.remoteHosts.get(hostId)?.name || this.deps.peers.list().find((p) => p.hostId === hostId && !p.revokedAt)?.name;
  }

  /** A link's alias, unique among the active links (see `aliasTable`). */
  aliasFor(link: A2aLinkRecordV1): string {
    return aliasTable(this.deps.links.list(), (h) => this.hostName(h)).get(link.linkId) ?? linkAlias(link, this.hostName(link.remote.hostId));
  }

  /** Apply one envelope from an authenticated peer host (`pull`: the server this PC joined, which holds its images). */
  accept(envelope: unknown, peer: { hostId: HostId; pull?: ImagePull }): Promise<A2aRemoteDeliverResponse> {
    return acceptInbound(envelope, peer, this.inboundDeps());
  }

  /**
   * An envelope a joiner posted. Refused for good: the images it uploaded
   * for it will never be claimed, so they go now rather than at the TTL.
   */
  private async acceptFromJoiner(envelope: unknown, peer: { hostId: HostId }): Promise<A2aRemoteDeliverResponse> {
    const res = await this.accept(envelope, peer);
    if (!res.ok && res.error !== 'unavailable' && res.error !== 'attachment-missing' && this.images && isPlainObject(envelope)) {
      const refs = parseA2aRemoteImageRefs(envelope['images']);
      if (refs) await this.images.discardStaged(peer.hostId, refs);
    }
    return res;
  }

  /** `notifyLinkChange` of the link RPCs: the other PC hears about it through the outbox. */
  readonly notifyLinkChange: NotifyLinkChange = (hostId, linkId, state, version) => {
    const reason = state === 'active' ? undefined : this.deps.links.get(linkId)?.endedReason;
    try {
      this.outbox.enqueue(hostId, {
        protocol: A2A_REMOTE_PROTOCOL,
        linkId,
        linkVersion: version,
        messageId: crypto.randomUUID(),
        kind: 'link',
        link: { state, version, ...(reason ? { reason } : {}) },
        sentAt: new Date().toISOString(),
      });
    } catch (err) {
      this.deps.log('error', `[a2a-remote] link ${linkId} ${state}: notice not queued: ${errMsg(err)}`);
    }
  };

  /** `LinkStore.onTransition`: tell the app, and end the work of a link that ended. */
  onLinkTransition(link: A2aLinkRecordV1): void {
    this.deps.broadcast({ type: 'a2a.remote.link.changed', sessionId: '', data: { type: 'a2a.remote.link.changed', linkId: link.linkId, state: link.state } });
    if (!TERMINAL_LINK.has(link.state)) return;
    void failTasksForLink(this.heldDeps(), link.linkId, link.state === 'revoked' ? 'link_revoked' : 'link_broken').catch((err: unknown) =>
      this.deps.log('error', `[a2a-remote] ending the tasks of link ${link.linkId} failed: ${errMsg(err)}`),
    );
  }

  /** The pairing with `hostId` was revoked here: drop its stream. */
  onPeerRevoked(hostId: HostId): void {
    this.hub.close(hostId);
    if (!this.deps.remoteHosts.get(hostId)) this.peerFeatureStore.forget(hostId);
  }

  /**
   * What `hostId`'s build takes: what it advertised most recently, in either
   * role, on a stream since this daemon started or before
   * (`peer-features.json`; every advertisement is recorded there). Undefined:
   * never seen.
   */
  peerFeatures(hostId: HostId): ReadonlySet<string> | undefined {
    const seen = this.peerFeatureStore.newest(hostId);
    return seen ? new Set(seen) : undefined;
  }


  /** Both roles' features from the streams since this daemon started; undefined when neither came up. */
  liveFeatures(hostId: HostId): ReadonlySet<string> | undefined {
    const asServer = this.sessions.get(hostId)?.session.features();
    const asJoiner = this.hub.featuresOf(hostId);
    if (!asServer && !asJoiner) return undefined;
    return new Set([...(asServer ?? []), ...(asJoiner ?? [])]);
  }

  registerRoutes(table: A2aRouteTable): void {
    this.hub.register(table);
    if (this.images) registerImageRoutes(table, { store: this.images, outbox: this.outbox, log: this.deps.log });
  }

  // --- lifecycle ------------------------------------------------------------

  start(): void {
    if (this.syncTimer) return;
    this.syncSessions();
    this.syncTimer = setInterval(() => this.syncSessions(), this.deps.syncMs ?? SYNC_MS);
    this.syncTimer.unref?.();
    this.maintenanceTimer = setInterval(() => void this.maintain(), MAINTENANCE_MS);
    this.maintenanceTimer.unref?.();
    void this.maintain();
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.syncTimer = null;
    this.maintenanceTimer = null;
    this.hub.closeAll();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => s.session.stop()));
    // Leave no handle on the outbox file (or its folder) once stopped.
    await this.outbox.idle();
  }

  /** One session per joined server; restarted when its address, port or pin changes. */
  syncSessions(): void {
    const hosts = this.deps.remoteHosts.list();
    const wanted = new Set(hosts.map((h) => h.hostId));
    for (const [hostId, entry] of [...this.sessions]) {
      const host = hosts.find((h) => h.hostId === hostId);
      if (wanted.has(hostId) && host && host.fingerprint256 === entry.fingerprint && host.port === entry.port) continue;
      this.sessions.delete(hostId);
      void entry.session.stop();
      // Left that PC, and it is not one of ours either: what it took no longer matters.
      if (!wanted.has(hostId) && !this.deps.peers.list().some((p) => p.hostId === hostId && !p.revokedAt)) this.peerFeatureStore.forget(hostId);
    }
    for (const host of hosts) {
      if (this.sessions.has(host.hostId)) continue;
      const session = this.newSession(host.hostId);
      this.sessions.set(host.hostId, { session, fingerprint: host.fingerprint256, port: host.port });
      session.start();
    }
  }

  status(): A2aRemoteHostStatus[] {
    // A PC that joined this one may also be one this PC joined: what it
    // advertised on either stream counts (its server `hello` and its joiner header).
    const out: A2aRemoteHostStatus[] = [...this.sessions.values()].map((s) => {
      const row = s.session.current();
      const features = this.liveFeatures(row.hostId);
      return features ? { ...row, features: [...features] } : row;
    });
    const joined = new Set(out.map((s) => s.hostId));
    for (const peer of this.deps.peers.list()) {
      if (peer.revokedAt || joined.has(peer.hostId)) continue;
      joined.add(peer.hostId);
      out.push(this.servedStatus(peer.hostId, peer.name));
    }
    return out;
  }

  /** Queue what the peer is owed for one remote task (our replies, our latest state). */
  async syncTask(taskId: string, summary?: string): Promise<void> {
    const res = await syncRemoteTask(this.outboundDeps(), taskId, summary !== undefined ? { summary } : {});
    if (!res.ok && !res.error.startsWith('link-not-active') && res.error !== 'unknown-link') {
      this.deps.log('warn', `[a2a-remote] ${taskId}: not queued for the peer yet: ${res.error}`);
    }
  }

  /** The ledger is the source of truth: re-queue anything a failed or interrupted send left owed. */
  async syncAll(): Promise<void> {
    for (const task of this.deps.taskService.listRemote()) {
      // eslint-disable-next-line no-await-in-loop -- one task at a time keeps the outbox order
      await syncRemoteTask(this.outboundDeps(), task.id).catch(() => undefined);
    }
  }

  /** Periodic upkeep: drop old acked records, reject holds past their TTL, re-queue what is owed. */
  async maintain(): Promise<void> {
    await this.syncAll().catch((err: unknown) => this.deps.log('warn', `[a2a-remote] outbound sync failed: ${errMsg(err)}`));
    // A no-agent hold whose reply to the sender could not go when it was held
    // (main marks it once): told here, once it can be.
    for (const task of this.deps.taskService.listRemoteHeld()) {
      const marker = task.metadata.remote as { direction?: string; held?: string } | undefined;
      if (marker?.direction === 'inbound' && marker.held === 'no-agent') await this.tellSender(task.id, NO_AGENT_SUMMARY);
    }
    // Before the prune: an ack whose mark never landed (crash, failed append) is
    // recovered while its record is still here. This runs at start and every
    // minute, so every acked record is seen at least once before it is pruned.
    await this.reconcileReplyAcks();
    try {
      this.outbox.prune();
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] outbox prune failed: ${errMsg(err)}`);
    }
    try {
      const expired = await expireHeld(this.heldDeps());
      if (expired.length > 0) this.deps.log('info', `[a2a-remote] ${expired.length} held remote task(s) expired`);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] hold expiry failed: ${errMsg(err)}`);
    }
    // Expiry, put-backs still owed, and claims a restart (or the app's absence) left unfinished.
    this.deps.offers?.recover();
    await this.maintainImages().catch((err: unknown) => this.deps.log('warn', `[a2a-remote] image upkeep failed: ${errMsg(err)}`));
  }

  /** Received images past their retention, unclaimed uploads, and sender copies nothing can resend any more. */
  private async maintainImages(): Promise<void> {
    if (!this.images) return;
    await this.images.sweep();
    await this.images.gcOutgoing(() => this.resendableImages());
  }

  /** Sender copies a resend may still need: a ledger message that may be sent (again), or an open record. */
  private resendableImages(): Set<string> {
    const referenced = new Set<string>();
    for (const task of this.deps.taskService.listRemote()) {
      const marker = task.metadata.remote as { messageId?: string; sent?: string[] } | undefined;
      const ended = (TERMINAL_STATES as readonly string[]).includes(task.status.state);
      for (const m of task.history) {
        // An ended task's message already sent will never be sent again.
        if (ended && (m.messageId === marker?.messageId || (marker?.sent ?? []).includes(m.messageId))) continue;
        for (const ref of imageRefsOf(m)) referenced.add(ref.sha256);
      }
    }
    for (const rec of this.openRecords()) for (const ref of rec.envelope.images ?? []) referenced.add(ref.sha256);
    return referenced;
  }

  /** Images a task that has not ended names, or an open record carries: a local copy of one is never evicted. */
  private openImages(): Set<string> {
    const out = new Set<string>();
    for (const task of this.deps.taskService.listOpen()) {
      for (const m of task.history) {
        for (const p of m.parts) {
          const sha = p.kind === 'file' ? p.metadata?.['sha256'] : undefined;
          if (typeof sha === 'string') out.add(sha);
        }
      }
    }
    for (const rec of this.openRecords()) for (const ref of rec.envelope.images ?? []) out.add(ref.sha256);
    return out;
  }

  /** Every record still owed to any host. */
  private openRecords(): A2aOutboxRecordV1[] {
    const hosts = new Set<HostId>([...this.deps.remoteHosts.list().map((h) => h.hostId), ...this.deps.peers.list().map((p) => p.hostId)]);
    return [...hosts].flatMap((h) => this.outbox.pending(h));
  }

  // --- RPC ------------------------------------------------------------------

  /** The delivery RPCs main calls (`A2A_REMOTE_RPC`) plus `a2a.remote.hosts.status`. Thin parses. */
  registerRpc(onRpc: (method: string, handler: RpcHandler) => void): void {
    const svc = this.deps.taskService;
    const str = (p: Record<string, unknown>, k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');

    onRpc(A2A_REMOTE_RPC.pending, async () => ({ tasks: svc.listRemotePending() }));
    onRpc(A2A_REMOTE_RPC.held, async () => ({ tasks: svc.listRemoteHeld() }));

    onRpc(A2A_REMOTE_RPC.mark, async (p) => {
      const taskId = str(p, 'taskId');
      if (!taskId) return { ok: false, error: 'bad-request: taskId is required' };
      const held = p['held'];
      if (held !== undefined && (typeof held !== 'string' || !(HELD_REASONS.has(held) || isLegacyHeldReason(held)))) {
        return { ok: false, error: 'bad-request: unknown held reason' };
      }
      const messageId = typeof p['messageId'] === 'string' ? p['messageId'] : undefined;
      const res = await svc.markRemote({
        taskId,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(p['delivered'] === true ? { delivered: true } : {}),
        ...(typeof held === 'string' ? { held: readHeldReason(held) } : {}),
        ...(typeof p['attempted'] === 'boolean' && p['delivered'] !== true && held === undefined ? { attempted: p['attempted'] } : {}),
        ...(p['note'] === 'pasted-not-submitted' ? { note: 'pasted-not-submitted' as const } : {}),
        ...(typeof p['ptyId'] === 'string' && isSafeId(p['ptyId']) ? { ptyId: p['ptyId'] } : {}),
      });
      // A reply that could not go now is tried again by `maintain`.
      if (res.ok && held === 'no-agent' && messageId === undefined) await this.tellSender(taskId, NO_AGENT_SUMMARY);
      // Not a hold: main keeps delivering and says `waiting` on every later miss,
      // so a reply that could not go is tried again then. A cause this build does not know is ignored.
      const waiting = p['waiting'];
      if (res.ok && held === undefined && isWaitingCause(waiting) && messageId === undefined) await this.tellSender(taskId, WAITING_SUMMARY[waiting]);
      // Handed over: the sender gets a `delivered` receipt.
      if (res.ok && p['delivered'] === true && messageId === undefined) await this.syncTask(taskId);
      return res.ok ? { ok: true } : res;
    });

    onRpc(A2A_REMOTE_RPC.read, async (p) => {
      const taskId = str(p, 'taskId');
      const task = taskId ? svc.getTask(taskId) : undefined;
      const marker = task?.metadata.remote as { direction?: string } | undefined;
      // Only the receiving side of an inbound task reads it.
      if (!task || marker?.direction !== 'inbound' || task.metadata.to.workspaceId !== str(p, 'workspaceId')) {
        return { ok: false, error: 'forbidden: not an inbound remote task of this workspace' };
      }
      const res = await svc.markRemote({ taskId, read: true });
      if (!res.ok) return res;
      await this.syncTask(taskId);
      return { ok: true };
    });

    onRpc(A2A_REMOTE_RPC.targets, async () => ({ targets: listRemoteTargets({ linkStore: this.deps.links, aliasFor: (l) => this.aliasFor(l) }) }));

    onRpc(A2A_REMOTE_RPC.sendTask, async (p) => {
      const from = isPlainObject(p['from']) ? p['from'] : null;
      const images = imagePaths(p['images']);
      if (images === null) return { ok: false, error: 'bad-request: images must be a list of paths' };
      // A pane sender names its pane; Moa (a brain link) has none. sendRemoteTask
      // checks it against the link's local end.
      if (!from || typeof from['workspaceId'] !== 'string' || (from['paneId'] !== undefined && typeof from['paneId'] !== 'string') || typeof p['text'] !== 'string') {
        return { ok: false, error: 'bad-request: linkId, from{workspaceId, paneId?} and text are required' };
      }
      return sendRemoteTask(this.outboundDeps(), {
        linkId: str(p, 'linkId'),
        from: {
          workspaceId: from['workspaceId'],
          name: typeof from['name'] === 'string' ? from['name'] : from['workspaceId'],
          ...(typeof from['paneId'] === 'string' ? { paneId: from['paneId'] } : {}),
          ...(typeof from['ptyId'] === 'string' ? { ptyId: from['ptyId'] } : {}),
        },
        title: str(p, 'title'),
        text: p['text'],
        ...(images ? { images } : {}),
      });
    });

    onRpc(A2A_REMOTE_RPC.reply, async (p) => {
      if (typeof p['text'] !== 'string') return { ok: false, error: 'bad-request: text is required' };
      const images = imagePaths(p['images']);
      if (images === null) return { ok: false, error: 'bad-request: images must be a list of paths' };
      return sendRemoteReply(this.outboundDeps(), {
        taskId: str(p, 'taskId'),
        workspaceId: str(p, 'workspaceId'),
        text: p['text'],
        ...(images ? { images } : {}),
        ...(typeof p['ptyId'] === 'string' && isSafeId(p['ptyId']) ? { ptyId: p['ptyId'] } : {}),
      });
    });

    // An agent's images for a pane on THIS PC: checked and kept like a
    // remote send's, in `uploads/a2a/local`, whose paths the receiver reads.
    onRpc(A2A_REMOTE_RPC.stageImages, async (p) => {
      const images = imagePaths(p['paths']);
      if (!images) return { ok: false, error: 'bad-request: paths must be a non-empty list of paths' };
      const ptyId = typeof p['ptyId'] === 'string' && isSafeId(p['ptyId']) ? p['ptyId'] : undefined;
      const read = await this.readImages(images, { ptyId, workspaceId: str(p, 'workspaceId') });
      const store = this.images;
      if (!read.ok) return read;
      if (!store) return { ok: false, error: 'unavailable: this PC cannot send images' };
      // All or none, in one go: a full folder makes room from copies nothing
      // open names (never this message's own), and when an image still does
      // not fit, the copies this call wrote go again.
      const stored = await store.putLocal(read.images, () => this.openImages());
      if (!stored.ok) return { ok: false, error: 'unavailable: the image folder is full; try again later' };
      const out = read.images.map((r, i) => ({
        path: stored.images[i].path,
        sha256: r.sha256,
        mediaType: r.info.mediaType,
        bytes: r.bytes.length,
        width: r.info.width,
        height: r.info.height,
        name: r.name,
      }));
      return { ok: true, images: out };
    });

    onRpc(A2A_REMOTE_RPC.state, async (p) => {
      const state = str(p, 'state');
      if (!STATES.has(state)) return { ok: false, error: 'bad-request: unknown state' };
      return sendRemoteState(this.outboundDeps(), {
        taskId: str(p, 'taskId'),
        state: state as 'working' | 'input-required' | 'completed' | 'failed' | 'canceled',
        ...(typeof p['summary'] === 'string' ? { summary: p['summary'] } : {}),
      });
    });

    onRpc(A2A_REMOTE_RPC.rejectHeld, async (p) => {
      const reason = str(p, 'reason').slice(0, 200) || 'rejected';
      return rejectHeld(this.heldDeps(), str(p, 'taskId'), reason);
    });

    onRpc('a2a.remote.hosts.status', async (): Promise<A2aRemoteHostsStatusResult> => ({ hosts: this.status() }));
  }

  // --- internals ------------------------------------------------------------

  /**
   * Our pane could not take the peer's task (no agent, or an agent behind a
   * prompt or a person typing): the sender hears why, once per summary, as a
   * reply from this side (its task stays open; `submitted` has no edge to
   * `input-required`, and nothing here has started the work). Once means the
   * reply is in the task's history: a send that failed stored nothing, so the
   * next call tries again. False only when the reply could not be sent.
   */
  private async tellSender(taskId: string, summary: string): Promise<boolean> {
    const task = this.deps.taskService.getTask(taskId);
    if (!task || task.status.state !== 'submitted') return true;
    const said = task.history.some((m) => m.parts.some((p) => p.kind === 'text' && p.text === summary));
    if (said) return true;
    const res = await sendRemoteReply(this.outboundDeps(), { taskId, workspaceId: task.metadata.to.workspaceId, text: summary });
    if (!res.ok) this.deps.log('warn', `[a2a-remote] ${taskId}: could not tell the sender why its task waits: ${res.error}`);
    return res.ok;
  }

  private newSession(hostId: HostId): JoinerSession {
    return new JoinerSession({
      hostId,
      host: () => this.deps.remoteHosts.get(hostId),
      onConnected: addressPromoter(this.deps.remoteHosts, hostId, this.deps.log),
      credential: () => this.deps.remoteHosts.credentialFor(hostId),
      outbox: this.outbox,
      accept: (env, peer) => this.accept(env, peer),
      onRefused: (rec, code, detail) => this.onRefused(rec, code, detail),
      ...(this.images ? { images: this.images } : {}),
      reconcileLinks: () => this.reconcileLinks(hostId),
      onStatus: (status) => this.deps.broadcast({ type: 'a2a.remote.hosts.status', sessionId: '', data: status }),
      onServerFeatures: (features) => this.peerFeatureStore.record(hostId, 'asServer', features),
      ...(this.features ? { features: this.features } : {}),
      ...(this.deps.timing ? { timing: this.deps.timing } : {}),
      ...(this.deps.client ? { client: this.deps.client } : {}),
      log: this.deps.log,
    });
  }

  /** Fold the server's view of every live link to `hostId` into ours (sequentially). */
  private async reconcileLinks(hostId: HostId): Promise<void> {
    for (const link of this.deps.links.listByHost(hostId)) {
      if (TERMINAL_LINK.has(link.state)) continue;
      // eslint-disable-next-line no-await-in-loop -- one request at a time to one host
      await this.deps.refreshLink(link.linkId).catch(() => undefined);
    }
  }

  /** The other PC refused a message for good (or its images could not be sent): the task it carried fails here. */
  private async onRefused(rec: A2aOutboxRecordV1, code: A2aRemoteErrorCode, detail?: string): Promise<void> {
    this.deps.log('warn', `[a2a-remote] ${rec.hostId} refused ${rec.envelope.kind} on link ${rec.envelope.linkId}: ${code}`);
    this.deps.offers?.onRefused(rec.hostId, rec.envelope, code);
    this.deps.spawnAsks?.onRefused(rec.hostId, rec.envelope, code);
    const taskId = taskOfEnvelope(rec.envelope, remoteTaskId);
    if (!taskId || !this.deps.taskService.getTask(taskId)) return;
    const reason = code === 'attachment-failed' ? `not sent to the other PC: ${detail ?? 'its images could not be uploaded'}` : `refused by the other PC: ${code}`;
    await this.deps.taskService.forceFailRemote({ taskId, reason, forced: 'remote_refused' });
  }

  private onEnqueue(rec: A2aOutboxRecordV1): void {
    this.sessions.get(rec.hostId)?.session.wake();
    this.hub.notify(rec.hostId);
  }

  /**
   * The peer acked our replies / states (#1922): once nothing more of ours is
   * owed on a task, its marker records when the other PC received all of it,
   * so this side's task view can show its replies arrived there.
   */
  private onAck(recs: A2aOutboxRecordV1[]): void {
    const tasks = new Set<string>();
    for (const rec of recs) {
      const taskId = replyOrStateTask(rec);
      if (taskId) tasks.add(taskId);
    }
    for (const taskId of tasks) void this.markReplyAcked(taskId, recs[0].hostId);
  }

  /** Mark every task whose acked replies / states have no mark yet (see `maintain`). */
  private async reconcileReplyAcks(): Promise<void> {
    const marks = new Map<string, HostId>();
    for (const rec of this.outbox.settled()) {
      const taskId = rec.state === 'acked' ? replyOrStateTask(rec) : null;
      const marker = taskId ? this.deps.taskService.getTask(taskId)?.metadata.remote as { replyDeliveredAt?: string } | undefined : undefined;
      if (taskId && marker && !marker.replyDeliveredAt) marks.set(taskId, rec.hostId);
    }
    for (const [taskId, hostId] of marks) {
      // eslint-disable-next-line no-await-in-loop -- one ledger append at a time
      await this.markReplyAcked(taskId, hostId);
    }
  }

  /**
   * Record that `hostId` has every reply / state of ours on `taskId`. Whether
   * any is still owed (or was refused) is decided inside the task's lock, so a
   * reply queued after the ack is never covered by it. Never rejects.
   */
  private async markReplyAcked(taskId: string, hostId: HostId): Promise<void> {
    if (!this.deps.taskService.getTask(taskId)) return;
    const notAll = (): boolean =>
      this.outbox.pending(hostId).some((r) => replyOrStateTask(r) === taskId) ||
      this.outbox.settled().some((r) => r.hostId === hostId && r.state === 'refused' && replyOrStateTask(r) === taskId);
    try {
      const res = await this.deps.taskService.markRemote({ taskId, replyAcked: true, stillOwed: notAll });
      if (!res.ok) this.deps.log('warn', `[a2a-remote] ${taskId}: peer ack not recorded: ${res.error}`);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] ${taskId}: peer ack not recorded: ${errMsg(err)}`);
    }
  }

  private servedStatus(hostId: HostId, name: string): A2aRemoteHostStatus {
    const since = this.hub.connectedSince(hostId);
    const features = this.hub.featuresOf(hostId);
    return {
      hostId,
      name,
      role: 'server',
      state: this.hub.isConnected(hostId) ? 'connected' : 'disconnected',
      pending: this.outbox.openCount(hostId),
      ...(since !== undefined ? { connectedAt: new Date(since).toISOString() } : {}),
      ...(features ? { features: [...features] } : {}),
    };
  }

  private announceServed(hostId: HostId): void {
    if (this.sessions.has(hostId)) return;
    const status = this.servedStatus(hostId, this.hostName(hostId) ?? '');
    if (this.served.get(hostId) === status.state) return;
    this.served.set(hostId, status.state);
    this.deps.broadcast({ type: 'a2a.remote.hosts.status', sessionId: '', data: status });
  }

  private inboundDeps(): InboundDeps {
    return {
      linkStore: this.deps.links,
      taskService: this.deps.taskService,
      broadcast: (event) => this.deps.broadcast({ type: event.type, sessionId: '', data: event }),
      aliasFor: (l) => this.aliasFor(l),
      ...(this.deps.localWorkspaceName ? { localWorkspaceName: this.deps.localWorkspaceName } : {}),
      ...(this.deps.offers ? { offers: this.deps.offers } : {}),
      ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}),
      ...(this.deps.continue ? { continue: this.deps.continue } : {}),
      ...(this.deps.spawnLinks ? { spawnLinks: this.deps.spawnLinks } : {}),
      ...(this.images ? { images: { store: this.images, pullAttempts: this.pullAttempts } } : {}),
      taskBudget: this.taskBudget,
      log: this.deps.log,
    };
  }

  private outboundDeps(): OutboundDeps {
    const store = this.images;
    return {
      linkStore: this.deps.links,
      taskService: this.deps.taskService,
      outbox: this.outbox,
      aliasFor: (l) => this.aliasFor(l),
      peerFeatures: (hostId) => this.peerFeatures(hostId),
      ...(this.deps.spawnLinks ? { spawnLink: (id: string) => this.deps.spawnLinks!.isSpawnLink(id) } : {}),
      ...(store
        ? {
          images: {
            prepare: (paths, caller) => this.prepareOutgoing(paths, caller),
            hasOutgoing: async (sha) => (await store.readOutgoing(sha)) !== null,
          },
        }
        : {}),
    };
  }

  /** Read, check and strip the images an agent named, all or none (a refusal names the one at fault). */
  private async readImages(
    paths: readonly string[],
    caller: ImageCaller,
  ): Promise<{ ok: true; images: Array<{ bytes: Buffer; info: A2aImageInfo; sha256: string; name: string }> } | { ok: false; error: string }> {
    const store = this.images;
    if (!store) return { ok: false, error: 'unavailable: this PC cannot send images' };
    if (paths.length > A2A_REMOTE_IMAGE_LIMITS.PER_MESSAGE) {
      return { ok: false, error: `bad-request: at most ${A2A_REMOTE_IMAGE_LIMITS.PER_MESSAGE} images on one message` };
    }
    // No verified pane, or a terminal of another workspace: only the uploads folder.
    const roots = imageRoots(caller.ptyId ? this.deps.spawnCwdOf?.(caller.ptyId, caller.workspaceId) : undefined, store.uploadsRoot);
    const out: Array<{ bytes: Buffer; info: A2aImageInfo; sha256: string; name: string }> = [];
    let total = 0;
    for (const [i, given] of paths.entries()) {
      const label = `images[${i}] ${JSON.stringify(given.length > 200 ? `${given.slice(0, 200)}…` : given)}`;
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const read = await readImageSource(given, roots);
      if (!read.ok) return { ok: false, error: `bad-request: ${label}: ${imageSourceMessage(read.reason)}` };
      const prepared = prepareA2aImage(read.bytes);
      if (!prepared.ok) return { ok: false, error: `bad-request: ${label}: ${IMAGE_REFUSAL[prepared.reason]}` };
      const bytes = Buffer.from(prepared.bytes.buffer, prepared.bytes.byteOffset, prepared.bytes.byteLength);
      total += bytes.length;
      if (total > A2A_REMOTE_IMAGE_LIMITS.MESSAGE_MAX_BYTES) {
        return { ok: false, error: `bad-request: the images of one message may total ${A2A_REMOTE_IMAGE_LIMITS.MESSAGE_MAX_BYTES / (1024 * 1024)} MB` };
      }
      const hash = sha256(bytes);
      // The same picture named twice is sent once.
      if (out.some((o) => o.sha256 === hash)) continue;
      out.push({ bytes, info: prepared.info, sha256: hash, name: path.basename(given) });
    }
    return { ok: true, images: out };
  }

  /** The images of a message to another PC, kept as sender copies for the peer. */
  private async prepareOutgoing(paths: readonly string[], caller: ImageCaller): Promise<{ ok: true; images: PreparedImage[] } | { ok: false; error: string }> {
    const read = await this.readImages(paths, caller);
    const store = this.images;
    if (!read.ok) return read;
    if (!store) return { ok: false, error: 'unavailable: this PC cannot send images' };
    const out: PreparedImage[] = [];
    for (const r of read.images) {
      try {
        // eslint-disable-next-line no-await-in-loop -- a handful of small writes
        await store.putOutgoing(r.bytes);
      } catch (err) {
        return { ok: false, error: `unavailable: an image could not be kept for sending (${errMsg(err)})` };
      }
      out.push({
        ref: { sha256: r.sha256, mediaType: r.info.mediaType, bytes: r.bytes.length },
        name: r.name,
        path: store.outgoingPath(r.sha256),
        width: r.info.width,
        height: r.info.height,
      });
    }
    return { ok: true, images: out };
  }

  private heldDeps(): HeldDeps {
    return {
      taskService: this.deps.taskService,
      linkStore: this.deps.links,
      outbox: this.outbox,
      ...(this.deps.spawnLinks ? { spawnLink: (id: string) => this.deps.spawnLinks!.isSpawnLink(id) } : {}),
    };
  }
}

const IMAGE_REFUSAL: Record<A2aImageRefusal, string> = {
  unsupported: 'only PNG, JPEG and WebP images can be attached',
  animated: 'animated images cannot be attached; attach a still image',
  malformed: 'the image is damaged, or its bytes are not the format they claim',
  dimensions: `the image is larger than ${A2A_REMOTE_IMAGE_LIMITS.MAX_EDGE} px on a side or ${A2A_REMOTE_IMAGE_LIMITS.MAX_PIXELS / 1_000_000} megapixels`,
};

/** `images` / `paths` of an RPC: undefined when absent, null when malformed (not a list of up to 4 non-empty strings). */
function imagePaths(v: unknown): string[] | undefined | null {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.length > A2A_REMOTE_IMAGE_LIMITS.PER_MESSAGE) return null;
  if (!v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 4096)) return null;
  return v as string[];
}

/** The task a reply / state record is about; null for any other kind. */
function replyOrStateTask(rec: A2aOutboxRecordV1): string | null {
  return rec.envelope.kind === 'reply' || rec.envelope.kind === 'state' ? taskOfEnvelope(rec.envelope, remoteTaskId) : null;
}
