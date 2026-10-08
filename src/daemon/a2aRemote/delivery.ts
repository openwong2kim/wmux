import crypto from 'node:crypto';
import {
  A2A_REMOTE_PROTOCOL,
  type A2aLinkRecordV1,
  type A2aOutboxRecordV1,
  type A2aRemoteDeliverResponse,
  type A2aRemoteErrorCode,
  type A2aRemoteHostRecordV1,
  type HostId,
  type PeerCredential,
} from '../../shared/a2aRemote';
import { A2A_REMOTE_RPC, type A2aRemoteHeldReason } from '../../shared/a2aRemoteDelivery';
import type { A2aRemoteHostStatus, A2aRemoteHostsStatusResult } from '../../shared/rpc';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import { failTasksForLink, expireHeld, rejectHeld, type HeldDeps } from './held';
import { remoteTaskId } from './ids';
import { acceptInbound, type InboundDeps } from './inbound';
import type { NotifyLinkChange } from './linkRpc';
import type { LinkStore } from './linkStore';
import { aliasTable, linkAlias, listRemoteTargets, sendRemoteReply, sendRemoteState, sendRemoteTask, syncRemoteTask, type OutboundDeps } from './outbound';
import { OutboxStore } from './outboxStore';
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
  'occupant-changed', 'pane-missing', 'link-not-active', 'brain-delivery-pending', 'brain-unavailable', 'delivery-unconfirmed', 'no-agent',
]);
/** What the sender's ledger shows while our pane has no agent to take its task. */
export const NO_AGENT_SUMMARY = 'The linked pane on the receiving PC has no agent running; the task is held until someone there acts.';
const STATES: ReadonlySet<string> = new Set(['working', 'input-required', 'completed', 'failed', 'canceled']);
const TERMINAL_LINK: ReadonlySet<string> = new Set(['revoked', 'broken']);

