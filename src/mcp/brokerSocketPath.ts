import * as fs from 'fs';

/**
 * What sits at the broker's socket path before a stale-socket cleanup:
 * lstat, so a symlink is reported as one and never followed.
 */
export function staleSocketKind(p: string): 'socket' | 'missing' | 'unreadable' | 'file' | 'symlink' | 'directory' | 'other' {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    // A failed look (EACCES, EIO) says nothing about what is there.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (st.isSocket()) return 'socket';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'other';
}

/**
 * The device and inode of the socket at `p`, or null when there is no socket
 * there. Taken before the stale probe and again before the unlink, so a socket
 * another broker bound in between is never the one removed.
 */
export function socketIdentity(p: string): string | null {
  try {
    const st = fs.lstatSync(p);
    return st.isSocket() ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
}
