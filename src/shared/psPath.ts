// The `ps` the MCP side reads parent pids with, by absolute path, so the
// answer does not depend on the PATH a process inherited.
import * as fs from 'fs';

let resolved: string | undefined;

/** /bin/ps on macOS; /bin/ps or /usr/bin/ps on Linux, whichever exists. */
export function psPath(): string {
  if (resolved) return resolved;
  const candidates = process.platform === 'linux' ? ['/bin/ps', '/usr/bin/ps'] : ['/bin/ps'];
  resolved = candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1];
  return resolved;
}
