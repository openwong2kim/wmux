// ─── Continue on another PC: the contract ───────────────────────────────────
//
// A pane's Claude conversation moves to another paired PC (B) that has the
// same repository, and B resumes it by its exact session id. The messages
// ride the A2A outbox as `link` envelopes, only to a PC that advertises
// `A2A_FEATURE_CONTINUE`. `linkId` is the continueId, and none of them touch
// a link record:
//
//   A -> B  'continue'           A2aContinueRequestV1      size estimates only; A's Claude keeps running
//   B -> A  'continue-result'    A2aContinueResultV1       each step B takes, and its decision
//   A -> B  'continue-manifest'  A2aContinueManifestV1     once B is `ready` and A has stopped its Claude
//   A -> B  'continue-status'    A2aContinueStatusQueryV1  B answers with its current `continue-result`
//
// The bytes travel on their own route, each file matched to a manifest entry
// by its SHA-256. Nothing in a message is a path on either PC: the repository
// is named by its origin, and the conversation's files by their path below
// its own folder.
//
// A checks its checkout again once its agent has stopped, and sends the
// manifest only when it is still clean at the commit the request named: the
// agent kept running while B decided. B refuses a manifest whose `head`
// differs from the request's.
//
// The conversation belongs to B from `received` on. A resumes its own copy
// only on a final answer that B did not start it and never will
// (continueResumesSource); a timeout alone never resumes it, nor does an
// `unknown`. B starts it only from `received` and only before it expires
// (continueClaimable).
//
// Pure module: no node:* imports.

import { agentRow, isAgentSlug, type AgentSlug } from './agentIdentity';
import { CHATV2_PROVIDER_SESSION_ID } from './chatv2/ipc';
import { isHostId, type HostId } from './a2aRemote';
import { normalizeSpawnSub, spawnClockOk } from './a2aSpawn';
import { DEFAULT_FANOUT_WORKER_PERMISSION_MODE, isFanoutWorkerPermissionMode, type FanoutWorkerPermissionMode } from './workerLaunch';

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Bytes of a conversation (its transcript and its folder's files), as written on disk. */
export const CONTINUE_BYTES_MAX = 64 * 1024 * 1024;
/** Files in a conversation's folder. */
export const CONTINUE_FILES_MAX = 1000;
/** A file's path below the conversation's folder: characters, segments, characters per segment. */
export const CONTINUE_REL_MAX = 240;
export const CONTINUE_REL_DEPTH_MAX = 8;
export const CONTINUE_SEGMENT_MAX = 120;
/** Longest a request may wait for B, and how long it waits when the asker names no time. */
export const CONTINUE_TTL_MAX_MS = 24 * 60 * 60 * 1000;
export const CONTINUE_TTL_DEFAULT_MS = 60 * 60 * 1000;
/** A decided request is kept this long, so a status query still gets its answer. */
export const CONTINUE_RECORD_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** A branch name (characters). */
export const CONTINUE_BRANCH_MAX = 200;

/** The link-envelope states these messages travel under. */
export const A2A_CONTINUE_LINK_STATES = ['continue', 'continue-result', 'continue-manifest', 'continue-status'] as const;
export type A2aContinueLinkState = (typeof A2A_CONTINUE_LINK_STATES)[number];

const CONTINUE_ID_RE = /^ct-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** A commit id: SHA-1, or SHA-256 for a repository that uses it. */
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** An origin as originUrlRepoKey writes it: `host/owner/repo`, lowercased, up to 21 path segments. */
const REPO_KEY_RE = /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+){1,21}$/;

// ─── Codes ──────────────────────────────────────────────────────────────────

/**
 * What a `continue-result` says. Only these ever reach A: never a path, an
 * errno, a message or a stack. `not-allowed` also covers "the feature is off
 * here", and B answers the repository codes only to a PC it takes
 * conversations from, so no other PC learns what B holds.
 */
