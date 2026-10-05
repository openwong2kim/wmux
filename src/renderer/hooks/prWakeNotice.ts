// One-time notice for "Wake the agent on PR events" (renderer/hooks/
// fanoutCallerNudge.ts): the first run that has the feature says once that an
// agent pane may now get a line when its PR's CI fails, someone comments or
// the PR conflicts, and where the switch is. It stays until dismissed — a
// five-second toast at startup is easy to miss, and it never comes back.
// Upgraders only: AppLayout's first-boot queue shows it when nothing else is
// on screen, and a fresh install marks it seen without showing it (there is
// no earlier behaviour to announce a change against).
import { useStore } from '../stores';
import { t } from '../i18n';

export const PR_WAKE_NOTICE_KEY = 'wmux.prWakeNotice.v1';

/** True when the notice has not been shown (or marked seen) on this profile.
 *  No storage reads as not pending, so it never risks showing on every start. */
export function prWakeNoticePending(storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  try {
    return !!storage && !storage.getItem(PR_WAKE_NOTICE_KEY);
  } catch {
    return false;
  }
}

/** Records the notice as seen without showing it (a fresh install). */
export function markPrWakeNoticeSeen(storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(PR_WAKE_NOTICE_KEY, '1');
  } catch {
    // no storage: nothing to record
  }
}

/** Shows the notice unless it was shown before. Returns the toast id, or null
 *  when it did not show. */
export function showPrWakeNoticeOnce(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): string | null {
  try {
    if (!storage || storage.getItem(PR_WAKE_NOTICE_KEY)) return null;
    storage.setItem(PR_WAKE_NOTICE_KEY, '1');
  } catch {
    return null; // no storage: never risk showing it on every start
  }
  return useStore.getState().pushToast({
    message: t('settings.prWakeNotice'),
    level: 'info',
    persist: true,
    action: { label: t('settings.prWakeNoticeOpen'), onClick: () => useStore.getState().setAppRoute('settings') },
  });
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
