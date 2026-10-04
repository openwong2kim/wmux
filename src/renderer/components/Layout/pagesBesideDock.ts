import type { AppRoute } from '../../stores/slices/uiSlice';

/** Rail pages that leave the dock (Moa, channels) in view and in reach beside
 *  them. Every other rail page covers the dock, inert, with the rest of the
 *  Workspaces page. */
export const PAGES_BESIDE_DOCK: ReadonlySet<AppRoute> = new Set<AppRoute>(['git']);

/** Whether the dock is on screen and usable on `route` (when it is open). */
export function dockShownOn(route: AppRoute): boolean {
  return route === 'workspaces' || PAGES_BESIDE_DOCK.has(route);
}