export const A2A_CONTINUE_CODES = [
  /** B shows its card. */
  'waiting-for-approval',
  /** Approved: A stops its Claude and sends the manifest and the bytes. */
  'ready',
  /** B holds every byte, checked: the conversation is B's now. */
  'received',
  'started',
  'not-supported',
  'not-allowed',
  'repo-not-found',
  /** More than one of B's folders has that origin. */
  'repo-ambiguous',
  'branch-not-found',
  /** The branch is checked out in another of B's worktrees. */
  'branch-busy',
  /** B cannot get A's commit from origin. */
  'head-missing',
  /** B's branch, or a conversation file B already holds, has moved on from A's. */
  'diverged',
  /** A pane on B already runs that conversation, or another request carries it. */
  'busy',
  /** B already holds as many requests from A as it takes; A may ask again later. */
  'full',
  'too-large',
  'no-space',
  'path-too-long',
  'declined',
  'expired',
  /**
   * B holds no record of the request (a status answer), or B began a start
   * it cannot tell ever ran (its report never came, and no pane there runs
   * the conversation). Not proof that B never started it (B may have lost
   * or pruned a record it ran), so A never resumes on it by itself.
   */
  'unknown',
  'failed',
] as const;
export type A2aContinueCode = (typeof A2A_CONTINUE_CODES)[number];

export function isContinueCode(v: unknown): v is A2aContinueCode {
  return typeof v === 'string' && (A2A_CONTINUE_CODES as readonly string[]).includes(v);
}

/** A code after which nothing more comes for that request. */
export function isFinalContinueCode(code: A2aContinueCode): boolean {
  return code !== 'waiting-for-approval' && code !== 'ready' && code !== 'received';
}

/**
 * Whether A, which stopped its agent for this request, resumes its own copy
 * on this answer: only on a final answer that B did not start the
 * conversation and never will (an expired request is never claimed, see
 * continueClaimable). Not on `started`, and not on `unknown`: that is the
 * owner's call.
 */
export function continueResumesSource(code: A2aContinueCode): boolean {
  return isFinalContinueCode(code) && code !== 'started' && code !== 'unknown';
}

// ─── Wire ───────────────────────────────────────────────────────────────────

/** A -> B. Exactly these keys; anything else is refused. */
export interface A2aContinueRequestV1 {
  v: 1;
  /** `ct-<uuid>`, minted by A; also the envelope's `linkId`. */
  continueId: string;
  /** The conversation's exact session id. */
  sessionId: string;
  /** An agent whose conversation can move (isContinueAgent). */
  agent: AgentSlug;
  repo: {
    /** origin as `host/owner/repo` (originUrlRepoKey): never a URL, so it carries no credential or path. */
    origin: string;
    branch: string;
    /** The commit A's branch is at. A has nothing unpushed, so origin has it too. */
    head: string;
    /** The conversation's folder below the repository's top level; absent for the top level. */
    sub?: string;
  };
  /** What the conversation comes to before A stops anything. The manifest's figures are checked again. */
  estimate: { bytes: number; files: number };
  /** ISO; judged by B's clock. */
  expiresAt: string;
}

/** One file of the conversation, as written on disk (the wire may compress it). */
export interface A2aContinueFileV1 {
  sha256: string;
  bytes: number;
}

/** A -> B, after `ready`: what A took once its Claude stopped. Exactly these keys. */
export interface A2aContinueManifestV1 {
  v: 1;
  continueId: string;
  /** The commit the checkout was at, clean, once the agent stopped: the request's `repo.head`, or B refuses. */
  head: string;
  /** `<sessionId>.jsonl`. */
  transcript: A2aContinueFileV1;
  /** The conversation's folder `<sessionId>/` (tool results, subagents): each file by its path below it. */
  files: Array<A2aContinueFileV1 & { rel: string }>;
}

/** B -> A: one per step, and the decision. */
export interface A2aContinueResultV1 {
  v: 1;
  continueId: string;
  code: A2aContinueCode;
}

/** A -> B: "where is it?". B answers with a `continue-result` (continueAnswerFor). */
export interface A2aContinueStatusQueryV1 {
  v: 1;
  continueId: string;
}

// ─── Records (each PC's own store) ──────────────────────────────────────────

