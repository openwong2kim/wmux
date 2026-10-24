// ─── Remote spawn: the contract ─────────────────────────────────────────────
//
// Another paired PC (A) asks this PC (B) to start a new agent, in a folder B
// allowed, with a first prompt. The request and its answer ride the existing
// A2A outbox as `link` envelopes (see `A2aRemoteEnvelope.link`):
//
//   A -> B  link.state 'spawn'          + `spawn`         (A2aSpawnRequestV1)
//   B -> A  link.state 'spawn-result'   + `spawnResult`   (A2aSpawnResultV1)
//   B -> A  link.state 'spawn-targets'  + `spawnTargets`  (A2aSpawnTargetsV1)
//
// B answers every spawn envelope at once (`ok`, or `bad-request` for one it
// cannot read) and decides later: approval and checks never hold up the
// transport. The decision travels back as its own `spawn-result` envelope,
// through B's own outbox, so it reaches A whichever side of the pair joined.
//
// Owner-gated on B: off by default, each PC opted in one by one, only the
// roots and agents B listed. The request names no path, command, flag, mode or
// environment. B's policy file is not a boundary against code running as the
// same user on B; the boundary is B's per-PC opt-in and B's approval.
//
// Pure module: no node:* imports (the renderer imports these types).

import { isAgentSlug, type AgentSlug } from './agentIdentity';
import { FANOUT_AGENTS } from './fanoutPreset';
import { A2A_REMOTE_BODY_MAX, A2A_REMOTE_RECORD_V, isConsistentEndpoint, isHostId, type HostId } from './a2aRemote';
import { DEFAULT_FANOUT_WORKER_PERMISSION_MODE, isFanoutWorkerPermissionMode, type FanoutWorkerPermissionMode } from './workerLaunch';

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Longest a request may wait for B, from when it was sent. */
export const SPAWN_TTL_MAX_MS = 72 * 60 * 60 * 1000;
/** How far ahead of B's clock a request's `sentAt` may be. */
export const SPAWN_CLOCK_SKEW_MS = 10 * 60 * 1000;
/** A request's first prompt (bytes, UTF-8). */
export const SPAWN_TEXT_MAX = A2A_REMOTE_BODY_MAX;
/** A `requestKey`: an id the asker minted (`[A-Za-z0-9-]`). */
export const SPAWN_REQUEST_KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
/** A folder's path below its root (characters). */
export const SPAWN_SUB_MAX = 512;
/** Roots and agents one policy may list. */
export const SPAWN_ROOTS_MAX = 32;
/** Decided requests kept per PC; past it, that PC's new requests wait (`rate-limited`). */
export const SPAWN_DECIDED_PER_HOST_MAX = 100;
/** "Always allow" rules one policy may hold. */
export const SPAWN_RULES_MAX = 256;
/** A root's display label (characters). */
export const SPAWN_LABEL_MAX = 64;
/** A decided request is kept this long past its expiry, so a resend gets the same answer. */
export const SPAWN_REQUEST_KEEP_MS = 24 * 60 * 60 * 1000;
/** Requests B keeps (all PCs). */
export const SPAWN_REQUESTS_MAX = 1000;
/** Fixed id of the `spawn-targets` envelope: never stored as a link. */
export const SPAWN_TARGETS_LINK_ID = 'spawn-targets';

const SPAWN_ID_RE = /^sp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SAFE_ID_MAX = 128;

// ─── Codes ──────────────────────────────────────────────────────────────────

/**
 * What a `spawn-result` says. Only these ever reach A: never a path, an
 * errno, a message or a stack.
 *
 * `not-allowed` covers "the feature is off here" AND "this PC is not allowed"
 * on purpose: A learns nothing about B's policy from it.
 */
export const A2A_SPAWN_CODES = [
  'waiting-for-approval',
  'started',
  'not-supported',
  'not-allowed',
  'agent-not-allowed',
  'agent-not-installed',
  'folder-not-allowed',
  'expired',
  'rate-limited',
  'declined',
  'app-not-ready',
  'failed',
] as const;
export type A2aSpawnCode = (typeof A2A_SPAWN_CODES)[number];

