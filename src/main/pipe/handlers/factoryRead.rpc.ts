// pr.read / issue.read / ci.read / verdict.read / trustMetrics.read /
// plan.propose — the bot reads and the plan card (shared/botSurface.ts
// FACTORY_READ_RPC, PLAN_RPC). Registered by the roles module
// (main/factory/roles/index.ts).
//
// Who may call (the handler is the gate; design §13 rules 1–2):
//   - a bot (every bot holds these tools, SHARED_SURFACE); it reads the
//     repository of its own profile — the workspace's repo — and only a
//     Coordinator-template bot (COORDINATOR_READ_EXTENSION, checked on its
//     live profile) may name another workspace, whose bots' repo it then
//     reads;
//   - the operator, naming the workspace;
//   - nobody else.
// The repository is never a path or key from params: it is the `repo` of a
// bot profile in the scoped workspace, and the remote key is derived from
// that checkout's own remote (the key the verdict store and the merge lane
// use). Every answer is bounded: lists are capped and long text is cut.
// A GitLab remote is read with glab; while glab is missing or signed out for
// its host, pr/issue/ci reads refuse `host_not_connected` and the owner is
// asked once per host to connect it (createHostSetupGate).
//
// plan.propose: one `plan` card, open, in a `plan:<id>` thread of the
// proposing bot's room, each item naming a workspace that has an enabled
// lead — its own workspace for any bot, any workspace for a Coordinator.
// The owner resolves it once (room.resolve); the roles module wakes the
// proposer with the answer, and it dispatches the approved items. A newer
// plan from the same bot closes its older plans still open (superseded).

import { randomBytes } from 'node:crypto';
import { isCoordinatorBot, type BotBinding, type BotProfile } from '../../../shared/bot';
import { FACTORY_READ_RPC, PLAN_RPC, botSurfaceRefusal, type BotToolName, type FactoryRefusal } from '../../../shared/botSurface';
import type { RpcContext } from '../../../shared/rpc';
import type { PrLaneFacts, PrReviewRead } from '../../../shared/prReview';
import type { IssueDetailResult, IssueFilter, IssueSummary } from '../../../shared/issueSurface';
import type { PrVerdictRecord } from '../../../shared/prVerdict';
import { ROOM_LIMITS, type RoomCard, type ThreadId } from '../../../shared/room';
import type { FactoryRouter } from '../../factory/factoryHost';
import type { BotDirectoryApi } from '../../factory/botStore';
import type { RoomWriter } from '../../factory/roomWriter';
import { DAY_MS, type TrustReadResult } from '../../factory/trustMetrics';
import { GUEST_TURN_STARTS_NO_WORKERS, guestOfRunningWake, type GuestProvenance } from '../../factory/wakeTaint';
import { crossesGuestBoundary } from '../../factory/guestWorkspaces';
import { isGithubHost, type PrGate } from '../../github/PrProvider';

// ── Limits ─────────────────────────────────────────────────────────────────

export const FACTORY_READ_LIMITS = {
  PR_FILES: 100,
  PR_CHECKS: 50,
  PR_LABELS: 20,
  ISSUE_LIST: 30,
  ISSUE_BODY: 4000,
  ISSUE_COMMENTS: 10,
  ISSUE_COMMENT_BODY: 1000,
  CI_CHECKS: 50,
  VERDICTS: 20,
  TRUST_REVERTED: 20,
  TRUST_MAX_DAYS: 90,
  PLAN_ITEMS: 10,
  PLAN_TEXT: 300,
} as const;

const PR_NUMBER_MAX = 99_999_999;

// ── Ports ──────────────────────────────────────────────────────────────────

export interface CiRollup {
  branch: string;
  headSha: string;
  committedAt: string | null;
  /** The rollup state in GitHub's words (SUCCESS, FAILURE, PENDING, ...; a
   *  GitLab pipeline's status is mapped to them), or null. */
  state: string | null;
  checks: Array<{ name: string; state: string }>;
  checksTotal: number;
}