/**
 * A request this PC sent:
 *   asked        — queued, or delivered and not answered yet; Claude runs
 *   waiting      — B shows its card; Claude runs
 *   stopping     — B is ready: Claude is being stopped and the snapshot taken
 *   sending      — the manifest and the bytes are on their way
 *   handed-over  — B has the bytes (`received`): the conversation is B's
 *   started      — final: B runs it
 *   refused      — final: B refused before `ready`; Claude was never stopped
 *   resumed      — final: B did not start it and never will; this pane resumed it
 *   expired      — final: no answer before it expired; Claude was never stopped
 */
export type A2aContinueOutgoingState = 'asked' | 'waiting' | 'stopping' | 'sending' | 'handed-over' | 'started' | 'refused' | 'resumed' | 'expired';

export interface A2aContinueOutgoingRecordV1 {
  v: 1;
  continueId: string;
  hostId: HostId;
  /** The pane (its daemon session) the conversation ran in. */
  ptyId: string;
  sessionId: string;
  state: A2aContinueOutgoingState;
  /** B's last answer. */
  code?: A2aContinueCode;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

/**
 * A request this PC received:
 *   pending    — checks running
 *   awaiting   — its card is shown
 *   ready      — approved; waiting for the manifest and the bytes
 *   receiving  — the manifest is accepted; the bytes arrive into staging
 *   received   — every byte is in staging and checked: the conversation is ours
 *   starting   — claimed: the worktree, the files and the pane are being made
 *   decided    — final; `code` says how
 */
export type A2aContinueIncomingState = 'pending' | 'awaiting' | 'ready' | 'receiving' | 'received' | 'starting' | 'decided';

export interface A2aContinueIncomingRecordV1 {
  v: 1;
  /** The asking PC as its link authenticated it, never a field of the request. */
  hostId: HostId;
  request: A2aContinueRequestV1;
  manifest?: A2aContinueManifestV1;
  state: A2aContinueIncomingState;
  code?: A2aContinueCode;
  /** The folder of ours the repository matched. */
  rootId?: string;
  receivedAt: string;
  updatedAt: string;
}

/** B's answer to a status query: where its record is, or `unknown` without one. */
export function continueAnswerFor(record: A2aContinueIncomingRecordV1 | undefined): A2aContinueCode {
  if (!record) return 'unknown';
  switch (record.state) {
    case 'pending':
    case 'awaiting':
      return 'waiting-for-approval';
    case 'ready':
    case 'receiving':
      return 'ready';
    case 'received':
    case 'starting':
      return 'received';
    case 'decided':
      // A decided record names a final code; any other is a writer's bug, and ends it.
      return record.code && isFinalContinueCode(record.code) ? record.code : 'failed';
  }
}

/** Whether B may start a received request now: it holds every byte, and the request has not expired. */
export function continueClaimable(record: A2aContinueIncomingRecordV1, now: number): boolean {
  const expires = Date.parse(record.request.expiresAt);
  return record.state === 'received' && !Number.isNaN(expires) && now <= expires;
}

// ─── Policy (each PC's own file) ────────────────────────────────────────────

/** The modes B may run a continued conversation in: never one that skips its permission checks. */
export type A2aContinuePermissionMode = Exclude<FanoutWorkerPermissionMode, 'bypassPermissions'>;

export interface A2aContinuePolicyV1 {
  v: 1;
  /**
   * As B: take conversations from the PCs, folders and agent the remote-spawn
   * policy allows. Each one still asks on its card, and runs in this PC's
   * mode, never in the mode the conversation was written in.
   */
  in: { enabled: boolean; permissionMode: A2aContinuePermissionMode };
  /** As A: the PCs this one may send a conversation to. */
  out: Record<HostId, { allowed: boolean }>;
  /** Bumped on every save. */
  version: number;
}

export function defaultContinuePolicy(): A2aContinuePolicyV1 {
  const mode = DEFAULT_FANOUT_WORKER_PERMISSION_MODE;
  return { v: 1, in: { enabled: false, permissionMode: mode === 'bypassPermissions' ? 'manual' : mode }, out: {}, version: 0 };
}

/** A policy as read from its file: unknown keys and invalid PCs dropped, a skipping mode refused; null when it is not one. */
export function coerceContinuePolicy(raw: unknown): A2aContinuePolicyV1 | null {
  if (!isPlain(raw) || raw['v'] !== 1) return null;
  const policy = defaultContinuePolicy();
  const version = raw['version'];
  if (typeof version === 'number' && Number.isInteger(version) && version >= 0) policy.version = version;
  const inbound = raw['in'];
  if (isPlain(inbound)) {
    policy.in.enabled = inbound['enabled'] === true;
    const mode = inbound['permissionMode'];
    if (isFanoutWorkerPermissionMode(mode) && mode !== 'bypassPermissions') policy.in.permissionMode = mode;
  }
  const out = raw['out'];
  if (isPlain(out)) {
    for (const [hostId, entry] of Object.entries(out)) {
      if (isHostId(hostId) && isPlain(entry) && entry['allowed'] === true) policy.out[hostId] = { allowed: true };
    }
  }
  return policy;
}

/** Whether this PC may send a conversation to `hostId`. */
export function continueOutAllowed(policy: A2aContinuePolicyV1, hostId: HostId): boolean {
  return policy.out[hostId]?.allowed === true;
}

// ─── RPC (machine-local, `wmux.internal`) ───────────────────────────────────

/** The daemon methods main starts a conversation this PC received with. */
export const A2A_CONTINUE_RPC = Object.freeze({
  /** → `A2aContinueWork`: the received requests main has to start (on connect, on each event, on a backstop). */
  work: 'a2a.remote.continue.work',
  /**
   * `{ hostId, continueId }` → `A2aContinueClaimResult`. Takes a received
   * request for starting, after checking it again right now. A refusal is
   * settled and answered by the daemon itself.
   */
  claim: 'a2a.remote.continue.claim',
  /**
   * `{ hostId, continueId, cwd }` → `A2aContinuePlaceResult`: the staged
   * conversation into Claude's project folder for `cwd`, a folder of that
   * request's own worktree. Only for a request that is starting.
   */
  place: 'a2a.remote.continue.place',
  /** `{ hostId, continueId }` → `A2aContinueStepResult`: take back exactly what `place` did. */
  unplace: 'a2a.remote.continue.unplace',
  /** `{ ptyId }` → `A2aContinueBinding`: the transcript the pane's agent named in its hooks, once it has. */
  binding: 'a2a.remote.continue.binding',
  /** `{ hostId, continueId }` → `A2aContinueStepResult`: the pane runs the conversation. */
  started: 'a2a.remote.continue.started',
  /** `{ hostId, continueId, code: A2aContinueStartFailure }` → `A2aContinueStepResult`: starting a claimed request failed. */
  failed: 'a2a.remote.continue.failed',
  /** `{ hostId, continueId }` → `A2aContinueRequestState`: where a request is now (asked after an answer was lost). */
  state: 'a2a.remote.continue.state',
} as const);

/** Daemon broadcast: a request this PC received answers something new (main starts it once it is `received`). */
export const A2A_CONTINUE_EVENT = 'a2a.remote.continue.changed';
export interface A2aContinueEvent {
  type: typeof A2A_CONTINUE_EVENT;
  hostId: HostId;
  continueId: string;
  code: A2aContinueCode;
}

/** `work`'s answer. */
export interface A2aContinueWork {
  received: Array<{ hostId: HostId; continueId: string }>;
}

/** What main needs to start a claimed conversation. The files stay with the daemon, which places them. */
export interface A2aContinueClaimV1 {
  hostId: HostId;
  /** This PC's name for the asking PC. */
  hostName: string;
  continueId: string;
  sessionId: string;
  agent: AgentSlug;
  /** The matched root's realpath: a git repository's top level. */
  repoPath: string;
  /** The repository as the request names it: its origin key, branch and commit. */
  origin: string;
  branch: string;
  head: string;
  /** The conversation's folder below the top level ('' = the top level). */
  sub: string;
  permissionMode: A2aContinuePermissionMode;
}

export type A2aContinueClaimResult =
  | { ok: true; claim: A2aContinueClaimV1 }
  /** Not startable now; `code` is what the asker was told, when it was settled here. */
  | { ok: false; error: string; code?: A2aContinueCode };

/** The codes a claimed start ends with when main could not start it (the receiver's CONTINUE_START_FAILURES). */
export type A2aContinueStartFailure = Extract<A2aContinueCode, 'failed' | 'branch-not-found' | 'branch-busy' | 'head-missing' | 'diverged' | 'path-too-long' | 'no-space'>;

export type A2aContinuePlaceResult =
  /** The placed transcript, as Claude is to be given it with `--resume`. */
  | { ok: true; transcriptPath: string }
  | { ok: false; code: Extract<A2aContinueStartFailure, 'failed' | 'diverged' | 'no-space' | 'path-too-long'>; error: string };

export type A2aContinueStepResult = { ok: true } | { ok: false; error: string };

/** `binding`'s answer: the transcript path the pane's hooks reported, or null before they have. */
export interface A2aContinueBinding {
  transcriptPath: string | null;
}

/** `state`'s answer: empty when this PC holds no record of the request. */
export interface A2aContinueRequestState {
  state?: A2aContinueIncomingState;
  code?: A2aContinueCode;
}

// ─── Parsers ────────────────────────────────────────────────────────────────

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function isCount(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

export function isContinueId(v: unknown): v is string {
  return typeof v === 'string' && CONTINUE_ID_RE.test(v);
}

/** An agent whose conversation another PC can take (its row's `continueOnPc`). */
export function isContinueAgent(v: unknown): v is AgentSlug {
  return isAgentSlug(v) && agentRow(v)?.continueOnPc === true;
}

export function isContinueSessionId(v: unknown): v is string {
  return typeof v === 'string' && CHATV2_PROVIDER_SESSION_ID.test(v);
}

export function isContinueRepoKey(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 512 && REPO_KEY_RE.test(v) && !v.split('/').some((p) => p === '.' || p === '..' || p.startsWith('-'));
}

/**
 * A branch name both PCs can hold: ASCII letters, digits and `._/-` only, and
 * none of the forms git refuses (git check-ref-format --branch): a `..`, an
 * empty or dot-led part, a trailing `/` or `.`, a `.lock` part, a leading
 * `-`, or `HEAD` (as the name or its first part).
 */
export function isContinueBranch(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > CONTINUE_BRANCH_MAX) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(v) || v.startsWith('-') || v.includes('..') || v.endsWith('.')) return false;
  if (v === 'HEAD' || v.startsWith('HEAD/')) return false;
  return v.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

export function isContinueCommit(v: unknown): v is string {
  return typeof v === 'string' && COMMIT_RE.test(v);
}

/** Names Windows keeps for devices, with or without an extension. */
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\..*)?$/i;

