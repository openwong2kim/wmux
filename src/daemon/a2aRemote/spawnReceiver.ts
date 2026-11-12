import fs from 'node:fs';
import path from 'node:path';
import { agentExecEnv } from '../../shared/execEnv';
import { agentLauncherStem, agentRow, type AgentSlug } from '../../shared/agentIdentity';
import { A2A_REMOTE_PROTOCOL, isHostId, type A2aRemoteDeliverResponse, type A2aRemoteEnvelope, type HostId } from '../../shared/a2aRemote';
import {
  A2A_SPAWN_RPC,
  SPAWN_TARGETS_LINK_ID,
  asSpawnLinkId,
  isFinalSpawnCode,
  isSpawnableAgent,
  normalizeSpawnSub,
  spawnRuleMatches,
  parseSpawnRequest,
  parseSpawnResult,
  parseSpawnTargets,
  spawnClockOk,
  spawnHostAllowed,
  spawnPendingPerHost,
  spawnTargetsFor,
  type A2aSpawnCardV1,
  type A2aSpawnClaimResult,
  type A2aSpawnCode,
  type A2aSpawnPolicyV1,
  type A2aSpawnRequestState,
  type A2aSpawnRequestV1,
  type A2aSpawnResultV1,
  type A2aSpawnStepResult,
  type A2aSpawnTargetsV1,
  type A2aSpawnVerdict,
  type A2aSpawnWork,
  type SpawnLinkId,
} from '../../shared/a2aSpawn';
import { sanitizeRemoteMessage } from '../../shared/a2aRemoteDelivery';
import { whichOnPath } from '../web/agentLaunch';
import type { SpawnPolicyStore } from './spawnPolicyStore';
import { samePath } from './spawnPolicyStore';
import { CheckTimeout, notThere, realpathNative, spawnChecks, type SpawnChecks } from './spawnChecks';
import { spawnFingerprint, type SpawnRequestRecordV1, type SpawnRequestStore, type SpawnStarted } from './spawnRequestStore';
import { errMsg, isPlainObject } from './storeFile';

/**
 * Remote spawn, the transport side (both roles; see `shared/a2aSpawn.ts`).
 *
 * Receiving a request (this PC is B): only cheap checks run before the
 * answer, which is `ok` for anything readable. A request that fails one is
 * answered and not stored; one that passes is stored pending and decided
 * right after. Either way its outcome goes back as a `spawn-result` envelope
 * through this PC's own outbox, so it reaches A whichever side joined, and
 * nothing that waits ever holds up the transport.
 *
 * Order of the checks, so a PC that may not ask learns nothing else:
 *   1. this PC opted in (feature on, host allowed)  else `not-allowed`
 *   -- a request already here: its stored outcome is sent again (or its
 *      decision resumed); the same id with another body is a `conflict`
 *   2. B's clock window (`spawnClockOk`)              else `expired`
 *   3. room (pending per PC, records kept)            else `rate-limited`
 *   -- answered `ok` here; then, decided:
 *   4. the agent is on B's list                       else `agent-not-allowed`
 *   5. the agent is installed                         else `agent-not-installed`
 *   6. the root is listed, still resolves to itself,
 *      and root + sub stays inside it, as a folder    else `folder-not-allowed`
 *   7. the policy and the expiry, read again after those waits
 *   8. room: starts per PC per hour and per day, and
 *      agents running at once, per PC and in all       else `rate-limited`
 *   9. the app is up (it waits for it, until expiry)  else `app-not-ready`
 *  10. a rule allows it (allow-list mode)             → approved
 *      otherwise                                      → its card; `waiting-for-approval`
 *
 * Then, driven by main: the card's answer (`decideCard`); `claim`, which
 * checks everything again right before the start (policy, room, agent,
 * folder) and hands main what it needs; `started` / `failed`. A build with
 * no `start` cannot start anything and answers `not-supported` at step 10.
 *
 * The same answer to the same request goes out at most once per
 * `SPAWN_REFUSAL_COALESCE_MS`. Each disk or PATH check goes through
 * `spawnChecks` (bounded in time, and in number process-wide; past the time
 * the request ends `failed`). Any other error keeps the request pending and
 * tries again later, until it expires.
 *
 * Receiving a result or targets (this PC is A): handed on only for a request
 * this PC sent and that has no final answer yet, and only newer targets.
 */

// Requests open per PC, starts per hour and day, and agents running per PC and
// in all: the owner's `limits` in the policy (A2aSpawnLimitsV1), read at each
// check. Absent means no limit, except requests open per PC
// (SPAWN_PENDING_PER_HOST_DEFAULT).
/** A claimed start main never reported back on ends `failed` after this. */
export const SPAWN_STARTING_MAX_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The same answer to the same request of one PC is sent at most once in this window. */
export const SPAWN_REFUSAL_COALESCE_MS = 60_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Final answers this PC remembers having handed on (as A). */
const ANSWERED_MAX = 1000;
/** Recent answers remembered for coalescing. */
const ANSWERED_RECENTLY_MAX = 1000;

