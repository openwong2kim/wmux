/**
 * Validation + normalization for per-workspace process profiles.
 *
 * Shared by the renderer (UI editing + load-from-session sanitization) and is
 * pure (no Electron / DOM / Node deps) so it can be unit-tested in isolation.
 *
 * Design rules enforced here:
 *   - Env keys must look like real shell identifiers and stay within a length
 *     cap; entries are capped in count so a runaway session.json can't bloat.
 *   - Reserved `WMUX_*` keys are rejected so a profile can never spoof the
 *     wmux identity vars (WMUX_WORKSPACE_ID / WMUX_SURFACE_ID / WMUX_SOCKET_PATH)
 *     or re-introduce a stripped auth token (WMUX_AUTH*). The spawn layer ALSO
 *     forces identity last as defense-in-depth — this is the input-side guard
 *     that gives the user immediate feedback.
 *   - Values are strings only, length-capped.
 *   - The startup command is trimmed only for emptiness; its content is
 *     otherwise preserved verbatim.
 *
 * `normalizeWorkspaceProfile` is intentionally forgiving: fed untrusted input
 * (a hand-edited or cross-version session.json), it drops anything invalid and
 * returns `undefined` when nothing usable remains, rather than throwing.
 */

import {
  WORKSPACE_PROFILE_COMMAND_MAX,
  WORKSPACE_PROFILE_ENV_KEY_MAX,
  WORKSPACE_PROFILE_ENV_VALUE_MAX,
  WORKSPACE_PROFILE_MAX_ENV_ENTRIES,
  type WorkspaceProfile,
} from './types';
import { isSensitiveEnvKey } from './envFilter';

/** Reserved env-key prefix that a workspace profile may never set. */
export const RESERVED_ENV_KEY_PREFIX = 'WMUX_';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `key` is a syntactically valid, non-reserved env var name. */
export function isValidEnvKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > WORKSPACE_PROFILE_ENV_KEY_MAX) return false;
  if (isReservedEnvKey(key)) return false;
  return ENV_KEY_RE.test(key);
}

/** True when `key` collides with wmux's reserved identity/auth namespace. */
export function isReservedEnvKey(key: string): boolean {
  return key.toUpperCase().startsWith(RESERVED_ENV_KEY_PREFIX);
}

/**
 * True when `key` looks like a raw credential (e.g. *_KEY, *_TOKEN, *_SECRET).
 *
 * Profiles are stored in plaintext in the session file, so by policy we do NOT
 * persist secret-NAMED env vars — the supported pattern is to point at a config
 * directory (CLAUDE_CONFIG_DIR, CODEX_HOME) that holds the real credential,
 * not to paste the credential itself. `normalizeEnv` drops these keys, and the
 * editor flags them. Case-insensitive (env names are conventionally uppercase,
 * but a user might type `openai_api_key`), reusing the inherited-env denylist
 * so the two stay in lockstep.
 */
export function isSecretLikeEnvKey(key: string): boolean {
  return isSensitiveEnvKey(key.toUpperCase());
}

/**
 * Normalize an arbitrary value into a clean env map. Invalid keys/values are
 * dropped; the result is capped at WORKSPACE_PROFILE_MAX_ENV_ENTRIES, keeping
 * the first valid entries in insertion order.
 */
export function normalizeEnv(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out;
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (count >= WORKSPACE_PROFILE_MAX_ENV_ENTRIES) break;
    if (!isValidEnvKey(rawKey)) continue;
    // Policy: never persist a secret-NAMED key in plaintext (point at a config
    // directory instead). Dropped here so both UI-save and load-time sanitize
    // enforce it uniformly.
    if (isSecretLikeEnvKey(rawKey)) continue;
    if (typeof rawValue !== 'string') continue;
    if (rawValue.length > WORKSPACE_PROFILE_ENV_VALUE_MAX) continue;
    out[rawKey] = rawValue;
    count++;
  }
  return out;
}

/**
 * Apply a workspace profile env overlay onto a child-process env map, in place.
 *
 * Used by BOTH spawn paths (local PTYManager + daemon DaemonSessionManager).
 * Reserved `WMUX_*` keys are skipped here too — so even if validation were
 * bypassed (e.g. a hand-edited session.json), a profile can never overwrite
 * the wmux identity vars the spawn layer forces. Non-string values are ignored.
 */
export function applyProfileEnv(
  target: Record<string, string>,
  profileEnv: Record<string, string> | undefined,
): void {
  if (!profileEnv) return;
  for (const [key, value] of Object.entries(profileEnv)) {
    if (typeof value !== 'string') continue;
    if (isReservedEnvKey(key)) continue;
    target[key] = value;
  }
}

/** Normalize a startup command: trim for emptiness, cap length, preserve content. */
export function normalizeCommand(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  if (input.trim().length === 0) return undefined;
  if (input.length > WORKSPACE_PROFILE_COMMAND_MAX) return undefined;
  return input;
}

/**
 * Build a clean WorkspaceProfile from untrusted input, or `undefined` when the
 * result would be empty. `env` is omitted when it has no valid entries so an
 * empty profile never persists as `{ env: {} }`.
 */
export function normalizeWorkspaceProfile(input: unknown): WorkspaceProfile | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const src = input as { env?: unknown; defaultPaneCommand?: unknown };

  const env = normalizeEnv(src.env);
  const command = normalizeCommand(src.defaultPaneCommand);

  const profile: WorkspaceProfile = {};
  if (Object.keys(env).length > 0) profile.env = env;
  if (command !== undefined) profile.defaultPaneCommand = command;

  if (profile.env === undefined && profile.defaultPaneCommand === undefined) {
    return undefined;
  }
  return profile;
}
