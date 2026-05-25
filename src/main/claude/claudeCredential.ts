// Cross-platform reader for the Claude Code OAuth credential.
//
// JS port of `openwong2kim/claude-token-check`'s TokenStore.swift, with
// added Windows + Linux branches. The whole module is **read-only**: we
// never write the credential back to disk, never log its contents, and
// never send the token anywhere except the Anthropic API (handled in
// UsageApi.ts).
//
// Storage by platform:
//
//   macOS   — Keychain (Generic password, service "Claude Code-credentials",
//             account == current user). Read via `security` CLI shell-out.
//   Windows — `%USERPROFILE%\.claude\.credentials.json` plain JSON file.
//             Confirmed shape on user's machine 2026-05-24:
//             { claudeAiOauth: { accessToken, refreshToken, expiresAt,
//                                scopes, rateLimitTier, subscriptionType } }
//   Linux   — Try `~/.claude/.credentials.json` first (same shape as
//             Windows). libsecret integration is a follow-up if demand
//             surfaces. No silent fallback to env vars — we want explicit
//             "token not found" rather than picking up an ambient credential.
//
// Subscription tier comes from the credential metadata directly
// (subscriptionType), so we never have to infer Pro/Max/Team from the
// API rate-limit values.

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/** Result returned by loadClaudeCredential. Token-bearing fields are
 *  intentionally NOT included in any string representation; callers
 *  should pull just what they need and pass the access token to
 *  UsageApi without ever stringifying this whole object into a log. */
export interface ClaudeCredential {
  accessToken: string;
  /** Subscription tier as reported by Claude Code (e.g. "pro", "max",
   *  "team", "free"). Free-form string — we surface it as-is to the UI
   *  but do not match it against an enum, so Anthropic adding new tiers
   *  doesn't break us. */
  subscriptionType: string | null;
  /** Per-tier descriptor from Anthropic. Currently informational only. */
  rateLimitTier: string | null;
  /** Token expiry, milliseconds since Unix epoch. null when unknown
   *  (raw-token storage form has no expiry metadata). */
  expiresAtMs: number | null;
}

export type LoadResult =
  | { ok: true; credential: ClaudeCredential }
  | { ok: false; reason: 'not-found' | 'unsupported-platform' | 'read-error'; detail?: string };

/**
 * Read the active Claude Code OAuth credential for the current user.
 *
 * Returns `{ok: false}` (NOT a thrown error) for the common "not logged
 * in" case so callers can switch on `reason` without try/catch. Network
 * / OS-API errors still resolve to `{ok: false, reason: 'read-error'}`
 * with the underlying message tucked in `detail` — useful for logging
 * the FAILURE but never the credential itself.
 */
export async function loadClaudeCredential(): Promise<LoadResult> {
  try {
    if (process.platform === 'darwin') {
      return await loadFromMacKeychain();
    }
    if (process.platform === 'win32') {
      return await loadFromWindowsJson();
    }
    if (process.platform === 'linux') {
      // Linux Claude Code stores credentials in the same json shape as
      // Windows when launched outside a keyring. libsecret support is a
      // follow-up — explicit miss rather than silent fallback.
      return await loadFromWindowsJson();
    }
    return { ok: false, reason: 'unsupported-platform' };
  } catch (err) {
    // Whatever upstream threw, sanitize: keep the error class + message,
    // strip anything that looks like it could be a token. Defense in
    // depth — the loaders below should already filter, but a Node
    // error propagating from low-level fs could in theory carry path
    // strings that contain user info.
    const detail = sanitizeError(err);
    return { ok: false, reason: 'read-error', detail };
  }
}

async function loadFromMacKeychain(): Promise<LoadResult> {
  // `security find-generic-password -s "Claude Code-credentials" -a <user> -w`
  // prints the secret as the entire stdout (no extra formatting). exit
  // code 44 ("specified item not found") means "user hasn't logged into
  // Claude Code yet" — distinct from any other failure.
  //
  // 5s timeout (Codex review 2026-05-24 P2 #4): a hung Keychain prompt
  // (e.g. corrupted keychain, hostile child of `security`, or user
  // interactively denying access in a system prompt) would otherwise
  // wedge UsagePoller's `inflight` flag forever and silently disable
  // the meter. Better to surface a one-time timeout to the UI than
  // freeze the entire feature.
  const username = os.userInfo().username;
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-a',
      username,
      '-w',
    ], { timeout: 5_000 });
    const token = extractAccessToken(stdout);
    if (!token) return { ok: false, reason: 'not-found' };
    // macOS Keychain stores only the secret — there's no companion
    // metadata for expiry/tier. Best effort: read the same blob as JSON
    // and pull metadata if the blob is the JSON shape (token-check
    // confirms both raw and JSON forms exist in the wild).
    return {
      ok: true,
      credential: buildCredentialFromBlob(token, stdout),
    };
  } catch (err) {
    if (isItemNotFoundError(err)) {
      return { ok: false, reason: 'not-found' };
    }
    throw err;
  }
}

