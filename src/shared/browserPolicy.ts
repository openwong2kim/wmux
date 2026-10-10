// Protected browser panes — the contract shared by main (store, gate, proxy),
// the MCP lane (authorization, refusals) and the renderer (A-ui editor).
//
// A pane opts in by turning protection on. A protected pane drives only its
// own exclusive Chrome profile, through main's filtering proxy, and only the
// hosts its policy allows. With no policy anywhere, nothing here runs and every
// browser path behaves exactly as before.
//
// One policy per pane, keyed by (workspaceId, paneId, profileId). A pane that
// moves to another workspace, or is rebound to another profile, keeps
// `protected` on but is deny-all until the operator re-confirms its hosts: the
// policy was approved for that pane in that place with that account, and none
// of the three may silently change under it.

import { DENY_ALL_HOST_POLICY, type HostPolicy } from './browserHostPolicy';

export const BROWSER_POLICY_VERSION = 2;
/** Versions a reader accepts. v1 is v2 without consent grants. */
export const BROWSER_POLICY_READABLE_VERSIONS: readonly number[] = [1, 2];
export const BROWSER_POLICY_FILE = 'browser-policy.json';
/** The independent "was ever protected" marker (see BrowserPolicyStore). */
export const BROWSER_POLICY_HISTORY_FILE = 'browser-policy-history.json';

/** One pane's policy as stored. */
export interface PanePolicy {
  workspaceId: string;
  paneId: string;
  /** The Chrome profile the policy was confirmed for. */
  profileId: string;
  protected: boolean;
  hosts: HostPolicy;
  /** Set when the pane was rebound or moved since the operator confirmed it:
   *  protection stays on and every host is refused until a fresh write. */
  needsConfirm?: boolean;
  /**
   * Standing consent the operator gave this pane ("Always on this pane").
   * Absent = none. Written only by the operator, dropped on a rebind or a move.
   */
  grants?: PaneConsentGrants;
}

/** What the operator allowed a protected pane to do without asking again. */
export interface PaneConsentGrants {
  /** Run agent-authored page scripts (browser_evaluate). */
  evaluate?: boolean;
  /** Let a download through (browser_download / browser_wait_for_download). */
  download?: boolean;
  /**
   * Sensitive hosts (email, banking, auth) whose cookies and storage the agent
   * may read and change, canonical host names. Per host: approving one never
   * opens another.
   */
  sensitiveHosts?: string[];
}

/** The dangerous actions a protected pane asks the operator about. */
export type BrowserConsentAction = 'evaluate' | 'download' | 'sensitive';

/** How long the operator has to answer a consent prompt. A timeout is a deny. */
export const BROWSER_CONSENT_DEADLINE_MS = 60_000;
/** The MCP lane's RPC timeout for a consent request: longer than the deadline,
 *  so main's answer (and never the transport) ends the wait. */
export const BROWSER_CONSENT_RPC_TIMEOUT_MS = BROWSER_CONSENT_DEADLINE_MS + 15_000;

export interface BrowserPolicyFile {
  version: number;
  /** Monotonic; bumped on every policy, profile-binding or backend change. */
  epoch: number;
  /** paneId → policy. */
  panes: Record<string, PanePolicy>;
}

/** What reading the primary file found. Never "created". */
export type BrowserPolicyFileState = 'missing' | 'ok' | 'corrupt' | 'unsupported-version';

/**
 * Error codes for refusals. Both are NON-RETRYABLE: the answer changes only
 * when the operator changes the pane's policy (or, for needs_consent, grants
 * it — PR B), so an agent that retries unchanged gets the same refusal.
 */
export const POLICY_DENIED_CODE = 'policy_denied';
export const NEEDS_CONSENT_CODE = 'needs_consent';
export type BrowserPolicyRefusalCode = typeof POLICY_DENIED_CODE | typeof NEEDS_CONSENT_CODE;

/** The message main throws: `<method>: policy_denied: <why>. Do not retry unchanged.` */
export function policyDeniedMessage(method: string, why: string): string {
  return `${method}: ${POLICY_DENIED_CODE}: ${why}. This pane's browser is protected; do not retry unchanged.`;
}

/**
 * The refusal code an error carries, or null. The code must be the message
 * PREFIX, optionally after one `<rpc.method>: ` segment — never a substring
 * elsewhere, so a page title quoted in some other error cannot forge it.
 */
const REFUSAL_PREFIX = new RegExp(
  `^(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*:[ \\t]+)?(${POLICY_DENIED_CODE}|${NEEDS_CONSENT_CODE}):`,
);