export interface SpawnReceiverDeps {
  policy: Pick<SpawnPolicyStore, 'get'> & Partial<Pick<SpawnPolicyStore, 'set'>>;
  requests: Pick<SpawnRequestStore, 'get' | 'receive' | 'decide' | 'pending' | 'pendingCount' | 'markSent' | 'unsent'>
    & Partial<Pick<SpawnRequestStore, 'advance' | 'inState' | 'approvedSince' | 'startingCount' | 'startsSince' | 'noteClaimedRoot'>>;
  /** Queue an envelope to `hostId` (the delivery outbox); throws when it cannot. */
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  /** Whether this PC can run `agent` (its launcher on the login PATH). */
  agentInstalled?: (agent: AgentSlug) => Promise<boolean>;
  realpath?: (p: string) => Promise<string>;
  /** Whether `p` is a folder; rejects with the stat error when it cannot tell. */
  isDirectory?: (p: string) => Promise<boolean>;
  /** As A: a request this PC sent to `hostId` that is still waiting for an answer. */
  isOutstanding?: (hostId: HostId, spawnId: string) => boolean;
  /** As A: an answer to one of this PC's requests; false when it could not be taken yet (the other PC sends it again). */
  onResult?: (hostId: HostId, result: A2aSpawnResultV1) => Promise<boolean>;
  /** The app has caught up with this daemon (it knows which panes exist). Until then a request waits. Default: ready. */
  appReady?: () => boolean;
  /** Live links remote starts made here: of `hostId`, or of every PC. Default: none. */
  liveSpawns?: (hostId?: HostId) => number;
  /** A request moved to a state main acts on (the `A2A_SPAWN_EVENT` broadcast). */
  onChange?: (hostId: HostId, spawnId: string, state: A2aSpawnRequestState) => void;
  /** This PC's name for `hostId`. */
  hostName?: (hostId: HostId) => string | undefined;
  /**
   * Make a started agent reachable, in phases (spawnStarter.ts): `prepare`
   * reserves the link (nothing reachable yet), the receiver stores `started`,
   * `commit` marks it owed, `activate` makes the link, the exposure and the
   * first task (idempotent, retried until it lands); only then the answer
   * goes. Absent: this build starts nothing.
   */
  start?: {
    prepare(rec: SpawnRequestRecordV1, request: A2aSpawnRequestV1, end: { workspaceId: string; paneId: string }): SpawnLinkId;
    commit(linkId: SpawnLinkId): void;
    discard(linkId: SpawnLinkId): void;
    activate(linkId: SpawnLinkId): Promise<void>;
    isActive(linkId: string): boolean;
  };
  /** End the link (and its exposure) a start of `spawnId` made, if any: the start did not finish. */
  abandon?: (hostId: HostId, spawnId: string) => void;
  onTargets?: (hostId: HostId, targets: A2aSpawnTargetsV1) => void;
  /** Targets for `hostId` are still in the outbox (so a start does not queue them again). */
  targetsQueued?: (hostId: HostId) => boolean;
  now?: () => number;
  /** Test seams. */
  checks?: SpawnChecks;
  retryMinMs?: number;
  refusalCoalesceMs?: number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

type SpawnEnvelopeState = 'spawn' | 'spawn-result' | 'spawn-targets';
/** What deciding a pending request comes to: a final code, its card, or approved by a rule. */
type Decision = A2aSpawnCode | 'awaiting' | 'approved';

/** The app has not caught up with this daemon yet: the request waits (and ends `app-not-ready` at its expiry). */
class AppNotReady extends Error {}

export function isSpawnEnvelope(env: A2aRemoteEnvelope): env is A2aRemoteEnvelope & { link: { state: SpawnEnvelopeState } } {
  const s = env.kind === 'link' ? env.link?.state : undefined;
  return s === 'spawn' || s === 'spawn-result' || s === 'spawn-targets';
}

const OK: A2aRemoteDeliverResponse = { ok: true, duplicate: false };
const UNAVAILABLE: A2aRemoteDeliverResponse = { ok: false, error: 'unavailable' };

export class A2aSpawnReceiver {
  private readonly deps: SpawnReceiverDeps;
  private readonly now: () => number;
  private readonly agentInstalled: (agent: AgentSlug) => Promise<boolean>;
  private readonly realpath: (p: string) => Promise<string>;
  private readonly isDirectory: (p: string) => Promise<boolean>;
  private readonly checks: SpawnChecks;
  private readonly retryMinMs: number;
  private readonly refusalCoalesceMs: number;
  /** Makes every result's message id new, across restarts too. */
  private readonly boot: string;
  private sends = 0;
  private stopped = false;
  /** Decisions in flight, by host:spawnId, so one is never decided twice at once. */
  private readonly deciding = new Map<string, Promise<void>>();
  /** Starts being linked (`started`), by host:spawnId. */
  private readonly minting = new Set<string>();
  /** Starts main gave up on while they were being linked: they refuse themselves before committing. */
  private readonly abandoned = new Set<string>();
  /** Stored starts being made reachable. */
  private readonly delivering = new Set<string>();
  /** Decisions waiting to try again, by host:spawnId. */
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each answer (host:spawnId:code) was last sent. */
  private readonly answeredAt = new Map<string, number>();
  /** As A: host:spawnId whose final answer was handed on. */
  private readonly answered = new Set<string>();
  /** As A: the newest targets version each PC sent. */
  private readonly targetsVersion = new Map<HostId, number>();

  constructor(deps: SpawnReceiverDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.agentInstalled = deps.agentInstalled ?? agentOnPath;
    this.realpath = deps.realpath ?? realpathNative;
    this.isDirectory = deps.isDirectory ?? ((p) => fs.promises.stat(p).then((s) => s.isDirectory()));
    this.checks = deps.checks ?? spawnChecks;
    this.retryMinMs = deps.retryMinMs ?? RETRY_MIN_MS;
    this.refusalCoalesceMs = deps.refusalCoalesceMs ?? SPAWN_REFUSAL_COALESCE_MS;
    this.boot = this.now().toString(36);
  }

  /** One spawn envelope from an authenticated peer. Never waits on a decision. */
  applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse | Promise<A2aRemoteDeliverResponse> {
    const state = env.link?.state;
    if (env.linkVersion !== 0) return { ok: false, error: 'bad-request' };
    if (state === 'spawn-result') {
      const result = parseSpawnResult(env.spawnResult);
      if (!result || result.spawnId !== env.linkId) return { ok: false, error: 'bad-request' };
      return this.takeResult(peer.hostId, result);
    }
    if (state === 'spawn-targets') {
      const targets = parseSpawnTargets(env.spawnTargets);
      if (!targets || env.linkId !== SPAWN_TARGETS_LINK_ID) return { ok: false, error: 'bad-request' };
      if (targets.version > (this.targetsVersion.get(peer.hostId) ?? -1)) {
        this.targetsVersion.set(peer.hostId, targets.version);
        this.deps.onTargets?.(peer.hostId, targets);
      }
      return OK;
    }
    // The prompt reaches a terminal later: control characters and escape
    // sequences go first, and only then is it checked for being empty.
    const raw = env.spawn as unknown;
    const clean = isPlainObject(raw) && typeof raw['text'] === 'string' ? { ...raw, text: sanitizeRemoteMessage(raw['text']) } : raw;
    const req = parseSpawnRequest(clean);
    if (!req || req.spawnId !== env.linkId) return { ok: false, error: 'bad-request' };
    return this.receive(peer.hostId, req, env.sentAt);
  }