export interface FactoryReadDeps {
  bots: () => BotDirectoryApi | null;
  /** The remote key (`host/owner/repo`, `host/group/…/project`) of a
   *  checkout's origin, or null. */
  repoKeyOf: (repoPath: string) => Promise<string | null>;
  readPr: (repoPath: string, repoKey: string, prNumber: number) => Promise<PrReviewRead<PrLaneFacts>>;
  listIssues: (repoPath: string, filter: IssueFilter, repoKey: string) => Promise<{ ok: true; issues: IssueSummary[] } | { ok: false; message: string }>;
  issueDetail: (repoPath: string, issueNumber: number, repoKey: string) => Promise<IssueDetailResult>;
  ciRollup: (repoPath: string, repoKey: string) => Promise<CiRollup | { error: string }>;
  verdicts: (repoKey: string, prNumber: number) => Promise<PrVerdictRecord[]>;
  trust: (repoPath: string, since: number, now: number) => Promise<TrustReadResult>;
  rooms: () => RoomWriter | null;
  /** The running wake's idempotency key for a bot's n-th post (room.post's). */
  postKey: (botId: string) => string | undefined;
  now?: () => number;
  /** The guest provenance of a bot's running wake (wakeTaint.ts); default
   *  the running tracker. */
  guestWake?: (botId: string) => GuestProvenance;
  /** Why the scope's host cannot be read now (a GitLab host without a
   *  usable glab: `host_not_connected`, or `read_failed` when it could not
   *  be reached just now), or null; createHostSetupGate. Absent: always
   *  readable. */
  hostReady?: (scope: RepoScope) => Promise<HostNotReady | null>;
}

// ── Caller and repo scope ──────────────────────────────────────────────────

type Caller = { kind: 'bot'; bot: BotBinding } | { kind: 'operator' };

function refusal<C extends string>(code: C, message: string): FactoryRefusal<C> {
  return { ok: false, code, message };
}

function params(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const TOOL_METHOD: Readonly<Partial<Record<BotToolName, string>>> = {
  pr_read: FACTORY_READ_RPC.prRead,
  issue_read: FACTORY_READ_RPC.issueRead,
  ci_read: FACTORY_READ_RPC.ciRead,
  verdict_read: FACTORY_READ_RPC.verdictRead,
  trust_metrics_read: FACTORY_READ_RPC.trustMetricsRead,
  plan_propose: PLAN_RPC.propose,
};

/** The caller of a read: a bot (its binding on the bot surface), or the
 *  operator. */
export function readCaller(ctx: RpcContext | undefined, tool: BotToolName): Caller | FactoryRefusal<'not_bot' | 'surface'> {
  if (ctx?.bot) {
    const method = TOOL_METHOD[tool];
    if (!method || botSurfaceRefusal(ctx.bot.role, method) !== null) return refusal('surface', `${tool} is not on the bot surface`);
    return { kind: 'bot', bot: ctx.bot };
  }
  if (ctx?.operator === true) return { kind: 'operator' };
  return refusal('not_bot', 'this call needs a bot identity or the operator');
}

const WORKSPACE_RE = /^[A-Za-z0-9._-]{1,80}$/;

function enabledBots(bots: BotDirectoryApi | null): BotProfile[] {
  try {
    return bots?.listEnabled() ?? [];
  } catch {
    return [];
  }
}

/** The repo a workspace's bots act on: the oldest enabled bot there with one. */
export function workspaceRepo(bots: BotDirectoryApi | null, workspaceId: string): { repoPath: string } | null {
  const withRepo = enabledBots(bots)
    .filter((b) => b.workspaceId === workspaceId && b.repo?.repoPath)
    .sort((a, b) => a.createdAt - b.createdAt);
  const repoPath = withRepo[0]?.repo?.repoPath;
  return repoPath ? { repoPath } : null;
}

export type RepoScope = { repoPath: string; repoKey: string; workspaceId: string };

/** The repository a call reads (see the header), or a refusal. */
export async function repoScope(
  caller: Caller,
  p: Record<string, unknown>,
  deps: Pick<FactoryReadDeps, 'bots' | 'repoKeyOf'>,
): Promise<RepoScope | FactoryRefusal<'invalid' | 'cross_workspace' | 'no_repo' | 'not_attributed'>> {
  const asked = p.workspaceId;
  if (asked !== undefined && (typeof asked !== 'string' || !WORKSPACE_RE.test(asked))) return refusal('invalid', 'workspaceId is not a workspace id');
  let workspaceId: string;
  let repoPath: string | null = null;
  const bots = deps.bots();
  if (caller.kind === 'bot') {
    const own = bots?.get(caller.bot.botId) ?? null;
    if (!own || !own.enabled || own.workspaceId !== caller.bot.workspaceId) return refusal('not_attributed', 'this bot is not running in the factory');
    if (asked !== undefined && asked !== own.workspaceId && !isCoordinatorBot(own)) {
      return refusal('cross_workspace', 'a bot reads its own workspace\'s repository; another workspace is a Coordinator\'s read');
    }
    workspaceId = (asked as string | undefined) ?? own.workspaceId;
    repoPath = workspaceId === own.workspaceId && own.repo?.repoPath
      ? own.repo.repoPath
      : workspaceRepo(bots, workspaceId)?.repoPath ?? null;
  } else {
    if (typeof asked !== 'string') return refusal('invalid', 'workspaceId is required');
    workspaceId = asked;
    repoPath = workspaceRepo(bots, workspaceId)?.repoPath ?? null;
  }
  if (!repoPath) return refusal('no_repo', `workspace ${workspaceId} has no bot with a repository`);
  const repoKey = await deps.repoKeyOf(repoPath).catch(() => null);
  if (!repoKey) return refusal('no_repo', 'the repository has no GitHub or GitLab remote wmux can read');
  return { repoPath, repoKey, workspaceId };
}

function positiveInt(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max ? v : null;
}

function cut(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false };
}

