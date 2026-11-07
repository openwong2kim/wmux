// The `ps` the MCP side reads parent pids with, by absolute path where the
// system keeps one, so the answer does not depend on the PATH a process
// inherited. A system with neither path (NixOS, Guix) keeps finding it on PATH.
import * as fs from 'fs';

/** /bin/ps on macOS; /bin/ps or /usr/bin/ps on Linux, whichever exists; else `ps`. */
export function pickPs(platform: NodeJS.Platform, exists: (p: string) => boolean): string {
  const candidates = platform === 'linux' ? ['/bin/ps', '/usr/bin/ps'] : ['/bin/ps'];
  return candidates.find(exists) ?? 'ps';
}

let resolved: string | undefined;

/** pickPs for this process, looked up once. */
export function psPath(): string {
  resolved ??= pickPs(process.platform, fs.existsSync);
  return resolved;
}
