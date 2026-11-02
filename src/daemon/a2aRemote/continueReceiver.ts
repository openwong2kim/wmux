import path from 'node:path';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteDeliverResponse, type A2aRemoteEnvelope, type HostId } from '../../shared/a2aRemote';
import {
  A2A_CONTINUE_LINK_STATES,
  CONTINUE_BYTES_MAX,
  CONTINUE_FILES_MAX,
  continueAnswerFor,
  continueClaimable,
  continueClockOk,
  isContinueAgent,
  parseContinueManifest,
  parseContinueRequest,
  parseContinueResult,
  parseContinueStatusQuery,
  type A2aContinueCode,
  type A2aContinueIncomingState,
  type A2aContinueLinkState,
  type A2aContinueManifestV1,
  type A2aContinuePermissionMode,
  type A2aContinueRequestV1,
} from '../../shared/a2aContinue';
import { spawnHostAllowed, type A2aSpawnPolicyV1, type A2aSpawnRootV1 } from '../../shared/a2aSpawn';
import type { ContinuePolicyStore } from './continuePolicyStore';
import { continueManifestBytes, sameContinueBody, type ContinueRequestRecordV1, type ContinueRequestStore } from './continueRequestStore';
import { CheckTimeout, spawnChecks, type SpawnChecks } from './spawnChecks';
import type { SpawnPolicyStore } from './spawnPolicyStore';
import { errMsg } from './storeFile';

/**
 * Continuing a conversation from another PC, the receiving side (this PC is
 * B; see `shared/a2aContinue.ts`). Every step goes back to A as a
 * `continue-result` envelope through this PC's own outbox, and each record
 * remembers the answer last queued, so one that never left is sent again on
 * recovery (and on each sweep).
 *
 * A request already here is always answered from its record, before any
 * policy or clock check: a refusal is final to A, and A would resume its own
 * copy of a conversation this PC may still hold and start. Only codes that
 * name what this PC holds (REPO_CODES) are hidden from a PC not allowed now.
 *
 * A new request, in this order, so a PC that may not send one learns nothing
 * else (these refusals are not stored):
 *   1. this PC takes conversations (continue policy on), from that PC, of
 *      that agent (the remote-spawn policy)            else `not-allowed`
 *   2. B's clock window (`continueClockOk`)            else `expired`
 *   3. no other open request carries that conversation, and room for one
 *      more of that PC's                                else `busy`
 *   -- stored pending; then, one request at a time:
 *   4. its estimate within this PC's caps               else `too-large`
 *   5. no pane here runs that conversation              else `busy`
 *   6. exactly one spawn root has that origin           else `repo-not-found` / `repo-ambiguous`
 *   7. room on the staging volume for the estimate      else `no-space`
 *   8. the policy and the expiry, read again after those waits
 *   9. a card can be shown                              else `not-allowed`
 *      → `awaiting` (`waiting-for-approval`); the card answers `decide`.
 * A check that does not answer in time ends it `failed`; one that could not
 * run now (the shared check gate busy, a git or disk error) leaves it
 * pending, checked again later with a growing wait, and `expired` once past
 * its expiry.
 *
 * Then: approved → `ready`; the manifest (`receiving`), checked against the
 * policy, the request's commit, the caps and the disk; `received` once its
 * intake (`bytes`) has every file in staging; `claim` → `starting`, only while
 * `continueClaimable` and after the pane, policy and root checks again;
 * `started` / `failed` from main. An unclaimed request past its expiry ends
 * `expired` on the sweep. A claimed one is never started again. One main
 * never reported on is settled after CONTINUE_STARTING_GRACE_MS: `started`
 * when a live agent here runs the conversation, else `unknown`, never
 * `failed`: the start may have run (a lost report, a pane since closed), and
 * a `failed` would let A resume its own copy beside it.
 *
 * Refusals of new requests (they leave no record) go out at most
 * CONTINUE_REFUSALS_PER_HOST_MAX per PC per CONTINUE_REFUSAL_WINDOW_MS, so
 * made-up ids cannot fill the outbox; past that a request goes unanswered
 * and expires on A, which stopped nothing for it.
 */

