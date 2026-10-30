// Tell the daemon (and main's own local-mode PTYManager) which window owns
// every pane's console window, so a sign-in picker a terminal command opens
// (`az login`'s account picker and other MSAL/WAM prompts) stacks above wmux
// instead of opening behind it. See shared/conptyParentWindow.ts.
//
// wmux has one desk window, but it can be replaced (macOS re-activate, the
// install-quit recovery window), and the daemon outlives the app. So this is
// reported on every daemon connection and every time a main window is adopted;
// the daemon applies it to its live panes and to each pane it spawns later.

/** The slice of BrowserWindow this reads, so a test can pass a stub. */
export interface HostWindowSource {
  isDestroyed(): boolean;
  getNativeWindowHandle(): Buffer;
}

/** The slice of DaemonClient this touches. */
export interface HostWindowRpcClient {
  readonly isConnected: boolean;
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Must match daemon/hostWindowRpc.ts HOST_WINDOW_RPC (main does not import daemon code). */
export const HOST_WINDOW_RPC = 'daemon.setHostWindow';

/** The window's HWND bytes, or null when there is no live window or not on Windows. */
export function hostWindowHandle(
  win: HostWindowSource | null,
  platform: NodeJS.Platform = process.platform,
): Buffer | null {
  if (platform !== 'win32' || !win || win.isDestroyed()) return null;
  return win.getNativeWindowHandle();
}

/**
 * Report `win` to the daemon. Never throws and never needs awaiting: a daemon
 * that is down or too old to know the method keeps today's behaviour (no
 * owner), and the next connection reports again.
 */
export function reportHostWindow(
  getClient: () => HostWindowRpcClient | null,
  win: HostWindowSource | null,
  platform: NodeJS.Platform = process.platform,
): void {
  const handle = hostWindowHandle(win, platform);
  if (!handle) return;
  const client = getClient();
  if (!client?.isConnected) return;
  void client.rpc(HOST_WINDOW_RPC, { handle: handle.toString('base64') }).catch(() => {
    // Silent: an old daemon without the method would otherwise log on every connect.
  });
}
