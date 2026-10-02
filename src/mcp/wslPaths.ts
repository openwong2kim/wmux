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
 * equivalent here. Relative paths, and every path for a non-WSL caller, come
 * back unchanged. `..` segments are left for the caller's own path.resolve so
 * that any sandbox check sees them exactly as before.
 */
export function fromAgentPath(agentPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = wslMountRoot(env);
  if (root === null || !agentPath.startsWith('/')) return agentPath;
  if (agentPath.startsWith(root)) {
    // The letter must be a whole segment: with root `/`, `/home` and `/cfoo`
    // are distro paths, not drives.
    const m = /^([A-Za-z])(?:\/(.*))?$/s.exec(agentPath.slice(root.length));
    if (m) return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
  }
  return null;
}
