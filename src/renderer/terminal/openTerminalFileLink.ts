/**
 * Click handler for a file path or `file:` link in a terminal pane.
 *
 * Resolves the text to a host path (WSL-aware, see shared/terminalFileLink),
 * then opens it as a read-only editor or preview tab in the pane's own
 * workspace. Directories, binaries, unreadable or oversized files, shadow
 * (remote) workspaces and the `os` setting all fall back to the OS opener.
 */

import { useStore } from '../stores';
import { getLeafPanes } from '../../shared/paneUtils';
import { isPreviewablePath } from '../../shared/filePreview';
import { isWslShell } from '../../shared/wslTarget';
import { resolveTerminalFileLink } from '../../shared/terminalFileLink';
import { paneWslSession } from './paneForegroundProbe';
import type { PathLocation } from './pathLinkProvider';

export interface OpenTerminalFileLinkDeps {
  /** OS opener (Electron shell.openPath, validated in main). */
  openWithOs: (filePath: string) => void;
  /** Raised when nothing could be opened at all (e.g. an unresolvable relative path). */
  onFailure: () => void;
  /**
   * The link came from an OSC 8 hyperlink, whose destination the program
   * controls and the user never saw. It may only open in the in-app viewer:
   * the OS opener is never reached (a hostile `file:` target must not hand the
   * OS a path to launch or a UNC share to authenticate against), so every
   * would-be fallback becomes `onFailure` instead.
   */
  viewerOnly?: boolean;
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

interface Located {
  workspaceId: string;
  paneId: string;
  shell: string;
  cwd: string;
}

function locatePty(ptyId: string | undefined): Located | null {
  if (!ptyId) return null;
  for (const ws of useStore.getState().workspaces) {
    for (const pane of getLeafPanes(ws.rootPane)) {
      const surface = pane.surfaces.find((s) => s.ptyId === ptyId);
      if (surface) return { workspaceId: ws.id, paneId: pane.id, shell: surface.shell, cwd: surface.cwd };
    }
  }
  return null;
}

export async function openTerminalFileLink(
  raw: string,
  location: PathLocation | undefined,
  ptyId: string | undefined,
  deps: OpenTerminalFileLinkDeps,
): Promise<void> {
  const platform = window.electronAPI.platform;
  // Every OS-opener fallback below goes through here.
  const openWithOs = deps.viewerOnly ? () => deps.onFailure() : deps.openWithOs;
  const owner = locatePty(ptyId);
  // The session decides; the tab label ('WSL' on a leaf's first tab) is only
  // a fallback for when the session list cannot answer.
  const session: { wsl: boolean; distro?: string } = owner !== null && ptyId && platform === 'win32'
    ? await paneWslSession(ptyId, window.electronAPI.pty)
    : { wsl: false };
  const inWsl = owner !== null && (session.wsl || isWslShell(owner.shell, platform));
  const distro = session.distro;
  const link = resolveTerminalFileLink({
    raw,
    hostPlatform: platform,
    shellKind: inWsl ? 'wsl' : 'native',
    distro,
    cwd: owner?.cwd || undefined,
  });

  if (!link) {
    // Nothing translated. An absolute path keeps the old behaviour (main
    // validates it); a relative one has no meaning to the OS opener. Neither
    // has a POSIX path on Windows: the OS would read `/tmp/x` on the current
    // drive, a different file from the one the pane printed.
    if (ABSOLUTE.test(raw) && !(platform === 'win32' && raw.startsWith('/'))) {
      openWithOs(raw.replace(/:\d+(?::\d+)?$/, ''));
    } else {
      deps.onFailure();
    }
    return;
  }

  const state = useStore.getState();
  if (state.terminalOpenFileLinksIn === 'os' || !owner) {
    openWithOs(link.hostPath);
    return;
  }

  if (isPreviewablePath(link.hostPath)) {
    state.addPreviewSurface(owner.paneId, link.hostPath, { workspaceId: owner.workspaceId });
    return;
  }

  let content: string | null = null;
  try {
    content = await window.electronAPI.fs.readFile(link.hostPath);
  } catch {
    content = null;
  }
  // null: a directory, missing, blocked or over the 1 MB cap. NUL: binary.
  if (content === null || content.includes('\0')) {
    openWithOs(link.hostPath);
    return;
  }
  state.addEditorSurface(owner.paneId, link.hostPath, {
    workspaceId: owner.workspaceId,
    // The provider strips `:line:col` from the matched text and reports it
    // separately, so `location` carries it for plain path clicks.
    ...((link.line ?? location?.line) !== undefined && { line: (link.line ?? location?.line) as number }),
  });
}
