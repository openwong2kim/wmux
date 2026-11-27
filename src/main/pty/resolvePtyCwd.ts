import fs from 'node:fs';
import { isLinuxCwd, isWslShell } from '../../shared/wsl';
import path from 'node:path';
import type { DeadPaneRecovery } from '../../shared/ptyRecovery';

export type PtyCwdSource = 'requested' | 'recovery-spawnCwd' | 'recovery-cwd' | 'recovery-home';

export interface ResolvedPtyCwd {
  incomingCwd?: string;
  safeCwd?: string;
  source: PtyCwdSource;
  /**
   * #3443 — the folder this create wanted that no longer exists, set only
   * when no folder validated and the pane starts in home instead. A UNC path
   * or a file is dropped too, but is not "gone", so it is not named here.
   */
  missingCwd?: string;
}

/** Validate and resolve a renderer-provided cwd. Returns undefined if invalid. */
export function validatePtyCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const resolved = path.resolve(cwd);
  // Block UNC paths (e.g. \\server\share).
  if (resolved.startsWith('\\\\')) return undefined;
  try {
    if (!fs.statSync(resolved).isDirectory()) return undefined;
  } catch {
    // Missing, inaccessible, or removed between resolution and stat: let the
    // caller continue to the next recovery candidate or home fallback.
    return undefined;
  }
  return resolved;
}

/** Whether `cwd` names a folder that no longer exists (nothing at that path). */
export function isMissingFolder(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const resolved = path.resolve(cwd);
  if (resolved.startsWith('\\\\')) return false;
  try {
    fs.statSync(resolved);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

export function validatePtyCwdForShell(cwd: string | undefined, shell?: string): string | undefined {
  if (isWslShell(shell) && isLinuxCwd(cwd)) return cwd;
  return validatePtyCwd(cwd);
}

/**
 * Resolve create-time cwd without letting renderer metadata become authority.
 * A known dead-session replacement tries its last live cwd (the daemon's
 * shell-tracked `cwd`), then the persisted spawnCwd; when neither validates,
 * the caller deliberately falls back to home. Ordinary creates retain their
 * existing single-cwd behavior.
 *
 * #1941 — live first, the order every daemon recovery path and the WSL branch
 * below already use. #762 (issue #650) tried spawnCwd first, so a tombstoned
 * pane came back where it was spawned rather than where its shell was, and
 * the Resume pill's cwd-scoped `--continue` ran in that folder. A pane whose
 * shell never reported a cwd still has `cwd === spawnCwd`, so it is unchanged.
 */
export function resolvePtyCreateCwd(
  requestedCwd: string | undefined,
  recovery: Pick<DeadPaneRecovery, 'spawnCwd' | 'cwd'> | undefined,
  validate: (cwd: string | undefined) => string | undefined = validatePtyCwd,
  missing: (cwd: string | undefined) => boolean = isMissingFolder,
): ResolvedPtyCwd {
  if (recovery !== undefined) {
    const liveCwd = validate(recovery.cwd);
    if (liveCwd) {
      return { incomingCwd: recovery.cwd, safeCwd: liveCwd, source: 'recovery-cwd' };
    }

    const spawnCwd = validate(recovery.spawnCwd);
    if (spawnCwd) {
      return { incomingCwd: recovery.spawnCwd, safeCwd: spawnCwd, source: 'recovery-spawnCwd' };
    }

    // The live folder is named first: it is where the pane last was.
    const missingCwd = [recovery.cwd, recovery.spawnCwd].find((c) => missing(c));
    return {
      incomingCwd: recovery.spawnCwd ?? recovery.cwd,
      source: 'recovery-home',
      ...(missingCwd ? { missingCwd } : {}),
    };
  }

  const safeCwd = validate(requestedCwd);
  return {
    incomingCwd: requestedCwd,
    safeCwd,
    source: 'requested',
    ...(!safeCwd && requestedCwd && missing(requestedCwd) ? { missingCwd: requestedCwd } : {}),
  };
}

/** WSL recovery uses the last Linux cwd; legacy spawnCwd may be Windows home. */
export function resolvePtyCreateCwdForShell(
  requestedCwd: string | undefined,
  recovery: Pick<DeadPaneRecovery, 'spawnCwd' | 'cwd'> | undefined,
  shell?: string,
): ResolvedPtyCwd {
  if (isWslShell(shell) && recovery !== undefined) {
    if (isLinuxCwd(recovery.cwd)) {
      return { incomingCwd: recovery.cwd, safeCwd: recovery.cwd, source: 'recovery-cwd' };
    }
    if (isLinuxCwd(recovery.spawnCwd)) {
      return { incomingCwd: recovery.spawnCwd, safeCwd: recovery.spawnCwd, source: 'recovery-spawnCwd' };
    }
  }
  return resolvePtyCreateCwd(requestedCwd, recovery, (cwd) => validatePtyCwdForShell(cwd, shell));
}
