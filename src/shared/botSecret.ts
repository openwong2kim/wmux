// ─── Bot secrets and logins — values the owner types, names the bots see ───
//
// Contract for main/factory/secretStore.ts, the FanOutService grant, the
// pty:create stage, the secret / login modal and Settings › Bots keys list).
//
// A bot asks with `secret_request {name, label, why}` (BOT_SECRET_RPC): main
// posts a `secret_request` card (shared/room.ts) with [Enter], which opens a
// modal showing which bot asked and the exact env name; the bot's text is
// rendered as plain text. The value goes from the modal to main once
// (BOT_SECRET_IPC.set, main window only) and is stored in
// `<wmuxDir>/factory/secrets.json` (mode 0600) as Electron safeStorage
// ciphertext; main refuses to store when encryption is unavailable or the
// Linux backend is `basic_text`. A value never enters a prompt, a log, a
// room card, a fact, a handoff, the ledger or the renderer after submit.
//
// Bots see names only (`secret_list`). A bot hands named secrets to a worker
// it starts (fanout `secretNames[]`): main mints a single-use SecretGrantId
// that travels through the renderer's fan-out path; main's pty:create stage
// resolves it and injects the values just before the daemon create, in a
// separate in-memory field never merged into `meta.env`, sessions.json or a
// web path. Names are credential-shaped (isBotSecretName) so the existing
// env strips treat them as credentials too.
//
// `login_request {service}` posts a `login_request` card: GitHub and Claude
// open the existing flows (main/github/ghLogin.ts,
// main/claude/claudeCredential.ts) in the modal; a website opens a browser
// pane at its login page for the owner.

import { isCredentialEnvKey } from './envFilter';
import type { ThreadId } from './room';

export const BOT_SECRET_RPC = {
  /** `secret_request`: ask the owner to enter one named secret. */
  request: 'botSecret.request',
  /** `secret_list`: the names stored (no values), with whether each is set. */
  list: 'botSecret.list',
  /** `login_request`: ask the owner to log in to a service. */
  loginRequest: 'botLogin.request',
} as const;

/** Main-window IPC (operator only; the main window's top frame). */
export const BOT_SECRET_IPC = {
  /** Names with their use (never values). */
  list: 'factory:secret:list',
  /** Store one value from the modal ({name, value, requestCardId?}). */
  set: 'factory:secret:set',
  /** Delete one stored secret by name. */
  delete: 'factory:secret:delete',
  /** Open a login flow for a `login_request` card. */
  login: 'factory:login:open',
} as const;

export const BOT_SECRET_LIMITS = {
  NAME_MAX: 64,
  LABEL_MAX: 80,
  WHY_MAX: 500,
  VALUE_MAX: 16 * 1024,
  /** Shortest value stored: main redacts stored values from what bots and
   *  stores see by exact match, which a very short value would make
   *  meaningless. */
  VALUE_MIN: 8,
  /** Most secrets stored at once. */
  STORED_MAX: 64,
  /** Most names one fan-out may carry. */
  NAMES_PER_FANOUT: 16,
  /** A grant id unused for this long is void. */
  GRANT_TTL_MS: 5 * 60_000,
} as const;

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** An env-var name a secret may be stored and injected under: upper snake
 *  case, at most NAME_MAX long, and credential-shaped (shared/envFilter.ts
 *  isCredentialEnvKey), so every env strip that removes credentials removes
 *  it too. Pure. */
export function isBotSecretName(name: unknown): name is string {
  return typeof name === 'string' && SECRET_NAME_RE.test(name) && !name.startsWith('WMUX_') && isCredentialEnvKey(name);
}

/** The secret env a worker spawn carries to the daemon
 *  (DaemonCreateSessionParams.secretEnv), validated: a non-empty map of
 *  isBotSecretName keys to string values within BOT_SECRET_LIMITS. Null for
 *  anything else, so the daemon refuses the create instead of guessing.
 *  Pure. */
export function sanitizeSecretEnv(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > BOT_SECRET_LIMITS.NAMES_PER_FANOUT) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!isBotSecretName(k) || typeof v !== 'string') return null;
    if (v.length < BOT_SECRET_LIMITS.VALUE_MIN || v.length > BOT_SECRET_LIMITS.VALUE_MAX || v.includes('\0')) return null;
    out[k] = v;
  }
  return out;
}

/** `sg-` + 16..64 url-safe characters, minted by main for one worker spawn. */
export const SECRET_GRANT_ID_RE = /^sg-[A-Za-z0-9_-]{16,64}$/;

export type SecretGrantId = string;

/** `botSecret.request` params (bot). */
export interface SecretRequestParams {
  name: string;
  /** What the owner sees, e.g. "npm publish token". */
  label: string;
  /** Why the bot needs it (plain text on the card and in the modal). */
  why: string;
  threadId?: ThreadId;
  /** Idempotency key; default `wake:<wakeId>:s<n>` from the running wake. */
  clientRequestId?: string;
}

/** One stored secret as anything outside the store sees it. */
export interface BotSecretEntry {
  name: string;
  label?: string;
  /** The bot whose request created it, if any. */
  requestedBy?: string;
  /** Entered for a connection (shared/botConnector.ts). */
  connectorId?: string;
  /** The connections that use it (the owner's list only). */
  connections?: string[];
  createdAt: number;
  updatedAt: number;
  /** The last worker grant that carried it. */
  lastUsed?: { botId: string; at: number };
}

export type LoginService = 'github' | 'claude' | 'website';

/** `botLogin.request` params (bot). */
export interface LoginRequestParams {
  service: LoginService;
  /** website: the https login page to open. */
  url?: string;
  why: string;
  threadId?: ThreadId;
  clientRequestId?: string;
}