function readFailed(r: { message: string; code?: string }): FactoryRefusal<'read_failed' | 'rate_limited'> {
  return refusal(r.code === 'rate-limited' ? 'rate_limited' : 'read_failed', r.message.slice(0, 300));
}

export interface HostNotReady { code: 'host_not_connected' | 'read_failed'; message: string }

/** The one refusal of a read whose host cannot be read now, or null. */
async function hostNotConnected(scope: RepoScope, deps: Pick<FactoryReadDeps, 'hostReady'>): Promise<FactoryRefusal<HostNotReady['code']> | null> {
  const why = deps.hostReady ? await deps.hostReady(scope).catch(() => null) : null;
  return why ? refusal(why.code, why.message) : null;
}

/** A host's gate: PrGate, or a host that could not be reached just now. */
export type HostGate = PrGate | { ok: false; reason: 'unreachable'; message: string };

export interface HostSetupGatePorts {
  /** glab's connection to a host (GlabPrService.connection, which caches
   *  only definite answers). */
  gate: (repoPath: string, host: string) => Promise<HostGate>;
  /** Ask the owner, in a workspace's room, to connect GitLab on `host`;
   *  `why` is the gate's message. */
  ask: (workspaceId: string, host: string, why: string) => void;
}

/**
 * FactoryReadDeps.hostReady for GitLab remotes: null for a GitHub host or a
 * GitLab host glab can read. A definite missing glab or sign-out is the
 * bot's `host_not_connected` refusal, and the owner is asked to connect that
 * host once — not per read, bot or workspace — until the gate passes again
 * (a later failure asks again). A host not reached just now (or a gate that
 * threw) is a transient `read_failed`: nobody is asked, nothing is kept.
 */
export function createHostSetupGate(ports: HostSetupGatePorts): (scope: RepoScope) => Promise<HostNotReady | null> {
  const asked = new Set<string>();
  return async (scope) => {
    const host = scope.repoKey.split('/')[0] ?? '';
    if (!host || isGithubHost(host)) return null;
    let gate: HostGate;
    try {
      gate = await ports.gate(scope.repoPath, host);
    } catch {
      gate = { ok: false, reason: 'unreachable', message: 'the GitLab CLI (glab) could not be run just now' };
    }
    if (gate.ok) {
      asked.delete(host);
      return null;
    }
    if (gate.reason === 'unreachable') return { code: 'read_failed', message: `${gate.message}; try again later.` };
    if (!asked.has(host)) {
      asked.add(host);
      try {
        ports.ask(scope.workspaceId, host, gate.message);
      } catch {
        /* the refusal still tells the bot */
      }
    }
    return {
      code: 'host_not_connected',
      message: `GitLab on ${host} is not connected in wmux (${gate.message}). The owner has been asked to connect it; `
        + 'merge requests, issues and CI can be read once they have. Do not retry this read or ask the owner about it again.',
    };
  };
}

