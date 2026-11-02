import { useEffect } from 'react';
import { useStore } from '../stores';

// Daemon security notices (shared/securityNotice.ts) go straight into the
// store's pinned list, never through the notification policy
// (useNotificationListener): focus, a muted workspace or category and the
// toast setting must not hide them. Subscribes before asking for the pending
// list, so a notice added in between is heard; the store merges the two by id.
export function useSecurityNotices(): void {
  useEffect(() => {
    const api = window.electronAPI?.notification;
    if (!api?.onSecurityNotice) return;
    let alive = true;
    const unsubscribe = api.onSecurityNotice((notice) => {
      useStore.getState().addSecurityNotice(notice);
    });
    void api.securityNotices().then(
      (list) => {
        if (alive) useStore.getState().setSecurityNotices(list);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
}
