import { useStore } from '../stores';
import { findLeaf } from '../../shared/paneUtils';
import { t } from '../i18n';
import { resolveStartupCwd } from './ptyCreateOptions';
import { isRemoteMirrorVisible } from '../stores/slices/remoteWorkspacesSlice';
import { selectOtherPcOnScreen } from '../stores/shadowWorkspace';
import { isShadowWorkspaceId } from '../../shared/pcRail';
import { showWorkspaces } from './showWorkspaces';

/**
 * Commands the palette lists that are not one-line store calls, so a keyboard
 * shortcut bound to them (UNBOUND_SHORTCUTS in shared/keymap.ts) runs the very
 * same code the palette row does. Each brings the Workspaces page forward
 * where its result lives there, as the palette always did.
 */

/** #977 — stash the ACTIVE pane (the slice owns every guard and toast). */
export function stashActivePane(): void {
  const state = useStore.getState();
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (ws) state.stashPane(ws.activePaneId, ws.id);
  showWorkspaces(useStore.getState());
}

/**
 * The keyboard route to fan-out. Its only other entry point is a button on the
 * agent toolbar, which a minimal chrome preset switches off entirely — leaving
 * the one path that creates task worktrees unreachable.
 */
export function openMultiTask(): void {
  const state = useStore.getState();
  // Same guard ToolbarHost applies: fan-out targets the LOCAL active
  // workspace, so firing it while a remote view is on screen would dig
  // worktrees in a repo the user is not looking at.
  if (isRemoteMirrorVisible(state) || selectOtherPcOnScreen(state)) return;
  if (!state.activeWorkspaceId) return;
  state.openFanOut(state.activeWorkspaceId, null);
  // The fan-out dialog opens over the Workspaces page.
  showWorkspaces(useStore.getState());
}

/**
 * Pin/unpin the agent toolbar. Unpinned it is pointer-summoned, so without
 * this a keyboard-only user has no way to make it stay.
 */
export function toggleAgentToolbarPin(): void {
  const state = useStore.getState();
  state.setAgentToolbarPinned(!state.agentToolbarPinned);
}

/**
 * Bookmark or un-bookmark the active local workspace (the row menu's
 * Bookmark, for the keyboard). Nothing while a remote mirror is on screen:
 * the local selection is only remembered then, not shown.
 */
export function toggleActiveWorkspaceBookmark(): void {
  const state = useStore.getState();
  if (isRemoteMirrorVisible(state) || selectOtherPcOnScreen(state) || !state.activeWorkspaceId) return;
  state.toggleSidebarBookmark(state.activeWorkspaceId);
}

/** J3 §1 — the task cleanup list (a disk scan of the dedicated root). */
export function openWorktaskCleanup(): void {
  useStore.getState().setWorktaskCleanupVisible(true);
}

/**
 * Workspace git diff: normalize the active pane's cwd to its worktree
 * toplevel with diff:resolveRepo, then open a read-only diff surface. A
 * non-git cwd gets a toast.
 */
export function showGitDiff(): void {
  const state = useStore.getState();
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return;
  const leaf = findLeaf(ws.rootPane, ws.activePaneId);
  if (!leaf) return;
  const activeSurface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  // Another computer's pane: its paths name that computer's disk, so git never
  // runs on this one for it.
  if (isShadowWorkspaceId(ws.id) || activeSurface?.surfaceType === 'remote-terminal') {
    state.pushToast({ level: 'warn', message: t('diff.noRepo') });
    return;
  }
  // cwd precedence: the active surface's live cwd (OSC 7) > profile
  // startupCwd > the global startup directory.
  const cwd =
    activeSurface?.cwd ||
    resolveStartupCwd({ splitInheritsCwd: false, profile: ws.profile, startupDirectory: state.startupDirectory }) ||
    ''; // An empty cwd is refused by resolveRepo (ok:false) → noRepo toast.
  void window.electronAPI.diff.resolveRepo(cwd).then((r) => {
    const st = useStore.getState();
    if (!r.ok) {
      st.pushToast({ level: 'warn', message: t('diff.noRepo') });
      return;
    }
    const repoName = r.repoPath.split(/[/\\]/).filter(Boolean).pop() || r.repoPath;
    st.addWorkspaceDiffSurface(leaf.id, r.repoPath, `diff: ${repoName}`);
    showWorkspaces(st);
  }).catch((err) => {
    // An IPC reject (unregistered handler, serialization failure, …) gets the
    // toast too instead of failing silently.
    useStore.getState().pushToast({ level: 'warn', message: t('diff.noRepo') });
    console.error('[wmux:commands] diff.resolveRepo failed:', err);
  });
}

/** Event the active pane's tab strip answers by opening the rename field on its active tab. */
export const RENAME_ACTIVE_TAB_EVENT = 'wmux:rename-active-tab';

/**
 * Rename the active tab. The edit field belongs to the pane's tab strip
 * (SurfaceTabs), so this brings the Workspaces page forward and asks it.
 */
export function renameActiveTab(): void {
  showWorkspaces(useStore.getState());
  document.dispatchEvent(new CustomEvent(RENAME_ACTIVE_TAB_EVENT));
}
