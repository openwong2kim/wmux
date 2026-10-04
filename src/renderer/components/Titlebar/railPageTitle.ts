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