/** The same answer to the same request goes out at most once in this window (a resend, a status query). */
export const CONTINUE_RESEND_COALESCE_MS = 60_000;
/** A claimed start main never reported on is settled after this long since its claim. */
export const CONTINUE_STARTING_GRACE_MS = 10 * 60 * 1000;
/** Refusals of new requests sent to one PC per window; past it, nothing is sent. */
export const CONTINUE_REFUSALS_PER_HOST_MAX = 10;
export const CONTINUE_REFUSAL_WINDOW_MS = 60_000;
/** A pending request whose checks could not run is checked again after this, doubling each time, at most RETRY_MAX_MS. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Recent answers remembered for coalescing. */
const ANSWERED_RECENTLY_MAX = 1000;
/** Open states before main claims a request: the sweep expires these. */
const UNCLAIMED: readonly A2aContinueIncomingState[] = ['pending', 'awaiting', 'ready', 'receiving', 'received'];
/** Codes that say what this PC holds (`path-too-long`: how long its root's path is): a PC not allowed now hears `not-allowed` instead. */
const REPO_CODES: ReadonlySet<A2aContinueCode> = new Set<A2aContinueCode>([
  'repo-not-found', 'repo-ambiguous', 'branch-not-found', 'branch-busy', 'head-missing', 'diverged', 'path-too-long',
]);

export interface ContinueReceiverDeps {
  policy: Pick<ContinuePolicyStore, 'get'>;
  /** The PCs, folders and agents this PC takes work from. */
  spawnPolicy: Pick<SpawnPolicyStore, 'get'>;
  requests: Pick<ContinueRequestStore, 'get' | 'inState' | 'unsent' | 'receive' | 'advance' | 'decide' | 'markSent' | 'prune' | 'reservedBytes'>;
  /** Queue an envelope to `hostId` (the delivery outbox); throws when it cannot. */
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  /** The origin of the repository at a spawn root, as originUrlRepoKey writes it; null without one. Throws when it could not be read now. */
  originKeyOf: (rootPath: string) => Promise<string | null>;
  /** A spawn root is still its repository's top level (not a folder inside another one). Throws when it could not be read now. */
  isRepoTop: (rootPath: string) => Promise<boolean>;
  /**
   * Free bytes on the staging volume (the a2a dir's), where a conversation's
   * bytes land. The Claude config dir's and the root's volumes are the
   * placer's to check (ContinueClaim.bytes).
   */
  freeBytes: () => Promise<number>;
  /** A pane on this PC runs the conversation `sessionId` (paneHoldsSession). */
  sessionLive: (sessionId: string) => boolean;
  /** The approval card can be shown. Absent: no card, so every request ends `not-allowed` after its checks. */
  cardAvailable?: () => boolean;
  /** Where a receiving request's bytes come in (continueBundle.ts). Absent: none come, and a receiving request ends `expired`. */
  bytes?: ContinueBytesIntake;
  /** This PC's caps, never above the contract's (default: the contract's). */
  limits?: { bytes: number; files: number };
  now?: () => number;
  /** Test seams. */
  checks?: SpawnChecks;
  resendCoalesceMs?: number;
  retryMinMs?: number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * The intake of a request's bytes, told when a request starts receiving (its
 * manifest taken), when one is decided (its staging goes), after a restart,
 * and when a paired PC is removed. None of these throws or waits: each
 * starts its own work, and the intake calls `received` or `receiveFailed`.
 */
export interface ContinueBytesIntake {
  receiving(rec: ContinueRequestRecordV1): void;
  decided(hostId: HostId, continueId: string): void;
  recover(): void;
  forgetHost(hostId: HostId): void;
}

/** What main needs to start a claimed conversation. */
export interface ContinueClaim {
  hostId: HostId;
  request: A2aContinueRequestV1;
  manifest: A2aContinueManifestV1;
  rootId: string;
  rootPath: string;
  permissionMode: A2aContinuePermissionMode;
  /**
   * What placing it takes on disk. Only the staging volume was checked here:
   * the placer checks the Claude config dir's volume and the root's (for the
   * worktree) before it writes there.
   */
  bytes: number;
}

/** The codes a claimed start ends with when main could not start it: what it found on this PC's checkout or disk. */
export const CONTINUE_START_FAILURES = ['failed', 'branch-not-found', 'branch-busy', 'head-missing', 'diverged', 'path-too-long', 'no-space'] as const;
export type ContinueStartFailure = (typeof CONTINUE_START_FAILURES)[number];

export type ContinueStepResult = { ok: true } | { ok: false; error: string };
export type ContinueClaimResult = { ok: true; claim: ContinueClaim } | { ok: false; error: string };

export function isContinueEnvelope(env: A2aRemoteEnvelope): env is A2aRemoteEnvelope & { link: { state: A2aContinueLinkState } } {
  const s = env.kind === 'link' ? env.link?.state : undefined;
  return s !== undefined && (A2A_CONTINUE_LINK_STATES as readonly string[]).includes(s);
}

