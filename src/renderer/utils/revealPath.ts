import { paneWslSession, type PaneForegroundApi } from '../terminal/paneForegroundProbe';
import { wslPathToHost } from '../../shared/wslPaths';
import { findLeaf } from '../../shared/paneUtils';
import type { Pane, Surface, Workspace } from '../../shared/types';

/**
 * A pane cwd as a path the host OS can open (Explorer / "Open with").
 *
 * Which form a WSL pane's cwd holds (verified against the code, not the
 * comments alone): it depends on who reported it. The bash prompt hook
 * (shell-hooks/bash.sh) runs `wslpath -w` and reports a `//wsl.localhost/...`
 * style UNC path, which the host opens as is. Other reporters (other shells,
 * agent-set cwds, restored sessions) carry the Linux path (`/home/me/repo`),
 * which on win32 `shell.openPath` reads as `\home\me\repo` on the current drive
 * and answers NOT_FOUND. So: a cwd starting with a single `/` that belongs to a
 * WSL pane is translated with the pane's distro; every other form comes back
 * unchanged. A UNC form starts with `//` and is never touched.
 */
export async function revealablePath(
  cwd: string,
  ptyId: string | undefined,
  api: Pick<PaneForegroundApi, 'list'>,
  platform: string | undefined = typeof window === 'undefined' ? undefined : window.electronAPI?.platform,
): Promise<{ path: string } | { error: string }> {
  // Only Windows hosts WSL panes; elsewhere a Linux path is the host's own.
  if (platform !== undefined && platform !== 'win32') return { path: cwd };
  if (!ptyId || !cwd.startsWith('/') || cwd.startsWith('//')) return { path: cwd };
  const session = await paneWslSession(ptyId, api);
  if (!session.wsl) return { path: cwd };
  // With no distro, wslPathToHost still maps /mnt/<drive> paths and rejects
  // distro-local ones with its own error.
  return wslPathToHost(cwd, session.distro);
}

/**
 * The ptyId of a workspace's focused pane (its active terminal surface, else
 * the pane's first terminal) — the pane whose cwd `metadata.cwd` follows.
 */
export function focusedPtyId(ws: Workspace | null | undefined): string | undefined {
  if (!ws) return undefined;
  const pane: Pane | null = findLeaf(ws.rootPane, ws.activePaneId);
  if (!pane || pane.type !== 'leaf') return undefined;
  const active: Surface | undefined = pane.surfaces?.find((s) => s.id === pane.activeSurfaceId);
  return (active?.ptyId || pane.surfaces?.find((s) => s.ptyId)?.ptyId) || undefined;
}

/**
 * Reveal `dir` through `openPath`, translating a WSL pane's Linux path first.
 * Every failure (untranslatable path, rejected open) goes to `onError`, which
 * the caller shows as the open-failure toast.
 */
export async function revealInHost(
  dir: string,
  ptyId: string | undefined,
  api: Pick<PaneForegroundApi, 'list'>,
  openPath: (path: string) => Promise<{ ok?: boolean; error?: string } | unknown> | undefined,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const target = await revealablePath(dir, ptyId, api);
    if ('error' in target) { onError(target.error); return; }
    const res = await openPath(target.path);
    if (res && typeof res === 'object' && (res as { ok?: unknown }).ok === false) {
      onError(String((res as { error?: unknown }).error ?? 'open failed'));
    }
  } catch (err) {
    onError(String((err as { message?: string })?.message ?? err));
  }
}
