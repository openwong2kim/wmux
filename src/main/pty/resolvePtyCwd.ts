import fs from 'node:fs';
import path from 'node:path';
import type { DeadPaneRecovery } from '../../shared/ptyRecovery';

export type PtyCwdSource = 'requested' | 'recovery-spawnCwd' | 'recovery-cwd' | 'recovery-home';

export interface ResolvedPtyCwd {
  incomingCwd?: string;
  safeCwd?: string;
  source: PtyCwdSource;
}

/** Validate and resolve a renderer-provided cwd. Returns undefined if invalid. */
export function validatePtyCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const resolved = path.resolve(cwd);
  // Block UNC paths (e.g. \\server\share).
  if (resolved.startsWith('\\\\')) return undefined;
  if (!fs.existsSync(resolved)) return undefined;
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return undefined;
  return resolved;
}

/**
 * Resolve create-time cwd without letting renderer metadata become authority.
 * A known dead-session replacement tries persisted spawnCwd, then its last live
 * cwd; when neither validates, the caller deliberately falls back to home.
 * Ordinary creates retain their existing single-cwd behavior.
 */
export function resolvePtyCreateCwd(
  requestedCwd: string | undefined,
  recovery: Pick<DeadPaneRecovery, 'spawnCwd' | 'cwd'> | undefined,
  validate: (cwd: string | undefined) => string | undefined = validatePtyCwd,
): ResolvedPtyCwd {
  if (recovery !== undefined) {
    const spawnCwd = validate(recovery.spawnCwd);
    if (spawnCwd) {
      return { incomingCwd: recovery.spawnCwd, safeCwd: spawnCwd, source: 'recovery-spawnCwd' };
    }

    const liveCwd = validate(recovery.cwd);
    if (liveCwd) {
      return { incomingCwd: recovery.cwd, safeCwd: liveCwd, source: 'recovery-cwd' };
    }

    return {
      incomingCwd: recovery.spawnCwd ?? recovery.cwd,
      source: 'recovery-home',
    };
  }

  return {
    incomingCwd: requestedCwd,
    safeCwd: validate(requestedCwd),
    source: 'requested',
  };
}