  /**
   * Tell PCs what they may ask for. With `previous` (a save): every PC allowed
   * now gets its targets, and one allowed before but not now gets empty lists
   * (it learns no more than a `not-allowed` answer would tell it). Without (a
   * start): every allowed PC, unless targets for it are still queued.
   */
  sendTargets(previous?: A2aSpawnPolicyV1): void {
    const policy = this.deps.policy.get();
    const hosts = new Set([...Object.keys(policy.hosts), ...Object.keys(previous?.hosts ?? {})]);
    for (const hostId of hosts) {
      if (!isHostId(hostId)) continue;
      const allowed = spawnTargetsFor(policy, hostId) !== null;
      if (previous) {
        if (!allowed && spawnTargetsFor(previous, hostId) === null) continue;
      } else if (!allowed || this.deps.targetsQueued?.(hostId)) {
        continue;
      }
      const env = this.targetsEnvelope(hostId) ?? this.targetsEnvelope(hostId, { v: 1, version: policy.version, roots: [], agents: [] });
      try {
        if (env) this.deps.enqueue(hostId, env);
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] spawn targets for ${hostId} not queued: ${errMsg(err)}`);
      }
    }
  }

  /** What `hostId` may ask for (or `targets`), as an envelope; null when it may not ask. */
  targetsEnvelope(hostId: HostId, empty?: A2aSpawnTargetsV1): A2aRemoteEnvelope | null {
    const targets = empty ?? spawnTargetsFor(this.deps.policy.get(), hostId);
    if (!targets) return null;
    return {
      protocol: A2A_REMOTE_PROTOCOL,
      linkId: SPAWN_TARGETS_LINK_ID,
      linkVersion: 0,
      messageId: `st-${targets.version}`,
      kind: 'link',
      link: { state: 'spawn-targets', version: 0 },
      spawnTargets: targets,
      sentAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * After a restart: decide what is pending, send what was decided but never
   * left. A start main had claimed is not resumed (the agent may or may not
   * be running): it ends `failed`. Approved ones are announced again for main.
   */
  recover(): void {
    for (const rec of this.deps.requests.pending()) this.scheduleDecide(rec.hostId, rec.spawnId);
    for (const rec of this.deps.requests.unsent()) {
      if (rec.code === 'started') void this.deliverStarted(rec);
      else this.sendDecided(rec);
    }
    for (const rec of this.deps.requests.inState?.('starting') ?? []) this.failStart(rec.hostId, rec.spawnId, 'failed');
    this.sweep();
    for (const rec of this.deps.requests.inState?.('approved') ?? []) this.deps.onChange?.(rec.hostId, rec.spawnId, 'approved');
  }

  /**
   * Requests on a card, or approved and not started, past their expiry end
   * `expired`. A start main claimed and never reported (main restarted, or
   * its report was lost) ends `failed` after `SPAWN_STARTING_MAX_MS`, with
   * whatever it made undone, so it cannot hold a slot for good.
   */
  sweep(): void {
    for (const state of ['awaiting', 'approved'] as const) {
      for (const rec of this.deps.requests.inState?.(state) ?? []) {
        if (this.now() > Date.parse(rec.expiresAt)) this.finish(rec.hostId, rec.spawnId, 'expired');
      }
    }
    for (const rec of this.deps.requests.inState?.('starting') ?? []) {
      const since = Date.parse(rec.claimedAt ?? rec.receivedAt);
      if (this.now() - since > SPAWN_STARTING_MAX_MS && !this.minting.has(`${rec.hostId}:${rec.spawnId}`)) this.failStart(rec.hostId, rec.spawnId, 'failed');
    }
    // Starts stored but not yet made reachable (an activation that failed): tried again.
    for (const rec of this.deps.requests.unsent()) if (rec.code === 'started') void this.deliverStarted(rec);
  }

  /** End a start that did not finish, and undo the link it may have made (with its exposure). */
  private failStart(hostId: HostId, spawnId: string, code: A2aSpawnCode): boolean {
    const stored = this.finish(hostId, spawnId, code);
    try {
      this.deps.abandon?.(hostId, spawnId);
    } catch (err) {
      this.deps.log('error', `[a2a-remote] spawn ${spawnId} from ${hostId}: its link was not ended: ${errMsg(err)}`);
    }
    return stored;
  }

  // --- B: what main does with a request ----------------------------------------

  /** What main has to show (cards) or start (approved). Expired ones are swept first. */
  work(): Pick<A2aSpawnWork, 'awaiting' | 'approved'> {
    this.sweep();
    const awaiting: A2aSpawnCardV1[] = [];
    for (const rec of this.deps.requests.inState?.('awaiting') ?? []) {
      const card = this.card(rec);
      if (card) awaiting.push(card);
    }
    const approved = (this.deps.requests.inState?.('approved') ?? []).map((r) => ({ hostId: r.hostId, spawnId: r.spawnId }));
    return { awaiting, approved };
  }

  /** The card for a request awaiting it: this PC's names for everything, and the full prompt. */
  card(rec: SpawnRequestRecordV1): A2aSpawnCardV1 | null {
    const req = rec.request;
    if (!req) return null;
    const policy = this.deps.policy.get();
    const root = policy.roots.find((r) => r.id === req.folder.root);
    if (!root) return null;
    const sub = req.folder.sub ? normalizeSpawnSub(req.folder.sub) : '';
    return {
      hostId: rec.hostId,
      hostName: this.deps.hostName?.(rec.hostId) || rec.hostId.slice(0, 8),
      spawnId: rec.spawnId,
      agent: req.agent,
      rootId: root.id,
      rootLabel: root.label,
      folder: sub ? path.join(root.path, ...sub.split('/')) : root.path,
      permissionMode: policy.permissionMode,
      followUps: policy.followUps,
      text: req.text,
      expiresAt: req.expiresAt,
    };
  }

  /**
   * The card's answer. `deny` ends the request `declined`; `once` and
   * `always` approve it, and `always` also adds the (PC, root, agent) rule,
   * which allow-list mode honours from then on.
   */
  decideCard(hostId: HostId, spawnId: string, verdict: A2aSpawnVerdict): Promise<A2aSpawnStepResult> {
    // On the claims' queue: the room it checks must not change before it is taken.
    return this.serialized(() => this.decideCardNow(hostId, spawnId, verdict));
  }

  private async decideCardNow(hostId: HostId, spawnId: string, verdict: A2aSpawnVerdict): Promise<A2aSpawnStepResult> {
    const rec = this.deps.requests.get(hostId, spawnId);
    if (!rec || rec.state !== 'awaiting' || !rec.request) return { ok: false, error: 'this request is not waiting for its card' };
    if (this.now() > Date.parse(rec.expiresAt)) {
      this.finish(hostId, spawnId, 'expired');
      return { ok: false, error: 'this request has expired' };
    }
    if (verdict === 'deny') return this.finish(hostId, spawnId, 'declined') ? { ok: true } : { ok: false, error: 'the answer could not be stored' };
    // Approving one more must still fit the room it had when its card opened.
    if (this.overCaps(hostId)) {
      this.finish(hostId, spawnId, 'rate-limited');
      return { ok: false, error: 'rate-limited' };
    }
    if (verdict === 'always') await this.addRule(hostId, rec.request);
    let moved: SpawnRequestRecordV1 | undefined;
    try {
      moved = this.deps.requests.advance?.(hostId, spawnId, ['awaiting'], 'approved');
    } catch (err) {
      return { ok: false, error: `the answer could not be stored: ${errMsg(err)}` };
    }
    if (!moved) return { ok: false, error: 'this request is not waiting for its card' };
    this.audit(moved, `approved (${verdict})`);
    this.deps.onChange?.(hostId, spawnId, 'approved');
    return { ok: true };
  }

  /**
   * Main takes an approved request to start it. Everything is checked again
   * right now: the PC still allowed, the agent still listed and installed,
   * the root still listed and resolving to itself, the folder inside it, the
   * expiry, and room for one more running agent. A refusal ends the request
   * with its code (answered to the asker); a check that could not run now
   * leaves it approved for main to try again.
   */
  claim(hostId: HostId, spawnId: string): Promise<A2aSpawnClaimResult> {
    // One claim at a time (across PCs, for the total): concurrent claims
    // would each see the room the others are about to take.
    return this.serialized(() => this.claimNow(hostId, spawnId));
  }

  /** Card answers and claims, one at a time. */
  private serialized<T>(step: () => Promise<T>): Promise<T> {
    const run = this.claims.then(step);
    this.claims = run.then(() => undefined, () => undefined);
    return run;
  }

  private claims: Promise<void> = Promise.resolve();

  /**
   * Room for this start, counted with it already starting: running agents
   * plus starts in flight, per PC and in all, and starts per hour and day.
   */
  private roomFor(hostId: HostId, spawnId: string): boolean {
    const r = this.deps.requests;
    const live = this.deps.liveSpawns ?? ((): number => 0);
    const others = (h?: HostId): number => Math.max(0, (r.startingCount?.(h) ?? 0) - 1);
    const now = this.now();
    return !this.atALimit({
      livePerPc: () => live(hostId) + others(hostId),
      liveTotal: () => live() + others(),
      startsPerHour: () => r.startsSince?.(now - HOUR_MS, hostId, spawnId) ?? 0,
      startsPerDay: () => r.startsSince?.(now - DAY_MS, hostId, spawnId) ?? 0,
    });
  }

  private async claimNow(hostId: HostId, spawnId: string): Promise<A2aSpawnClaimResult> {
    let rec: SpawnRequestRecordV1 | undefined;
    try {
      rec = this.deps.requests.advance?.(hostId, spawnId, ['approved'], 'starting');
    } catch (err) {
      return { ok: false, error: `not claimed: ${errMsg(err)}` };
    }
    const req = rec?.request;
    if (!rec || !req) return { ok: false, error: 'this request is not approved, or is already starting' };
    const refuse = (code: A2aSpawnCode): A2aSpawnClaimResult => {
      this.finish(hostId, spawnId, code);
      return { ok: false, error: code, code };
    };
    const policy = this.deps.policy.get();
    if (!spawnHostAllowed(policy, hostId)) return refuse('not-allowed');
    if (this.now() > Date.parse(req.expiresAt)) return refuse('expired');
    if (!policy.agents.includes(req.agent) || !isSpawnableAgent(req.agent)) return refuse('agent-not-allowed');
    const sub = normalizeSpawnSub(req.folder.sub);
    const root = policy.roots.find((r) => r.id === req.folder.root);
    if (sub === null || !root) return refuse('folder-not-allowed');
    if (!this.roomFor(hostId, spawnId)) return refuse('rate-limited');
    try {
      if (!(await this.checks.run(() => this.agentInstalled(req.agent)))) return refuse('agent-not-installed');
      if (!(await this.folderInside(root.path, sub))) return refuse('folder-not-allowed');
    } catch (err) {
      if (err instanceof CheckTimeout) return refuse('failed');
      // Busy or a passing error: back to approved, main tries again.
      try {
        this.deps.requests.advance?.(hostId, spawnId, ['starting'], 'approved');
      } catch (e) {
        this.deps.log('warn', `[a2a-remote] spawn request ${spawnId} from ${hostId}: not put back to approved: ${errMsg(e)}`);
      }
      return { ok: false, error: `not checked now, try again: ${errMsg(err)}` };
    }
    // The checks waited: the policy, the expiry and the room are read once more.
    const now = this.deps.policy.get();
    if (!spawnHostAllowed(now, hostId) || !now.agents.includes(req.agent) || !now.roots.some((r) => r.id === root.id && r.path === root.path)) {
      return refuse('not-allowed');
    }
    if (this.now() > Date.parse(req.expiresAt)) return refuse('expired');
    if (!this.roomFor(hostId, spawnId)) return refuse('rate-limited');
    try {
      this.deps.requests.noteClaimedRoot?.(hostId, spawnId, root.path);
    } catch (err) {
      return refuse('failed');
    }
    this.audit(rec, 'starting');
    return {
      ok: true,
      claim: {
        hostId,
        hostName: this.deps.hostName?.(hostId) || hostId.slice(0, 8),
        spawnId,
        agent: req.agent,
        repoPath: root.path,
        sub,
        permissionMode: now.permissionMode,
      },
    };
  }

  /**
   * Main started the agent in this pane. The policy, the root (by id and by
   * the path the claim checked) and the expiry are checked once more (the
   * start took a while); refused, main closes what it opened. Then, in this
   * order: the link is reserved (nothing reachable), the request is stored
   * `started` (committed), and only then the link, the exposure and the
   * first task are made and the answer goes. A `failed` from main before the
   * commit abandons the start; after it, the start stands.
   */
  async started(hostId: HostId, spawnId: string, end: { workspaceId: string; paneId: string }): Promise<A2aSpawnStepResult> {
    const rec = this.deps.requests.get(hostId, spawnId);
    const req = rec?.request;
    if (!rec || rec.state !== 'starting' || !req) return { ok: false, error: 'this request is not starting' };
    const start = this.deps.start;
    if (!start) return { ok: false, error: 'this build cannot start remote agents' };
    const k = `${hostId}:${spawnId}`;
    if (this.minting.has(k)) return { ok: false, error: 'this request is already being linked' };
    const policy = this.deps.policy.get();
    const sub = normalizeSpawnSub(req.folder.sub);
    let refused: A2aSpawnCode | undefined;
    if (!spawnHostAllowed(policy, hostId) || !policy.agents.includes(req.agent)) refused = 'not-allowed';
    else if (sub === null || !policy.roots.some((r) => r.id === req.folder.root && r.path === rec.claimedRoot)) refused = 'folder-not-allowed';
    else if (this.now() > Date.parse(req.expiresAt)) refused = 'expired';
    if (refused) {
      this.finish(hostId, spawnId, refused);
      return { ok: false, error: refused };
    }
    this.minting.add(k);
    let decided: SpawnRequestRecordV1 | undefined;
    try {
      let linkId: SpawnLinkId;
      try {
        linkId = start.prepare(rec, req, end);
      } catch (err) {
        this.deps.log('error', `[a2a-remote] spawn request ${spawnId} from ${hostId}: started, not reserved: ${errMsg(err)}`);
        this.failStart(hostId, spawnId, 'failed');
        return { ok: false, error: `not linked: ${errMsg(err)}` };
      }
      if (this.abandoned.has(k)) {
        start.discard(linkId);
        this.failStart(hostId, spawnId, 'failed');
        return { ok: false, error: 'the start was abandoned' };
      }
      try {
        decided = this.deps.requests.decide(hostId, spawnId, 'started', { endpoint: { kind: 'pane', ...end }, linkVersion: 1, linkId });
      } catch (err) {
        start.discard(linkId);
        this.failStart(hostId, spawnId, 'failed');
        return { ok: false, error: `the answer could not be stored: ${errMsg(err)}` };
      }
      try {
        start.commit(linkId);
      } catch (err) {
        // The request says started; activation is owed either way (recover and sweep retry it).
        this.deps.log('warn', `[a2a-remote] spawn ${spawnId}: committed, link record not updated: ${errMsg(err)}`);
      }
    } finally {
      this.minting.delete(k);
      this.abandoned.delete(k);
    }
    if (!decided) return { ok: false, error: 'this request is not starting' };
    this.audit(decided, 'started');
    this.deps.onChange?.(hostId, spawnId, 'decided');
    await this.deliverStarted(decided);
    return { ok: true };
  }

  /**
   * A stored start made reachable, then answered. Idempotent: what exists is
   * kept, what is missing is made. A failure is logged and retried by
   * `sweep` (and `recover`); the answer waits until it lands.
   */
  private async deliverStarted(rec: SpawnRequestRecordV1): Promise<boolean> {
    const linkId = asSpawnLinkId(rec.linkId);
    const k = `${rec.hostId}:${rec.spawnId}`;
    if (!linkId || !this.deps.start || this.delivering.has(k)) return false;
    this.delivering.add(k);
    try {
      await this.deps.start.activate(linkId);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn ${rec.spawnId} from ${rec.hostId}: not reachable yet, trying again: ${errMsg(err)}`);
      return false;
    } finally {
      this.delivering.delete(k);
    }
    return this.sendDecided(rec);
  }

