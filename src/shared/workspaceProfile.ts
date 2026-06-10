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
  WORKSPACE_PROFILE_STARTUP_CWD_MAX,
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
 * Credential-NAMED keys whose value is a PATH/reference, not a secret — the
 * "reference over secret" pattern we actively encourage. These match the
 * inherited-env denylist by name but must NOT be treated as raw secrets by the
 * profile policy (dropping them would break documented cloud/SSH use cases).
 * Compared case-insensitively.
 */
const SECRET_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  'GOOGLE_APPLICATION_CREDENTIALS', // path to a service-account JSON
  'AWS_SHARED_CREDENTIALS_FILE',    // path to an AWS credentials file
]);

/**
 * True when `key` looks like a raw credential (e.g. *_KEY, *_TOKEN, *_SECRET)
 * AND is not a known path-pointer (SECRET_KEY_ALLOWLIST).
 *
 * Profiles are stored in plaintext in the session file, so by policy we do NOT
 * accept secret-NAMED env vars from the editor — the supported pattern is to
 * point at a config directory/file (CLAUDE_CONFIG_DIR, CODEX_HOME,
 * GOOGLE_APPLICATION_CREDENTIALS) that holds the real credential, not to paste
 * the credential itself. Case-insensitive (env names are conventionally
 * uppercase, but a user might type `openai_api_key`), reusing the inherited-env
 * denylist so the two stay in lockstep.
 */
export function isSecretLikeEnvKey(key: string): boolean {
  if (SECRET_KEY_ALLOWLIST.has(key.toUpperCase())) return false;
  return isSensitiveEnvKey(key.toUpperCase());
}

/**
 * Normalize an arbitrary value into a clean env map. Invalid keys/values are
 * dropped; the result is capped at WORKSPACE_PROFILE_MAX_ENV_ENTRIES, keeping
 * the first valid entries in insertion order.
 *
 * `dropSecretKeys` enforces the secret-name policy. It is applied only at the
 * editor/save boundary (setWorkspaceProfile), NOT on load: load-time
 * sanitization must be non-destructive so an existing session.json that
 * predates this policy keeps working until the user actively edits it (the
 * editor then flags the key and drops it on save). Dropping on load would
 * silently delete a user's working config without un-storing the already-
 * persisted value.
 */
export function normalizeEnv(input: unknown, dropSecretKeys = false): Record<string, string> {
  const out: Record<string, string> = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out;
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (count >= WORKSPACE_PROFILE_MAX_ENV_ENTRIES) break;
    if (!isValidEnvKey(rawKey)) continue;
    if (dropSecretKeys && isSecretLikeEnvKey(rawKey)) continue;
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
 * Normalize a startup directory (issue #175): trim, drop when empty or
 * over-long. No existence check here — paths may live on currently-detached
 * drives; the spawn layer's validateCwd tolerantly falls back to homedir.
 */
export function normalizeStartupCwd(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > WORKSPACE_PROFILE_STARTUP_CWD_MAX) return undefined;
  return trimmed;
}

/**
 * Build a clean WorkspaceProfile from untrusted input, or `undefined` when the
 * result would be empty. `env` is omitted when it has no valid entries so an
 * empty profile never persists as `{ env: {} }`.
 */
export function normalizeWorkspaceProfile(
  input: unknown,
  opts: { dropSecretKeys?: boolean } = {},
): WorkspaceProfile | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const src = input as { env?: unknown; defaultPaneCommand?: unknown; startupCwd?: unknown };

  const env = normalizeEnv(src.env, opts.dropSecretKeys ?? false);
  const command = normalizeCommand(src.defaultPaneCommand);
  const startupCwd = normalizeStartupCwd(src.startupCwd);

  const profile: WorkspaceProfile = {};
  if (Object.keys(env).length > 0) profile.env = env;
  if (command !== undefined) profile.defaultPaneCommand = command;
  if (startupCwd !== undefined) profile.startupCwd = startupCwd;

  if (profile.env === undefined && profile.defaultPaneCommand === undefined && profile.startupCwd === undefined) {
    return undefined;
  }
  return profile;
}
