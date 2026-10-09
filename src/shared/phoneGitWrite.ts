import type { MergeBlock } from './prReview';

/**
 * Phone git write actions (push, pr.create, pr.merge): the wire contract the
 * daemon serves and the phone codes against. See "Phone git write actions" in
 * docs/phone-client-contract.md.
 *
 * Push and merge are two-step: a preview hands out facts plus a single-use
 * `confirmToken`, and the execute names the values the person saw. pr.create
 * has no preview. Every execute carries a `requestId` and answers 202 with a
 * receipt the phone polls.
 *
 * Pure: types, limits, body parsers and the fingerprint source. No I/O.
 */

export const PHONE_GIT_WRITE_ACTIONS = ['push', 'pr.create', 'pr.merge'] as const;
export type PhoneGitWriteAction = (typeof PHONE_GIT_WRITE_ACTIONS)[number];

/** A confirm token lives this long after its preview. */
export const GIT_WRITE_CONFIRM_TTL_MS = 90_000;
/** Receipts stay on disk at least this long; afterwards a GET answers 404 `receipt-expired`. */
export const GIT_WRITE_RECEIPT_TTL_MS = 72 * 60 * 60 * 1000;
/** The push preview lists at most this many commits; `ahead` carries the full count. */
export const GIT_WRITE_PUSH_MAX_COMMITS = 20;
export const GIT_WRITE_PR_TITLE_MAX = 256;
export const GIT_WRITE_PR_BODY_MAX_BYTES = 64 * 1024;
export const GIT_WRITE_MERGE_METHODS = ['squash'] as const;
export type GitWriteMergeMethod = (typeof GIT_WRITE_MERGE_METHODS)[number];

/** Case-insensitive on input (iOS `UUID().uuidString` is uppercase); parsers lowercase it. */
export const GIT_WRITE_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A full commit id: SHA-1 (40) or SHA-256 (64), lowercase. Same format as Moa's `expectHead`. */
export const GIT_WRITE_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A GitHub login: what `gitWriteLogin` and `identity.login` hold. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Receipt states. The names match Moa's `MergeEffectStatus`; `uncertain` is never re-run here. */
export type GitWriteReceiptState = 'pending' | 'inFlight' | 'done' | 'refused' | 'uncertain';

/** Every `error` tag these routes answer with, and the tags a refused receipt carries. */
export type GitWriteError =
  | 'invalid-git-request' | 'merge-method-unsupported' | 'invalid-pr-title' | 'invalid-base'
  | 'authorization-expired'
  | 'git-write-disabled'
  | 'pr-not-found' | 'receipt-expired'
  | 'stale' | 'non-fast-forward' | 'blocked'
  | 'squash-disabled' | 'protected-target' | 'remote-branch-exists' | 'remote-unsupported' | 'not-pushed'
  | 'pr-exists' | 'no-commits-ahead' | 'detached-head' | 'git-operation-in-progress' | 'merge-in-flight'
  | 'identity-changed' | 'request-id-reused'
  | 'gh-auth-missing' | 'remote-forbidden'
  | 'confirm-required'
  | 'git-busy' | 'rate-limited'
  | 'gh-unavailable' | 'remote-unreachable'
  | 'git-receipts-unavailable'
  /** The session's directory is not inside a git repository. */
  | 'not-a-git-repo'
  /** git could not answer while resolving the repository. */
  | 'git-operation-failed'
  /** This daemon does not serve the action yet (its `/api/config` key is absent). */
  | 'not-implemented'
  /** Receipt only: the push did not reach the remote. */
  | 'push-not-landed';

/** HTTP status for each tag when it is the response itself (not inside a receipt). */
export const GIT_WRITE_ERROR_STATUS: Readonly<Record<GitWriteError, number>> = {
  'invalid-git-request': 400, 'merge-method-unsupported': 400, 'invalid-pr-title': 400, 'invalid-base': 400,
  'authorization-expired': 401,
  'git-write-disabled': 403,
  'pr-not-found': 404, 'receipt-expired': 404,
  stale: 409, 'non-fast-forward': 409, blocked: 409,
  'squash-disabled': 409, 'protected-target': 409, 'remote-branch-exists': 409, 'remote-unsupported': 409,
  'not-pushed': 409, 'pr-exists': 409, 'no-commits-ahead': 409, 'detached-head': 409,
  'git-operation-in-progress': 409, 'merge-in-flight': 409, 'identity-changed': 409, 'request-id-reused': 409,
  'gh-auth-missing': 424, 'remote-forbidden': 424,
  'confirm-required': 428,
  'git-busy': 429, 'rate-limited': 429,
  'gh-unavailable': 502, 'remote-unreachable': 502,
  'git-receipts-unavailable': 503,
  'not-a-git-repo': 409,
  'git-operation-failed': 500,
  'not-implemented': 501,
  'push-not-landed': 409,
};