  /** Main could not start a claimed request. */
  failed(hostId: HostId, spawnId: string, code: 'folder-not-allowed' | 'failed'): A2aSpawnStepResult {
    const rec = this.deps.requests.get(hostId, spawnId);
    if (!rec || (rec.state !== 'starting' && rec.state !== 'approved')) return { ok: false, error: 'this request is not starting' };
    // Being linked right now: abandoned, so the start refuses itself before it commits.
    const k = `${hostId}:${spawnId}`;
    if (this.minting.has(k)) {
      this.abandoned.add(k);
      return { ok: true };
    }
    return this.failStart(hostId, spawnId, code) ? { ok: true } : { ok: false, error: 'the answer could not be stored' };
  }

  /**
   * The (PC, folder, agent) rule `always` adds, for exactly the folder the
   * card showed (root and sub); a save that conflicts is tried once more on a
   * fresh read.
   */
  private async addRule(hostId: HostId, req: A2aSpawnRequestV1): Promise<void> {
    const set = this.deps.policy.set;
    const sub = normalizeSpawnSub(req.folder.sub);
    if (!set || sub === null) return;
    const rule = { hostId, rootId: req.folder.root, agent: req.agent, ...(sub ? { sub } : {}) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const policy = this.deps.policy.get();
      if (policy.rules.some((r) => spawnRuleMatches(r, hostId, rule.rootId, rule.agent, sub))) return;
      // eslint-disable-next-line no-await-in-loop -- a retry needs the first answer
      const res = await set.call(this.deps.policy, { ...policy, rules: [...policy.rules, rule] });
      if (res.ok) return;
      if (!res.conflict) {
        this.deps.log('warn', `[a2a-remote] spawn rule for ${hostId} not saved: ${res.error}`);
        return;
      }
    }
  }

