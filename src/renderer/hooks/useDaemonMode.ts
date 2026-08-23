import { useSyncExternalStore } from 'react';
import { isDaemonModeActive, subscribeDaemonMode } from '../daemon/daemonMode';

/**
 * React binding for the renderer's daemon-connection flag.
 *
 * The flag itself lives in a module-level variable (see daemon/daemonMode.ts —
 * most of its readers run outside React's render cycle). This hook is for the
 * few places where the UI has to REPAINT on a connect/disconnect: the pane
 * stash button (#977) is unavailable without the daemon, and a control that
 * silently keeps offering an action the store will refuse is worse than one
 * that is honestly greyed out.
 */
export function useDaemonModeActive(): boolean {
  return useSyncExternalStore(subscribeDaemonMode, isDaemonModeActive, () => false);
}
