import path from 'node:path';
import type { DesktopPhoneBridge } from './DesktopPhoneBridge';
import {
  DESKTOP_ACCOUNT_ENV_COMMAND, PANE_ACCOUNT_ENV_KEY,
  type HandoffFrom, type PaneAccountVendor, type StoredHandoffFrom,
} from '../../shared/phonePaneAccount';

/** The account a new pane runs on, resolved by the desktop. Never sent to the phone. */
export interface ResolvedPaneAccount { vendor: PaneAccountVendor; dir: string }

/** A typed refusal: every one of them means nothing was created. */
export interface PaneAccountRefusal { status: number; body: { error: string; effect: 'none' } }

const refuse = (status: number, error: string): PaneAccountRefusal => ({ status, body: { error, effect: 'none' } });

/**
 * Ask the attached desktop which directory `accountId` names. Fails closed:
 * a desktop that did not announce the command, any bridge error, and any
 * answer that is not exactly one well-formed directory for the account's
 * vendor all refuse. The caller never falls back to the workspace binding.
 */
export async function resolvePaneAccount(
  desktop: Pick<DesktopPhoneBridge, 'available' | 'supports' | 'request'> | null,
  workspaceId: string,
  accountId: string,
): Promise<{ ok: true; account: ResolvedPaneAccount } | { ok: false; refusal: PaneAccountRefusal }> {
  const unavailable = { ok: false as const, refusal: refuse(503, 'desktop-unavailable') };
  if (!desktop?.available || !desktop.supports(DESKTOP_ACCOUNT_ENV_COMMAND)) return unavailable;
  let raw: unknown;
  try { raw = await desktop.request(DESKTOP_ACCOUNT_ENV_COMMAND, { workspaceId, accountId }); }
  catch { return unavailable; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable;
  const answer = raw as Record<string, unknown>;
  if (answer.ok === false) {
    // An unknown id and another host's id are the same answer: the phone learns only "not here".
    if (answer.error === 'unknown-account') return { ok: false, refusal: refuse(400, 'unknown-account') };
    if (answer.error === 'account-directory-missing') return { ok: false, refusal: refuse(409, 'account-directory-missing') };
    return unavailable;
  }
  if (answer.ok !== true || (answer.vendor !== 'claude' && answer.vendor !== 'codex')) return unavailable;
  const vendor = answer.vendor;
  const env = answer.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return unavailable;
  const keys = Object.keys(env);
  const dir = (env as Record<string, unknown>)[PANE_ACCOUNT_ENV_KEY[vendor]];
  if (keys.length !== 1 || typeof dir !== 'string' || !dir || dir.includes('\0') || !path.isAbsolute(dir)) return unavailable;
  return { ok: true, account: { vendor, dir } };
}

/**
 * Override ONLY the account's vendor key on an environment that already
 * carries the workspace binding; the other vendor's key is left as it was.
 */
export function applyPaneAccount<T extends Record<string, string | undefined>>(env: T, account: ResolvedPaneAccount): T {
  return { ...env, [PANE_ACCOUNT_ENV_KEY[account.vendor]]: account.dir };
}

/**
 * The lineage stored on the new pane. `verified` is true only when the source
 * pane is readable by this caller now and, when an `agentSessionId` was sent,
 * it equals the source's current conversation. A source the caller may not
 * read is stored exactly like a missing one. The conversation id is compared
 * only when the server serves transcripts, so a caller without that grant
 * cannot use `verified` to test guesses about it.
 */
export async function verifyHandoff(
  handoff: HandoffFrom,
  deps: {
    readable: (sessionId: string) => boolean;
    allowTranscript: boolean;
    currentConversation: (sessionId: string) => Promise<string | undefined>;
    now: () => number;
  },
): Promise<StoredHandoffFrom> {
  let verified = false;
  if (deps.readable(handoff.sessionId)) {
    if (handoff.agentSessionId === undefined) verified = true;
    else if (deps.allowTranscript) {
      verified = await deps.currentConversation(handoff.sessionId).then(id => id === handoff.agentSessionId, () => false);
    }
  }
  return { ...handoff, verified, at: deps.now() };
}

/** Accept a persisted lineage record only in its exact stored shape. */
export function storedHandoffOf(value: unknown): StoredHandoffFrom | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.sessionId)) return undefined;
  if (v.agentSessionId !== undefined && (typeof v.agentSessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(v.agentSessionId))) return undefined;
  if (typeof v.verified !== 'boolean' || typeof v.at !== 'number' || !Number.isFinite(v.at)) return undefined;
  return {
    sessionId: v.sessionId,
    ...(typeof v.agentSessionId === 'string' ? { agentSessionId: v.agentSessionId } : {}),
    verified: v.verified,
    at: v.at,
  };
}

/**
 * The row's view of the lineage. The conversation id rides the row only when
 * the server serves transcripts: rows reach every reader, and that id is
 * otherwise a transcript-gated value.
 */
export function handoffRowOf(value: unknown, allowTranscript: boolean): { handoffFrom?: StoredHandoffFrom } {
  const stored = storedHandoffOf(value);
  if (!stored) return {};
  if (allowTranscript) return { handoffFrom: stored };
  return { handoffFrom: { sessionId: stored.sessionId, verified: stored.verified, at: stored.at } };
}