  private audit(rec: Pick<SpawnRequestRecordV1, 'hostId' | 'spawnId' | 'agent' | 'rootId'>, what: string): void {
    // Ids, the outcome, the agent and the root: never the prompt.
    this.deps.log('info', `[a2a-remote] spawn ${rec.spawnId} from ${rec.hostId}: ${what} (agent ${rec.agent}, root ${rec.rootId})`);
  }

  /**
   * A paired PC was removed: whatever this receiver keeps for it in memory
   * goes too, so a re-paired PC starts from nothing (its targets from v1).
   * A decision already running ends without an answer: its record is gone.
   */
  forgetHost(hostId: HostId): void {
    const mine = (k: string): boolean => k.startsWith(`${hostId}:`);
    for (const [k, t] of this.retries) if (mine(k)) { clearTimeout(t); this.retries.delete(k); }
    for (const k of [...this.deciding.keys()]) if (mine(k)) this.deciding.delete(k);
    for (const k of [...this.answeredAt.keys()]) if (mine(k)) this.answeredAt.delete(k);
    for (const k of [...this.answered]) if (mine(k)) this.answered.delete(k);
    this.targetsVersion.delete(hostId);
  }

  /** Settle every decision in flight (tests). Retries waiting on a timer are not waited for. */
  async idle(): Promise<void> {
    while (this.deciding.size > 0) await Promise.all([...this.deciding.values()]);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
  }

