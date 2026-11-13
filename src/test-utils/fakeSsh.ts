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
  // A segment fakeSshUrl escaped is restored before the command runs.
  fs.writeFileSync(file, `#!/bin/sh\n${touch}for last; do :; done\nlast=$(printf '%s' "$last" | sed 's#/${DASH_ESCAPE}-#/-#g')\nfor v in $(env | sed -n 's/^\\(GIT_[A-Z0-9_]*\\)=.*/\\1/p'); do unset "$v"; done\nexec sh -c "$last"\n`, { mode: 0o755 });
  return file;
}

/**
 * Put before a path segment that starts with `-` (a TMPDIR such as
 * `/private/tmp/x/-Users-me/…`): an address with such a segment is not a plain
 * one, so the URL carries it escaped and the fake ssh restores it.
 */
const DASH_ESCAPE = '_wmuxdash_';

/** `ssh://localhost<abs>`: an ssh URL for a local bare repository. */
export function fakeSshUrl(absPath: string): string {
  return `ssh://localhost${absPath.split('/').map((s) => (s.startsWith('-') ? DASH_ESCAPE + s : s)).join('/')}`;
}
