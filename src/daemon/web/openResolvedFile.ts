import fs from 'node:fs';
import { promisify } from 'node:util';

/**
 * The flags each open still asks for where they exist. Written out bare, as
 * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, the expression collapsed to plain
 * O_RDONLY on win32 without a word: Node defines neither constant there, and
 * `undefined | x` is `x` (#1434). The `?? 0` keeps that visible, and the checks
 * in `openResolvedFile` are what hold on a platform where both are 0.
 */
const READ_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

const fstat = promisify(fs.fstat);

/**
 * Same file object. Some Node builds report `st_dev` as 0 for a PATH stat on
 * Windows while the handle's stat carries the volume serial (see
 * `sameFileIdentity` in webStateStore.ts), so there the device is compared
 * only when both sides report one. The inode is the NTFS file ID, which is
 * why these are bigint stats: it does not fit a double.
 */
function sameFile(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  if (a.ino !== b.ino) return false;
  if (a.dev === b.dev) return true;
  return process.platform === 'win32' && (a.dev === 0n || b.dev === 0n);
}

/**
 * Open, for reading, a path the caller got back from `realpath` and has
 * already found inside its boundary — and refuse it if that is no longer what
 * the path names. Resolves to the handle, or to `null` for every refusal, so
 * the caller answers with the one 404 it gives a path that is not there.
 *
 * What it holds on every platform, instead of leaning on flags win32 lacks:
 *
 * - Nothing but a regular file is ever opened. `real` came out of realpath with
 *   every link resolved, so a link here was swapped in since; a directory,
 *   device or FIFO never was a file. Checking before the open is what keeps a
 *   FIFO from parking the request (and its handle) waiting for a writer.
 * - After the open, the HANDLE is the judge: it must be a regular file (Node
 *   reports a Windows named pipe as one by path; only the handle's stat says
 *   otherwise), the path must still name that same file without a
 *   link in its last component, and realpath must still give `real` back —
 *   the last is what catches a DIRECTORY on the way that became a junction or
 *   symlink, which O_NOFOLLOW never covered on POSIX either.
 *
 * What it cannot hold: Node has no handle-relative lookup, so a swap that is
 * made before the open and undone again between the two lookups after it can
 * still get through. That takes two precisely timed swaps inside the boundary
 * instead of one.
 */
export async function openResolvedFile(real: string): Promise<fs.promises.FileHandle | null> {
  try {
    if (!(await fs.promises.lstat(real, { bigint: true })).isFile()) return null;
  } catch {
    return null;
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(real, READ_FLAGS);
  } catch {
    // ELOOP from O_NOFOLLOW on a swapped-in link lands here, as does any other
    // reason the path cannot be opened now.
    return null;
  }
  try {
    const opened = await fstat(handle.fd, { bigint: true });
    const named = await fs.promises.lstat(real, { bigint: true });
    if (
      opened.isFile() &&
      named.isFile() &&
      sameFile(opened, named) &&
      (await fs.promises.realpath(real)) === real
    ) {
      return handle;
    }
  } catch {
    // Gone, or unreadable, between the open and the checks: the same refusal.
  }
  await handle.close().catch(() => { /* already gone — nothing to release */ });
  return null;
}