  // --- B: requests --------------------------------------------------------------

  private receive(hostId: HostId, req: A2aSpawnRequestV1, sentAt: string): A2aRemoteDeliverResponse {
    // A PC that may not ask learns nothing else, not even what it asked before.
    const policy = this.deps.policy.get();
    if (!spawnHostAllowed(policy, hostId)) return this.refuse(hostId, req.spawnId, 'not-allowed');

    // A request already here is answered from what was stored, whatever the
    // clock says now: the asker may have lost the first answer.
    const known = this.deps.requests.get(hostId, req.spawnId);
    if (known) {
      if (known.fingerprint !== spawnFingerprint(req)) return { ok: false, error: 'conflict' };
      return this.resume(known);
    }

    // A request refused here is not stored: a PC that may not ask cannot
    // grow this PC's files. Its resend is refused the same way again.
    let refused: A2aSpawnCode | undefined;
    if (!spawnClockOk(sentAt, req.expiresAt, this.now())) refused = 'expired';
    else if (this.deps.requests.pendingCount(hostId) >= spawnPendingPerHost(this.deps.policy.get())) refused = 'rate-limited';
    if (refused) return this.refuse(hostId, req.spawnId, refused);

    let got: ReturnType<SpawnReceiverDeps['requests']['receive']>;
    try {
      got = this.deps.requests.receive(hostId, req);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn request from ${hostId} not stored: ${errMsg(err)}`);
      return UNAVAILABLE;
    }
    if (got.kind === 'conflict') return { ok: false, error: 'conflict' };
    if (got.kind === 'duplicate') return this.resume(got.rec);
    if (got.kind === 'full') return this.refuse(hostId, req.spawnId, 'rate-limited');
    this.deps.log('info', `[a2a-remote] spawn request ${req.spawnId} from ${hostId}: agent ${req.agent}, root ${req.folder.root}`);
    this.scheduleDecide(hostId, req.spawnId);
    return OK;
  }

  /**
   * Answer a request that is not stored. A resend of the same request gets
   * the same answer at most once per `SPAWN_REFUSAL_COALESCE_MS`; one that
   * could not be queued is `unavailable`, so the asker sends it again.
   */
  private refuse(hostId: HostId, spawnId: string, code: A2aSpawnCode): A2aRemoteDeliverResponse {
    this.deps.log('info', `[a2a-remote] spawn request ${spawnId} from ${hostId}: ${code}`);
    if (this.answeredRecently(hostId, spawnId, code)) return OK;
    return this.sendResult(hostId, { v: 1, spawnId, code }) ? OK : UNAVAILABLE;
  }

  /** A request already stored: send its outcome again (coalesced), or make sure it is being decided. */
  private resume(rec: SpawnRequestRecordV1): A2aRemoteDeliverResponse {
    if (rec.state === 'pending') {
      this.scheduleDecide(rec.hostId, rec.spawnId);
      return { ok: true, duplicate: true };
    }
    if (rec.state !== 'decided') {
      // On its card, approved or starting: the answer comes when it is decided.
      // One on its card says so again (the first word may have been lost).
      if (rec.state !== 'awaiting' || this.answeredRecently(rec.hostId, rec.spawnId, 'waiting-for-approval')) return { ok: true, duplicate: true };
      return this.sendResult(rec.hostId, { v: 1, spawnId: rec.spawnId, code: 'waiting-for-approval' }) ? { ok: true, duplicate: true } : UNAVAILABLE;
    }
    if (rec.code && this.answeredRecently(rec.hostId, rec.spawnId, rec.code)) return { ok: true, duplicate: true };
    return this.sendDecided(rec) ? { ok: true, duplicate: true } : UNAVAILABLE;
  }

  private answeredRecently(hostId: HostId, spawnId: string, code: A2aSpawnCode): boolean {
    const last = this.answeredAt.get(`${hostId}:${spawnId}:${code}`);
    return last !== undefined && this.now() - last < this.refusalCoalesceMs;
  }

  private sendDecided(rec: SpawnRequestRecordV1): boolean {
    if (!rec.code) return false;
    // A start is answered only once it is reachable.
    if (rec.code === 'started' && rec.linkId && this.deps.start && !this.deps.start.isActive(rec.linkId)) return false;
    const started = rec.code === 'started' && rec.endpoint && rec.linkVersion && rec.linkId
      ? { endpoint: rec.endpoint, linkVersion: rec.linkVersion, linkId: rec.linkId }
      : {};
    if (!this.sendResult(rec.hostId, { v: 1, spawnId: rec.spawnId, code: rec.code, ...started })) return false;
    try {
      this.deps.requests.markSent(rec.hostId, rec.spawnId);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn request ${rec.spawnId} from ${rec.hostId}: sent, not marked: ${errMsg(err)}`);
    }
    return true;
  }

  private scheduleDecide(hostId: HostId, spawnId: string, attempt = 0): void {
    if (this.stopped) return;
    const k = `${hostId}:${spawnId}`;
    if (this.deciding.has(k) || (attempt === 0 && this.retries.has(k))) return;
    this.retries.delete(k);
    const run: Promise<void> = (async () => {
      let code: Decision;
      try {
        code = await this.decide(hostId, spawnId);
      } catch (err) {
        if (!(err instanceof CheckTimeout)) {
          this.retryLater(hostId, spawnId, attempt, err);
          return;
        }
        this.deps.log('warn', `[a2a-remote] spawn request ${spawnId} from ${hostId}: a check did not answer in time`);
        code = 'failed';
      }
      this.settle(hostId, spawnId, code, attempt);
    })().finally(() => {
      // Cleared whatever happened, so a retry is never turned away as "already deciding".
      if (this.deciding.get(k) === run) this.deciding.delete(k);
    });
    this.deciding.set(k, run);
  }

  /**
   * An error that may pass (a busy or failing disk, an outcome not stored):
   * the request stays pending and is tried again later; once it has expired
   * it ends `expired`.
   */
  private retryLater(hostId: HostId, spawnId: string, attempt: number, err: unknown): void {
    if (this.stopped) return;
    const rec = this.deps.requests.get(hostId, spawnId);
    if (!rec || rec.state !== 'pending') return;
    const delay = Math.min(this.retryMinMs * 2 ** attempt, RETRY_MAX_MS);
    this.deps.log('warn', `[a2a-remote] spawn request ${spawnId} from ${hostId}: not decided yet, trying again in ${Math.round(delay / 1000)}s: ${errMsg(err)}`);
    const k = `${hostId}:${spawnId}`;
    clearTimeout(this.retries.get(k));
    const t = setTimeout(() => {
      this.retries.delete(k);
      const now = this.deps.requests.get(hostId, spawnId);
      if (!now || now.state !== 'pending') return;
      if (this.now() > Date.parse(now.expiresAt)) this.settle(hostId, spawnId, err instanceof AppNotReady ? 'app-not-ready' : 'expired', attempt + 1);
      else this.scheduleDecide(hostId, spawnId, attempt + 1);
    }, delay);
    t.unref?.();
    this.retries.set(k, t);
  }

  private async decide(hostId: HostId, spawnId: string): Promise<Decision> {
    const rec = this.deps.requests.get(hostId, spawnId);
    const req = rec?.request;
    if (!rec || rec.state !== 'pending' || !req) return 'failed';
    const policy = this.deps.policy.get();
    // The policy may have changed since the request arrived.
    if (!spawnHostAllowed(policy, hostId)) return 'not-allowed';
    if (this.now() > Date.parse(req.expiresAt)) return 'expired';
    if (!policy.agents.includes(req.agent) || !isSpawnableAgent(req.agent)) return 'agent-not-allowed';
    // Nothing that could leave the root reaches the disk (parsed so already; checked again here).
    const sub = normalizeSpawnSub(req.folder.sub);
    const root = policy.roots.find((r) => r.id === req.folder.root);
    if (sub === null || !root) return 'folder-not-allowed';
    if (!(await this.checks.run(() => this.agentInstalled(req.agent)))) return 'agent-not-installed';
    if (!(await this.folderInside(root.path, sub))) return 'folder-not-allowed';
    // The checks above wait on the disk and the PATH: the human may have
    // turned this PC (or that root, or that agent) off meanwhile, and the
    // request may have expired.
    const now = this.deps.policy.get();
    if (!spawnHostAllowed(now, hostId)) return 'not-allowed';
    if (!now.agents.includes(req.agent) || !now.roots.some((r) => r.id === root.id && r.path === root.path)) return 'not-allowed';
    if (this.now() > Date.parse(req.expiresAt)) return 'expired';
    if (!this.deps.start) return 'not-supported';
    if (this.overCaps(hostId)) return 'rate-limited';
    // Nothing is shown or started before the app has caught up: the request waits for it, until it expires.
    if (this.deps.appReady && !this.deps.appReady()) throw new AppNotReady('the app is not ready');
    const ruled = now.approval === 'allow-list' && now.rules.some((r) => spawnRuleMatches(r, hostId, root.id, req.agent, sub));
    return ruled ? 'approved' : 'awaiting';
  }

  /** Starts per PC per hour and per day, and running agents per PC and in all (counting those about to start), against the limits set. */
  private overCaps(hostId: HostId): boolean {
    const r = this.deps.requests;
    const now = this.now();
    const live = this.deps.liveSpawns ?? ((): number => 0);
    return this.atALimit({
      startsPerHour: () => r.approvedSince?.(now - HOUR_MS, hostId) ?? 0,
      startsPerDay: () => r.approvedSince?.(now - DAY_MS, hostId) ?? 0,
      livePerPc: () => live(hostId) + (r.startingCount?.(hostId) ?? 0),
      liveTotal: () => live() + (r.startingCount?.() ?? 0),
    });
  }

  /** Whether any limit the policy sets is reached; each count is read only for a limit that is set. */
  private atALimit(counts: Record<'livePerPc' | 'liveTotal' | 'startsPerHour' | 'startsPerDay', () => number>): boolean {
    const limits = this.deps.policy.get().limits ?? {};
    return (Object.keys(counts) as (keyof typeof counts)[]).some((key) => {
      const limit = limits[key];
      return limit !== undefined && counts[key]() >= limit;
    });
  }

  /**
   * `sub` below `rootPath` stays inside it once every link is resolved, and is
   * a folder. The root itself must still resolve to the path stored when it
   * was added: a root replaced by a link elsewhere is refused. The realpaths
   * are compared as they are (no case folding: on a case-sensitive volume a
   * sibling that differs only by case is another folder). The folder is
   * resolved again after the directory check, so a swap in between is seen.
   * Only "not there" errors refuse; any other (out of file handles, I/O)
   * is thrown, and the decision is tried again.
   * Whatever starts an agent later checks again right before it does.
   */
  private async folderInside(rootPath: string, sub: string): Promise<boolean> {
    const target = (rootReal: string): string => (sub ? path.join(rootReal, ...sub.split('/')) : rootReal);
    try {
      const rootReal = await this.checks.run(() => this.realpath(rootPath));
      const real = await this.checks.run(() => this.realpath(target(rootReal)));
      if (!samePath(rootReal, rootPath) || !inside(rootReal, real)) return false;
      if (!(await this.checks.run(() => this.isDirectory(real)))) return false;
      return samePath(await this.checks.run(() => this.realpath(target(rootReal))), real);
    } catch (err) {
      if (notThere(err)) return false;
      throw err;
    }
  }

  private settle(hostId: HostId, spawnId: string, outcome: Decision, attempt: number): void {
    if (this.stopped) return;
    // The PC was removed (its requests forgotten) while this was decided: nothing goes back.
    const rec = this.deps.requests.get(hostId, spawnId);
    if (!rec || rec.state !== 'pending') return;
    if (outcome === 'awaiting' || outcome === 'approved') {
      let moved: SpawnRequestRecordV1 | undefined;
      try {
        moved = this.deps.requests.advance?.(hostId, spawnId, ['pending'], outcome);
      } catch (err) {
        this.retryLater(hostId, spawnId, attempt, err);
        return;
      }
      if (!moved) return;
      this.audit(moved, outcome === 'awaiting' ? 'waiting for its card' : 'approved (rule)');
      // Informational: the asker learns its request waits for a person here.
      if (outcome === 'awaiting') this.sendResult(hostId, { v: 1, spawnId, code: 'waiting-for-approval' });
      this.deps.onChange?.(hostId, spawnId, outcome);
      return;
    }
    // Not stored: the request stays pending and is settled again later.
    if (!this.finish(hostId, spawnId, outcome)) this.retryLater(hostId, spawnId, attempt, new Error('the outcome could not be stored'));
  }

  /** Decide an open request and send its answer. False when the outcome could not be stored (nothing was sent). */
  private finish(
    hostId: HostId,
    spawnId: string,
    code: A2aSpawnCode,
    started?: SpawnStarted,
  ): boolean {
    let decided: SpawnRequestRecordV1 | undefined;
    try {
      decided = isFinalSpawnCode(code) ? this.deps.requests.decide(hostId, spawnId, code, started) : undefined;
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn request ${spawnId} from ${hostId}: ${code} not stored: ${errMsg(err)}`);
      return false;
    }
    this.deps.log('info', `[a2a-remote] spawn request ${spawnId} from ${hostId}: ${code}`);
    if (decided) this.sendDecided(decided);
    else this.sendResult(hostId, { v: 1, spawnId, code });
    if (decided) this.deps.onChange?.(hostId, spawnId, 'decided');
    return true;
  }

  /**
   * Queue a result; false when the outbox would not take it. Each send has
   * its own message id: `_` is in neither a spawnId nor a code, and the last
   * part is new for every send (this run's start, then a count).
   */
  private sendResult(hostId: HostId, result: A2aSpawnResultV1): boolean {
    try {
      this.deps.enqueue(hostId, {
        protocol: A2A_REMOTE_PROTOCOL,
        linkId: result.spawnId,
        linkVersion: 0,
        messageId: `res_${result.spawnId}_${result.code}_${this.boot}-${this.sends++}`,
        kind: 'link',
        link: { state: 'spawn-result', version: 0 },
        spawnResult: result,
        sentAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn result ${result.spawnId} to ${hostId} not queued: ${errMsg(err)}`);
      return false;
    }
    this.answeredAt.delete(`${hostId}:${result.spawnId}:${result.code}`);
    this.answeredAt.set(`${hostId}:${result.spawnId}:${result.code}`, this.now());
    if (this.answeredAt.size > ANSWERED_RECENTLY_MAX) this.answeredAt.delete(this.answeredAt.keys().next().value as string);
    return true;
  }

  // --- A: answers ---------------------------------------------------------------

  /**
   * An answer is handed on only for a request this PC sent and that has no
   * final answer yet. One the asking side could not take (its link or first
   * task not written) is refused `unavailable`, so the other PC sends it again.
   */
  private async takeResult(hostId: HostId, result: A2aSpawnResultV1): Promise<A2aRemoteDeliverResponse> {
    const k = `${hostId}:${result.spawnId}`;
    if (this.answered.has(k) || this.deps.isOutstanding?.(hostId, result.spawnId) !== true) {
      this.deps.log('info', `[a2a-remote] spawn result ${result.spawnId} from ${hostId} ignored: no request of this PC waits for it`);
      return OK;
    }
    if (this.deps.onResult && !(await this.deps.onResult(hostId, result))) return UNAVAILABLE;
    if (isFinalSpawnCode(result.code)) {
      this.answered.add(k);
      if (this.answered.size > ANSWERED_MAX) this.answered.delete(this.answered.values().next().value as string);
    }
    return OK;
  }
}

