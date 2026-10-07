import { wslPathToHost } from '../../mcp/wslPaths';

/**
 * A caller pane's reported cwd, as a path this (Windows) process can hand to
 * `git` as a child-process cwd.
 *
 * A WSL pane reports a Linux path (`/mnt/d/repo`, `/home/me/repo`). On win32,
 * `path.resolve` reads that as rooted on the CURRENT drive and answers
 * `C:\mnt\d\repo` — a directory that does not exist, so the caller was told its
 * repository is "not a git repository". On win32 no Windows path starts with a
 * single `/`, so any such cwd is translated; drive (`D:\…`) and UNC paths, and
 * every cwd on macOS/Linux, come back unchanged without a daemon round trip.
 *
 * The distro is only needed for a distro-internal path, and is read from the
 * daemon session that owns the pane (`wslTarget`, recorded at spawn) — never
 * guessed from the default distro, since the pane may run another one.
 */
export async function hostCwdForPane(
  cwd: string,
  ptyId: string,
  opts: { platform?: NodeJS.Platform; daemonRpc?: DaemonRpc } = {},
): Promise<{ cwd: string } | { error: string }> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' || !cwd.startsWith('/') || cwd.startsWith('//')) return { cwd };
  const first = wslPathToHost(cwd, undefined);
  if ('path' in first) return { cwd: first.path };
  const distro = await paneWslDistro(ptyId, opts.daemonRpc);
  const translated = wslPathToHost(cwd, distro);
  return 'path' in translated ? { cwd: translated.path } : { error: translated.error };
}

/** The daemon RPC seam (a DaemonClient's `rpc`, or a handler's daemon port). */
export type DaemonRpc = (method: 'daemon.listSessions', params: Record<string, unknown>) => Promise<unknown>;

async function paneWslDistro(ptyId: string, daemonRpc: DaemonRpc | undefined): Promise<string | undefined> {
  if (!ptyId || !daemonRpc) return undefined;
  try {
    const sessions = (await daemonRpc('daemon.listSessions', {})) as Array<{
      id?: string;
      wslTarget?: { distribution?: unknown };
    }>;
    if (!Array.isArray(sessions)) return undefined;
    const d = sessions.find((s) => s?.id === ptyId)?.wslTarget?.distribution;
    return typeof d === 'string' ? d : undefined;
  } catch {
    return undefined;
  }
}