// ── Handlers ───────────────────────────────────────────────────────────────

export async function handlePrRead(raw: unknown, ctx: RpcContext | undefined, deps: FactoryReadDeps): Promise<unknown> {
  const caller = readCaller(ctx, 'pr_read');
  if ('ok' in caller) return caller;
  const p = params(raw);
  const n = positiveInt(p.prNumber, PR_NUMBER_MAX);
  if (n === null) return refusal('invalid', 'prNumber must be a positive integer');
  const scope = await repoScope(caller, p, deps);
  if ('ok' in scope) return scope;
  const notConnected = await hostNotConnected(scope, deps);
  if (notConnected) return notConnected;
  const r = await deps.readPr(scope.repoPath, scope.repoKey, n);
  if (!r.ok) return readFailed(r);
  const f = r.value;
  const L = FACTORY_READ_LIMITS;
  return {
    ok: true,
    repoKey: scope.repoKey,
    workspaceId: scope.workspaceId,
    pr: {
      number: f.number,
      title: f.title ?? '',
      state: f.state,
      isDraft: f.isDraft,
      author: f.author,
      headSha: f.headRefOid,
      headRefName: f.headRefName,
      baseRefName: f.baseRefName,
      isCrossRepository: f.isCrossRepository,
      mergeStateStatus: f.mergeStateStatus ?? null,
      mergeable: f.mergeable ?? null,
      mergedAt: f.mergedAt,
      labels: f.labels.slice(0, L.PR_LABELS),
      labelsTruncated: f.labelsTruncated || f.labels.length > L.PR_LABELS,
      files: f.files.slice(0, L.PR_FILES),
      filesTruncated: f.filesTruncated || f.files.length > L.PR_FILES,
      checksHeadSha: f.checksHeadOid,
      checks: f.checks.slice(0, L.PR_CHECKS).map((c) => ({ name: c.name, bucket: c.bucket, required: c.isRequired === true })),
      checksTruncated: f.checksTruncated || f.checks.length > L.PR_CHECKS,
    },
  };
}

export async function handleIssueRead(raw: unknown, ctx: RpcContext | undefined, deps: FactoryReadDeps): Promise<unknown> {
  const caller = readCaller(ctx, 'issue_read');
  if ('ok' in caller) return caller;
  const p = params(raw);
  if (p.issueNumber !== undefined && positiveInt(p.issueNumber, PR_NUMBER_MAX) === null) return refusal('invalid', 'issueNumber must be a positive integer');
  if (p.label !== undefined && (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 100)) return refusal('invalid', 'label must be a label name');
  const scope = await repoScope(caller, p, deps);
  if ('ok' in scope) return scope;
  const notConnected = await hostNotConnected(scope, deps);
  if (notConnected) return notConnected;
  const L = FACTORY_READ_LIMITS;
  if (typeof p.issueNumber === 'number') {
    const r = await deps.issueDetail(scope.repoPath, p.issueNumber, scope.repoKey);
    if (!r.ok) return readFailed(r);
    const d = r.detail;
    const body = cut(d.body, L.ISSUE_BODY);
    const comments = d.comments.slice(-L.ISSUE_COMMENTS).map((c) => {
      const b = cut(c.body, L.ISSUE_COMMENT_BODY);
      return { author: c.author, createdAt: c.createdAt, body: b.text, ...(b.truncated || c.truncated ? { truncated: true } : {}) };
    });
    return {
      ok: true,
      repoKey: scope.repoKey,
      issue: {
        number: d.number, title: d.title, state: d.state, author: d.author, url: d.url,
        labels: d.labels.map((l) => l.name).slice(0, L.PR_LABELS),
        createdAt: d.createdAt,
        body: body.text, bodyTruncated: body.truncated || d.bodyTruncated,
        comments, commentsTruncated: d.comments.length > L.ISSUE_COMMENTS,
      },
    };
  }
  const filter: IssueFilter = typeof p.label === 'string' ? { kind: 'label', label: p.label.trim() } : { kind: 'all' };
  const r = await deps.listIssues(scope.repoPath, filter, scope.repoKey);
  if (!r.ok) return readFailed(r);
  return {
    ok: true,
    repoKey: scope.repoKey,
    issues: r.issues.slice(0, L.ISSUE_LIST).map((i) => ({
      number: i.number, title: i.title, author: i.author, labels: i.labels.map((l) => l.name).slice(0, 10),
      updatedAt: i.updatedAt, comments: i.comments, url: i.url,
    })),
    truncated: r.issues.length > L.ISSUE_LIST,
  };
}