function inside(rootReal: string, real: string): boolean {
  const rel = path.relative(rootReal, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The agent's launcher on the login shell's PATH (`PATHEXT` on Windows). */
async function agentOnPath(agent: AgentSlug): Promise<boolean> {
  const row = agentRow(agent);
  if (!row) return false;
  const stem = agentLauncherStem(row);
  const env = await agentExecEnv(process.env);
  if (process.platform !== 'win32') return (await whichOnPath(stem, env.PATH ?? '')) !== undefined;
  const exts = (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  for (const dir of (env.Path ?? env.PATH ?? '').split(';')) {
    if (!path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      if (await fs.promises.stat(path.join(dir, stem + ext.toLowerCase())).then((s) => s.isFile(), () => false)) return true;
    }
  }
  return false;
}

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** The machine-local policy RPCs (`wmux.internal`). */
export function registerSpawnRpc(
  onRpc: (method: string, handler: RpcHandler) => void,
  deps: {
    policy: Pick<SpawnPolicyStore, 'get' | 'set'>;
    requests: Pick<SpawnRequestStore, 'summaries'>;
    /** A saved policy: tell the PCs it concerns what they may ask for now. */
    onSaved?: (previous: A2aSpawnPolicyV1) => void;
  },
): void {
  onRpc(A2A_SPAWN_RPC.policyGet, async () => ({ policy: deps.policy.get() }));
  onRpc(A2A_SPAWN_RPC.policySet, async (params) => {
    const previous = deps.policy.get();
    const res = await deps.policy.set(params['policy']);
    if (res.ok) deps.onSaved?.(previous);
    return res;
  });
  onRpc(A2A_SPAWN_RPC.requestsList, async () => ({ requests: deps.requests.summaries() }));
}
