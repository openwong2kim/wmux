import fs from 'node:fs';
import path from 'node:path';

/**
 * Copy a directory tree (a test's git fixture) in plain JS.
 *
 * TEST-ONLY. `fs.cpSync` is not used on purpose: its native implementation
 * failed intermittently on macos-14 with "ENOENT, No such file or directory
 * '<copy>/.git/objects'" while copying a freshly built fixture repo, and the
 * failure could not be reproduced locally. A readdir/copyFile walk has no such
 * mode, and a git fixture holds only directories, files and (rarely) symlinks.
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
