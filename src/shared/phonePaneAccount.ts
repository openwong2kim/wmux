/**
 * Per-pane account choice and handoff lineage on `POST /api/sessions`
 * (docs/phone-client-contract.md, "Proposed: contract v-next", item 4).
 * Served: `WebTerminalServer` reads them (`src/daemon/phone/paneAccount.ts`).
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
export type PaneAccountParseError = 'invalid-account-id' | 'workspace-required' | 'invalid-handoff';

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/**
 * Every `Object.prototype` member name (plus `prototype`) is refused as an id,
 * so no consumer that indexes a plain object by one of these ids can hit a
 * prototype member. Serving code must still look ids up with a Map or an
 * own-property check; this is the second line, not the first.
 */
const RESERVED: ReadonlySet<string> = new Set([...Object.getOwnPropertyNames(Object.prototype), '__proto__', 'prototype']);
const idOk = (v: unknown, shape: RegExp): v is string => typeof v === 'string' && shape.test(v) && !RESERVED.has(v);

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
    if (!idOk(id, ACCOUNT_ID)) return { ok: false, error: 'invalid-account-id' };
    // The desktop resolves an account only for a named workspace; without one there is nothing to fall back from.
    if (typeof body.workspaceId !== 'string' || !body.workspaceId.trim()) return { ok: false, error: 'workspace-required' };
    value.accountId = id;
  }
  if (body.handoffFrom !== undefined) {
    const h = body.handoffFrom;
    if (!h || typeof h !== 'object' || Array.isArray(h)) return { ok: false, error: 'invalid-handoff' };
    const o = h as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== 'sessionId' && k !== 'agentSessionId')) return { ok: false, error: 'invalid-handoff' };
    if (!idOk(o.sessionId, SESSION_ID)) return { ok: false, error: 'invalid-handoff' };
    if (o.agentSessionId !== undefined && !idOk(o.agentSessionId, AGENT_SESSION_ID)) {
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
 * Desktop bridge command `accounts.envForAccount`: `{workspaceId, accountId}` →
 * `{ok:true, vendor, env:{CLAUDE_CONFIG_DIR}|{CODEX_HOME}}` or `{ok:false, error}`.
 * Handled in `src/main/phone/PhoneAccounts.ts`.
 *
 * Capability handshake: the daemon advertises `paneAccount` only after the
 * attached desktop announced this command (`DESKTOP_ACCOUNT_ENV_COMMAND` in
 * its supported-command list) on the current connection. Any failure of the
 * command refuses the create; the daemon never falls back to the workspace's
 * account environment once an `accountId` was sent.
 */
export const DESKTOP_ACCOUNT_ENV_COMMAND = 'accounts.envForAccount';
export interface AccountEnvForAccountRequest { workspaceId: string; accountId: string }
export type AccountEnvForAccountResult =
  | { ok: true; vendor: PaneAccountVendor; env: Partial<Record<'CLAUDE_CONFIG_DIR' | 'CODEX_HOME', string>> }
  | { ok: false; error: 'unknown-account' | 'account-directory-missing' };
