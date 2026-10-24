import crypto from 'node:crypto';
import { A2A_FEATURE_SPAWN, A2A_REMOTE_PROTOCOL, isHostId, type A2aLinkRecordV1, type A2aRemoteEnvelope, type A2aRemoteErrorCode, type A2aRemoteTaskMarkerV1, type HostId } from '../../shared/a2aRemote';
import { remoteWorkspaceId, sanitizeRemoteMessage } from '../../shared/a2aRemoteDelivery';
import { isAgentSlug } from '../../shared/agentIdentity';
import {
  A2A_SPAWN_OUTGOING_EVENT,
  A2A_SPAWN_RPC,
  SPAWN_ASKS_OPEN_PER_HOST_MAX,
  SPAWN_ASKS_PER_PANE_PER_HOUR,
  SPAWN_ASK_GRACE_MS,
  SPAWN_ASK_TTL_DEFAULT_MS,
  SPAWN_CLOCK_SKEW_MS,
  SPAWN_REQUEST_KEY_RE,
  SPAWN_TTL_MAX_MS,
  asSpawnLinkId,
  parseSpawnRequest,
  spawnFirstMessageId,
  type A2aSpawnAskInput,
  type A2aSpawnAskResult,
  type A2aSpawnOutgoingEvent,
  type A2aSpawnOutgoingList,
  type A2aSpawnOutgoingSummary,
  type A2aSpawnRequestV1,
  type A2aSpawnResultV1,
  type A2aSpawnTargetsV1,
} from '../../shared/a2aSpawn';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import { remoteTaskId } from './ids';
import type { LinkStore } from './linkStore';
import type { SpawnOutgoingRecordV1, SpawnOutgoingStore } from './spawnOutgoingStore';
import { errMsg, isPlainObject } from './storeFile';

/**
 * The asking side of remote spawn: this PC asks another PC to start an agent.
 *
 * A request is stored, then queued in the outbox for that PC; it goes when
 * that PC is on, until it expires. Answers come back as `spawn-result`
 * envelopes (`A2aSpawnReceiver` hands them here). On `started` this PC makes
 * its side of the link (its own pane to the new one there) and its copy of
 * the first task, under the ids both PCs derive from the link id, so the
 * agent's replies and states land on it. Both are made before the answer is
 * taken: if either fails, the answer is refused `unavailable` and the other
 * PC sends it again.
 */

export interface SpawnRequesterDeps {
  store: SpawnOutgoingStore;
  links: Pick<LinkStore, 'get' | 'createSpawned'>;
  taskService: Pick<A2aTaskService, 'getTask' | 'createTask'>;
  /** Queue an envelope for `hostId`; throws when it was not queued. */
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  /** Every paired PC (either role) with this PC's name for it and whether its link is up. */
  hosts: () => { hostId: HostId; name: string; online: boolean }[];
  /** What `hostId` advertised most recently; undefined when it never connected. */
  features: (hostId: HostId) => ReadonlySet<string> | undefined;
  aliasFor: (link: A2aLinkRecordV1) => string;
  broadcast: (event: A2aSpawnOutgoingEvent) => void;
  now?: () => number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const HOUR_MS = 60 * 60 * 1000;
/** Longest a request may ask to wait: B refuses one past 72 h by its own clock, which may run behind. */
const TTL_CEILING_MS = SPAWN_TTL_MAX_MS - SPAWN_CLOCK_SKEW_MS;

export class A2aSpawnRequester {
  private readonly deps: SpawnRequesterDeps;
  private readonly now: () => number;

