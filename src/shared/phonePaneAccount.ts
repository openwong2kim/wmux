/**
 * Per-pane account choice and handoff lineage on `POST /api/sessions`
 * (docs/phone-client-contract.md, "Proposed: contract v-next", item 4).
 * CONTRACT ONLY: the route does not read these fields yet.
 *
 * The phone names an account by its desktop account id, never by a path. The
 * desktop resolves the id to its config directory; the workspace's own
 * account binding is not changed.
 */

export type PaneAccountVendor = 'claude' | 'codex';

export interface HandoffFrom {
  /** The pane the work is handed off from (`/api/sessions` id). */
  sessionId: string;
  /** The native conversation id in that pane (`chat.agentSessionId`). */
  agentSessionId?: string;
}

/** What the daemon stores on the new pane and exposes on its row and in history. */
export interface StoredHandoffFrom extends HandoffFrom {
  /**
   * True only when, at creation, the source pane was live and readable by the
   * caller and (when given) `agentSessionId` equalled its current
   * conversation. False is "not proven", never "false claim": the source may
   * simply have closed.
   */
  verified: boolean;
  /** Epoch ms of creation. */
  at: number;
}

export interface PaneAccountFields {
  accountId?: string;
  handoffFrom?: HandoffFrom;
}

/** 400 tags this parser produces. Resolution adds its own (see the doc). */
export type PaneAccountParseError = 'invalid-account-id' | 'invalid-handoff';

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Read `accountId` / `handoffFrom` off a create body. Absent fields stay
 * absent; a present but malformed one is refused, never ignored, because an
 * ignored `accountId` spawns on the wrong account.
 */
export function parsePaneAccountFields(body: Record<string, unknown>):
  { ok: true; value: PaneAccountFields } | { ok: false; error: PaneAccountParseError } {
  const value: PaneAccountFields = {};
  if (body.accountId !== undefined) {
    const id = body.accountId;
    if (typeof id !== 'string' || !ACCOUNT_ID.test(id) || RESERVED.has(id)) return { ok: false, error: 'invalid-account-id' };
    value.accountId = id;
  }
  if (body.handoffFrom !== undefined) {
    const h = body.handoffFrom;
    if (!h || typeof h !== 'object' || Array.isArray(h)) return { ok: false, error: 'invalid-handoff' };
    const o = h as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== 'sessionId' && k !== 'agentSessionId')) return { ok: false, error: 'invalid-handoff' };
    if (typeof o.sessionId !== 'string' || !SESSION_ID.test(o.sessionId)) return { ok: false, error: 'invalid-handoff' };
    if (o.agentSessionId !== undefined && (typeof o.agentSessionId !== 'string' || !AGENT_SESSION_ID.test(o.agentSessionId))) {
      return { ok: false, error: 'invalid-handoff' };
    }
    value.handoffFrom = { sessionId: o.sessionId, ...(typeof o.agentSessionId === 'string' ? { agentSessionId: o.agentSessionId } : {}) };
  }
  return { ok: true, value };
}

/**
 * The env keys an account overrides for its vendor. Only this key is replaced
 * on the new pane; the other vendor keeps the workspace binding.
 */
export const PANE_ACCOUNT_ENV_KEY: Readonly<Record<PaneAccountVendor, 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * Proposed desktop bridge command (`DesktopPhoneCommand` gains
 * `accounts.envForAccount`): `{workspaceId?, accountId}` →
 * `{vendor, env:{CLAUDE_CONFIG_DIR}|{CODEX_HOME}}` or an error tag. Type only.
 */
export interface AccountEnvForAccountRequest { workspaceId?: string; accountId: string }
export type AccountEnvForAccountResult =
  | { ok: true; vendor: PaneAccountVendor; env: Partial<Record<'CLAUDE_CONFIG_DIR' | 'CODEX_HOME', string>> }
  | { ok: false; error: 'unknown-account' | 'account-directory-missing' };
