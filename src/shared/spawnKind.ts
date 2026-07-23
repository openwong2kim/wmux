/**
 * Pane spawn origin classification — input to env policy.
 *
 *  'user-shell' : user-opened interactive shell via UI (env passthrough — same as other terminals).
 *  'agent'      : wmux-autonomous agent pane spawn (credential gate).
 *  'exec'       : supervised exec leaf — command runs as pane root process (credential gate).
 *
 * Shared by renderer (PtyCreateOptions) and main (pty.handler / PTYManager), so it lives
 * in a pure type module separate from envFilter which owns the env builders.
 */
export type SpawnKind = 'user-shell' | 'agent' | 'exec';

/** Env policy result. passthrough = human shell; gated = agent/automation (strip credentials). */
export type EnvPolicy = 'passthrough' | 'gated';

/**
 * Execution context → env policy. **fail-CLOSED** rules:
 *
 *   1. exec/supervision always gated (overrides stamp). Supervised exec leaf is
 *      wmux-driven automation by definition, so gate even with a wrong user-shell stamp.
 *   2. Explicit 'user-shell' only → passthrough.
 *   3. Everything else (unstamped · 'agent' · unknown) → gated.
 *
 * If a new spawn path omits its stamp, failure blocks credentials rather than leaking them —
 * i.e. misclassification defaults to "gate", not "human shell".
 */
export function resolveEnvPolicy(opts: {
  spawnKind?: SpawnKind;
  hasExec?: boolean;
  hasSupervision?: boolean;
}): EnvPolicy {
  if (opts.hasExec || opts.hasSupervision) return 'gated';
  if (opts.spawnKind === 'user-shell') return 'passthrough';
  return 'gated';
}