  constructor(deps: SpawnRequesterDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Store a request and queue it for the other PC. Never waits on that PC. */
  ask(input: A2aSpawnAskInput): A2aSpawnAskResult {
    const host = this.resolvePc(input.pc);
    if ('error' in host) return { ok: false, error: host.error };
    if (!this.deps.features(host.hostId)?.has(A2A_FEATURE_SPAWN)) {
      return { ok: false, error: 'not-supported', message: `${host.name}'s wmux cannot start agents for other PCs (or it has not connected since it was paired)` };
    }
    // A retry of a request already stored: its answer, never a second request.
    if (input.requestKey !== undefined) {
      if (!SPAWN_REQUEST_KEY_RE.test(input.requestKey)) return { ok: false, error: 'bad-request', message: 'requestKey must be 8-64 characters of [A-Za-z0-9-]' };
      const sent = this.deps.store.byRequestKey(input.callerKey, input.requestKey);
      if (sent) return sent.hostId === host.hostId ? { ok: true, spawn: this.summary(sent, host.name), online: host.online } : { ok: false, error: 'bad-request', message: 'that requestKey was used for another PC' };
    }
    const hours = input.expiresInHours ?? SPAWN_ASK_TTL_DEFAULT_MS / HOUR_MS;
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) return { ok: false, error: 'bad-request', message: 'expiresInHours must be a whole number from 1 to 72' };
    const now = this.now();
    const spawnId = `sp-${crypto.randomUUID()}`;
    const request = parseSpawnRequest({
      v: 1,
      spawnId,
      agent: input.agent,
      folder: input.folder,
      text: typeof input.text === 'string' ? sanitizeRemoteMessage(input.text) : input.text,
      expiresAt: new Date(now + Math.min(hours * HOUR_MS, TTL_CEILING_MS)).toISOString(),
      from: input.from,
    });
    if (!request) return { ok: false, error: 'bad-request', message: 'the agent, folder, prompt or reply pane is not valid' };
    if (this.deps.store.sentSince(input.callerKey, now - HOUR_MS) >= SPAWN_ASKS_PER_PANE_PER_HOUR) {
      return { ok: false, error: 'rate-limited', message: `at most ${SPAWN_ASKS_PER_PANE_PER_HOUR} requests per pane per hour` };
    }
    if (this.deps.store.openCount(host.hostId) >= SPAWN_ASKS_OPEN_PER_HOST_MAX) {
      return { ok: false, error: 'rate-limited', message: `${SPAWN_ASKS_OPEN_PER_HOST_MAX} requests to ${host.name} are waiting for an answer already` };
    }
    const at = new Date(now).toISOString();
    const rec: SpawnOutgoingRecordV1 = {
      v: 1, hostId: host.hostId, spawnId, agent: request.agent, rootId: request.folder.root,
      ...(request.folder.sub ? { sub: request.folder.sub } : {}),
      from: { workspaceId: request.from.workspaceId, paneId: request.from.paneId },
      callerKey: input.callerKey, ...(input.requestKey !== undefined ? { requestKey: input.requestKey } : {}),
      text: request.text, state: 'sent', createdAt: at, updatedAt: at, expiresAt: request.expiresAt,
    };
    try {
      this.deps.store.add(rec);
    } catch (err) {
      return { ok: false, error: 'unavailable', message: errMsg(err) };
    }
    try {
      this.deps.enqueue(host.hostId, this.requestEnvelope(request, now));
    } catch (err) {
      try {
        this.deps.store.remove(host.hostId, spawnId);
      } catch (e) {
        this.deps.log('warn', `[a2a-remote] spawn request ${spawnId}: not queued and not removed: ${errMsg(e)}`);
      }
      return { ok: false, error: 'unavailable', message: `could not queue the request (${errMsg(err)})` };
    }
    this.deps.log('info', `[a2a-remote] spawn request ${spawnId} to ${host.hostId}: ${request.agent} in ${request.folder.root}`);
    this.changed(host.hostId, spawnId, 'sent');
    return { ok: true, spawn: this.summary(rec, host.name), online: host.online };
  }

