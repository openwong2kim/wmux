/**
 * Whether Windows would let a directory be deleted right now, without
 * deleting anything. Shared by the desktop's phone-worktree Remove
 * (src/main/worktask/PhoneWorktreeRemoval.ts) and the daemon's recovery of an
 * interrupted phone worktree (src/daemon/web/phoneWorktree.ts).
 */

import fs from 'node:fs';

/** `in-use`: a process holds the directory itself. `refused`: a handle below it, or an ACL. */
export type DirectoryHold = 'free' | 'in-use' | 'refused';

/**
 * Windows: anything that stops the directory itself from being deleted makes
 * `git worktree remove` delete every file and then fail on the directory. A
 * rename to the same path opens the directory for DELETE and, when that
 * succeeds, changes nothing (no timestamp, attribute, ACL or change
 * notification). When it fails:
 * - EBUSY: a process holds the directory itself, e.g. a shell whose current
 *   directory it is; a cmd.exe prompt is not scraped, so that pane's cwd is
 *   never reported;
 * - EPERM / EACCES: a handle below it (a shell in a subdirectory, a file some
 *   program has open) or an ACL that forbids deleting it.
 * Anything else (ENOENT: already gone) is no hold.
 */
export async function windowsDirectoryHold(dir: string): Promise<DirectoryHold> {
  try {
    await fs.promises.rename(dir, dir);
    return 'free';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EBUSY' ? 'in-use' : code === 'EPERM' || code === 'EACCES' ? 'refused' : 'free';
  }
}

/** `windowsDirectoryHold` on Windows; elsewhere nothing is probed. */
export const directoryHold = async (dir: string): Promise<DirectoryHold> =>
  process.platform === 'win32' ? windowsDirectoryHold(dir) : 'free';