export async function handleCiRead(raw: unknown, ctx: RpcContext | undefined, deps: FactoryReadDeps): Promise<unknown> {
  const caller = readCaller(ctx, 'ci_read');
  if ('ok' in caller) return caller;
  const scope = await repoScope(caller, params(raw), deps);
  if ('ok' in scope) return scope;
  const notConnected = await hostNotConnected(scope, deps);
  if (notConnected) return notConnected;
  const r = await deps.ciRollup(scope.repoPath, scope.repoKey);
  if ('error' in r) return refusal('read_failed', r.error.slice(0, 300));
  const failing = r.checks.filter((c) => /^(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE)$/.test(c.state));
  return {
    ok: true,
    repoKey: scope.repoKey,
    ci: { ...r, checks: r.checks.slice(0, FACTORY_READ_LIMITS.CI_CHECKS), failing: failing.map((c) => c.name).slice(0, 20) },
  };
}

export async function handleVerdictRead(raw: unknown, ctx: RpcContext | undefined, deps: FactoryReadDeps): Promise<unknown> {
  const caller = readCaller(ctx, 'verdict_read');
  if ('ok' in caller) return caller;
  const p = params(raw);
  const n = positiveInt(p.prNumber, PR_NUMBER_MAX);
  if (n === null) return refusal('invalid', 'prNumber must be a positive integer');
  const scope = await repoScope(caller, p, deps);
  if ('ok' in scope) return scope;
  let all: PrVerdictRecord[];
  try {
    all = await deps.verdicts(scope.repoKey, n);
  } catch {
    return refusal('read_failed', 'the verdict store could not be read');
  }
  const newest = [...all].sort((a, b) => b.at - a.at).slice(0, FACTORY_READ_LIMITS.VERDICTS);
  return {
    ok: true,
    repoKey: scope.repoKey,
    prNumber: n,
    verdicts: newest.map((v) => ({
      headSha: v.headSha, verdict: v.verdict, summary: v.summary, at: v.at,
      by: { workspaceId: v.principal.workspaceId, ...(v.principal.botId ? { botId: v.principal.botId } : {}), agent: v.principal.agent },
      ...(v.evidence ? { evidenceTaskId: v.evidence.taskId } : {}),
    })),
    truncated: all.length > FACTORY_READ_LIMITS.VERDICTS,
  };
}

export async function handleTrustMetricsRead(raw: unknown, ctx: RpcContext | undefined, deps: FactoryReadDeps): Promise<unknown> {
  const caller = readCaller(ctx, 'trust_metrics_read');
  if ('ok' in caller) return caller;
  const p = params(raw);
  const days = p.sinceDays === undefined ? 30 : positiveInt(p.sinceDays, FACTORY_READ_LIMITS.TRUST_MAX_DAYS);
  if (days === null) return refusal('invalid', `sinceDays must be 1-${FACTORY_READ_LIMITS.TRUST_MAX_DAYS}`);
  const scope = await repoScope(caller, p, deps);
  if ('ok' in scope) return scope;
  const now = (deps.now ?? Date.now)();
  const r = await deps.trust(scope.repoPath, now - days * DAY_MS, now);
  if (!r.ok) return refusal(r.code, r.message);
  const a = r.analysis;
  return {
    ok: true,
    repoKey: scope.repoKey,
    ref: r.ref,
    sinceDays: days,
    totals: a.totals,
    unattributedCommits: r.unattributedCommits,
    reverted: a.reverted.slice(-FACTORY_READ_LIMITS.TRUST_REVERTED).map((x) => ({
      pr: x.pr, subject: x.subject.slice(0, 200), mergedAt: x.mergedAt,
      hoursToRevert: x.timeToRevertMs === null ? null : Math.round(x.timeToRevertMs / 360_000) / 10,
      inMainNow: x.inMainNow,
    })),
    revertPrs: a.revertPrs.length,
    note: 'Only git revert is seen; a change undone by hand or in part is not.',
  };
}

