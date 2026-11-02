/**
 * `daemon.setHostWindow({ handle })`: main reports the desktop window that
 * should own every pane's console window (Windows; see
 * shared/conptyParentWindow.ts). `handle` is the base64 of
 * BrowserWindow.getNativeWindowHandle(), or null for "no window".
 *
 * First-party only, like `daemon.presence.desktop`: an MCP tool or the CLI
 * holds the same pipe token but never claims the app's role, and must not be
 * able to hand every pane's console to some other window.
 *
 * The daemon outlives the app. When the client that set the window goes away,
 * its window is gone with it, so the owner is cleared rather than left
 * pointing at a dead window; the next app to connect reports its own.
 */
import { decodeNativeWindowHandle } from '../shared/conptyParentWindow';

export { HOST_WINDOW_RPC } from '../shared/conptyParentWindow';

export interface HostWindowRpcDeps {
  isFirstParty: (clientId: string) => boolean;
  /** DaemonSessionManager.setHostWindow; returns how many live panes it reached. */
  setHostWindow: (handle: Buffer | null) => number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export type HostWindowRpcResult =
  | { ok: true; reached: number }
  | { ok: false; reason: 'not-authorized' | 'bad-handle' };

export interface HostWindowRpc {
  handle(params: Record<string, unknown>, clientId: string): HostWindowRpcResult;
  /** Call from the pipe server's client-close hook. */
  onClientClose(clientId: string): void;
}

export function createHostWindowRpc(deps: HostWindowRpcDeps): HostWindowRpc {
  let owner: string | null = null;
  return {
    handle(params, clientId) {
      if (!deps.isFirstParty(clientId)) {
        deps.log?.('warn', `[host-window] ignored a host window from non-first-party client ${clientId}`);
        return { ok: false, reason: 'not-authorized' };
      }
      const handle = decodeNativeWindowHandle(params['handle']);
      if (handle === undefined) return { ok: false, reason: 'bad-handle' };
      owner = handle ? clientId : null;
      const reached = deps.setHostWindow(handle);
      deps.log?.('info', `[host-window] ${handle ? 'set' : 'cleared'} by ${clientId}; ${reached} live pane(s) reached`);
      return { ok: true, reached };
    },
    onClientClose(clientId) {
      if (owner === null || owner !== clientId) return;
      owner = null;
      const reached = deps.setHostWindow(null);
      deps.log?.('info', `[host-window] cleared: client ${clientId} closed; ${reached} live pane(s) reached`);
    },
  };
}
