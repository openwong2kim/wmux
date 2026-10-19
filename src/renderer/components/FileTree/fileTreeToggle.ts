import type { AppRoute } from '../../stores/slices/uiSlice';
import { showWorkspaces } from '../../utils/showWorkspaces';

interface FileTreeToggleState {
  fileTreeVisible: boolean;
  setFileTreeVisible: (visible: boolean) => void;
  appRoute?: AppRoute;
  setAppRoute?: (route: AppRoute) => void;
}

/**
 * Show or hide the file tree column. The column lives on the Workspaces page,
 * so opening it from a rail page brings that page forward: otherwise it would
 * open behind an inert page. From a rail page with the column already shown,
 * the same press brings the page forward instead of hiding something the user
 * cannot see. Shared by the agent bar's Files button, the shortcut and the
 * palette.
 */
export function toggleFileTreePanel(state: FileTreeToggleState): void {
  const offPage = state.appRoute !== undefined && state.appRoute !== 'workspaces';
  if (offPage && state.fileTreeVisible) {
    showWorkspaces(state);
    return;
  }
  state.setFileTreeVisible(!state.fileTreeVisible);
  showWorkspaces(state);
}
