// ─── Which git a guarded caller runs ──────────────────────────────────────
//
// A caller that runs git in a repository it does not trust (a bring-back
// import, a box making a bundle of an agent's worktree) runs only a git found
// by absolute path, never a bare name (started with its folder in that
// repository, a bare name may be looked up there first), and never one inside
// that repository.

import fs from 'node:fs';
import path from 'node:path';
import { findExecutable } from './exeSearch';

/** What a guarded caller says when no git it may run is found. */
export const GIT_NOT_FOUND_TEXT = 'git was not found on this PC';

/**
 * Git's absolute path, from the absolute folders of PATH only, or null. Never a bare name. Never throws.
 */
export function findAbsoluteGit(env: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') {
    const found = findExecutable('git', { env });
    return found && path.isAbsolute(found) ? found : null;
  }
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, 'git');
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      continue;
    }
  }
  return null;
}

/** Whether `file` (as it resolves) is under the folder `dir`. Never throws. */
export function isInsideFolder(dir: string, file: string): boolean {
  // path.relative compares case-insensitively on Windows.
  const rel = path.relative(resolveReal(dir), resolveReal(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * `p` as the native realpath of its nearest existing folder plus the rest: a Windows short (8.3) name or a link in
 * an existing part resolves the same way whether or not the file itself exists. Never throws.
 */
function resolveReal(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    let real: string | null = null;
    try {
      real = fs.realpathSync.native(head);
    } catch {
      real = null;
    }
    if (real) return path.join(real, ...tail.reverse());
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail.push(path.basename(head));
    head = up;
  }
}