/** A code after which nothing more comes for that request. */
export function isFinalSpawnCode(code: A2aSpawnCode): boolean {
  return code !== 'waiting-for-approval';
}

export function isSpawnCode(v: unknown): v is A2aSpawnCode {
  return typeof v === 'string' && (A2A_SPAWN_CODES as readonly string[]).includes(v);
}

// ─── Wire ───────────────────────────────────────────────────────────────────

/** A's pane that gets the replies: A's own side, named by A. */
export interface A2aSpawnFromV1 {
  kind: 'pane';
  workspaceId: string;
  paneId: string;
}

/** A -> B. Exactly these keys; anything else is refused as `bad-request`. */
export interface A2aSpawnRequestV1 {
  v: 1;
  /** `sp-<uuid>`, minted by A; also the envelope's `linkId`. */
  spawnId: string;
  agent: AgentSlug;
  /** A root B advertised, and an optional relative POSIX path below it. */
  folder: { root: string; sub?: string };
  /** The first prompt. */
  text: string;
  /** ISO; judged by B's clock. */
  expiresAt: string;
  from: A2aSpawnFromV1;
}

/** B -> A: one per decision (`waiting-for-approval` may come first). */
export interface A2aSpawnResultV1 {
  v: 1;
  spawnId: string;
  code: A2aSpawnCode;
  /** `started` only: B's new pane, B's own side. */
  endpoint?: { kind: 'pane'; workspaceId: string; paneId: string };
  /** `started` only: the link's version on B. */
  linkVersion?: number;
  /** `started` only: the link's id (a uuid B minted when it started the agent). */
  linkId?: string;
}

/**
 * The message id of a started spawn's first task (the prompt), on both PCs:
 * with the link id from the `started` answer it gives the same task id on
 * each (`remoteTaskId`), so the replies of the started agent land on the
 * asker's copy. The link id is a fresh uuid minted by B (`links.json` takes
 * uuids only, and nothing the asker sent predicts it).
 */
