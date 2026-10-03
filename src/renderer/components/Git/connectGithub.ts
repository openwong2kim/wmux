// "Connect GitHub" on the Git page: run `gh auth login --web` in a new
// terminal tab of the active workspace, so the user finishes the sign-in in
// the browser. gh keeps the credential; wmux never sees or stores a token.
// The tab is an ordinary shell tab (the accountLogin / project-command
// pattern), so the user can read gh's prompts and close it when done.

import { useStore } from '../../stores';
import { withDefaultShell, withWorkspaceProfile, resolveStartupCwd } from '../../utils/ptyCreateOptions';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';

export const GH_LOGIN_COMMAND = 'gh auth login --web';

/** Opens the sign-in tab and shows it. Resolves false when there is nowhere to put it. */
export async function openGithubLoginTab(title: string): Promise<boolean> {
  const state = useStore.getState();
  if (state.paneGate !== 'ready') return false;
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws || !window.electronAPI?.pty?.create) return false;
  const paneId = ws.activePaneId;
  const cwd = resolveStartupCwd({ splitInheritsCwd: false, profile: ws.profile, startupDirectory: state.startupDirectory });
  // No role binding: it would rewrite the command as an agent launch.
  const options = withWorkspaceProfile(
    withDefaultShell({ workspaceId: ws.id, cwd, spawnKind: 'user-shell' as const, initialCommand: GH_LOGIN_COMMAND }, state.defaultShell),
    ws.profile,
  );
  try {
    const created = await window.electronAPI.pty.create(options) as { id: string; shell?: string; cwd?: string };
    const fresh = useStore.getState();
    if (!fresh.workspaces.some((w) => w.id === ws.id)) {
      void window.electronAPI.pty.dispose(created.id).catch(() => undefined);
      return false;
    }
    // addSurface's third argument is the shell (the restore path re-spawns it).
    fresh.addSurface(paneId, created.id, created.shell || options.shell || '', created.cwd || cwd || '', ws.id);
    const after = useStore.getState();
    const surface = getWorkspaceLeafPanes(after.workspaces.find((w) => w.id === ws.id) ?? ws)
      .flatMap((p) => p.surfaces)
      .find((x) => x.ptyId === created.id);
    if (surface) after.updateSurfaceTitle(surface.id, title);
    after.setActivePane(paneId);
    showWorkspaces(after);
    return true;
  } catch {
    return false;
  }
}