/**
 * Whether a pane runs the conversation `sessionId`: its own resume binding
 * names it (from the agent's hooks, or its launch line's `--resume` /
 * `--session-id`), or, with no binding, the transcript bound to it is that
 * conversation's; and an agent whose conversations can move runs there now,
 * the binding's own. A binding outlives the agent that wrote it, so a shell
 * where the conversation once ran does not count. Cheapest first: the
 * transcript (a path resolution) and the live agent are read only when
 * needed.
 */
export function paneHoldsSession(
  pane: { resumeBinding?: { agent: string; sessionId: string } },
  liveAgent: () => string | undefined,
  transcriptPath: () => string | null,
  sessionId: string,
): boolean {
  const bound = pane.resumeBinding;
  if (bound && bound.sessionId !== sessionId) return false;
  if (!bound) {
    const transcript = transcriptPath();
    if (transcript === null || path.basename(transcript) !== `${sessionId}.jsonl`) return false;
  }
  const agent = liveAgent();
  return isContinueAgent(agent) && (!bound || bound.agent === agent);
}

const OK: A2aRemoteDeliverResponse = { ok: true, duplicate: false };
const DUPLICATE: A2aRemoteDeliverResponse = { ok: true, duplicate: true };
const UNAVAILABLE: A2aRemoteDeliverResponse = { ok: false, error: 'unavailable' };
const BAD: A2aRemoteDeliverResponse = { ok: false, error: 'bad-request' };
const CONFLICT: A2aRemoteDeliverResponse = { ok: false, error: 'conflict' };
const NOT_STORED: { ok: false; error: string } = { ok: false, error: 'the answer could not be stored' };

export class A2aContinueReceiver {
  private readonly deps: ContinueReceiverDeps;
  private readonly now: () => number;
  private readonly checks: SpawnChecks;
  private readonly limits: { bytes: number; files: number };
  private readonly coalesceMs: number;
  private readonly retryMinMs: number;
  /** Pending requests waiting to be checked again, by host:continueId. */
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Makes every result's message id new, across restarts too. */
  private readonly boot: string;
  private sends = 0;
  private stopped = false;
  /** When each answer (host:continueId:code) was last sent. */
  private readonly answeredAt = new Map<string, number>();
  /** When each PC was last told `unknown`: at most once per window, whatever the id. */
  private readonly unknownAt = new Map<HostId, number>();
  /** When each PC was refused a new request, within the last window. */
  private readonly refusedAt = new Map<HostId, number[]>();
  /** Each spawn root's origin, for one version of the spawn policy. */
  private origins: { version: number; keys: Map<string, string | null> } = { version: -1, keys: new Map() };
  /** Checks, manifests and claims, one at a time: their disk and git checks share one bounded gate. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ContinueReceiverDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.checks = deps.checks ?? spawnChecks;
    this.limits = {
      bytes: Math.min(deps.limits?.bytes ?? CONTINUE_BYTES_MAX, CONTINUE_BYTES_MAX),
      files: Math.min(deps.limits?.files ?? CONTINUE_FILES_MAX, CONTINUE_FILES_MAX),
    };
    this.coalesceMs = deps.resendCoalesceMs ?? CONTINUE_RESEND_COALESCE_MS;
    this.retryMinMs = deps.retryMinMs ?? RETRY_MIN_MS;
    this.boot = this.now().toString(36);
  }

  /** One continue envelope from an authenticated peer: `peer.hostId` is the asker, never a field of the body. */
  applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse | Promise<A2aRemoteDeliverResponse> {
    if (env.linkVersion !== 0) return BAD;
    switch (env.link?.state) {
      case 'continue': {
        const req = parseContinueRequest(env.continue);
        return req && req.continueId === env.linkId ? this.receive(peer.hostId, req, env.sentAt) : BAD;
      }
      case 'continue-manifest': {
        const manifest = parseContinueManifest(env.continueManifest);
        return manifest && manifest.continueId === env.linkId ? this.serial(() => this.takeManifest(peer.hostId, manifest)) : BAD;
      }
      case 'continue-status': {
        const query = parseContinueStatusQuery(env.continueStatus);
        return query && query.continueId === env.linkId ? this.answer(peer.hostId, query.continueId) : BAD;
      }
      case 'continue-result': {
        // An answer to a request this PC sent: the sending side is not built yet, so it is taken and dropped.
        const result = parseContinueResult(env.continueResult);
        return result && result.continueId === env.linkId ? OK : BAD;
      }
      default:
        return BAD;
    }
  }

  /** After a restart: check what is pending, settle starts left behind, send what was owed, expire what ran out. */
  recover(): void {
    for (const rec of this.deps.requests.inState('pending')) {
      const { hostId } = rec;
      const { continueId } = rec.request;
      void this.serial(() => this.check(hostId, continueId));
    }
    this.sweep();
    this.deps.bytes?.recover();
  }