async function loadFromWindowsJson(): Promise<LoadResult> {
  const credentialPath = path.join(os.homedir(), '.claude', '.credentials.json');
  let raw: string;
  try {
    raw = await readFile(credentialPath, 'utf8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { ok: false, reason: 'not-found' };
    }
    throw err;
  }
  const token = extractAccessToken(raw);
  if (!token) return { ok: false, reason: 'not-found' };
  return {
    ok: true,
    credential: buildCredentialFromBlob(token, raw),
  };
}

/**
 * Pull the access token out of a Keychain/JSON blob. Mirrors the Swift
 * TokenStore.extractAccessToken behavior so platforms agree:
 *  1. Try `json.accessToken` directly.
 *  2. Try `json[*].accessToken` (matches the `{claudeAiOauth: {accessToken}}` shape).
 *  3. Fall back to the regex for a raw token blob (≥20 url-safe chars).
 *
 * Exported for unit testing.
 */
export function extractAccessToken(blob: string): string | null {
  const trimmed = blob.trim();
  if (!trimmed) return null;

  // Form 1+2: JSON.
  try {
    const json = JSON.parse(trimmed) as unknown;
    if (json && typeof json === 'object') {
      const direct = (json as Record<string, unknown>)['accessToken'];
      if (typeof direct === 'string' && direct.length > 0) return direct;
      // Nested one level deep — token-check's `claudeAiOauth.accessToken`.
      for (const value of Object.values(json as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
          const nested = (value as Record<string, unknown>)['accessToken'];
          if (typeof nested === 'string' && nested.length > 0) return nested;
        }
      }
    }
  } catch {
    // Not JSON — fall through to raw-token regex.
  }

  // Form 3: raw token blob.
  if (/^[A-Za-z0-9_\-.~+/=]{20,}$/.test(trimmed)) return trimmed;

  return null;
}

/** Extract the surrounding metadata block from a JSON-form blob, if
 *  present. Returns nulls when the blob is a raw token. Exported for
 *  unit tests. */
export function extractCredentialMetadata(blob: string): {
  subscriptionType: string | null;
  rateLimitTier: string | null;
  expiresAtMs: number | null;
} {
  const empty = { subscriptionType: null, rateLimitTier: null, expiresAtMs: null };
  const trimmed = blob.trim();
  if (!trimmed) return empty;
  try {
    const json = JSON.parse(trimmed) as unknown;
    if (!json || typeof json !== 'object') return empty;
    const top = json as Record<string, unknown>;
    // The credential schema observed on Windows nests one level deep
    // under `claudeAiOauth`. We also look at the top level so a future
    // schema flattening doesn't break us silently.
    for (const candidate of [top, ...Object.values(top).filter(isPlainObject)]) {
      const c = candidate as Record<string, unknown>;
      const subscriptionType = pickString(c, 'subscriptionType');
      const rateLimitTier = pickString(c, 'rateLimitTier');
      const expiresAtRaw = c['expiresAt'];
      const expiresAtMs =
        typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw) ? expiresAtRaw : null;
      if (subscriptionType || rateLimitTier || expiresAtMs !== null) {
        return { subscriptionType, rateLimitTier, expiresAtMs };
      }
    }
  } catch {
    /* not JSON */
  }
  return empty;
}

function buildCredentialFromBlob(accessToken: string, blob: string): ClaudeCredential {
  const { subscriptionType, rateLimitTier, expiresAtMs } = extractCredentialMetadata(blob);
  return { accessToken, subscriptionType, rateLimitTier, expiresAtMs };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isItemNotFoundError(err: unknown): boolean {
  // `security` exits 44 with stderr "could not be found" when the
  // service+account doesn't exist. node child_process attaches stderr
  // and code on the thrown ExecFileException.
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; stderr?: unknown };
  if (typeof e.code === 'number' && e.code === 44) return true;
  if (typeof e.stderr === 'string' && /could not be found/i.test(e.stderr)) return true;
  return false;
}

function isFileNotFoundError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT';
}

function sanitizeError(err: unknown): string {
  // Defensive: never include anything that could plausibly be a token in
  // the returned detail string. We accept the readable error class +
  // numeric error code, and drop the message entirely if it's long
  // enough to potentially carry a secret. Real errors here are file
  // permission / missing binary / etc — they fit in < 200 chars.
  if (!err || typeof err !== 'object') return 'unknown error';
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof e.name === 'string' ? e.name : 'Error';
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : '';
  const message = typeof e.message === 'string' && e.message.length < 200 ? e.message : '';
  return [name, code, message].filter(Boolean).join(' ');
}