/**
 * A file's path below the conversation's folder, if every PC can hold it as
 * is: '/'-separated, relative, at most CONTINUE_REL_DEPTH_MAX segments of at
 * most CONTINUE_SEGMENT_MAX characters, and no segment that is empty, `.` or
 * `..`, ends in a dot or a space, is a Windows device name, or holds a
 * control character or one of `\ : * ? " < > |`. Null otherwise: nothing is
 * rewritten, so the name B writes is the name A read.
 */
export function normalizeContinueRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > CONTINUE_REL_MAX) return null;
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.length > CONTINUE_REL_DEPTH_MAX) return null;
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.length > CONTINUE_SEGMENT_MAX) return null;
    if (part.endsWith('.') || part.endsWith(' ') || WINDOWS_RESERVED_RE.test(part)) return null;
  }
  return rel;
}

/**
 * A path folded past any case-insensitive file system's own folding (NFC, then
 * upper and lower case: `ς` and `σ` meet, and `ß` meets `ss`): two paths that
 * meet here may be one file there. Folding too much only refuses a manifest.
 */
function foldedPath(rel: string): string {
  return rel.normalize('NFC').toUpperCase().toLowerCase();
}

/** Whether a request is inside its time window by B's clock (spawnClockOk, with CONTINUE_TTL_MAX_MS). */
export function continueClockOk(sentAt: string, expiresAt: string, now: number): boolean {
  return spawnClockOk(sentAt, expiresAt, now, CONTINUE_TTL_MAX_MS);
}

