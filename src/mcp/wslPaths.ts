/**
 * Path translation for an MCP server launched for an agent inside WSL.
 *
 * The server itself runs on Windows (Electron runtime via WSL interop), so
 * every path it computes — home, ~/.wmux, temp — is a Windows path, while the
 * agent calling the tools lives in Linux and reads and writes Linux paths.
 * The launcher (WSL_MCP_LAUNCH) says so through two env vars:
 *  - WMUX_WSL_DISTRO: the distro name; non-empty means a WSL caller.
 *  - WMUX_WSL_MOUNT: what `wslpath -u 'C:\'` answered, e.g. `/mnt/c/`. Empty
 *    when wslpath was unavailable, in which case the default `/mnt/` root is
 *    assumed.
 *
 * Without WMUX_WSL_DISTRO every function here is the identity, so non-WSL
 * callers see byte-identical tool output.
 *
 * Env is read on every call rather than cached at import: it is fixed for the
 * life of a production process, and tests need to flip it.
 */

import { isValidWslDistroName } from '../shared/wslDistro';

const DEFAULT_MOUNT_ROOT = '/mnt/';

/**
 * The drive automount root as the WSL caller sees it (`/mnt/`, or `/` for a
 * wsl.conf `automount.root = /`), always with a trailing slash. Null when the
 * caller is not in WSL.
 */
export function wslMountRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.WMUX_WSL_DISTRO) return null;
  // `/mnt/c/` → `/mnt/`; `/c/` → `/`. Anything else (empty, an error string)
  // gets the default rather than a guess.
  const m = /^(\/(?:.*\/)?)c\/?$/i.exec((env.WMUX_WSL_MOUNT ?? '').trim());
  return m ? m[1] : DEFAULT_MOUNT_ROOT;
}

/**
 * A host (Windows) path as the WSL caller should be told it:
 * `C:\Users\me\x` → `/mnt/c/Users/me/x`. UNC, relative and already-POSIX
 * paths, and every path for a non-WSL caller, come back unchanged.
 */
export function toAgentPath(hostPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = wslMountRoot(env);
  if (root === null) return hostPath;
  const m = /^([A-Za-z]):[\\/](.*)$/s.exec(hostPath);
  if (!m) return hostPath;
  return `${root}${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/**
 * A path the WSL caller handed us, as the host can open it:
 * `/mnt/c/Users/me/x` → `C:\Users\me\x`.
 *
 * Returns null for a WSL caller's POSIX absolute path outside the drive mount
 * (`/home/me/x`): it names a file inside the distro that has no drive-letter
 * equivalent here. Also null for a WSL caller's relative path: it is relative
 * to the agent's Linux cwd, which this Windows process cannot know, and
 * resolving it against our own cwd would silently name some other directory.
 * Windows drive and UNC paths, and every path for a non-WSL caller, come back
 * unchanged. `..` segments are left for the caller's own path.resolve so that
 * any sandbox check sees them exactly as before.
 */
export function fromAgentPath(agentPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = wslMountRoot(env);
  if (root === null || /^[A-Za-z]:[\\/]/.test(agentPath) || agentPath.startsWith('\\\\')) return agentPath;
  if (!agentPath.startsWith('/')) return null;
  if (agentPath.startsWith(root)) {
    // The letter must be a whole segment: with root `/`, `/home` and `/cfoo`
    // are distro paths, not drives.
    const m = /^([A-Za-z])(?:\/(.*))?$/s.exec(agentPath.slice(root.length));
    if (m) return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
  }
  return null;
}

/**
 * A WSL pane's Linux cwd, as the Windows host process must open it, for a
 * caller that has no WMUX_WSL_* env of its own (the main process reading a
 * pane's reported cwd):
 *  - under the drive mount: `/mnt/d/a b/c` → `D:\a b\c` (the same rule as
 *    fromAgentPath);
 *  - anywhere else: `\\wsl$\<distro>\home\me\repo`, when the distro is known.
 *
 * `mount` is what `wslpath -u 'C:\'` answers inside the distro; the main
 * process never learns it, so callers there omit it and the default `/mnt/`
 * root applies (a wsl.conf `automount.root` elsewhere is then read as a
 * distro-internal path and goes through `\\wsl$\`, which still names the same
 * directory). Returns an error string instead of a guess: a distro-internal
 * path with no (valid) distro, a path holding a character that is a separator
 * or reserved on Windows, a name Win32 reads as another file (trailing dot or
 * space, device name), or anything that is not an absolute Linux path.
 */
export function wslPathToHost(
  linuxPath: string,
  distro: string | undefined,
  mount = '',
): { path: string } | { error: string } {
  if (!linuxPath.startsWith('/') || linuxPath.startsWith('//')) {
    return { error: `${JSON.stringify(linuxPath)} is not an absolute Linux path` };
  }
  // `\` and `:` are ordinary characters in a Linux name but separators on
  // Windows: `/home/me/repo/..\other` is ONE directory inside repo, yet as
  // `\\wsl$\…\repo\..\other` it resolves to a sibling of repo. The rest of
  // the Windows-reserved set cannot name the same file either. Refuse rather
  // than translate into a different directory.
  if (/[\\:*?"<>|]/.test(linuxPath)) {
    return {
      error: `${JSON.stringify(linuxPath)} contains a character (\\ : * ? " < > |) that means something else in a Windows path, so it cannot be translated safely`,
    };
  }
  // Win32 drops a trailing dot or space from every path segment, so
  // `/mnt/d/x/repo.` would open `D:\x\repo` (seen live: a different
  // repository); other trailing whitespace is trimmed by the callers' own
  // normalizers, with the same effect. A reserved device name (`con`, `nul.txt`, `com1`) opens the
  // device, not the directory. `.` and `..` are segments, not names.
  const unsafe = linuxPath
    .split('/')
    .find((s) => s !== '.' && s !== '..' && (/[.\s]$/.test(s) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(s)));
  if (unsafe !== undefined) {
    return {
      error: `${JSON.stringify(linuxPath)} has a name (${JSON.stringify(unsafe)}) that Windows reads as a different file (a trailing dot or space, or a device name), so it cannot be translated safely`,
    };
  }
  // fromAgentPath only needs a non-empty distro to switch on; the drive
  // mapping itself never reads the name.
  const drive = fromAgentPath(linuxPath, { WMUX_WSL_DISTRO: distro || 'wsl', WMUX_WSL_MOUNT: mount });
  if (drive !== null) return { path: drive };
  if (!distro || !isValidWslDistroName(distro)) {
    return {
      error: `${JSON.stringify(linuxPath)} is inside a WSL distro's own filesystem, and the pane's WSL distro is unknown, so it has no Windows path`,
    };
  }
  return { path: `\\\\wsl$\\${distro}${linuxPath.replace(/\//g, '\\')}` };
}
