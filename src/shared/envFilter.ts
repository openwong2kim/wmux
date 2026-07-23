/**
 * Filter that builds env for child processes (PTY shell, daemon spawn shell, etc.).
 *
 * env intervention splits into two classes (execution-context policy, see spawnKind):
 *
 *   INTERNAL — wmux/Electron/build-tooling internal variables. Stripped **always**,
 *     whether human shell or agent. (ELECTRON_*, VITE_*, WMUX_AUTH*, ORIGINAL_XDG_*,
 *     NODE_OPTIONS, ELECTRON_RUN_AS_NODE) — blocks Electron detection leak, RPC token
 *     exfiltration, and re-entry via custom flags.
 *
 *   CREDENTIAL — credential names (`*_TOKEN`/`*_SECRET`/`*_PASSWORD`/`*_CREDENTIALS`/
 *     `*_KEY` + well-known exact names). Stripped only on **gated (agent/automation)**
 *     spawns; passthrough on user-opened shells — same as other terminals.
 *
 * SAFE_PASSTHROUGH are names that match credential patterns but hold socket paths /
 * terminal capability flags, not secrets (SSH_AUTH_SOCK, COLORTERM).
 *
 * Both spawn paths (main PTYManager · daemon DaemonSessionManager) share this module so
 * hardening evolves in lockstep. Policy choice (which builder) is resolveSpawnEnv via
 * spawnKind.
 */

// ── INTERNAL: always strip ──────────────────────────────────────────────────
const INTERNAL_PATTERNS: ReadonlyArray<RegExp> = [
  /^ELECTRON_/,
  /^VITE_/,
  /^WMUX_AUTH/,     // daemon RPC token
  /^ORIGINAL_XDG_/, // Electron-injected XDG override
];

const INTERNAL_EXACT: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
]);

// ── CREDENTIAL: strip on gated spawns only ───────────────────────────────────
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /_TOKEN$/,        // GITHUB_TOKEN, NPM_TOKEN, …
  /_SECRET$/,       // *_CLIENT_SECRET, …
  /_PASSWORD$/,
  /_CREDENTIALS$/,
  /_KEY$/,          // ANTHROPIC_API_KEY, OPENAI_API_KEY, …
];

const CREDENTIAL_EXACT: ReadonlySet<string> = new Set([
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',  // ends in _ID, not _KEY$ (AWS credential)
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'DOCKER_PASSWORD',
  // Well-known secrets without a leading underscore (3-model review). Widening to
  // `/PASSWORD$/` would false-positive non-credential keys like ENABLE_PASSWORD, so
  // add by exact name only.
  'PGPASSWORD',
  'MYSQL_PWD',
  'SECRET_KEY_BASE',
  'LDAPPASSWORD',
  // Connection strings embedding credentials in URL/URI (same class as DATABASE_URL)
  'DATABASE_URL',
  'REDIS_URL',
  'MONGO_URL',
  'MONGODB_URI',
]);

const SAFE_PASSTHROUGH: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',      // SSH agent socket path — not a secret
  'COLORTERM',          // terminal capability hint
]);

/**
 * wmux/Electron/build internal variable — strip target under both policies.
 * Matching is case-insensitive (uppercase keys) — blocks lowercase bypass.
 */
export function isInternalEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  if (INTERNAL_EXACT.has(k)) return true;
  return INTERNAL_PATTERNS.some((re) => re.test(k));
}

/**
 * Credential name — strip target on gated (agent/automation) spawns only.
 * SAFE_PASSTHROUGH passes even when name matches a pattern. Case-insensitive.
 */
export function isCredentialEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  if (SAFE_PASSTHROUGH.has(k)) return false;
  if (CREDENTIAL_EXACT.has(k)) return true;
  return CREDENTIAL_PATTERNS.some((re) => re.test(k));
}

/**
 * Key that must not inherit into child processes (INTERNAL ∪ CREDENTIAL).
 * Strip predicate for gated policy; backward-compat predicate (existing callers·
 * workspaceProfile dropSecretKeys depend on this meaning). Exposed for tests.
 */
export function isSensitiveEnvKey(key: string): boolean {
  return isInternalEnvKey(key) || isCredentialEnvKey(key);
}

/** Fresh copy of baseEnv minus keys where `drop(key)` is true and undefined values. */
function buildFilteredEnv(
  baseEnv: NodeJS.ProcessEnv,
  drop: (key: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (drop(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Env for human-opened interactive shell: strip wmux/Electron internals only;
 * **passthrough** credentials (same as tmux/Windows Terminal). Reported incident —
 * Claude Code/MCP run manually in the user's shell replaced `${KAD_GATEWAY_KEY}` with
 * empty values — this builder does not strip credentials, so that problem goes away.
 */
export function buildInteractiveShellEnv(
  baseEnv: NodeJS.ProcessEnv = globalThis.process.env,
): Record<string, string> {
  return buildFilteredEnv(baseEnv, isInternalEnvKey);
}

/**
 * Env for agent/automation spawn: strip internals + credentials. Blocks ambient
 * credential leak into arbitrary code in semi-trusted agent panes wmux spawns autonomously.
 */
export function buildGatedAutomationEnv(
  baseEnv: NodeJS.ProcessEnv = globalThis.process.env,
): Record<string, string> {
  return buildFilteredEnv(baseEnv, isSensitiveEnvKey);
}

/**
 * Backward-compat alias — existing callers (resolveSpawnEnv fallback, DaemonSessionManager
 * process.env fallback) expect gated behavior under this name. Matches fail-closed default:
 * unspecified policy falls through to gated.
 */
export const buildSafeChildEnv = buildGatedAutomationEnv;

/**
 * Credential **names** removed on gated spawn (not values — observability/diagnostics).
 * Excludes INTERNAL keys: reporting unexpected wmux internals as "withheld credentials"
 * is noise. Signal to finish "why is it missing?" within 5 minutes.
 */
export function withheldCredentialNames(
  baseEnv: NodeJS.ProcessEnv = globalThis.process.env,
): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!isInternalEnvKey(key) && isCredentialEnvKey(key)) names.push(key);
  }
  return names;
}

/**
 * **Fresh** env copy with credential *values* removed — used at disk/RPC serialization
 * boundaries (sessions.json persistence, daemon.listSessions/createSession responses).
 * Does not touch INTERNAL keys (handled at spawn); removes credential names only;
 * preserves non-credential env (PATH·LANG·WMUX_* identity).
 *
 * Returns empty object when env is missing or not an object — legacy/corrupt sessions.json
 * scrub must be total·non-throwing so sessions are not lost.
 *
 * **Must replace with the return value.** Does not mutate input in place; callers must
 * `{ ...s, env: stripCredentialValues(s.env) }`. listSessions passes env that is the same
 * reference as live in-memory meta.env — in-place delete breaks spawn.
 */
export function stripCredentialValues(
  env: Record<string, string> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== 'object') return out;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isCredentialEnvKey(key)) continue;
    out[key] = value as string;
  }
  return out;
}