  /** This PC's requests (one, with `spawnId`) and what each paired PC lets it ask for. */
  list(spawnId?: string): A2aSpawnOutgoingList {
    this.expire();
    const hosts = this.deps.hosts();
    const nameOf = new Map(hosts.map((h) => [h.hostId, h.name]));
    const requests = this.deps.store.list()
      .filter((r) => !spawnId || r.spawnId === spawnId)
      .map((r) => this.summary(r, nameOf.get(r.hostId)));
    const places = hosts.map((h) => {
      const targets = this.deps.store.targets(h.hostId);
      return {
        hostId: h.hostId, name: h.name, online: h.online,
        supported: this.deps.features(h.hostId)?.has(A2A_FEATURE_SPAWN) === true,
        ...(targets ? { targets } : {}),
      };
    });
    return { requests, places };
  }

  /** `A2aSpawnReceiver.isOutstanding`: a request of this PC to `hostId` with no final answer yet. */
  isOutstanding(hostId: HostId, spawnId: string): boolean {
    return this.deps.store.takesAnswer(hostId, spawnId);
  }

  /**
   * An answer to one of this PC's requests. False when it could not be taken
   * (the other PC sends it again): `started` is taken only once this PC's
   * side of the link and its copy of the first task exist.
   */
  async onResult(hostId: HostId, result: A2aSpawnResultV1): Promise<boolean> {
    const rec = this.deps.store.get(hostId, result.spawnId);
    // An expired request still takes its answer: the other PC may have started
    // the agent just before the expiry while this PC was off.
    if (!rec || !this.deps.store.takesAnswer(hostId, result.spawnId)) return true;
    try {
      if (result.code === 'waiting-for-approval') {
        // Only a sent request moves to waiting: an expired one is revived only by `started`.
        if (rec.state === 'sent') this.settle(rec, { state: 'waiting' });
        return true;
      }
      if (result.code !== 'started') {
        this.settle(rec, { state: 'refused', code: result.code });
        return true;
      }
      const linkId = asSpawnLinkId(result.linkId);
      if (!linkId || !result.endpoint || result.linkVersion !== 1) {
        this.deps.log('warn', `[a2a-remote] spawn result ${rec.spawnId} from ${hostId}: started without a usable link`);
        this.settle(rec, { state: 'refused', code: 'failed' });
        return true;
      }
      // The link id is the other PC's word. An existing link is taken only when
      // it is the one this request reserved (a retry after a partial write);
      // any other id ends the request, so the other PC stops sending it.
      const existing = this.deps.links.get(linkId);
      const reservedElsewhere = this.deps.store.list().some((r) => r.linkId === linkId && !(r.hostId === hostId && r.spawnId === rec.spawnId));
      if (reservedElsewhere || (rec.linkId !== undefined && rec.linkId !== linkId) || (existing && !ownLink(existing, rec, hostId))) {
        this.deps.log('warn', `[a2a-remote] spawn result ${rec.spawnId} from ${hostId}: started on a link this request did not reserve`);
        this.settle(rec, { state: 'refused', code: 'failed' });
        return true;
      }
      let link = existing;
      if (!link) {
        // Reserved before the link exists, so a retry after a crash knows it as this request's.
        if (rec.linkId !== linkId) this.deps.store.settle(hostId, rec.spawnId, { state: rec.state, linkId });
        link = this.deps.links.createSpawned({
          linkId,
          local: { kind: 'pane', workspaceId: rec.from.workspaceId, paneId: rec.from.paneId },
          remote: { hostId, kind: 'pane', workspaceId: result.endpoint.workspaceId, paneId: result.endpoint.paneId },
          allow: { outbound: true, inbound: false },
          proposer: 'local',
        });
      }
      const messageId = spawnFirstMessageId(linkId);
      const taskId = remoteTaskId(linkId, messageId);
      const task = this.deps.taskService.getTask(taskId);
      if (task) {
        const marker = task.metadata.remote as A2aRemoteTaskMarkerV1 | undefined;
        if (marker?.linkId !== linkId || marker.direction !== 'outbound' || task.metadata.from.paneId !== rec.from.paneId) {
          this.deps.log('warn', `[a2a-remote] spawn result ${rec.spawnId} from ${hostId}: its first task id is another task's`);
          this.settle(rec, { state: 'refused', code: 'failed' });
          return true;
        }
      } else {
        const text = rec.text ?? '';
        const created = await this.deps.taskService.createTask({
          id: taskId,
          title: text.split('\n', 1)[0].slice(0, 100),
          from: { workspaceId: rec.from.workspaceId, name: rec.from.workspaceId, paneId: rec.from.paneId },
          to: { workspaceId: remoteWorkspaceId(linkId), name: this.deps.aliasFor(link) },
          history: [{ kind: 'message', messageId, role: 'user', parts: [{ kind: 'text', text }] }],
          // Sent already, as the request: the outbound sync never sends a task's own first message.
          remote: { v: 1, linkId, hostId, messageId, direction: 'outbound', kind: 'pane' },
        });
        if (!created.ok) throw new Error(`the first task was not recorded: ${created.error}`);
      }
      this.settle(rec, { state: 'started', linkId });
      this.deps.log('info', `[a2a-remote] spawn request ${rec.spawnId}: started on ${hostId}, link ${linkId}`);
      return true;
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn result ${result.spawnId} from ${hostId} not taken yet: ${errMsg(err)}`);
      return false;
    }
  }

  /** What `hostId` says this PC may ask for (only a newer version is kept). */
  onTargets(hostId: HostId, targets: A2aSpawnTargetsV1): void {
    try {
      if (this.deps.store.setTargets(hostId, targets)) this.deps.broadcast({ type: A2A_SPAWN_OUTGOING_EVENT, hostId });
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn targets from ${hostId} not stored: ${errMsg(err)}`);
    }
  }

