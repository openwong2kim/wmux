import fs from 'node:fs';

/** A small file a worker can write (HEAD, a worktree's `gitdir`, the
 *  shallow list), read without waiting on it: a plain file only (lstat, then
 *  fstat on the opened handle, same file), opened non-blocking and with no
 *  symlink followed, at most `max` bytes. Null for anything else. Never
 *  throws. Shared by main's task push and the daemon's phone push. */
export async function readWorkerFile(p: string, max = 4096): Promise<string | null> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    const st = await fs.promises.lstat(p);
    if (!st.isFile() || st.size > max) return null;
    fh = await fs.promises.open(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = await fh.stat();
    if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev) return null;
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
    return bytesRead > max ? null : buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
