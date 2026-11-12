import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether any process of this user works inside `dir` (its current folder is
 * `dir` or below it), read from /proc. For a headless start whose agent's
 * process tree could not be checked whole: its worktree is not removed, nor
 * the start counted as ended, while one does. Null where it cannot be told
 * (no /proc, as on macOS, or /proc unreadable): the caller keeps waiting.
 * Processes of other users are not readable and are skipped (the agent runs
 * as the daemon's user).
 */
export async function processesWorkingIn(dir: string, procRoot = '/proc'): Promise<boolean | null> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(procRoot);
  } catch {
    return null;
  }
  const inside = (p: string): boolean => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let cwd: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- one link at a time keeps the scan cheap
      cwd = await fs.promises.readlink(path.join(procRoot, name, 'cwd'));
    } catch {
      continue;
    }
    if (inside(cwd.replace(/ \(deleted\)$/, ''))) return true;
  }
  return false;
}
