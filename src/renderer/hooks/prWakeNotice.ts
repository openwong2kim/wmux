// One-time notice for "Wake the agent on PR events" (renderer/hooks/
// fanoutCallerNudge.ts): the first run that has the feature says once that an
// agent pane may now get a line when its PR's CI fails, someone comments or
// the PR conflicts, and where the switch is. It stays until dismissed — a
// five-second toast at startup is easy to miss, and it never comes back.
import { useStore } from '../stores';
import { t } from '../i18n';

export const PR_WAKE_NOTICE_KEY = 'wmux.prWakeNotice.v1';

/** Shows the notice unless it was shown before. Returns whether it showed. */
export function showPrWakeNoticeOnce(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): boolean {
  try {
    if (!storage || storage.getItem(PR_WAKE_NOTICE_KEY)) return false;
    storage.setItem(PR_WAKE_NOTICE_KEY, '1');
  } catch {
    return false; // no storage: never risk showing it on every start
  }
  useStore.getState().pushToast({
    message: t('settings.prWakeNotice'),
    level: 'info',
    persist: true,
    action: { label: t('settings.prWakeNoticeOpen'), onClick: () => useStore.getState().setAppRoute('settings') },
  });
  return true;
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
