// "Connect GitHub" on the Git page: run `gh auth login --web` in a new
// terminal tab of the active workspace, so the user finishes the sign-in in
// the browser. gh keeps the credential; wmux never sees or stores a token.
// The tab is an ordinary shell tab (the accountLogin / project-command
// pattern), so the user can read gh's prompts and close it when done.
//
// It resolves false whenever no visible tab ends up running the command — no
// workspace, startup not finished, a pane closed during the spawn, or a
// Windows default shell that enters WSL (whose gh is not the one wmux reads) —
// and the page then shows the command to copy instead.

import { useStore } from '../../stores';
import { withDefaultShell, withWorkspaceProfile, resolveStartupCwd } from '../../utils/ptyCreateOptions';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { isWslShell } from '../../../shared/imagePaste';
import type { Workspace } from '../../../shared/types';
import { isShadowWorkspaceId } from '../../../shared/pcRail';

export const GH_LOGIN_COMMAND = 'gh auth login --web';

let inFlight: Promise<boolean> | null = null;

/** The pane to put the tab in: the active one, else the first. */
function targetPaneId(ws: Workspace): string | null {
  const panes = getWorkspaceLeafPanes(ws);
  return (panes.find((p) => p.id === ws.activePaneId) ?? panes[0])?.id ?? null;
}

/** Opens the sign-in tab and shows it. One at a time: a second call while one
 *  is opening gets the same answer instead of a second tab. */
export function openGithubLoginTab(title: string): Promise<boolean> {
  if (!inFlight) inFlight = open(title).finally(() => { inFlight = null; });
  return inFlight;
}

async function open(title: string): Promise<boolean> {
  const state = useStore.getState();
  if (state.paneGate !== 'ready') return false;
  const platform = (window as unknown as { electronAPI?: { platform?: string } }).electronAPI?.platform;
  if (platform === 'win32' && (isWslShell(state.defaultShell) || state.defaultShell === 'wsl' || !!state.defaultWslDistro)) return false;
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  // Another computer's (shadow) workspace never gets a local shell.
  if (!ws || isShadowWorkspaceId(ws.id) || !window.electronAPI?.pty?.create) return false;
  const paneId = targetPaneId(ws);
  if (!paneId) return false;
  const cwd = resolveStartupCwd({ splitInheritsCwd: false, profile: ws.profile, startupDirectory: state.startupDirectory });
  // No role binding: it would rewrite the command as an agent launch.
  const options = withWorkspaceProfile(
    withDefaultShell({ workspaceId: ws.id, cwd, spawnKind: 'user-shell' as const, initialCommand: GH_LOGIN_COMMAND }, state.defaultShell),
    ws.profile,
  );
  let created: { id: string; shell?: string; cwd?: string };
  try {
    created = await window.electronAPI.pty.create(options) as { id: string; shell?: string; cwd?: string };
  } catch {
    return false;
  }
  const dispose = () => { void window.electronAPI.pty.dispose(created.id).catch(() => undefined); };
  // The workspace or its pane may have been closed or split away during the
  // await; then no tab would show the PTY, so it must not live on unseen.
  const freshWs = useStore.getState().workspaces.find((w) => w.id === ws.id);
  if (!freshWs || !getWorkspaceLeafPanes(freshWs).some((p) => p.id === paneId)) {
    dispose();
    return false;
  }
  // addSurface's third argument is the shell (the restore path re-spawns it).
  useStore.getState().addSurface(paneId, created.id, created.shell || options.shell || '', created.cwd || cwd || '', ws.id);
  const after = useStore.getState();
  const afterWs = after.workspaces.find((w) => w.id === ws.id);
  const surface = afterWs
    ? getWorkspaceLeafPanes(afterWs).flatMap((p) => p.surfaces).find((x) => x.ptyId === created.id)
    : undefined;
  if (!surface) {
    dispose();
    return false;
  }
  after.updateSurfaceTitle(surface.id, title);
  after.setActivePane(paneId);
  showWorkspaces(after);
  return true;
}
