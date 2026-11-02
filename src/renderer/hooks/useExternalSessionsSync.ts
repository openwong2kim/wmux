import { useEffect } from 'react';
import { useStore } from '../stores';
import { externalSessionsApi } from '../stores/slices/externalSessionsSlice';

/**
 * Mirrors the daemon's external sessions into the store: the list once, then
 * every push (each carries the whole list). Does nothing on a preload without
 * the bridge.
 */
export function useExternalSessionsSync(): void {
  useEffect(() => {
    const api = externalSessionsApi();
    if (!api) return;
    let live = true;
    // A push that lands before the first list answers is the newer truth.
    let pushed = false;
    const off = api.onChanged((sessions) => {
      pushed = true;
      useStore.getState().setExternalSessions(sessions);
    });
    void api.list().then(
      (sessions) => { if (live && !pushed) useStore.getState().setExternalSessions(sessions); },
      () => undefined,
    );
    return () => {
      live = false;
      off();
    };
  }, []);
}
