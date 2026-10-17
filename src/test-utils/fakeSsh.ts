// A stand-in for ssh in git tests: it runs the remote command (git-upload-pack
// '<path>', git-receive-pack '<path>') on this machine, so an
// `ssh://localhost/<absolute path>` origin reaches a local bare repository
// through git's ssh transport. POSIX only (a /bin/sh script).
import fs from 'node:fs';
import path from 'node:path';

/** Writes the script into `dir` and returns its path; `marker`, when given,
 *  is touched on every run. */
export function writeFakeSsh(dir: string, marker?: string): string {
  const file = path.join(dir, 'fake-ssh.sh');
  const touch = marker ? `touch '${marker}'\n` : '';
  // The command is the last argument; git's own repository variables are
  // the caller's, not the remote side's.
  fs.writeFileSync(file, `#!/bin/sh\n${touch}for last; do :; done\nfor v in $(env | sed -n 's/^\\(GIT_[A-Z0-9_]*\\)=.*/\\1/p'); do unset "$v"; done\nexec sh -c "$last"\n`, { mode: 0o755 });
  return file;
}

/** `ssh://localhost<abs>`: an ssh URL for a local bare repository. */
export function fakeSshUrl(absPath: string): string {
  return `ssh://localhost${absPath}`;
}