export function spawnFirstMessageId(linkId: SpawnLinkId): string {
  return `first_${linkId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The id of a link a remote start made: a uuid the starting PC minted.
 * Branded, so a spawnId (or any other string) cannot be passed where one is
 * meant; `asSpawnLinkId` is the only way to get one.
 */
export type SpawnLinkId = string & { readonly __spawnLinkId: true };

export function asSpawnLinkId(v: unknown): SpawnLinkId | null {
  return typeof v === 'string' && UUID_RE.test(v) ? (v as SpawnLinkId) : null;
}

/** B -> A: what A may ask for. Ids and labels only, never a path. */
export interface A2aSpawnTargetsV1 {
  v: 1;
  /** Bumped on every change; A keeps the highest. */
  version: number;
  roots: { id: string; label: string }[];
  agents: AgentSlug[];
}

// ─── Policy (B's own file, `a2a/spawn-policy.json`) ─────────────────────────

export type A2aSpawnApproval = 'ask' | 'allow-list';
export type A2aSpawnFollowUps = 'ask' | 'direct';
export type A2aSpawnPermissionMode = FanoutWorkerPermissionMode;

export interface A2aSpawnRootV1 {
  /** Stable id A refers to (`[a-z0-9-]`, ≤ 32). */
  id: string;
  label: string;
  /** Absolute; a git repository's top level, realpath'd when it was added. */
  path: string;
}

export interface A2aSpawnRuleV1 {
  hostId: HostId;
  rootId: string;
  agent: AgentSlug;
  /**
   * The folder below the root it was granted for (normalized; '' = the root).
   * Absent on a rule saved before it was recorded: it then covers the root only.
   */
  sub?: string;
}

/** A rule allows exactly the folder it was granted for. */
export function spawnRuleMatches(rule: A2aSpawnRuleV1, hostId: HostId, rootId: string, agent: AgentSlug, sub: string): boolean {
  return rule.hostId === hostId && rule.rootId === rootId && rule.agent === agent && (rule.sub ?? '') === sub;
}

export interface A2aSpawnPolicyV1 {
  v: 1;
  enabled: boolean;
  approval: A2aSpawnApproval;
  followUps: A2aSpawnFollowUps;
  /** The mode the agent runs in on this PC; never the request's. */
  permissionMode: A2aSpawnPermissionMode;
  hosts: Record<HostId, { allowed: boolean }>;
  roots: A2aSpawnRootV1[];
  agents: AgentSlug[];
  rules: A2aSpawnRuleV1[];
  /** Bumped on every save: the `spawn-targets` version. */
  version: number;
}

export const DEFAULT_SPAWN_POLICY: Readonly<A2aSpawnPolicyV1> = Object.freeze({
  v: 1,
  enabled: false,
  approval: 'ask',
  followUps: 'ask',
  permissionMode: DEFAULT_FANOUT_WORKER_PERMISSION_MODE,
  hosts: {},
  roots: [],
  agents: [],
  rules: [],
  version: 0,
});

export function defaultSpawnPolicy(): A2aSpawnPolicyV1 {
  return structuredClone({ ...DEFAULT_SPAWN_POLICY }) as A2aSpawnPolicyV1;
}

// ─── RPC (machine-local, `wmux.internal`) ───────────────────────────────────

export const A2A_SPAWN_RPC = Object.freeze({
  /** → `{ policy: A2aSpawnPolicyV1 }` */
  policyGet: 'a2a.remote.spawnPolicy.get',
  /** `{ policy }` → `{ ok: true, policy } | { ok: false, error }`; roots are checked and realpath'd here. */
  policySet: 'a2a.remote.spawnPolicy.set',
  /** → `{ requests: A2aSpawnRequestSummary[] }` (newest first, no prompt text). */
  requestsList: 'a2a.remote.spawnRequests.list',
  /** → `A2aSpawnWork`: what main has to show or start (on connect and on each event). */
  work: 'a2a.remote.spawn.work',
  /** `{ hostId, spawnId, verdict: A2aSpawnVerdict }` → `A2aSpawnStepResult`; only for a request awaiting its card. */
  decide: 'a2a.remote.spawn.decide',
  /**
   * `{ hostId, spawnId }` → `A2aSpawnClaimResult`. Takes an approved request
   * for starting, after checking everything again right now (policy, caps,
   * folder). A refusal is settled and answered by the daemon itself.
   */
  claim: 'a2a.remote.spawn.claim',
  /** `{ hostId, spawnId, workspaceId, paneId }` → `A2aSpawnStepResult`: the pane runs; mint the link, answer `started`, queue the prompt. */
  started: 'a2a.remote.spawn.started',
  /** `{ hostId, spawnId, code: 'folder-not-allowed' | 'failed' }` → `A2aSpawnStepResult`: starting a claimed request failed. */
  failed: 'a2a.remote.spawn.failed',
  /**
   * As A: `A2aSpawnAskInput` → `A2aSpawnAskResult`. Main calls it after
   * checking the caller (local origin, its own pane, depth 1); the daemon
   * stores the request and queues it for the other PC.
   */
  ask: 'a2a.remote.spawn.ask',
  /** As A: `{ spawnId? }` → `A2aSpawnOutgoingList`: this PC's requests (no prompt text) and what each PC lets it ask for. */
  outgoing: 'a2a.remote.spawn.outgoing',
} as const);

/** Main-pipe methods (local origin only): an agent, the CLI or the Remote page asks another PC to start an agent. */
export const A2A_SPAWN_PIPE_RPC = Object.freeze({
  /** `{ pc, agent, root, sub?, prompt, expiresInHours?, senderPtyId }` → `A2aSpawnAskResult`. */
  spawn: 'a2a.remote.spawn',
  /** `{ spawnId? }` → `A2aSpawnOutgoingList`. */
  status: 'a2a.remote.spawnStatus',
} as const);

/**
 * The fan-out lineage owner main stamps on a workspace another PC started
 * (`remote-spawn:<hostId>`): depth 1 for its agent. Not a workspace id, so
 * the sidebar does not nest it under (or orphan it from) an owner.
 */
export const REMOTE_SPAWN_LINEAGE_PREFIX = 'remote-spawn:';

/** Daemon broadcast: a received request changed state (main shows its card, or starts it). */
export const A2A_SPAWN_EVENT = 'a2a.remote.spawn.changed';
export interface A2aSpawnEvent {
  type: typeof A2A_SPAWN_EVENT;
  hostId: HostId;
  spawnId: string;
  state: A2aSpawnRequestState;
}

/**
 * A received request, on B:
 *   pending  — checks running (or waiting for the app)
 *   awaiting — its card is shown
 *   approved — allowed (by its card, or a rule); main starts it
 *   starting — main claimed it and is creating the worktree and pane
 *   decided  — final; `code` says how
 */
export type A2aSpawnRequestState = 'pending' | 'awaiting' | 'approved' | 'starting' | 'decided';

/** The card's three answers. `always` also adds the (PC, folder, agent) rule. */
export type A2aSpawnVerdict = 'once' | 'always' | 'deny';

/** What B's approval card shows. Machine-local only: it carries the prompt. */
export interface A2aSpawnCardV1 {
  hostId: HostId;
  /** B's name for that PC. */
  hostName: string;
  spawnId: string;
  agent: AgentSlug;
  rootId: string;
  rootLabel: string;
  /** The folder as resolved on B (root realpath + sub), for display. */
  folder: string;
  permissionMode: A2aSpawnPermissionMode;
  followUps: A2aSpawnFollowUps;
  /** The full prompt (already sanitized on arrival). */
  text: string;
  expiresAt: string;
}

/**
 * The workspace a remote spawn started, as the renderer keeps it for the
 * workspace's whole life (`fanout.spawnWorkspace` param `remoteSpawnedBy`):
 * its header chip and the start toast read it. Never the prompt.
 */
export interface A2aRemoteSpawnedBy {
  hostId: HostId;
  /** This PC's name for the asking PC. */
  name: string;
  spawnId: string;
  agent: AgentSlug;
}

/** An approved request main has to start. */
export interface A2aSpawnWorkItem {
  hostId: HostId;
  spawnId: string;
}

/**
 * A later instruction on a link a remote spawn made, held for its card
 * (`followUps: 'ask'`). Allowed: main retries the hold (it is delivered like
 * any held task); denied: main rejects the hold.
 */
export interface A2aSpawnFollowUpCardV1 {
  taskId: string;
  hostId: HostId;
  hostName: string;
  agent: AgentSlug;
  folder: string;
  permissionMode: A2aSpawnPermissionMode;
  text: string;
}

/** `a2a.remote.spawn.work`'s answer. */
export interface A2aSpawnWork {
  awaiting: A2aSpawnCardV1[];
  approved: A2aSpawnWorkItem[];
  followUps: A2aSpawnFollowUpCardV1[];
}

/** What main needs to start a claimed request. No prompt: it goes as the link's first task. */
export interface A2aSpawnClaimV1 {
  hostId: HostId;
  hostName: string;
  spawnId: string;
  agent: AgentSlug;
  /** The root's realpath: a git repository's top level. */
  repoPath: string;
  /** Normalized relative POSIX path below it ('' = the root). */
  sub: string;
  permissionMode: A2aSpawnPermissionMode;
}

export type A2aSpawnClaimResult =
  | { ok: true; claim: A2aSpawnClaimV1 }
  /** Not startable now; `code` is what the asker was told, when it was settled here. */
  | { ok: false; error: string; code?: A2aSpawnCode };

export type A2aSpawnStepResult = { ok: true } | { ok: false; error: string };

/** `a2a.remote.spawnPolicy.set`'s answer: the saved policy, or why it was refused. */
export type A2aSpawnPolicySetResult =
  | { ok: true; policy: A2aSpawnPolicyV1 }
  /** `conflict`: the policy changed since the caller read it (`version`); read it again. */
  | { ok: false; error: string; conflict?: true };

// ─── Asking (A's side) ──────────────────────────────────────────────────────

/** Requests one pane may send per hour, to any PC. */
export const SPAWN_ASKS_PER_PANE_PER_HOUR = 3;
/** Requests to one PC that may wait for their answer at once. */
export const SPAWN_ASKS_OPEN_PER_HOST_MAX = 3;
/** How long a request waits for the other PC when the caller names no time. */
export const SPAWN_ASK_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;
/** A request with no answer this long after its expiry is ended `expired` here. */
export const SPAWN_ASK_GRACE_MS = 10 * 60 * 1000;

/**
 * A request this PC sent:
 *   sent     — queued, or delivered and not answered yet
 *   waiting  — the other PC shows its card
 *   started  — the agent runs there; `linkId` is the link to it
 *   refused  — `code` says why
 *   expired  — no answer in time
 */
export type A2aSpawnOutgoingState = 'sent' | 'waiting' | 'started' | 'refused' | 'expired';

/** What a caller may see about a request this PC sent: never the prompt. */
export interface A2aSpawnOutgoingSummary {
  hostId: HostId;
  /** This PC's name for the other PC, when it has one. */
  hostName?: string;
  spawnId: string;
  agent: AgentSlug;
  rootId: string;
  sub?: string;
  /** The pane here that gets the replies. */
  from: A2aSpawnFromV1;
  state: A2aSpawnOutgoingState;
  code?: A2aSpawnCode;
  linkId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

/** What main hands the daemon; `from` is the caller's own pane, found by main. */
export interface A2aSpawnAskInput {
  /** The other PC: its host id, or this PC's name for it. */
  pc: string;
  agent: AgentSlug;
  folder: { root: string; sub?: string };
  text: string;
  /** 1–72; default 24. */
  expiresInHours?: number;
  from: A2aSpawnFromV1;
  /** Counts toward the per-pane hourly limit: the pane that gets the replies. */
  callerKey: string;
  /**
   * The asker's own id for this request: the same key from the same caller
   * answers with the request already stored instead of sending a second one,
   * so a retry after an unclear failure starts nothing twice. Never sent.
   */
  requestKey?: string;
}

/**
 * The Remote page's ask (renderer → main). `end` is the pane that gets the
 * replies; main checks it against its own pane tree before using it.
 */
export interface A2aSpawnUiAsk {
  hostId: HostId;
  agent: AgentSlug;
  folder: { root: string; sub?: string };
  text: string;
  expiresInHours?: number;
  end: { workspaceId: string; paneId: string };
  /** Minted once per dialog and reused on a retry (`A2aSpawnAskInput.requestKey`). */
  requestKey?: string;
}

/**
 * Why a request was not sent. `not-supported`: that PC's wmux cannot take
 * one (it never said `spawn.1`); `unknown-pc` / `ambiguous-pc`: no paired PC,
 * or more than one, goes by that name; `needs-review`: main's final pass over
 * the prompt (finalizeSpawnPrompt) would change it, so the person did not see
 * what would be sent.
 */
export type A2aSpawnAskError = 'unknown-pc' | 'ambiguous-pc' | 'not-supported' | 'rate-limited' | 'bad-request' | 'unavailable' | 'needs-review';

export type A2aSpawnAskResult =
  /** `online`: the other PC's link is up now; when false the request waits for it until `expiresAt`. */
  | { ok: true; spawn: A2aSpawnOutgoingSummary; online: boolean }
  | { ok: false; error: A2aSpawnAskError; message?: string };

/** One paired PC as a place to ask. */
export interface A2aSpawnPlace {
  hostId: HostId;
  name?: string;
  online: boolean;
  /** It said `spawn.1`. */
  supported: boolean;
  /** What it last said this PC may ask for; absent until it says. Empty lists: nothing (any more). */
  targets?: A2aSpawnTargetsV1;
}

export interface A2aSpawnOutgoingList {
  /** Newest first. */
  requests: A2aSpawnOutgoingSummary[];
  places: A2aSpawnPlace[];
}

/** Daemon broadcast: a request this PC sent, or what a PC lets it ask for, changed. */
export const A2A_SPAWN_OUTGOING_EVENT = 'a2a.remote.spawn.outgoing.changed';
export interface A2aSpawnOutgoingEvent {
  type: typeof A2A_SPAWN_OUTGOING_EVENT;
  hostId: HostId;
  spawnId?: string;
  state?: A2aSpawnOutgoingState;
}

/** What the UI may list about a received request: never the prompt. */
export interface A2aSpawnRequestSummary {
  hostId: HostId;
  spawnId: string;
  agent: AgentSlug;
  rootId: string;
  state: A2aSpawnRequestState;
  code?: A2aSpawnCode;
  receivedAt: string;
  expiresAt: string;
}

// ─── Parsers ────────────────────────────────────────────────────────────────

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function safeId(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return typeof v === 'string' && v.length > 0 && v.length <= SAFE_ID_MAX && !/[\u0000-\u001f\u007f]/.test(v);
}

/**
 * Agents another PC may start here: the fan-out agents verified end to end
 * (FANOUT_AGENTS `selectable`), which start unattended past their first-run
 * screens. Any other agent would stop on its own trust or onboarding prompt
 * with nobody there. A policy drops one when it is read, and a request for
 * one is refused `agent-not-allowed`.
 */
const SPAWNABLE_AGENTS: ReadonlySet<string> = new Set(FANOUT_AGENTS.filter((a) => a.selectable).map((a) => a.stem));
export function isSpawnableAgent(v: unknown): v is AgentSlug {
  return isAgentSlug(v) && SPAWNABLE_AGENTS.has(v);
}

export function isSpawnId(v: unknown): v is string {
  return typeof v === 'string' && SPAWN_ID_RE.test(v);
}

export function isSpawnRootId(v: unknown): v is string {
  return typeof v === 'string' && ROOT_ID_RE.test(v);
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * The path below a root, normalized: '' for the root itself, else segments
 * joined by '/'. Null for anything that could leave the root or is not plain:
 * absolute, a drive or UNC prefix, a `..` segment, a backslash, NUL or another
 * control character, or too long. `.` and empty segments are dropped.
 */
export function normalizeSpawnSub(sub: unknown): string | null {
  if (sub === undefined) return '';
  if (typeof sub !== 'string' || sub.length > SPAWN_SUB_MAX) return null;
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(sub)) return null;
  if (sub.startsWith('/') || /^[A-Za-z]:/.test(sub)) return null;
  const parts = sub.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** A request body, strictly; null when it is not exactly one. */
export function parseSpawnRequest(raw: unknown): A2aSpawnRequestV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, ['v', 'spawnId', 'agent', 'folder', 'text', 'expiresAt', 'from'])) return null;
  if (raw['v'] !== 1 || !isSpawnId(raw['spawnId']) || !isAgentSlug(raw['agent'])) return null;
  const folder = raw['folder'];
  if (!isPlain(folder) || !onlyKeys(folder, ['root', 'sub']) || !isSpawnRootId(folder['root'])) return null;
  const sub = normalizeSpawnSub(folder['sub']);
  if (sub === null) return null;
  const text = raw['text'];
  if (typeof text !== 'string' || !text.trim() || utf8Bytes(text) > SPAWN_TEXT_MAX) return null;
  const expiresAt = raw['expiresAt'];
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) return null;
  const from = raw['from'];
  if (!isPlain(from) || !onlyKeys(from, ['kind', 'workspaceId', 'paneId']) || from['kind'] !== 'pane') return null;
  if (!isConsistentEndpoint(from) || !safeId(from['workspaceId']) || !safeId(from['paneId'])) return null;
  return {
    v: 1,
    spawnId: raw['spawnId'] as string,
    agent: raw['agent'] as AgentSlug,
    folder: { root: folder['root'] as string, ...(sub ? { sub } : {}) },
    text,
    expiresAt,
    from: { kind: 'pane', workspaceId: from['workspaceId'] as string, paneId: from['paneId'] as string },
  };
}

/**
 * Whether a request is inside its time window by B's clock: not sent from the
 * future (past the allowed skew), not living longer than 72 h from either its
 * send time or now, and not expired.
 */
export function spawnClockOk(sentAt: string, expiresAt: string, now: number): boolean {
  const sent = Date.parse(sentAt);
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(sent) || Number.isNaN(expires)) return false;
  if (sent > now + SPAWN_CLOCK_SKEW_MS) return false;
  if (expires > now + SPAWN_TTL_MAX_MS || expires > sent + SPAWN_TTL_MAX_MS) return false;
  return now <= expires;
}

export function parseSpawnResult(raw: unknown): A2aSpawnResultV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, ['v', 'spawnId', 'code', 'endpoint', 'linkVersion', 'linkId'])) return null;
  if (raw['v'] !== 1 || !isSpawnId(raw['spawnId']) || !isSpawnCode(raw['code'])) return null;
  const code = raw['code'];
  const endpoint = raw['endpoint'];
  const linkVersion = raw['linkVersion'];
  const linkId = raw['linkId'];
  if (code !== 'started') {
    if (endpoint !== undefined || linkVersion !== undefined || linkId !== undefined) return null;
    return { v: 1, spawnId: raw['spawnId'] as string, code };
  }
  if (!isPlain(endpoint) || !onlyKeys(endpoint, ['kind', 'workspaceId', 'paneId']) || endpoint['kind'] !== 'pane') return null;
  if (!safeId(endpoint['workspaceId']) || !safeId(endpoint['paneId'])) return null;
  if (typeof linkVersion !== 'number' || !Number.isInteger(linkVersion) || linkVersion < 1) return null;
  if (typeof linkId !== 'string' || !UUID_RE.test(linkId)) return null;
  return {
    v: 1,
    spawnId: raw['spawnId'] as string,
    code,
    endpoint: { kind: 'pane', workspaceId: endpoint['workspaceId'] as string, paneId: endpoint['paneId'] as string },
    linkVersion,
    linkId,
  };
}

export function parseSpawnTargets(raw: unknown): A2aSpawnTargetsV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, ['v', 'version', 'roots', 'agents'])) return null;
  const version = raw['version'];
  if (raw['v'] !== 1 || typeof version !== 'number' || !Number.isInteger(version) || version < 0) return null;
  const roots = raw['roots'];
  const agents = raw['agents'];
  if (!Array.isArray(roots) || roots.length > SPAWN_ROOTS_MAX || !Array.isArray(agents) || agents.length > SPAWN_ROOTS_MAX) return null;
  const cleanRoots: A2aSpawnTargetsV1['roots'] = [];
  for (const r of roots) {
    if (!isPlain(r) || !onlyKeys(r, ['id', 'label']) || !isSpawnRootId(r['id']) || !isLabel(r['label'])) return null;
    cleanRoots.push({ id: r['id'] as string, label: r['label'] as string });
  }
  if (!agents.every(isAgentSlug)) return null;
  return { v: 1, version, roots: cleanRoots, agents: [...new Set(agents as AgentSlug[])] };
}

function isLabel(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return typeof v === 'string' && v.trim().length > 0 && v.length <= SPAWN_LABEL_MAX && !/[\u0000-\u001f\u007f]/.test(v);
}

/**
 * A policy from disk or from the UI, every field checked; null when it is not
 * one. Unknown agents, hosts, rules and malformed roots make the whole policy
 * invalid rather than being dropped, so a save never silently narrows. A known
 * agent another PC may not start (`isSpawnableAgent`) is dropped instead, with
 * its rules: a policy saved when it was offered keeps every other host, root
 * and agent.
 */
export function coerceSpawnPolicy(raw: unknown): A2aSpawnPolicyV1 | null {
  if (!isPlain(raw) || raw['v'] !== A2A_REMOTE_RECORD_V) return null;
  const { enabled, approval, followUps, permissionMode, hosts, roots, agents, rules, version } = raw;
  if (typeof enabled !== 'boolean') return null;
  if (approval !== 'ask' && approval !== 'allow-list') return null;
  if (followUps !== 'ask' && followUps !== 'direct') return null;
  if (!isFanoutWorkerPermissionMode(permissionMode)) return null;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return null;
  if (!isPlain(hosts)) return null;
  const cleanHosts: Record<HostId, { allowed: boolean }> = {};
  for (const [hostId, h] of Object.entries(hosts)) {
    if (!isHostId(hostId) || !isPlain(h) || typeof h['allowed'] !== 'boolean') return null;
    cleanHosts[hostId] = { allowed: h['allowed'] };
  }
  if (!Array.isArray(roots) || roots.length > SPAWN_ROOTS_MAX) return null;
  const cleanRoots: A2aSpawnRootV1[] = [];
  for (const r of roots) {
    if (!isPlain(r) || !isSpawnRootId(r['id']) || !isLabel(r['label']) || typeof r['path'] !== 'string' || !r['path']) return null;
    if (cleanRoots.some((c) => c.id === r['id'])) return null;
    cleanRoots.push({ id: r['id'] as string, label: r['label'] as string, path: r['path'] as string });
  }
  if (!Array.isArray(agents) || agents.length > SPAWN_ROOTS_MAX || !agents.every(isAgentSlug)) return null;
  if (!Array.isArray(rules) || rules.length > SPAWN_RULES_MAX) return null;
  const cleanRules: A2aSpawnRuleV1[] = [];
  for (const r of rules) {
    if (!isPlain(r) || !isHostId(r['hostId']) || !isSpawnRootId(r['rootId']) || !isAgentSlug(r['agent'])) return null;
    const sub = r['sub'] === undefined ? '' : normalizeSpawnSub(r['sub']);
    if (sub === null || (r['sub'] !== undefined && sub !== r['sub'])) return null;
    // A rule for a folder no longer listed goes with it: a folder added later
    // under the same id must not inherit it.
    if (!cleanRoots.some((root) => root.id === r['rootId']) || !isSpawnableAgent(r['agent'])) continue;
    cleanRules.push({ hostId: r['hostId'], rootId: r['rootId'] as string, agent: r['agent'], ...(sub ? { sub } : {}) });
  }
  return {
    v: 1,
    enabled,
    approval,
    followUps,
    permissionMode,
    hosts: cleanHosts,
    roots: cleanRoots,
    agents: [...new Set((agents as AgentSlug[]).filter(isSpawnableAgent))],
    rules: cleanRules,
    version,
  };
}

/** Whether `hostId` may ask at all: the feature on and that PC opted in. */
export function spawnHostAllowed(policy: A2aSpawnPolicyV1, hostId: HostId): boolean {
  return policy.enabled && policy.hosts[hostId]?.allowed === true;
}

/** What `hostId` may ask for, or null when it may not ask at all. */
export function spawnTargetsFor(policy: A2aSpawnPolicyV1, hostId: HostId): A2aSpawnTargetsV1 | null {
  if (!spawnHostAllowed(policy, hostId)) return null;
  return {
    v: 1,
    version: policy.version,
    roots: policy.roots.map((r) => ({ id: r.id, label: r.label })),
    agents: [...policy.agents],
  };
}