// ── plan.propose ───────────────────────────────────────────────────────────

export const PLAN_SIZES = ['S', 'M', 'L'] as const;

export interface PlanItem { workspaceId: string; title: string; size: (typeof PLAN_SIZES)[number]; why: string }

function oneLine(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t && t.length <= max ? t : null;
}

/** The plan card's body: the ordered items, then Moa's notes. */
export function renderPlanBody(items: readonly PlanItem[], notes: string): string {
  const rows = items.map((it, i) => `${i + 1}. **${it.title}** — workspace \`${it.workspaceId}\`, size ${it.size}. ${it.why}`);
  const text = [...rows, ...(notes ? ['', notes] : [])].join('\n');
  return text.length > ROOM_LIMITS.CARD_BODY_MAX ? `${text.slice(0, ROOM_LIMITS.CARD_BODY_MAX - 1)}…` : text;
}

export async function handlePlanPropose(raw: unknown, ctx: RpcContext | undefined, deps: FactoryReadDeps): Promise<unknown> {
  const caller = readCaller(ctx, 'plan_propose');
  if ('ok' in caller) return caller;
  if (caller.kind !== 'bot') return refusal('surface', 'plan.propose is a bot\'s');
  const bot = caller.bot;
  let own: BotProfile | null = null;
  try {
    own = deps.bots()?.get(bot.botId) ?? null;
  } catch {
    own = null;
  }
  if (!own || !own.enabled || own.workspaceId !== bot.workspaceId) {
    return refusal('not_attributed', 'this bot is not running in the factory');
  }
  // The owner's answer to a plan wakes its bot to start the work.
  if ((deps.guestWake ?? guestOfRunningWake)(bot.botId) !== false) return refusal('not_authorized', `plan.propose: ${GUEST_TURN_STARTS_NO_WORKERS}`);
  const anyWorkspace = isCoordinatorBot(own);
  const p = params(raw);
  const L = FACTORY_READ_LIMITS;
  const title = oneLine(p.title, ROOM_LIMITS.TITLE_MAX);
  if (!title) return refusal('invalid', 'title is required (one line)');
  if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > L.PLAN_ITEMS) {
    return refusal('invalid', `items must list 1-${L.PLAN_ITEMS} plan items`);
  }
  const notes = p.body === undefined ? '' : typeof p.body === 'string' && p.body.length <= 4000 ? p.body.trim() : null;
  if (notes === null) return refusal('invalid', 'body must be text of at most 4000 characters');
  const leads = new Set(enabledBots(deps.bots()).filter((b) => b.role === 'lead').map((b) => b.workspaceId));
  const items: PlanItem[] = [];
  for (const [k, rawItem] of (p.items as unknown[]).entries()) {
    const it = params(rawItem);
    const ws = typeof it.workspaceId === 'string' && WORKSPACE_RE.test(it.workspaceId) ? it.workspaceId : null;
    const itTitle = oneLine(it.title, ROOM_LIMITS.TITLE_MAX);
    const why = oneLine(it.why, L.PLAN_TEXT);
    const size = (PLAN_SIZES as readonly unknown[]).includes(it.size) ? (it.size as PlanItem['size']) : null;
    if (!ws || !itTitle || !why || !size) return refusal('invalid', `item ${k + 1} needs workspaceId, title, size (S, M or L) and why`);
    if (ws !== own.workspaceId && !anyWorkspace) {
      return refusal('cross_workspace', `item ${k + 1}: a bot plans for its own workspace; another workspace is a Coordinator's`);
    }
    if (crossesGuestBoundary(own.workspaceId, ws)) {
      return refusal('cross_workspace', `item ${k + 1}: a guest workspace is planned for only from inside it`);
    }
    if (!leads.has(ws)) return refusal('no_lead', `item ${k + 1}: workspace ${ws} has no enabled lead to dispatch to`);
    items.push({ workspaceId: ws, title: itTitle, size, why });
  }
  const writer = deps.rooms();
  if (!writer) return refusal('not_started', 'rooms are not running yet');
  const threadId = `plan:p-${(deps.now ?? Date.now)().toString(36)}${randomBytes(3).toString('hex')}` as ThreadId;
  const clientPostId = deps.postKey(bot.botId);
  const r = writer.post({
    workspaceId: bot.workspaceId,
    threadId,
    kind: 'plan',
    actor: { kind: 'bot', workspaceId: bot.workspaceId, botId: bot.botId },
    title,
    body: renderPlanBody(items, notes),
    state: 'open',
    ...(clientPostId ? { clientPostId } : {}),
  });
  if (!r.ok) return refusal('invalid', r.message);
  const card: RoomCard = r.card;
  // A newer plan supersedes the bot's older ones still open: they leave the
  // open state (no answer is routed for them; the room counts only the
  // newest anyway, botsModel.ts livePlanIds).
  if (!r.duplicate) {
    for (;;) {
      // Main's own bookkeeping: a guest-sourced plan of the bot is closed too
      // (its words go nowhere; only its state changes).
      const older = writer.find(bot.workspaceId, (c) => c.kind === 'plan' && c.state === 'open' && c.id !== card.id
        && c.actor.kind === 'bot' && c.actor.botId === bot.botId, { guests: true });
      if (!older || !writer.setState(bot.workspaceId, older.id, 'resolved')) break;
    }
  }
  return { ok: true, card, threadId: card.threadId, items, ...(r.duplicate ? { duplicate: true } : {}) };
}