/** `{error, …}`: the tag plus the extras its row in the contract names. */
export interface GitWriteErrorBody {
  error: GitWriteError;
  /** `stale` (push). */
  head?: string;
  /** `stale` (merge). */
  headRefOid?: string;
  /** `non-fast-forward`. */
  remoteTip?: string | null;
  behind?: number;
  /** `blocked`. */
  reason?: MergeBlock;
  /** `pr-exists`. */
  number?: number;
  /** `gh-auth-missing`, `remote-forbidden`. */
  login?: string;
  /** `rate-limited`, epoch ms. */
  retryAt?: number;
}

/** The account every push and merge goes out as (`gitWriteLogin`). */
export interface GitWriteIdentity { login: string }

/** What a preview adds to its facts. */
export interface GitWriteConfirmGrant {
  confirmToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** First answer to every execute. A resend of the same body gets the stored receipt instead. */
export interface GitWriteAccepted { requestId: string; replayed: false; state: 'pending' }

/**
 * A receipt: the GET answer, and (with `replayed: true`) the answer to a
 * resent execute. `Done` is the action's own result fields.
 */
export type GitWriteReceipt<Done> =
  | { requestId: string; replayed?: boolean; state: 'pending' | 'inFlight' | 'uncertain' }
  | ({ requestId: string; replayed?: boolean; state: 'done' } & Done)
  | ({ requestId: string; replayed?: boolean; state: 'refused' } & GitWriteErrorBody);

// ── push ─────────────────────────────────────────────────────────────────────

export interface PushTarget {
  /** Always `origin` in v1. */
  remote: string;
  /** The upstream's remote ref, which may differ from the local branch name. */
  ref: string;
  /** True when the push creates the remote branch. */
  create: boolean;
}

export interface PushCommit { oid: string; subject: string; author: string }

export interface PushPreviewFacts {
  branch: string;
  ref: string;
  head: string;
  target: PushTarget;
  /** `github.com/<owner>/<repo>`. */
  repo: string;
  ahead: number;
  behind: number;
  remoteTip: string | null;
  remoteMoved: boolean;
  fastForward: boolean;
  /** At most GIT_WRITE_PUSH_MAX_COMMITS. */
  commits: PushCommit[];
  commitsTruncated: boolean;
  identity: GitWriteIdentity;
}

export type PushPreview = PushPreviewFacts & GitWriteConfirmGrant;

export interface PushExecuteBody {
  requestId: string;
  confirmToken: string;
  expectedHead: string;
  expectedRef: string;
}

export interface PushDone { pushed: string; target: string }
export type PushReceipt = GitWriteReceipt<PushDone>;

// ── pr.create ────────────────────────────────────────────────────────────────

export interface PrCreateExecuteBody {
  requestId: string;
  title: string;
  body: string;
  /** Absent: the repository's default branch. */
  base?: string;
  draft?: boolean;
}

export interface PrCreateDone { number: number; url: string }
export type PrCreateReceipt = GitWriteReceipt<PrCreateDone>;

// ── pr.merge ─────────────────────────────────────────────────────────────────

export interface PrMergeChecks {
  overall: string;
  counts: Record<string, number>;
  /** OMITTED when GitHub could not say which checks are required; absence is not "none required". */
  requiredFailing?: string[];
  requiredPending?: string[];
}

/**
 * The facts a merge is decided on: the merge preview without its confirm
 * grant. Shared by the phone merge preview and the Moa pr.merge decision
 * payload, so both surfaces show one sheet.
 */
export interface PrMergeFacts {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  /** Non-null: the merge will be refused, and why. */
  block: MergeBlock | null;
  squashAllowed: boolean;
  checks: PrMergeChecks;
  methods: GitWriteMergeMethod[];
  subject: string;
  body: string;
  identity: GitWriteIdentity;
}

export type PrMergePreview = PrMergeFacts & GitWriteConfirmGrant;

export interface PrMergeExecuteBody {
  requestId: string;
  confirmToken: string;
  expectHead: string;
  method: GitWriteMergeMethod;
  subject: string;
  body: string;
}

export interface PrMergeDone { mergeCommitOid: string }
export type PrMergeReceipt = GitWriteReceipt<PrMergeDone>;

// ── Confirm pins ─────────────────────────────────────────────────────────────

/**
 * Values a confirm token is bound to, set by the preview. Push pins `head`,
 * `ref`, `targetRef` and `remoteTip`; merge pins `number` and `headRefOid`.
 */
export type GitWritePins = Readonly<Record<string, string | number | null>>;

/** The pins an execute body names, compared against the token's own. */
export function executeBodyPins(action: PhoneGitWriteAction, body: PushExecuteBody | PrMergeExecuteBody, number?: number): GitWritePins {
  if (action === 'push') {
    const b = body as PushExecuteBody;
    return { head: b.expectedHead, ref: b.expectedRef };
  }
  return { number: number ?? null, headRefOid: (body as PrMergeExecuteBody).expectHead };
}

// ── Parsers ──────────────────────────────────────────────────────────────────

export type GitWriteParse<T> = { ok: true; value: T } | { ok: false; error: GitWriteError };

const bad = (error: GitWriteError = 'invalid-git-request') => ({ ok: false as const, error });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const REF = /^refs\/heads\/[^\0\s]{1,240}$/;
/** A branch name as `base`: no ref prefix, no whitespace or control characters, no `..`. */
const BRANCH = /^(?!-)(?!.*\.\.)[^\0-\x20\x7f~^:?*[\\]{1,240}$/;

function requestIdOf(o: Record<string, unknown>): string | null {
  return typeof o.requestId === 'string' && GIT_WRITE_REQUEST_ID.test(o.requestId) ? o.requestId.toLowerCase() : null;
}

/** A preview body is `{}`: the daemon derives everything from the session. */
export function parsePreviewBody(body: unknown): GitWriteParse<Record<string, never>> {
  return isObject(body) && Object.keys(body).length === 0 ? { ok: true, value: {} } : bad();
}

export function parsePushExecute(body: unknown): GitWriteParse<PushExecuteBody> {
  if (!isObject(body) || !onlyKeys(body, ['requestId', 'confirmToken', 'expectedHead', 'expectedRef'])) return bad();
  const requestId = requestIdOf(body);
  if (!requestId || typeof body.confirmToken !== 'string' || !TOKEN.test(body.confirmToken)) return bad();
  if (typeof body.expectedHead !== 'string' || !GIT_WRITE_OID.test(body.expectedHead)) return bad();
  if (typeof body.expectedRef !== 'string' || !REF.test(body.expectedRef)) return bad();
  return { ok: true, value: { requestId, confirmToken: body.confirmToken, expectedHead: body.expectedHead, expectedRef: body.expectedRef } };
}

export function parsePrCreateExecute(body: unknown): GitWriteParse<PrCreateExecuteBody> {
  if (!isObject(body) || !onlyKeys(body, ['requestId', 'title', 'body', 'base', 'draft'])) return bad();
  const requestId = requestIdOf(body);
  if (!requestId) return bad();
  const { title, body: text, base, draft } = body;
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > GIT_WRITE_PR_TITLE_MAX || /[\0\r\n]/.test(title)) {
    return bad('invalid-pr-title');
  }
  if (typeof text !== 'string' || text.includes('\0') || new TextEncoder().encode(text).length > GIT_WRITE_PR_BODY_MAX_BYTES) return bad();
  if (base !== undefined && (typeof base !== 'string' || !BRANCH.test(base) || base.endsWith('/') || base.endsWith('.lock'))) {
    return bad('invalid-base');
  }
  if (draft !== undefined && typeof draft !== 'boolean') return bad();
  return {
    ok: true,
    value: { requestId, title, body: text, ...(base !== undefined ? { base } : {}), ...(draft !== undefined ? { draft } : {}) },
  };
}

export function parsePrMergeExecute(body: unknown): GitWriteParse<PrMergeExecuteBody> {
  if (!isObject(body) || !onlyKeys(body, ['requestId', 'confirmToken', 'expectHead', 'method', 'subject', 'body'])) return bad();
  const requestId = requestIdOf(body);
  if (!requestId || typeof body.confirmToken !== 'string' || !TOKEN.test(body.confirmToken)) return bad();
  if (typeof body.expectHead !== 'string' || !GIT_WRITE_OID.test(body.expectHead)) return bad();
  if (typeof body.method !== 'string') return bad();
  if (!(GIT_WRITE_MERGE_METHODS as readonly string[]).includes(body.method)) return bad('merge-method-unsupported');
  const { subject, body: text } = body;
  if (typeof subject !== 'string' || subject.length > GIT_WRITE_PR_TITLE_MAX || /[\0\r\n]/.test(subject)) return bad();
  if (typeof text !== 'string' || text.includes('\0') || new TextEncoder().encode(text).length > GIT_WRITE_PR_BODY_MAX_BYTES) return bad();
  return { ok: true, value: { requestId, confirmToken: body.confirmToken, expectHead: body.expectHead, method: 'squash', subject, body: text } };
}

/** A PR number from the path: a positive integer without sign, padding or exponent. */
export function parsePrNumber(raw: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// ── Fingerprint ──────────────────────────────────────────────────────────────

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * The text an execute's fingerprint is taken over: the action, the PR number
 * and the parsed body WITHOUT `confirmToken`, keys sorted. A resend after the
 * token was consumed carries the same spent token, and must still match.
 */
export function gitWriteFingerprintSource(action: PhoneGitWriteAction, body: object, number?: number): string {
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete rest.confirmToken;
  return canonical({ action, number: number ?? null, body: rest });
}