export function browserPolicyRefusalCode(error: unknown): BrowserPolicyRefusalCode | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === POLICY_DENIED_CODE || code === NEEDS_CONSENT_CODE) return code;
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = REFUSAL_PREFIX.exec(message);
  return match ? (match[1] as BrowserPolicyRefusalCode) : null;
}

/** Typed refusal for the MCP lane (and anything that must rethrow it). */
export class BrowserPolicyError extends Error {
  readonly code: BrowserPolicyRefusalCode;
  constructor(code: BrowserPolicyRefusalCode, message: string) {
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = 'BrowserPolicyError';
    this.code = code;
  }
}

/** The refusal as a typed error, or null when `error` is not one. */
export function browserPolicyRefusal(error: unknown): BrowserPolicyError | null {
  if (error instanceof BrowserPolicyError) return error;
  const code = browserPolicyRefusalCode(error);
  if (!code) return null;
  const message = error instanceof Error ? error.message : String(error);
  // Keep main's explanation but lead with the code.
  const body = message.replace(/^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*:[ \t]+)?/, '');
  return new BrowserPolicyError(code, body);
}

/**
 * What a pane's policy means right now. `legacy` = behave exactly as before.
 */
export type PanePolicyDecision =
  | { kind: 'legacy' }
  | { kind: 'denied'; why: string }
  | { kind: 'protected'; epoch: number; profileId: string; hosts: HostPolicy; confirmed: boolean };

/**
 * Resolve a stored entry against where the pane is now. Pure.
 *
 * `currentProfile` is the profile the pane resolves to today. A mismatch in
 * workspace or profile, or a pending confirmation, keeps protection on with
 * every host refused.
 */
export function resolvePanePolicy(
  entry: PanePolicy | undefined,
  where: { workspaceId: string; currentProfile: string | undefined },
  epoch: number,
): PanePolicyDecision {
  if (!entry || !entry.protected) return { kind: 'legacy' };
  const confirmed =
    entry.needsConfirm !== true
    && entry.workspaceId === where.workspaceId
    && where.currentProfile !== undefined
    && entry.profileId === where.currentProfile;
  return {
    kind: 'protected',
    epoch,
    profileId: where.currentProfile ?? entry.profileId,
    hosts: confirmed ? entry.hosts : { ...DENY_ALL_HOST_POLICY, allow: [], block: [] },
    confirmed,
  };
}

/**
 * The authorization main hands the MCP lane on every `browser.lease.acquire`
 * that asks for it (`authorize: true`). `protected: false` is the legacy
 * answer; the lane then behaves exactly as before.
 */
export interface BrowserPolicyAuthorization {
  protected: boolean;
  epoch?: number;
  hosts?: HostPolicy;
}

// ── IPC (renderer → main; A-ui uses these) ───────────────────────────────

export const BROWSER_POLICY_IPC = {
  /** payload `{ workspaceId, paneId }` → `BrowserPolicyReadResult`. */
  get: 'browser:policy:get',
  /** payload `BrowserPolicyWritePayload` → `BrowserPolicyWriteResult`. */
  set: 'browser:policy:set',
  /** payload `BrowserPolicyGrantsPayload` → `BrowserPolicyWriteResult`. */
  grants: 'browser:policy:grants',
} as const;

export interface BrowserPolicyReadResult {
  ok: boolean;
  error?: string;
  state?: BrowserPolicyFileState;
  epoch?: number;
  policy?: PanePolicy | null;
  /** The profile the pane resolves to now — what a write must confirm. */
  currentProfile?: string;
  /** What browser calls from this pane get right now (PanePolicyDecision). */
  decision?: PanePolicyDecision['kind'];
  /** With decision 'protected': false while the site list awaits re-confirmation. */
  confirmed?: boolean;
}

/** `browser:policy:set` reply. `code` is set on every failed write. */
export type BrowserPolicyWriteErrorCode = 'invalid' | 'stale' | 'not-exclusive' | 'io';
export interface BrowserPolicyWriteResult {
  ok: boolean;
  epoch?: number;
  error?: string;
  code?: BrowserPolicyWriteErrorCode;
}

export interface BrowserPolicyWritePayload {
  workspaceId: string;
  paneId: string;
  /** Must equal the pane's current exclusive profile. */
  profileId: string;
  protected: boolean;
  hosts: HostPolicy;
  /** The epoch the editor read; a stale one is refused. */
  expectedEpoch: number;
}

/** `browser:policy:grants` payload: the operator revokes standing consent. */
export interface BrowserPolicyGrantsPayload {
  workspaceId: string;
  paneId: string;
  /** Must equal the pane's current exclusive profile. */
  profileId: string;
  /** The grants after the edit (only revocation is offered in the editor). */
  grants: PaneConsentGrants;
  expectedEpoch: number;
}
