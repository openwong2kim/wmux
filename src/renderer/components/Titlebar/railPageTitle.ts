import type { AppRoute } from '../../stores/slices/uiSlice';
import type { TranslationKey } from '../../i18n/locales/en';

/** The titlebar names the rail page it shows; the Workspaces page and
 *  Settings keep the workspace's name, its branch and New workspace. */
export const RAIL_PAGE_TITLE_KEYS: Partial<Record<AppRoute, TranslationKey>> = {
  fleet: 'fleet.title',
  schedules: 'schedules.title',
  remote: 'sidebar.remote',
  git: 'git.title',
};

/** Whether the titlebar carries the workspace's name, task link, branch and
 *  New workspace. Only while the sidebar is hidden: an open sidebar already
 *  shows them (its `Workspaces N +` header and the highlighted row), and a
 *  rail page names itself instead. */
export function workspaceChromeInTitlebar(s: { appRoute: AppRoute; sidebarVisible: boolean }): boolean {
  return !(s.appRoute in RAIL_PAGE_TITLE_KEYS) && !s.sidebarVisible;
}
