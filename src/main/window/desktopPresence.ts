// Tell the daemon when the user is actually looking at the desktop app.
//
// The daemon uses this to hold back the phone push for an approval it can see
// the user is already staring at (`daemon/push/presence.ts`). One bit, sent on
// transition, and that is nearly the entire contract — the daemon owns the
// freshness rules and the fail-open behaviour, so little here has to be clever.
//
// Hung on the `app`-level `browser-window-focus`/`browser-window-blur` events
// rather than on a BrowserWindow: they fire for every window, they survive the
// window being recreated (macOS dock re-activate), and there is exactly one
// place to register them.
//
// The two directions are NOT symmetric, and that asymmetry drives the retry
// below. A lost `focused:true` costs a redundant buzz. A lost `focused:false`
// leaves the daemon believing the user is present when they are not, and holds
// their notifications — so a blur that fails to send is retried, and a focus
// that fails is not.

/** The slice of Electron's `app` this touches, so a test can pass a stub. */
export interface PresenceApp {
  on(event: 'browser-window-focus' | 'browser-window-blur', listener: () => void): unknown;
}

/**
 * The slice of Electron's `powerMonitor` this touches.
 *
 * Locking the screen, the display sleeping, and the machine suspending do NOT
 * fire a window blur — the window keeps focus behind the lock screen. Without
 * these the daemon would hold notifications for the whole freshness window
 * after the user locked up and walked away, which is precisely the moment the
 * phone is the only channel left.
 */
export interface PresencePowerMonitor {
  on(
    event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume' | 'shutdown',
    listener: () => void,
  ): unknown;
}

/** The slice of DaemonClient this touches. */
export interface PresenceRpcClient {
  readonly isConnected: boolean;
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export const DESKTOP_PRESENCE_RPC = 'daemon.presence.desktop';

/** How long to wait before re-sending a blur that failed. */
export const PRESENCE_BLUR_RETRY_MS = 750;

/**
 * Send one presence report.
 *
 * Never throws and never awaits anything a caller cares about: a daemon that
 * is down, restarting, or too old to know the method simply does not learn the
 * user is present, and the daemon's fail-open default then sends the push.
 *
 * A failed `focused:false` is retried once — see the module note. A failed
 * retry is dropped: the daemon's own freshness window is the backstop, and an
 * unbounded retry loop against a dead daemon is worse than a late notification.
 */
export function reportDesktopPresence(
  getClient: () => PresenceRpcClient | null,
  focused: boolean,
  opts: { retryMs?: number } = {},
): void {
  const client = getClient();
  if (!client?.isConnected) return;
  void client.rpc(DESKTOP_PRESENCE_RPC, { focused }).catch(() => {
    // Deliberately silent otherwise. This fires on every window focus change;
    // a daemon without the method would write a log line per alt-tab.
    if (focused) return;
    const timer = setTimeout(() => {
      const retryClient = getClient();
      if (!retryClient?.isConnected) return;
      void retryClient.rpc(DESKTOP_PRESENCE_RPC, { focused: false }).catch(() => {
        // One retry only. The daemon's own freshness window is the backstop,
        // and a loop against a dead daemon is worse than a late notification.
      });
    }, opts.retryMs ?? PRESENCE_BLUR_RETRY_MS);
    timer.unref?.();
  });
}

/**
 * Wire focus/blur reporting. Call once at boot — `app` outlives every window.
 *
 * `isFocused` is read on wake-up (`unlock-screen`/`resume`) to re-report the
 * truth: the window may or may not still be the focused one, and guessing
 * either way would be wrong half the time.
 */
export function attachDesktopPresenceReporter(
  electronApp: PresenceApp,
  getClient: () => PresenceRpcClient | null,
  opts: { powerMonitor?: PresencePowerMonitor; isFocused?: () => boolean } = {},
): void {
  electronApp.on('browser-window-focus', () => reportDesktopPresence(getClient, true));
  electronApp.on('browser-window-blur', () => reportDesktopPresence(getClient, false));

  const power = opts.powerMonitor;
  if (!power) return;
  // The user is behind a lock screen or the machine is going down: absent,
  // whatever the window still thinks it owns.
  for (const event of ['lock-screen', 'suspend', 'shutdown'] as const) {
    power.on(event, () => reportDesktopPresence(getClient, false));
  }
  // Back at the machine. Re-report what is actually true rather than assuming
  // the user came back to THIS window.
  for (const event of ['unlock-screen', 'resume'] as const) {
    power.on(event, () => reportDesktopPresence(getClient, opts.isFocused?.() ?? false));
  }
}