export function registerFactoryReadHandlers(router: Pick<FactoryRouter, 'register'>, deps: FactoryReadDeps): void {
  router.register(FACTORY_READ_RPC.prRead, (raw, ctx) => handlePrRead(raw, ctx, deps));
  router.register(FACTORY_READ_RPC.issueRead, (raw, ctx) => handleIssueRead(raw, ctx, deps));
  router.register(FACTORY_READ_RPC.ciRead, (raw, ctx) => handleCiRead(raw, ctx, deps));
  router.register(FACTORY_READ_RPC.verdictRead, (raw, ctx) => handleVerdictRead(raw, ctx, deps));
  router.register(FACTORY_READ_RPC.trustMetricsRead, (raw, ctx) => handleTrustMetricsRead(raw, ctx, deps));
  router.register(PLAN_RPC.propose, (raw, ctx) => handlePlanPropose(raw, ctx, deps));
}

// ── The default-branch CI read (one GraphQL call) ──────────────────────────

export const CI_ROLLUP_QUERY = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){defaultBranchRef{name target{... on Commit{oid committedDate statusCheckRollup{state contexts(first:${FACTORY_READ_LIMITS.CI_CHECKS}){totalCount nodes{__typename ... on CheckRun{name conclusion status} ... on StatusContext{context state}}}}}}}}}`;

/** The GraphQL answer → CiRollup, or null when it is not one. */
export function mapCiRollup(raw: unknown): CiRollup | null {
  const repo = (raw as { data?: { repository?: { defaultBranchRef?: unknown } } } | null)?.data?.repository?.defaultBranchRef as
    | { name?: unknown; target?: { oid?: unknown; committedDate?: unknown; statusCheckRollup?: { state?: unknown; contexts?: { totalCount?: unknown; nodes?: unknown } } | null } }
    | null
    | undefined;
  if (!repo || typeof repo.name !== 'string' || typeof repo.target?.oid !== 'string') return null;
  const rollup = repo.target.statusCheckRollup ?? null;
  const nodes = Array.isArray(rollup?.contexts?.nodes) ? (rollup?.contexts?.nodes as Array<Record<string, unknown>>) : [];
  const checks = nodes.flatMap((n) => {
    if (n.__typename === 'CheckRun' && typeof n.name === 'string') {
      return [{ name: n.name, state: String(n.conclusion ?? n.status ?? 'UNKNOWN') }];
    }
    if (n.__typename === 'StatusContext' && typeof n.context === 'string') return [{ name: n.context, state: String(n.state ?? 'UNKNOWN') }];
    return [];
  });
  return {
    branch: repo.name,
    headSha: repo.target.oid,
    committedAt: typeof repo.target.committedDate === 'string' ? repo.target.committedDate : null,
    state: typeof rollup?.state === 'string' ? rollup.state : null,
    checks,
    checksTotal: typeof rollup?.contexts?.totalCount === 'number' ? rollup.contexts.totalCount : checks.length,
  };
}
