import fs from 'node:fs';
import path from 'node:path';

/**
 * Copy a directory tree (a test's git fixture) in plain JS.
 *
 * TEST-ONLY. Uses a readdir/copyFile walk for directories, files and symlinks.
 * The caller must keep the source immutable for the entire copy. In particular,
 * git templates must disable automatic maintenance BEFORE their first commit:
 * detached maintenance can remove a lock or repack objects during this walk.
 */
export function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(from, to);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
}
