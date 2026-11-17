import * as fs from 'fs';

/**
 * What sits at the broker's socket path before a stale-socket cleanup:
 * lstat, so a symlink is reported as one and never followed.
 */
export function staleSocketKind(p: string): 'socket' | 'missing' | 'file' | 'symlink' | 'directory' | 'other' {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other';
  }
  if (st.isSocket()) return 'socket';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'other';
}
