import { isValidWslDistroName, isWslShellPath } from '../shared/wslDistro';
import { wslPathToHost } from '../mcp/wslPaths';
import type { GitDirMapper } from '../main/pty/gitContextWatch';

type WatchedSession = { cwd: string; cmd?: string; wslTarget?: { distribution?: unknown } };

/**
 * A session's cwd as the daemon's git watcher must open it (#2407).
 *
 * A WSL pane reports its directory as a Linux path (`/mnt/d/repo`,
 * `/home/me/repo`). The watcher runs in the Windows daemon process and reads
 * `.git` with Windows `fs`, where such a path resolves against the current
 * drive and names nothing, so the pane never showed a branch.
 *
 * A path under the drive mount is the Windows folder it names (`/mnt/d/repo`
 * → `D:\repo`): a local path, so the walk and the HEAD watch work as for any
 * Windows shell. A path inside the distro is that distro's share
 * (`\\wsl$\<distro>\home\me\repo`), with the distro the session recorded at
 * spawn (`wslTarget`, the cwd probe's $WSL_DISTRO_NAME, so a default-distro
 * pane has its name too). The watcher reads a share path only asynchronously
 * and polls it, since the share serves no change notifications
 * (GitContextWatcher's WSL_SHARE).
 *
 * Only a WSL session on win32 is translated. With no valid distro recorded,
 * only the drive mount is; a path that cannot be translated (a character
 * Windows reads as a separator) is passed as given, which keeps the old
 * "unknown", never a wrong repository.
 */
export function gitWatchCwdFor(session: WatchedSession, platform: NodeJS.Platform = process.platform): string {
  const wsl = wslOf(session, platform);
  return wsl ? asWatcherPath(session.cwd, wsl.distro) : session.cwd;
}

/**
 * How the watcher reads a worktree's Linux `gitdir:` for this session: by the
 * same rule as its cwd, so a host-drive worktree of a repository inside the
 * distro reaches that distro's share. Undefined for any other session, whose
 * gitdirs the watcher reads as it always has.
 */
export function gitDirMapperFor(
  session: WatchedSession,
  platform: NodeJS.Platform = process.platform,
): GitDirMapper | undefined {
  const distro = wslOf(session, platform)?.distro;
  return distro === undefined ? undefined : (gitdir) => asWatcherPath(gitdir, distro);
}

/** A WSL session on win32, with its distro when one valid name is recorded. */
function wslOf(session: WatchedSession, platform: NodeJS.Platform): { distro?: string } | undefined {
  if (platform !== 'win32') return undefined;
  if (session.wslTarget === undefined && !isWslShellPath(session.cmd)) return undefined;
  const distro = session.wslTarget?.distribution;
  return { distro: isValidWslDistroName(distro) ? distro : undefined };
}

/** wslPathToHost refuses anything but an absolute Linux path it can name safely. */
function asWatcherPath(linuxPath: string, distro: string | undefined): string {
  const host = wslPathToHost(linuxPath, distro);
  return 'path' in host ? host.path : linuxPath;
}