/** A request body, strictly; null when it is not exactly one. */
export function parseContinueRequest(raw: unknown): A2aContinueRequestV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, ['v', 'continueId', 'sessionId', 'agent', 'repo', 'estimate', 'expiresAt'])) return null;
  if (raw['v'] !== 1 || !isContinueId(raw['continueId']) || !isContinueSessionId(raw['sessionId']) || !isContinueAgent(raw['agent'])) return null;
  const repo = raw['repo'];
  if (!isPlain(repo) || !onlyKeys(repo, ['origin', 'branch', 'head', 'sub'])) return null;
  if (!isContinueRepoKey(repo['origin']) || !isContinueBranch(repo['branch']) || !isContinueCommit(repo['head'])) return null;
  // The folder below the top level, in its normal form, that every PC can hold.
  const sub = normalizeSpawnSub(repo['sub']);
  if (sub === null || (repo['sub'] !== undefined && (sub !== repo['sub'] || normalizeContinueRel(sub) === null))) return null;
  const estimate = raw['estimate'];
  if (!isPlain(estimate) || !onlyKeys(estimate, ['bytes', 'files'])) return null;
  if (!isCount(estimate['bytes'], CONTINUE_BYTES_MAX) || !isCount(estimate['files'], CONTINUE_FILES_MAX)) return null;
  const expiresAt = raw['expiresAt'];
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) return null;
  return {
    v: 1,
    continueId: raw['continueId'] as string,
    sessionId: raw['sessionId'] as string,
    agent: raw['agent'] as AgentSlug,
    repo: {
      origin: repo['origin'] as string,
      branch: repo['branch'] as string,
      head: repo['head'] as string,
      ...(sub ? { sub } : {}),
    },
    estimate: { bytes: estimate['bytes'] as number, files: estimate['files'] as number },
    expiresAt,
  };
}

