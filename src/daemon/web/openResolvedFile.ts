import fs from 'node:fs';
import { promisify } from 'node:util';

/**
 * The flags each open still asks for where they exist. Written out bare, as
 * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, the expression collapsed to plain
 * O_RDONLY on win32 without a word: Node defines neither constant there, and
 * `undefined | x` is `x` (#1434). The `?? 0` keeps that visible, and the checks
 * in `openResolvedFile` are what is left on a platform where both are 0.
 */
const READ_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

const fstat = promisify(fs.fstat);

/**
 * Whether `real` still names the file `opened` describes: same file ID, on
 * the same volume. A file ID is only unique within its volume, so a match
 * without one could be a file on another volume. Some Node builds report
 * `st_dev` as 0 for a PATH stat on Windows while a handle's stat carries the
 * volume serial (see `sameFileIdentity` in webStateStore.ts); when one side
 * has no volume, the path is opened once more and the two handles compared,
 * so both sides come from the same kind of stat. The stats are bigint because
 * an NTFS file ID does not fit a double.
 */
async function sameFile(opened: fs.BigIntStats, named: fs.BigIntStats, real: string): Promise<boolean> {
  if (opened.ino !== named.ino) return false;
  if (opened.dev === named.dev) return true;
  if (process.platform !== 'win32' || (opened.dev !== 0n && named.dev !== 0n)) return false;
  const again = await fs.promises.open(real, READ_FLAGS);
  try {
    const reopened = await fstat(again.fd, { bigint: true });
    return reopened.ino === opened.ino && reopened.dev === opened.dev;
  } finally {
    await again.close().catch(() => { /* already gone — nothing to release */ });
  }
}

/**
 * Open, for reading, a path the caller has already found inside its boundary
 * — and refuse it if that is no longer what the path names. Resolves to the
 * handle, or to `null` for every refusal, so the caller answers with the one
 * 404 it gives a path that is not there.
 *
 * `real` MUST be what the NATIVE realpath returned: `fs.promises.realpath` or
 * `fs.realpathSync.native`. The last check below compares realpath's answer
 * with `real` byte for byte, and only the native one spells a path the way the
 * filesystem does. JS `fs.realpathSync` keeps the caller's casing on a
 * case-insensitive volume (NTFS, default APFS), and `path.resolve` output is
 * not resolved at all; hand in either and legitimate files are refused.
 *
 * Before the open, the path must be a regular file. `real` came out of
 * realpath with every link resolved, so a link here was swapped in since, and
 * a directory, device or FIFO never was a file; none of them is opened. On
 * POSIX the flags cover the moment after that check: O_NOFOLLOW refuses a
 * link swapped into the last component, and O_NONBLOCK opens a FIFO swapped
 * in without parking the request (and its handle) on a writer, for the check
 * on the handle to refuse. On win32 neither flag exists, and a named pipe
 * looks like a regular file by path anyway: it passes the check and IS
 * opened, which connects to it, and the check on the handle refuses it before
 * anything is read.
 *
 * After the open, on every platform, the HANDLE is the judge: it must be a
 * regular file, the path must still name that same file without a link in its
 * last component, and realpath must still give `real` back. The last is what
 * catches a DIRECTORY on the way that became a junction or symlink, which
 * O_NOFOLLOW never covered on POSIX either.
 *
 * This narrows the window between the boundary check and the open; it does
 * not close it. A swap made before the open and undone again between the two
 * lookups after it gets through, and winning that takes no precise timing: a
 * process that keeps flipping a directory on the path to a link and back
 * (atomically on POSIX, with renameat2 RENAME_EXCHANGE or renamex_np
 * RENAME_SWAP) gets some fraction of requests through. Closing it needs the
 * path of the open handle itself, which Node has no API for on Windows or
 * macOS. Linux has one, a readlink of `/proc/self/fd/<fd>`, but that spelling
 * comes from the dentry cache: on a case-insensitive mount it can differ from
 * `real` for the very same file, so comparing the two would refuse legitimate
 * files.
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
    // Settled on the handle alone before any further lookup by path: on win32
    // every lookup of a named pipe is one more connection to its server.
    if (opened.isFile()) {
      const named = await fs.promises.lstat(real, { bigint: true });
      if (named.isFile() && (await sameFile(opened, named, real)) && (await fs.promises.realpath(real)) === real) {
        return handle;
      }
    }
  } catch {
    // Gone, or unreadable, between the open and the checks: the same refusal.
  }
  await handle.close().catch(() => { /* already gone — nothing to release */ });
  return null;
}
