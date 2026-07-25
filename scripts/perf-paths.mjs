// File-identity helpers shared by the perf gate and its confirmation re-run
// (#570). Small on purpose: "is this the same file?" is a security-relevant
// question and two copies of the answer would drift.
//
// Comparing resolved strings is not enough on Windows, where
// `\\?\C:\x\out\perf-current.json`, an 8.3 short name, a symlink and a hard
// link are all the same file spelled four ways. realpath collapses the first
// three; only file identity (dev + ino, which Node fills in on Windows too)
// catches a hard link.
//
// Identity is a fail-closed name/artifact guard, not the source of verdict
// bytes. A filesystem that reports ino=0 is refused; one that reports an
// unstable id can make a confirmation red. `claimNewFile` therefore also keeps
// the actual handle open and exposes its bytes, so even a synthetic/non-unique
// id cannot redirect what the gate judges.

import fs from 'node:fs';
import path from 'node:path';

const eq = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function realOrResolved(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved; // does not exist yet — nothing to alias
  }
}

export function fileIdentity(p) {
  let fd;
  try {
    // fstat an opened handle rather than stat the path. On Windows, path-based
    // stat can report dev=0 while fstat reports the real volume id; the latter
    // is what lets two same-numbered files on different volumes stay distinct.
    fd = fs.openSync(p, 'r');
    const s = fs.fstatSync(fd, { bigint: true });
    return s.ino === 0n ? null : `${s.dev}:${s.ino}`;
  } catch {
    return null; // absent, so it is not the same file as anything
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/**
 * Whether two paths name the same file — by string, by link, or by inode.
 * Returns the reason (a short phrase) or null when they are distinct.
 */
export function sameFileReason(a, b) {
  if (!a || !b) return null;
  if (eq(path.resolve(a), path.resolve(b))) return 'same path';
  if (eq(realOrResolved(a), realOrResolved(b))) return 'same file after resolving links';
  const ia = fileIdentity(a);
  if (ia != null && ia === fileIdentity(b)) return 'same file identity — hard link';
  return null;
}

/**
 * Create `file` and fail if anything is already there. `wx+` is atomic, so this
 * both refuses an existing file and claims the name against a racing creator —
 * an existsSync check would leave a window in which the target could become a
 * link to something that matters.
 *
 * Returns the claimed file's identity and an open handle. The caller keeps that
 * handle open until the writer is done, so a deleted file cannot surrender its
 * inode for reuse and make a delete/recreate swap look unchanged.
 */
export function claimNewFile(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const fd = fs.openSync(file, 'wx+');
  try {
    // Capture identity from the handle returned by the atomic create, not from
    // a second lookup by name. A close-then-stat sequence would reopen a TOCTOU
    // window in the very helper meant to close it. BigInt avoids rounding a
    // 64-bit Windows file id into the same Number as a neighbouring id.
    const s = fs.fstatSync(fd, { bigint: true });
    if (s.ino === 0n) {
      const err = new Error('the filesystem does not expose a stable file identity');
      err.code = 'ENOTSUP';
      throw err;
    }
    let open = true;
    return {
      identity: `${s.dev}:${s.ino}`,
      // Read through the original handle after the writer exits. Verifying the
      // path and then reopening it would leave one last swap window between the
      // identity check and the bytes the verdict actually parses.
      readBytes() {
        if (!open) throw new Error('the claimed file handle has already been released');
        return fs.readFileSync(fd);
      },
      release() {
        if (!open) return;
        open = false;
        fs.closeSync(fd);
      },
    };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}