function parseFile(raw: unknown, keys: readonly string[]): A2aContinueFileV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, keys)) return null;
  const { sha256, bytes } = raw;
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256) || !isCount(bytes, CONTINUE_BYTES_MAX)) return null;
  return { sha256, bytes };
}

/**
 * A manifest, strictly: every path one every PC can hold
 * (normalizeContinueRel), no two that a case-insensitive file system takes
 * for one, no file where another needs a folder, and the totals inside the
 * caps. Null otherwise.
 */
export function parseContinueManifest(raw: unknown): A2aContinueManifestV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, ['v', 'continueId', 'head', 'transcript', 'files'])) return null;
  if (raw['v'] !== 1 || !isContinueId(raw['continueId']) || !isContinueCommit(raw['head'])) return null;
  const transcript = parseFile(raw['transcript'], ['sha256', 'bytes']);
  const files = raw['files'];
  if (!transcript || !Array.isArray(files) || files.length > CONTINUE_FILES_MAX) return null;
  const out: A2aContinueManifestV1['files'] = [];
  const seen = new Set<string>();
  let total = transcript.bytes;
  for (const f of files) {
    const file = parseFile(f, ['rel', 'sha256', 'bytes']);
    const rel = isPlain(f) ? normalizeContinueRel(f['rel']) : null;
    if (!file || rel === null) return null;
    const folded = foldedPath(rel);
    if (seen.has(folded)) return null;
    seen.add(folded);
    total += file.bytes;
    if (total > CONTINUE_BYTES_MAX) return null;
    out.push({ rel, ...file });
  }
  // A file cannot also be a folder another file sits in.
  for (const folded of seen) {
    const parts = folded.split('/');
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) return null;
  }
  return { v: 1, continueId: raw['continueId'] as string, head: raw['head'] as string, transcript, files: out };
}

export function parseContinueResult(raw: unknown): A2aContinueResultV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, ['v', 'continueId', 'code'])) return null;
  if (raw['v'] !== 1 || !isContinueId(raw['continueId']) || !isContinueCode(raw['code'])) return null;
  return { v: 1, continueId: raw['continueId'] as string, code: raw['code'] };
}

export function parseContinueStatusQuery(raw: unknown): A2aContinueStatusQueryV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, ['v', 'continueId'])) return null;
  if (raw['v'] !== 1 || !isContinueId(raw['continueId'])) return null;
  return { v: 1, continueId: raw['continueId'] as string };
}
