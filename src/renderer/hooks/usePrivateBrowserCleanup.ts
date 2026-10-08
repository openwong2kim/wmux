import { useEffect } from 'react';
import { useStore } from '../stores';
import { createPrivateSessionWatcher } from '../../shared/privateBrowser';

/**
 * Wipes the shared private-tab session in main when the last private browser
 * tab leaves the store — closed as a tab, with its pane, or with its workspace.
 * A webview that only unmounts (hidden, discarded) is not a close: the surface
 * is still in the store, so nothing fires. Renders nothing and never causes a
 * re-render (a plain store subscription, not a selector).
 */
export function usePrivateBrowserCleanup(): void {
  useEffect(() => {
    const clear = () => {
      void window.electronAPI?.browser?.clearPrivateSession?.().catch((err: unknown) => {
        console.warn('[private-browser] failed to clear the private session:', err);
      });
    };
    const watch = createPrivateSessionWatcher(clear);
    watch(useStore.getState().workspaces);
    return useStore.subscribe((state) => watch(state.workspaces));
  }, []);
}