  /** The other PC refused the request envelope for good: an older build that cannot read it. */
  onRefused(hostId: HostId, envelope: A2aRemoteEnvelope, code: A2aRemoteErrorCode): void {
    if (envelope.kind !== 'link' || envelope.link?.state !== 'spawn') return;
    const rec = this.deps.store.get(hostId, envelope.linkId);
    if (!rec || (rec.state !== 'sent' && rec.state !== 'waiting')) return;
    this.deps.log('warn', `[a2a-remote] spawn request ${rec.spawnId}: ${hostId} refused it (${code})`);
    this.trySettle(rec, { state: 'refused', code: 'not-supported' });
  }

  /** Requests with no answer past their expiry (and some grace) end `expired` here. */
  expire(): void {
    const now = this.now();
    for (const rec of this.deps.store.list()) {
      if ((rec.state === 'sent' || rec.state === 'waiting') && now > Date.parse(rec.expiresAt) + SPAWN_ASK_GRACE_MS) {
        this.trySettle(rec, { state: 'expired' });
      }
    }
  }

  forgetHost(hostId: HostId): void {
    this.deps.store.forgetHost(hostId);
  }

  private resolvePc(pc: string): { hostId: HostId; name: string; online: boolean } | { error: 'unknown-pc' | 'ambiguous-pc' } {
    const hosts = this.deps.hosts();
    const want = pc.trim().toLowerCase();
    if (isHostId(pc)) {
      const h = hosts.find((x) => x.hostId === pc);
      return h ?? { error: 'unknown-pc' };
    }
    const named = want ? hosts.filter((h) => h.name.trim().toLowerCase() === want) : [];
    if (named.length > 1) return { error: 'ambiguous-pc' };
    return named[0] ?? { error: 'unknown-pc' };
  }

  private requestEnvelope(request: A2aSpawnRequestV1, now: number): A2aRemoteEnvelope {
    return {
      protocol: A2A_REMOTE_PROTOCOL,
      linkId: request.spawnId,
      linkVersion: 0,
      messageId: `sq_${request.spawnId}`,
      kind: 'link',
      link: { state: 'spawn', version: 0 },
      spawn: request,
      sentAt: new Date(now).toISOString(),
    };
  }

