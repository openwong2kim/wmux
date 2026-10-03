import type { AppRoute } from '../stores/slices/uiSlice';

interface RouteState {
  appRoute?: AppRoute;
  setAppRoute?: (route: AppRoute) => void;
}

/**
 * Panes and workspaces live on the Workspaces page. Any action that changes
 * them from somewhere else (the palette, a titlebar chip, the preset picker,
 * the tools-panel toggle, a workspace shortcut) brings that page forward,
 * because otherwise it would act behind an inert page the user cannot see.
 * Run the action first, then call this.
 */
export function showWorkspaces(state: RouteState): void {
  if (state.appRoute && state.appRoute !== 'workspaces') state.setAppRoute?.('workspaces');
}
