import crypto from 'node:crypto';
import path from 'node:path';
import {
  A2A_SPAWN_RPC,
  normalizeSpawnSub,
  asSpawnLinkId,
  spawnFirstMessageId,
  type SpawnLinkId,
  type A2aSpawnFollowUpCardV1,
  type A2aSpawnRequestV1,
  type A2aSpawnVerdict,
  type A2aSpawnWork,
} from '../../shared/a2aSpawn';
import { isHostId, type A2aLinkRecordV1, type HostId } from '../../shared/a2aRemote';
import { A2A_REMOTE_INBOUND_EVENT, remoteWorkspaceId, type A2aRemoteInboundEvent, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import type { ExposureStore } from './exposureStore';
import { remoteTaskId } from './ids';
import type { LinkStore } from './linkStore';
import type { SpawnLinkStore } from './spawnLinkStore';
import type { SpawnPolicyStore } from './spawnPolicyStore';
import type { A2aSpawnReceiver } from './spawnReceiver';
import type { SpawnRequestRecordV1 } from './spawnRequestStore';
import { errMsg, isSafeId } from './storeFile';

/**
 * Remote spawn on the receiving PC (B), once main has started the agent:
 * what makes it reachable from the asking PC, and what the link it gets
 * means for as long as it lives.
 *
 * `mint` (the receiver calls it from `started`):
 *   1. picks a fresh link id (a uuid nothing the asker sent predicts; it is
 *      told the id in the `started` answer);
 *   2. shows the new pane to that PC, unless it was shown already;
 *   3. records the link in `spawn-links.json` (before the link exists, so a
 *      link a start made is never without its put-back);
 *   4. creates the link, active at once and marked `spawned`
 *      (`LinkStore.createSpawned`): this PC takes new tasks from the asker's
 *      pane on it, and sends none;
 *   5. queues the prompt as the link's first inbound task (`first_<id>`),
 *      delivered like any remote task: typed into the pane once its agent is
 *      ready, never on a command line.
 *   Anything that fails undoes what this call made. A start that fails later
 *   (its `started` answer not stored, a restart, a start that never reported
 *   back) ends the link again through `abandon`.
 *
 * On a spawn link (`isSpawnLink`): outgoing text is redacted and no images go
 * either way (outbound.ts, inbound.ts); with `followUps: 'ask'` each later
 * task waits for its card (`held: 'awaiting-approval'`).
 *
 * When the link ends (`onLinkTransition`; `reconcile` on start and
 * periodically): the exposure the start added is put back, unless another
 * live link to that PC still uses the pane (then when that one ends), and the
 * record goes. The pane keeps running, owned by this PC's person.
 */

export interface SpawnStarterDeps {
  links: Pick<LinkStore, 'get' | 'list' | 'createSpawned' | 'revoke'>;
  spawnLinks: Pick<SpawnLinkStore, 'get' | 'has' | 'list' | 'add' | 'update' | 'remove'>;
  exposures: Pick<ExposureStore, 'addPane' | 'removePane' | 'isPaneExposed' | 'get'>;
  taskService: Pick<A2aTaskService, 'createTask' | 'listRemoteHeld'>;
  policy: Pick<SpawnPolicyStore, 'get'>;
  hostName: (hostId: HostId) => string | undefined;
  /** Display alias of a link's remote pane (`linkAlias`). */
  aliasFor: (link: A2aLinkRecordV1) => string;
  localWorkspaceName?: (workspaceId: string) => string | undefined;
  broadcast: (event: A2aRemoteInboundEvent) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  now?: () => number;
}

const TERMINAL_LINK: ReadonlySet<string> = new Set(['revoked', 'broken']);

export class A2aSpawnStarter {
  private readonly deps: SpawnStarterDeps;
  private readonly now: () => number;

  constructor(deps: SpawnStarterDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * A link a remote start made here: marked so on the link itself, or (a
   * file an older build rewrote without the mark) still recorded here.
   */
  isSpawnLink(linkId: string): boolean {
    const link = this.deps.links.get(linkId);
    return (link?.spawned === true && link.proposer === 'remote') || this.deps.spawnLinks.has(linkId);
  }

  /** A new task on this link waits for its card. */
  holdsFollowUps(linkId: string): boolean {
    return this.isSpawnLink(linkId) && this.deps.policy.get().followUps === 'ask';
  }

  /**
   * Agents remote starts made here that run, or are about to: of `hostId`,
   * or of every PC. A start still only prepared is counted by the request
   * (it is starting there), not here, so nothing counts twice.
   */
  liveCount(hostId?: HostId): number {
    return this.deps.spawnLinks.list().filter((r) => {
      if (hostId !== undefined && r.hostId !== hostId) return false;
      if (r.ending || r.phase === 'prepared') return false;
      if (r.phase === 'committed') return true;
      const link = this.deps.links.get(r.linkId);
      return link !== undefined && !TERMINAL_LINK.has(link.state);
    }).length;
  }

  /** Activated: the link, the exposure and the first task exist (the `started` answer may go). */
  isActive(linkId: string): boolean {
    return this.deps.spawnLinks.get(linkId)?.phase === 'active';
  }

  /**
   * Phase 1 of a start: reserve a fresh link id (nothing the asker sent
   * predicts it) and record what activation will need. Nothing exists yet
   * that the asker could reach: no link, no exposure, no task. Throws when
   * it cannot be recorded.
   */
  prepare(rec: SpawnRequestRecordV1, request: A2aSpawnRequestV1, end: { workspaceId: string; paneId: string }): SpawnLinkId {
    if (!isSafeId(end.workspaceId) || !isSafeId(end.paneId)) throw new Error('the started pane is not named');
    let linkId = asSpawnLinkId(crypto.randomUUID());
    while (!linkId || this.deps.links.get(linkId) || this.deps.spawnLinks.has(linkId)) linkId = asSpawnLinkId(crypto.randomUUID());
    const policy = this.deps.policy.get();
    const root = policy.roots.find((r) => r.id === request.folder.root);
    const sub = normalizeSpawnSub(request.folder.sub) ?? '';
    this.deps.spawnLinks.add({
      v: 1, linkId, hostId: rec.hostId, spawnId: rec.spawnId, workspaceId: end.workspaceId, paneId: end.paneId, agent: request.agent,
      rootId: request.folder.root, folder: root ? (sub ? path.join(root.path, ...sub.split('/')) : root.path) : '',
      remote: { workspaceId: request.from.workspaceId, paneId: request.from.paneId }, text: request.text,
      addedExposure: false, addedWorkspace: false, startedAt: new Date(this.now()).toISOString(), phase: 'prepared',
    });
    return linkId;
  }

  /** Phase 2 done (the request is stored `started`): activation may run, and is owed from now on. */
  commit(linkId: SpawnLinkId): void {
    this.deps.spawnLinks.update(linkId, { phase: 'committed' });
  }

  /** A prepared start that will not be committed: its reservation goes (nothing else was made). */
  discard(linkId: SpawnLinkId): void {
    if (this.deps.spawnLinks.get(linkId)?.phase === 'prepared') this.forget(linkId);
  }

  /**
   * Phase 3, once the start is committed: show the pane to that PC, create
   * the link active, queue the prompt as its first task (typed into the pane
   * once its agent is ready, never on a command line). Each step is done
   * only if missing, so a retry (after a failure or a restart) finishes it.
   * The exposure is recorded before it is added, so it is always put back.
   */
  async activate(linkId: SpawnLinkId): Promise<void> {
    let rec = this.deps.spawnLinks.get(linkId);
    if (!rec || rec.ending || rec.phase === 'prepared') throw new Error(`spawn link ${linkId}: not committed`);
    const { hostId } = rec;
    const end = { workspaceId: rec.workspaceId, paneId: rec.paneId };
    if (rec.phase === 'committed') {
      if (!this.deps.exposures.isPaneExposed(hostId, end.workspaceId, end.paneId)) {
        if (!rec.addedExposure) {
          const addedWorkspace = !(this.deps.exposures.get(hostId)?.workspaceIds.includes(end.workspaceId) ?? false);
          rec = this.deps.spawnLinks.update(linkId, { addedExposure: true, addedWorkspace });
        }
        this.deps.exposures.addPane(hostId, end.workspaceId, end.paneId);
      }
      let link = this.deps.links.get(linkId);
      if (!link) {
        link = this.deps.links.createSpawned({
          linkId,
          local: { kind: 'pane', ...end },
          remote: { hostId, kind: 'pane', ...rec.remote },
          allow: { inbound: true, outbound: false },
          proposer: 'remote',
        });
      }
      if (TERMINAL_LINK.has(link.state)) throw new Error(`spawn link ${linkId}: ended before it was activated`);
      const messageId = spawnFirstMessageId(linkId);
      const text = rec.text ?? '';
      const created = await this.deps.taskService.createTask(
        {
          id: remoteTaskId(linkId, messageId),
          title: text.split('\n', 1)[0].slice(0, 100),
          from: { workspaceId: remoteWorkspaceId(linkId), name: this.deps.aliasFor(link) },
          to: { workspaceId: end.workspaceId, name: this.deps.localWorkspaceName?.(end.workspaceId) ?? end.workspaceId, paneId: end.paneId },
          history: [{ kind: 'message', messageId, role: 'user', parts: [{ kind: 'text', text }] }],
          remote: { v: 1, linkId, hostId, messageId, direction: 'inbound', delivered: false, kind: 'pane' },
        },
        { conflictOnBodyMismatch: true },
      );
      if (!created.ok) throw new Error(`the prompt was not queued: ${created.error}`);
      this.deps.spawnLinks.update(linkId, { phase: 'active', dropText: true });
    }
    this.deps.broadcast({ type: A2A_REMOTE_INBOUND_EVENT, taskId: remoteTaskId(linkId, spawnFirstMessageId(linkId)) });
  }

  /**
   * A start that did not finish: a prepared one is only dropped; one that
   * got further is marked `ending` (durably) and its link ended, retried by
   * `reconcile` until it is.
   */
  abandon(hostId: HostId, spawnId: string): void {
    for (const rec of this.deps.spawnLinks.list()) {
      if (rec.hostId !== hostId || rec.spawnId !== spawnId) continue;
      const linkId = rec.linkId as SpawnLinkId;
      if (rec.phase === 'prepared') {
        this.discard(linkId);
        continue;
      }
      try {
        this.deps.spawnLinks.update(linkId, { ending: true });
      } catch (err) {
        this.deps.log('error', `[a2a-remote] spawn ${spawnId}: link ${linkId} not marked ending: ${errMsg(err)}`);
      }
      this.endLink(linkId);
    }
  }

  /**
   * Any link ended: put back what spawn links that ended showed. Not only
   * this one: a put-back that waited for another live link to let go of the
   * pane is done now, and one whose write failed is tried again.
   */
  onLinkTransition(link: A2aLinkRecordV1): void {
    if (TERMINAL_LINK.has(link.state)) this.reconcile();
  }

  /**
   * Spawn links that ended, vanished, or are being ended: end the link if it
   * still lives, put back the exposure, drop the record. On start, on every
   * link ending, and periodically, so whatever could not be done or written
   * is retried. A committed start whose activation is still owed is left to
   * the receiver.
   */
  reconcile(): void {
    for (const rec of this.deps.spawnLinks.list()) {
      const link = this.deps.links.get(rec.linkId);
      if (rec.ending && link && !TERMINAL_LINK.has(link.state)) {
        this.endLink(rec.linkId as SpawnLinkId);
        continue;
      }
      const gone = link ? TERMINAL_LINK.has(link.state) : rec.phase === 'active' || rec.ending === true;
      if (gone) this.end(rec.linkId);
    }
  }

  private endLink(linkId: SpawnLinkId): void {
    const link = this.deps.links.get(linkId);
    try {
      if (link && !TERMINAL_LINK.has(link.state)) this.deps.links.revoke(linkId, 'local');
      else this.reconcile();
    } catch (err) {
      // Kept `ending`: reconcile tries again.
      this.deps.log('error', `[a2a-remote] spawn link ${linkId} not ended yet: ${errMsg(err)}`);
    }
  }

  /** Later instructions held for their card, with what the card shows. */
  followUpCards(): A2aSpawnFollowUpCardV1[] {
    const policy = this.deps.policy.get();
    const out: A2aSpawnFollowUpCardV1[] = [];
    for (const task of this.deps.taskService.listRemoteHeld()) {
      const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
      if (!marker || marker.direction !== 'inbound' || marker.held !== 'awaiting-approval') continue;
      const rec = this.deps.spawnLinks.get(marker.linkId);
      if (!rec) continue;
      const text = (task.history[0]?.parts ?? []).flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n');
      out.push({
        taskId: task.id,
        hostId: rec.hostId,
        hostName: this.deps.hostName(rec.hostId) || rec.hostId.slice(0, 8),
        agent: rec.agent,
        folder: rec.folder,
        permissionMode: policy.permissionMode,
        text,
      });
    }
    return out;
  }

  private end(linkId: string): void {
    const rec = this.deps.spawnLinks.get(linkId);
    if (!rec) return;
    if (rec.addedExposure) {
      const inUse = this.deps.links.list().some(
        (l) => !TERMINAL_LINK.has(l.state) && l.linkId !== linkId && l.remote.hostId === rec.hostId &&
          l.local.kind === 'pane' && l.local.workspaceId === rec.workspaceId && l.local.paneId === rec.paneId,
      );
      // Not put back while another live link still uses the pane: the record stays until that one ends too.
      if (inUse) return;
      if (!this.unexpose(rec.hostId, rec, rec.addedWorkspace)) return;
    }
    this.forget(linkId);
  }

  /** False when the write failed (the pane is hidden in memory; the next start tries again). */
  private unexpose(hostId: HostId, end: { workspaceId: string; paneId: string }, dropWorkspace: boolean): boolean {
    try {
      this.deps.exposures.removePane(hostId, end.workspaceId, end.paneId, dropWorkspace);
      return true;
    } catch (err) {
      this.deps.log('error', `[a2a-remote] pane ${end.paneId} hidden from ${hostId} in memory only: ${errMsg(err)}`);
      return false;
    }
  }

  private forget(linkId: string): void {
    try {
      this.deps.spawnLinks.remove(linkId);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn link ${linkId}: record not removed: ${errMsg(err)}`);
    }
  }
}

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

const VERDICTS: ReadonlySet<string> = new Set<A2aSpawnVerdict>(['once', 'always', 'deny']);

/** The machine-local RPCs main drives a received request with (`wmux.internal`). */
export function registerSpawnStartRpc(
  onRpc: (method: string, handler: RpcHandler) => void,
  deps: { receiver: A2aSpawnReceiver; starter: A2aSpawnStarter },
): void {
  const ids = (p: Record<string, unknown>): { hostId: HostId; spawnId: string } | null => {
    const hostId = p['hostId'];
    const spawnId = p['spawnId'];
    return isHostId(hostId) && typeof spawnId === 'string' && spawnId.length > 0 && spawnId.length <= 64 ? { hostId, spawnId } : null;
  };
  const bad = { ok: false, error: 'bad-request' } as const;
  onRpc(A2A_SPAWN_RPC.work, async (): Promise<A2aSpawnWork> => ({ ...deps.receiver.work(), followUps: deps.starter.followUpCards() }));
  onRpc(A2A_SPAWN_RPC.decide, async (p) => {
    const id = ids(p);
    const verdict = p['verdict'];
    if (!id || typeof verdict !== 'string' || !VERDICTS.has(verdict)) return bad;
    return deps.receiver.decideCard(id.hostId, id.spawnId, verdict as A2aSpawnVerdict);
  });
  onRpc(A2A_SPAWN_RPC.claim, async (p) => {
    const id = ids(p);
    return id ? deps.receiver.claim(id.hostId, id.spawnId) : bad;
  });
  onRpc(A2A_SPAWN_RPC.started, async (p) => {
    const id = ids(p);
    const workspaceId = p['workspaceId'];
    const paneId = p['paneId'];
    const baseNote = p['baseNote'];
    if (!id || !isSafeId(workspaceId) || !isSafeId(paneId) || (baseNote !== undefined && typeof baseNote !== 'string')) return bad;
    return deps.receiver.started(id.hostId, id.spawnId, { workspaceId, paneId }, baseNote);
  });
  onRpc(A2A_SPAWN_RPC.failed, async (p) => {
    const id = ids(p);
    const code = p['code'];
    if (!id || (code !== 'folder-not-allowed' && code !== 'failed')) return bad;
    return deps.receiver.failed(id.hostId, id.spawnId, code);
  });
}
