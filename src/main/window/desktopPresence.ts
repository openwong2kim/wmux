// Tell the daemon when the user is actually looking at the desktop app.
//
// The daemon uses this to skip the phone push for an approval it can see the
// user is already staring at (`daemon/push/presence.ts`). One bit, sent on
// transition, and that is the entire contract — the daemon owns the freshness
// rules and the fail-open behaviour, so nothing here has to be clever.
//
// Hung on the `app`-level `browser-window-focus`/`browser-window-blur` events
// rather than on a BrowserWindow: they fire for every window, they survive the
// window being recreated (macOS dock re-activate), and there is exactly one
// place to register them.

/** The slice of Electron's `app` this touches, so a test can pass a stub. */
export interface PresenceApp {
  on(event: 'browser-window-focus' | 'browser-window-blur', listener: () => void): unknown;
}

/** The slice of DaemonClient this touches. */
export interface PresenceRpcClient {
  readonly isConnected: boolean;
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export const DESKTOP_PRESENCE_RPC = 'daemon.presence.desktop';

/**
 * Send one presence report. Never throws and never awaits anything a caller
 * cares about: a daemon that is down, restarting, or too old to know the
 * method simply does not learn the user is present, and the daemon's fail-open
 * default then sends the push. That is the correct degradation — the
 * suppression is a nicety, the notification is not.
 */
export function reportDesktopPresence(
  getClient: () => PresenceRpcClient | null,
  focused: boolean,
): void {
  const client = getClient();
  if (!client?.isConnected) return;
  void client.rpc(DESKTOP_PRESENCE_RPC, { focused }).catch(() => {
    // Deliberately silent. This fires on every window focus change; a daemon
    // without the method would otherwise write a log line per alt-tab.
  });
}

/**
 * Wire focus/blur reporting. Call once at boot — `app` outlives every window.
 */
export function attachDesktopPresenceReporter(
  electronApp: PresenceApp,
  getClient: () => PresenceRpcClient | null,
): void {
  electronApp.on('browser-window-focus', () => reportDesktopPresence(getClient, true));
  electronApp.on('browser-window-blur', () => reportDesktopPresence(getClient, false));
}