  /**
   * Unclaimed requests past their expiry end `expired`; claimed starts past
   * their grace are settled; owed answers go again; old decided records go.
   */
  sweep(): void {
    for (const state of UNCLAIMED) {
      for (const rec of this.deps.requests.inState(state)) {
        if (this.expired(rec)) this.finish(rec.hostId, rec.request.continueId, 'expired');
      }
    }
    this.settleStarts();
    for (const rec of this.deps.requests.unsent()) this.sendOwed(rec);
    try {
      this.deps.requests.prune();
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue requests not pruned: ${errMsg(err)}`);
    }
  }

  /** The card's answer: `once` approves this request, `deny` declines it. A continue card never offers more. */
  decide(hostId: HostId, continueId: string, verdict: unknown): ContinueStepResult {
    if (verdict !== 'once' && verdict !== 'deny') return { ok: false, error: 'a continue card answers once or deny' };
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'awaiting') return { ok: false, error: 'this request is not waiting for its card' };
    let code: A2aContinueCode | undefined;
    if (verdict === 'deny') code = 'declined';
    else if (this.expired(rec)) code = 'expired';
    else if (!this.allowed(hostId, rec.request)) code = 'not-allowed';
    else if (this.deps.sessionLive(rec.request.sessionId)) code = 'busy';
    if (code) {
      if (!this.finish(hostId, continueId, code)) return NOT_STORED;
      return code === 'declined' ? { ok: true } : { ok: false, error: code };
    }
    return this.step(hostId, continueId, ['awaiting'], 'ready') ? { ok: true } : NOT_STORED;
  }

  /** Every file of the manifest is in staging and checked: the conversation is this PC's now. */
  received(hostId: HostId, continueId: string): ContinueStepResult {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'receiving') return { ok: false, error: 'this request is not receiving' };
    // Bytes that came after the expiry are never taken: A resumes its own copy on `expired`.
    if (this.expired(rec)) return this.finish(hostId, continueId, 'expired') ? { ok: false, error: 'expired' } : NOT_STORED;
    return this.step(hostId, continueId, ['receiving'], 'received') ? { ok: true } : NOT_STORED;
  }

  /** The bytes could not be received or checked. */
  receiveFailed(hostId: HostId, continueId: string): ContinueStepResult {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'receiving') return { ok: false, error: 'this request is not receiving' };
    return this.finish(hostId, continueId, 'failed') ? { ok: true } : NOT_STORED;
  }

  /**
   * Main takes a received request to start it: only while `continueClaimable`
   * (never after its expiry, never twice), while the policy still allows that
   * PC, no pane here runs the conversation, and the root it matched is still
   * the one root with that origin (read again, not from the cache). A
   * refusal ends the request; a root that could not be read now leaves it
   * received for main to try again.
   */
  claim(hostId: HostId, continueId: string): Promise<ContinueClaimResult> {
    return this.serial(() => this.claimNow(hostId, continueId));
  }

  /** Main started the claimed conversation in a pane. */
  started(hostId: HostId, continueId: string): ContinueStepResult {
    return this.endStart(hostId, continueId, 'started');
  }

  /** Main could not start the claimed conversation, and why (`failed` when nothing more precise applies). */
  failed(hostId: HostId, continueId: string, code: ContinueStartFailure = 'failed'): ContinueStepResult {
    if (!(CONTINUE_START_FAILURES as readonly string[]).includes(code)) return { ok: false, error: 'not a code a start ends with' };
    return this.endStart(hostId, continueId, code);
  }

  /** A paired PC was removed: what this receiver keeps for it in memory goes too. */
  forgetHost(hostId: HostId): void {
    for (const k of [...this.answeredAt.keys()]) if (k.startsWith(`${hostId}:`)) this.answeredAt.delete(k);
    this.unknownAt.delete(hostId);
    this.refusedAt.delete(hostId);
    for (const [k, t] of [...this.retries]) {
      if (!k.startsWith(`${hostId}:`)) continue;
      clearTimeout(t);
      this.retries.delete(k);
    }
    this.deps.bytes?.forgetHost(hostId);
  }

  /** Settle every check, manifest and claim in flight (tests). */
  async idle(): Promise<void> {
    let q: Promise<unknown>;
    do {
      q = this.queue;
      await q;
    } while (q !== this.queue);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
  }

  private async claimNow(hostId: HostId, continueId: string): Promise<ContinueClaimResult> {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'received' || !rec.manifest || !rec.rootId) return { ok: false, error: 'this request is not received, or is already starting' };
    const refuse = (code: A2aContinueCode): ContinueClaimResult => (this.finish(hostId, continueId, code) ? { ok: false, error: code } : NOT_STORED);
    const before = this.claimRefusal(rec);
    if (before) return refuse(before);
    let policy = this.deps.spawnPolicy.get();
    let found: { root: A2aSpawnRootV1 } | { code: A2aContinueCode } = { code: 'not-allowed' };
    try {
      for (let attempt = 1; ; attempt++) {
        // eslint-disable-next-line no-await-in-loop -- a read that a policy save overtook is done again
        found = await this.claimRoot(rec, policy);
        const fresh = this.deps.spawnPolicy.get();
        if (fresh.version === policy.version) break;
        // The settings changed while the roots were read: read them again as they are now.
        if (attempt === 3) {
          found = { code: 'not-allowed' };
          break;
        }
        policy = fresh;
      }
    } catch (err) {
      return { ok: false, error: `the folder was not checked now, try again: ${errMsg(err)}` };
    }
    // The reads waited: the clock, the policy and the panes once more.
    const after = this.claimRefusal(rec);
    if (after) return refuse(after);
    if ('code' in found) return refuse(found.code);
    const { root } = found;
    if (!this.step(hostId, continueId, ['received'], 'starting')) return { ok: false, error: 'this request is not received, or is already starting' };
    return {
      ok: true,
      claim: {
        hostId,
        request: rec.request,
        manifest: rec.manifest,
        rootId: root.id,
        rootPath: root.path,
        permissionMode: this.deps.policy.get().in.permissionMode,
        bytes: continueManifestBytes(rec.manifest),
      },
    };
  }

  /**
   * The root a claim starts in, from one snapshot of the spawn policy: the
   * one root whose origin, read afresh, is the request's, and still its
   * repository's top level (a root that became a folder inside another
   * repository reads that repository's origin). Or why there is none.
   */
  private async claimRoot(rec: ContinueRequestRecordV1, policy: A2aSpawnPolicyV1): Promise<{ root: A2aSpawnRootV1 } | { code: A2aContinueCode }> {
    const matched = await this.rootsWithOrigin(rec.request.repo.origin, true, policy);
    if (matched.length > 1) return { code: 'repo-ambiguous' };
    const root = matched[0];
    if (!root || root.id !== rec.rootId) return { code: 'not-allowed' };
    return (await this.checks.run(() => this.deps.isRepoTop(root.path))) ? { root } : { code: 'not-allowed' };
  }

  /** Why a received request may not start now, if it may not. */
  private claimRefusal(rec: ContinueRequestRecordV1): A2aContinueCode | undefined {
    if (!continueClaimable(rec, this.now())) return 'expired';
    if (!this.allowed(rec.hostId, rec.request)) return 'not-allowed';
    // A pane here runs the conversation already: this PC never starts a second one.
    if (this.deps.sessionLive(rec.request.sessionId)) return 'busy';
    return undefined;
  }

  private endStart(hostId: HostId, continueId: string, code: 'started' | ContinueStartFailure): ContinueStepResult {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'starting') return { ok: false, error: 'this request is not starting' };
    return this.finish(hostId, continueId, code) ? { ok: true } : NOT_STORED;
  }

  /**
   * A claimed start main never reported on (it stopped, or its report was
   * lost), once CONTINUE_STARTING_GRACE_MS have passed since the claim
   * (a starting record's `updatedAt`): `started` when a live agent here runs
   * the conversation, else `unknown`, on which A does not resume by itself.
   * Never `failed`: only main's own report says a start did not run.
   */
  private settleStarts(): void {
    for (const rec of this.deps.requests.inState('starting')) {
      if (this.now() - Date.parse(rec.updatedAt) <= CONTINUE_STARTING_GRACE_MS) continue;
      this.finish(rec.hostId, rec.request.continueId, this.deps.sessionLive(rec.request.sessionId) ? 'started' : 'unknown');
    }
  }

  private receive(hostId: HostId, req: A2aContinueRequestV1, sentAt: string): A2aRemoteDeliverResponse {
    // Its record answers a request already here, before the policy or the clock: see the top of this file.
    const known = this.deps.requests.get(hostId, req.continueId);
    if (known) return sameContinueBody(known.request, req) ? this.answer(hostId, req.continueId, true) : CONFLICT;
    if (!this.allowed(hostId, req)) return this.refuse(hostId, req.continueId, 'not-allowed');
    if (!continueClockOk(sentAt, req.expiresAt, this.now())) return this.refuse(hostId, req.continueId, 'expired');
    let got: ReturnType<ContinueReceiverDeps['requests']['receive']>;
    try {
      got = this.deps.requests.receive(hostId, req);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue request from ${hostId} not stored: ${errMsg(err)}`);
      return UNAVAILABLE;
    }
    if (got.kind === 'conflict') return CONFLICT;
    if (got.kind === 'duplicate') return this.answer(hostId, req.continueId, true);
    if (got.kind === 'busy' || got.kind === 'full') return this.refuse(hostId, req.continueId, got.kind);
    this.deps.log('info', `[a2a-remote] continue ${req.continueId} from ${hostId}: received (agent ${req.agent})`);
    void this.serial(() => this.check(hostId, req.continueId));
    return OK;
  }

  /** The checks of a pending request, then its card or its refusal; a check that could not run now is tried again later. */
  private async check(hostId: HostId, continueId: string, attempt = 0): Promise<void> {
    const rec = this.deps.requests.get(hostId, continueId);
    if (this.stopped || !rec || rec.state !== 'pending') return;
    let outcome: A2aContinueCode | { rootId: string };
    try {
      outcome = await this.evaluate(rec);
    } catch (err) {
      if (!(err instanceof CheckTimeout)) {
        this.retryLater(hostId, continueId, attempt, err);
        return;
      }
      this.deps.log('warn', `[a2a-remote] continue ${continueId} from ${hostId}: a check did not answer in time`);
      outcome = 'failed';
    }
    // The policy may have changed meanwhile: a PC no longer allowed learns nothing more, not even its repository codes.
    if (!this.allowed(hostId, rec.request)) outcome = 'not-allowed';
    if (this.stopped || this.deps.requests.get(hostId, continueId)?.state !== 'pending') return;
    const stored = typeof outcome === 'string'
      ? this.finish(hostId, continueId, outcome)
      : this.step(hostId, continueId, ['pending'], 'awaiting', { rootId: outcome.rootId });
    // Not stored: it stays pending and is settled again later.
    if (!stored) this.retryLater(hostId, continueId, attempt, new Error('the outcome could not be stored'));
  }

  /**
   * An error that may pass (the shared check gate busy, a git or disk error,
   * an outcome not stored): the request stays pending and is checked again,
   * after RETRY_MIN_MS doubling up to RETRY_MAX_MS; once past its expiry it
   * ends `expired`.
   */
  private retryLater(hostId: HostId, continueId: string, attempt: number, err: unknown): void {
    if (this.stopped || this.deps.requests.get(hostId, continueId)?.state !== 'pending') return;
    const delay = Math.min(this.retryMinMs * 2 ** attempt, RETRY_MAX_MS);
    this.deps.log('warn', `[a2a-remote] continue ${continueId} from ${hostId}: not checked yet, trying again in ${Math.round(delay / 1000)}s: ${errMsg(err)}`);
    const k = `${hostId}:${continueId}`;
    clearTimeout(this.retries.get(k));
    const t = setTimeout(() => {
      this.retries.delete(k);
      const now = this.deps.requests.get(hostId, continueId);
      if (this.stopped || !now || now.state !== 'pending') return;
      if (this.expired(now)) this.finish(hostId, continueId, 'expired');
      else void this.serial(() => this.check(hostId, continueId, attempt + 1));
    }, delay);
    t.unref?.();
    this.retries.set(k, t);
  }

  private async evaluate(rec: ContinueRequestRecordV1): Promise<A2aContinueCode | { rootId: string }> {
    const req = rec.request;
    if (this.expired(rec)) return 'expired';
    if (req.estimate.bytes > this.limits.bytes || req.estimate.files > this.limits.files) return 'too-large';
    if (this.deps.sessionLive(req.sessionId)) return 'busy';
    const matched = await this.rootsWithOrigin(req.repo.origin, false);
    if (matched.length === 0) return 'repo-not-found';
    if (matched.length > 1) return 'repo-ambiguous';
    if (!(await this.roomFor(req.estimate.bytes))) return 'no-space';
    if (this.expired(rec)) return 'expired';
    if (!this.deps.cardAvailable?.()) return 'not-allowed';
    return { rootId: matched[0].id };
  }

  /**
   * The roots of `policy` whose origin is `origin`. Each root's origin is
   * read once per spawn-policy version; `fresh` reads every root again (and
   * keeps what it read). Only an origin read is kept: no origin (a root not
   * cloned yet) is read again next time. A read that failed is thrown.
   */
  private async rootsWithOrigin(origin: string, fresh: boolean, policy = this.deps.spawnPolicy.get()): Promise<A2aSpawnRootV1[]> {
    if (this.origins.version !== policy.version) this.origins = { version: policy.version, keys: new Map() };
    const keys = this.origins.keys;
    const matched: A2aSpawnRootV1[] = [];
    for (const root of policy.roots) {
      let key = fresh ? undefined : keys.get(root.path);
      if (key === undefined) {
        // eslint-disable-next-line no-await-in-loop -- one git read at a time, through the bounded gate
        key = await this.checks.run(() => this.deps.originKeyOf(root.path));
        if (key !== null) keys.set(root.path, key);
      }
      if (key === origin) matched.push(root);
    }
    return matched;
  }

  /**
   * Room on the staging volume for `bytes`, beside the bytes other requests
   * have yet to write there (reservedBytes: what is written already is gone
   * from the free space).
   */
  private async roomFor(bytes: number): Promise<boolean> {
    const free = await this.checks.run(() => this.deps.freeBytes());
    return free - this.deps.requests.reservedBytes() >= bytes;
  }

  /**
   * The manifest A took once its agent stopped, only for a request that is
   * `ready`. A resend of the one taken is a duplicate, another one a
   * conflict; for a request not waiting for one, A hears where it is.
   */
  private async takeManifest(hostId: HostId, manifest: A2aContinueManifestV1): Promise<A2aRemoteDeliverResponse> {
    const rec = this.deps.requests.get(hostId, manifest.continueId);
    if (!rec || rec.state !== 'ready') {
      if (rec?.manifest) return sameContinueBody(rec.manifest, manifest) ? DUPLICATE : CONFLICT;
      return this.answer(hostId, manifest.continueId);
    }
    const bytes = continueManifestBytes(manifest);
    // First the policy (a PC no longer allowed learns nothing of this PC's checkout) and the clock.
    const refusal = (): A2aContinueCode | undefined => {
      if (!this.allowed(hostId, rec.request)) return 'not-allowed';
      return this.expired(rec) ? 'expired' : undefined;
    };
    let code = refusal();
    // A's checkout moved on while B decided: what it took is of another commit.
    if (!code && manifest.head !== rec.request.repo.head) code = 'diverged';
    if (!code && (bytes > this.limits.bytes || manifest.files.length > this.limits.files)) code = 'too-large';
    if (!code) {
      let room: boolean;
      try {
        room = await this.roomFor(bytes);
      } catch (err) {
        // Not settled: A sends the manifest again (or the request expires).
        this.deps.log('warn', `[a2a-remote] continue ${manifest.continueId} from ${hostId}: free space not read: ${errMsg(err)}`);
        return UNAVAILABLE;
      }
      // The disk took a while: the policy and the clock again.
      code = refusal() ?? (room ? undefined : 'no-space');
    }
    if (code) return this.finish(hostId, manifest.continueId, code) ? OK : UNAVAILABLE;
    if (!this.step(hostId, manifest.continueId, ['ready'], 'receiving', { manifest })) return UNAVAILABLE;
    const taken = this.deps.requests.get(hostId, manifest.continueId);
    if (taken) this.deps.bytes?.receiving(taken);
    return OK;
  }

  /** This PC takes conversations from `hostId` (and of the request's agent, given one). The parser checked the agent can move. */
  private allowed(hostId: HostId, req?: A2aContinueRequestV1): boolean {
    const spawn = this.deps.spawnPolicy.get();
    return this.deps.policy.get().in.enabled && spawnHostAllowed(spawn, hostId) && (!req || spawn.agents.includes(req.agent));
  }

  /** Past its expiry by B's clock; an expiry that does not read counts as past. */
  private expired(rec: ContinueRequestRecordV1): boolean {
    const expires = Date.parse(rec.request.expiresAt);
    return Number.isNaN(expires) || this.now() > expires;
  }

  /** What `code` reads as to the record's PC: nothing of what this PC holds once that PC is not allowed. */
  private shown(rec: ContinueRequestRecordV1, code: A2aContinueCode): A2aContinueCode {
    return REPO_CODES.has(code) && !this.allowed(rec.hostId, rec.request) ? 'not-allowed' : code;
  }

  /** Move a request on and send its answer when that changed. False when it was not in `from` or not stored. */
  private step(
    hostId: HostId,
    continueId: string,
    from: readonly A2aContinueIncomingState[],
    to: Exclude<A2aContinueIncomingState, 'pending' | 'decided'>,
    extra?: { rootId?: string; manifest?: A2aContinueManifestV1 },
  ): boolean {
    let rec: ContinueRequestRecordV1 | undefined;
    try {
      rec = this.deps.requests.advance(hostId, continueId, from, to, extra);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue ${continueId} from ${hostId}: ${to} not stored: ${errMsg(err)}`);
      return false;
    }
    if (!rec) return false;
    this.deps.log('info', `[a2a-remote] continue ${continueId} from ${hostId}: ${to}`);
    this.sendOwed(rec);
    return true;
  }

  /** Decide an open request and send its answer. False when it is not open or the outcome was not stored. */
  private finish(hostId: HostId, continueId: string, code: A2aContinueCode): boolean {
    let rec: ContinueRequestRecordV1 | undefined;
    try {
      rec = this.deps.requests.decide(hostId, continueId, code);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue ${continueId} from ${hostId}: ${code} not stored: ${errMsg(err)}`);
      return false;
    }
    if (!rec) return false;
    this.deps.log('info', `[a2a-remote] continue ${continueId} from ${hostId}: ${code}`);
    this.sendOwed(rec);
    this.deps.bytes?.decided(hostId, continueId);
    return true;
  }

  /** Queue the record's answer unless it was queued already, and remember it. */
  private sendOwed(rec: ContinueRequestRecordV1): void {
    const code = continueAnswerFor(rec);
    if (rec.state === 'pending' || rec.sent === code) return;
    if (this.sendResult(rec.hostId, rec.request.continueId, this.shown(rec, code))) this.markSent(rec, code);
  }

  /**
   * The request's answer as it stands, coalesced: a resend or a status query.
   * An id this PC holds no record of gets nothing when that PC is not
   * allowed, and `unknown` at most once per window when it is, so made-up
   * ids cannot fill the outbox.
   */
  private answer(hostId: HostId, continueId: string, duplicate = false): A2aRemoteDeliverResponse {
    const done = duplicate ? DUPLICATE : OK;
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec) {
      if (!this.allowed(hostId)) return done;
      const last = this.unknownAt.get(hostId);
      if (last !== undefined && this.now() - last < this.coalesceMs) return done;
      if (!this.sendResult(hostId, continueId, 'unknown')) return UNAVAILABLE;
      this.unknownAt.set(hostId, this.now());
      return done;
    }
    const code = continueAnswerFor(rec);
    const shown = this.shown(rec, code);
    if (this.answeredRecently(hostId, continueId, shown)) return done;
    if (!this.sendResult(hostId, continueId, shown)) return UNAVAILABLE;
    this.markSent(rec, code);
    return done;
  }

  /**
   * Answer a request that is not stored (coalesced, and at most
   * CONTINUE_REFUSALS_PER_HOST_MAX per PC per window); `unavailable` when it
   * could not be queued, so A sends it again.
   */
  private refuse(hostId: HostId, continueId: string, code: A2aContinueCode): A2aRemoteDeliverResponse {
    this.deps.log('info', `[a2a-remote] continue ${continueId} from ${hostId}: ${code}`);
    if (this.answeredRecently(hostId, continueId, code)) return OK;
    const now = this.now();
    const recent = (this.refusedAt.get(hostId) ?? []).filter((t) => now - t < CONTINUE_REFUSAL_WINDOW_MS);
    this.refusedAt.set(hostId, recent);
    if (recent.length >= CONTINUE_REFUSALS_PER_HOST_MAX) return OK;
    if (!this.sendResult(hostId, continueId, code)) return UNAVAILABLE;
    recent.push(now);
    return OK;
  }

  private markSent(rec: ContinueRequestRecordV1, code: A2aContinueCode): void {
    try {
      this.deps.requests.markSent(rec.hostId, rec.request.continueId, code);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue ${rec.request.continueId} from ${rec.hostId}: sent, not marked: ${errMsg(err)}`);
    }
  }

  private answeredRecently(hostId: HostId, continueId: string, code: A2aContinueCode): boolean {
    const last = this.answeredAt.get(`${hostId}:${continueId}:${code}`);
    return last !== undefined && this.now() - last < this.coalesceMs;
  }

  /**
   * Queue a result; false when the outbox would not take it. Each send has
   * its own message id: `_` is in neither a continueId nor a code, and the
   * last part is new for every send (this run's start, then a count).
   */
  private sendResult(hostId: HostId, continueId: string, code: A2aContinueCode): boolean {
    try {
      this.deps.enqueue(hostId, {
        protocol: A2A_REMOTE_PROTOCOL,
        linkId: continueId,
        linkVersion: 0,
        messageId: `cres_${continueId}_${code}_${this.boot}-${this.sends++}`,
        kind: 'link',
        link: { state: 'continue-result', version: 0 },
        continueResult: { v: 1, continueId, code },
        sentAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue result ${continueId} to ${hostId} not queued: ${errMsg(err)}`);
      return false;
    }
    const k = `${hostId}:${continueId}:${code}`;
    this.answeredAt.delete(k);
    this.answeredAt.set(k, this.now());
    if (this.answeredAt.size > ANSWERED_RECENTLY_MAX) this.answeredAt.delete(this.answeredAt.keys().next().value as string);
    return true;
  }

  /** Run `step` after every check, manifest and claim before it. */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