  private settle(rec: SpawnOutgoingRecordV1, patch: Parameters<SpawnOutgoingStore['settle']>[2]): void {
    this.deps.store.settle(rec.hostId, rec.spawnId, patch);
    this.changed(rec.hostId, rec.spawnId, patch.state);
  }

  private trySettle(rec: SpawnOutgoingRecordV1, patch: Parameters<SpawnOutgoingStore['settle']>[2]): void {
    try {
      this.settle(rec, patch);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn request ${rec.spawnId}: ${patch.state} not stored: ${errMsg(err)}`);
    }
  }

  private changed(hostId: HostId, spawnId: string, state: A2aSpawnOutgoingSummary['state']): void {
    this.deps.broadcast({ type: A2A_SPAWN_OUTGOING_EVENT, hostId, spawnId, state });
  }

  private summary(rec: SpawnOutgoingRecordV1, hostName: string | undefined): A2aSpawnOutgoingSummary {
    return {
      hostId: rec.hostId, ...(hostName ? { hostName } : {}), spawnId: rec.spawnId, agent: rec.agent, rootId: rec.rootId,
      ...(rec.sub ? { sub: rec.sub } : {}),
      from: { kind: 'pane', workspaceId: rec.from.workspaceId, paneId: rec.from.paneId },
      state: rec.state, ...(rec.code ? { code: rec.code } : {}), ...(rec.linkId ? { linkId: rec.linkId } : {}),
      createdAt: rec.createdAt, updatedAt: rec.updatedAt, expiresAt: rec.expiresAt,
    };
  }
}

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** The asking side's daemon RPCs; main checks the caller (local origin, its own pane, depth 1) before `ask`. */
export function registerSpawnAskRpc(onRpc: (method: string, handler: RpcHandler) => void, requester: A2aSpawnRequester): void {
  onRpc(A2A_SPAWN_RPC.ask, async (p) => {
    const folder = isPlainObject(p['folder']) ? p['folder'] : null;
    const from = isPlainObject(p['from']) ? p['from'] : null;
    if (typeof p['pc'] !== 'string' || !isAgentSlug(p['agent']) || !folder || typeof folder['root'] !== 'string' || typeof p['text'] !== 'string' ||
      !from || typeof from['workspaceId'] !== 'string' || typeof from['paneId'] !== 'string' || typeof p['callerKey'] !== 'string' ||
      (p['expiresInHours'] !== undefined && typeof p['expiresInHours'] !== 'number') || (p['requestKey'] !== undefined && typeof p['requestKey'] !== 'string')) {
      return { ok: false, error: 'bad-request', message: 'pc, agent, folder{root, sub?}, text, from{workspaceId, paneId} and callerKey are required' };
    }
    return requester.ask({
      pc: p['pc'],
      agent: p['agent'],
      folder: { root: folder['root'], ...(typeof folder['sub'] === 'string' && folder['sub'] ? { sub: folder['sub'] } : {}) },
      text: p['text'],
      ...(typeof p['expiresInHours'] === 'number' ? { expiresInHours: p['expiresInHours'] } : {}),
      from: { kind: 'pane', workspaceId: from['workspaceId'], paneId: from['paneId'] },
      callerKey: p['callerKey'],
      ...(typeof p['requestKey'] === 'string' ? { requestKey: p['requestKey'] } : {}),
    });
  });
  onRpc(A2A_SPAWN_RPC.outgoing, async (p) => requester.list(typeof p['spawnId'] === 'string' ? p['spawnId'] : undefined));
}

/** The link this request reserved and made: this PC's asking pane to that PC, marked as a spawn's. */
function ownLink(link: A2aLinkRecordV1, rec: SpawnOutgoingRecordV1, hostId: HostId): boolean {
  return rec.linkId === link.linkId && link.spawned === true && link.proposer === 'local' && link.remote.hostId === hostId &&
    link.local.kind === 'pane' && link.local.workspaceId === rec.from.workspaceId && link.local.paneId === rec.from.paneId;
}