export class A2aRemoteDelivery {
  readonly outbox: OutboxStore;
  readonly hub: A2aStreamHub;
  private readonly deps: A2aRemoteDeliveryDeps;
  private readonly sessions = new Map<HostId, { session: JoinerSession; fingerprint: string; port: number }>();
  /** Server-side status, last announced. */
  private readonly served = new Map<HostId, A2aRemoteHostStatus['state']>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: A2aRemoteDeliveryDeps) {
    this.deps = deps;
    this.outbox = new OutboxStore({ dir: deps.dir, log: deps.log, onEnqueue: (rec) => this.onEnqueue(rec), onAck: (recs) => this.onAck(recs) });
    this.hub = new A2aStreamHub({
      outbox: this.outbox,
      accept: (env, peer) => this.accept(env, peer),
      serves: (hostId) => !deps.remoteHosts.get(hostId),
      onStatus: (hostId) => this.announceServed(hostId),
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

  /** Apply one envelope from an authenticated peer host. */
  accept(envelope: unknown, peer: { hostId: HostId }): Promise<A2aRemoteDeliverResponse> {
    return acceptInbound(envelope, peer, this.inboundDeps());
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
  }

  registerRoutes(table: A2aRouteTable): void {
    this.hub.register(table);
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
    }
    for (const host of hosts) {
      if (this.sessions.has(host.hostId)) continue;
      const session = this.newSession(host.hostId);
      this.sessions.set(host.hostId, { session, fingerprint: host.fingerprint256, port: host.port });
      session.start();
    }
  }

  status(): A2aRemoteHostStatus[] {
    const out: A2aRemoteHostStatus[] = [...this.sessions.values()].map((s) => s.session.current());
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
      if (held !== undefined && (typeof held !== 'string' || !HELD_REASONS.has(held))) return { ok: false, error: 'bad-request: unknown held reason' };
      const messageId = typeof p['messageId'] === 'string' ? p['messageId'] : undefined;
      const res = await svc.markRemote({
        taskId,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(p['delivered'] === true ? { delivered: true } : {}),
        ...(typeof held === 'string' ? { held: held as A2aRemoteHeldReason } : {}),
        ...(typeof p['attempted'] === 'boolean' && p['delivered'] !== true && held === undefined ? { attempted: p['attempted'] } : {}),
        ...(p['note'] === 'pasted-not-submitted' ? { note: 'pasted-not-submitted' as const } : {}),
        ...(typeof p['ptyId'] === 'string' && isSafeId(p['ptyId']) ? { ptyId: p['ptyId'] } : {}),
      });
      if (res.ok && held === 'no-agent' && messageId === undefined) await this.noAgent(taskId);
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
      });
    });

    onRpc(A2A_REMOTE_RPC.reply, async (p) => {
      if (typeof p['text'] !== 'string') return { ok: false, error: 'bad-request: text is required' };
      return sendRemoteReply(this.outboundDeps(), { taskId: str(p, 'taskId'), workspaceId: str(p, 'workspaceId'), text: p['text'] });
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
   * Our pane kept having no agent for the peer's task: the sender hears why,
   * once, as a reply from this side (its task stays open; `submitted` has no
   * edge to `input-required`, and nothing here has started the work).
   */
  private async noAgent(taskId: string): Promise<void> {
    const task = this.deps.taskService.getTask(taskId);
    if (!task || task.status.state !== 'submitted') return;
    const said = task.history.some((m) => m.parts.some((p) => p.kind === 'text' && p.text === NO_AGENT_SUMMARY));
    if (said) return;
    const res = await sendRemoteReply(this.outboundDeps(), { taskId, workspaceId: task.metadata.to.workspaceId, text: NO_AGENT_SUMMARY });
    if (!res.ok) this.deps.log('warn', `[a2a-remote] ${taskId}: could not tell the sender its pane has no agent: ${res.error}`);
  }

  private newSession(hostId: HostId): JoinerSession {
    return new JoinerSession({
      hostId,
      host: () => this.deps.remoteHosts.get(hostId),
      onConnected: addressPromoter(this.deps.remoteHosts, hostId, this.deps.log),
      credential: () => this.deps.remoteHosts.credentialFor(hostId),
      outbox: this.outbox,
      accept: (env, peer) => this.accept(env, peer),
      onRefused: (rec, code) => this.onRefused(rec, code),
      reconcileLinks: () => this.reconcileLinks(hostId),
      onStatus: (status) => this.deps.broadcast({ type: 'a2a.remote.hosts.status', sessionId: '', data: status }),
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

  /** The other PC refused a message for good: the task it carried fails here. */
  private async onRefused(rec: A2aOutboxRecordV1, code: A2aRemoteErrorCode): Promise<void> {
    this.deps.log('warn', `[a2a-remote] ${rec.hostId} refused ${rec.envelope.kind} on link ${rec.envelope.linkId}: ${code}`);
    const taskId = taskOfEnvelope(rec.envelope, remoteTaskId);
    if (!taskId || !this.deps.taskService.getTask(taskId)) return;
    await this.deps.taskService.forceFailRemote({ taskId, reason: `refused by the other PC: ${code}`, forced: 'remote_refused' });
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
    return {
      hostId,
      name,
      role: 'server',
      state: this.hub.isConnected(hostId) ? 'connected' : 'disconnected',
      pending: this.outbox.openCount(hostId),
      ...(since !== undefined ? { connectedAt: new Date(since).toISOString() } : {}),
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
    };
  }

  private outboundDeps(): OutboundDeps {
    return { linkStore: this.deps.links, taskService: this.deps.taskService, outbox: this.outbox, aliasFor: (l) => this.aliasFor(l) };
  }

  private heldDeps(): HeldDeps {
    return { taskService: this.deps.taskService, linkStore: this.deps.links, outbox: this.outbox };
  }
}

/** The task a reply / state record is about; null for any other kind. */
function replyOrStateTask(rec: A2aOutboxRecordV1): string | null {
  return rec.envelope.kind === 'reply' || rec.envelope.kind === 'state' ? taskOfEnvelope(rec.envelope, remoteTaskId) : null;
}
