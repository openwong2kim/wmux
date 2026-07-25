/**
 * Shared contract for the "wmux web" browser/PWA terminal server.
 *
 * The server itself lives INSIDE the daemon (see daemon/web/WebTerminalServer).
 * This module is the single source of truth for the shape that crosses three
 * boundaries so they can't drift:
 *   - daemon.web.{start,status,stop} RPC result (daemon → main)
 *   - the web.* IPC handler (main → renderer, ipc/handlers/web.handler.ts)
 *   - the titlebar WebToggle popover (renderer)
 *
 * The CLI (`cli/commands/web.ts`) keeps its own local copy of this shape and
 * the security warning wording; the GUI reuses the wording, shortened.
 */

/** Default listen port shared with the CLI (`wmux web`) and the daemon. */
export const WEB_DEFAULT_PORT = 7681;
/** Loopback-only bind (safe default — nothing off-machine can reach it). */
export const WEB_LOOPBACK_HOST = '127.0.0.1';
/** All-interfaces bind (explicit `Expose to network` opt-in). */
export const WEB_EXPOSE_HOST = '0.0.0.0';

/**
 * Status/start/stop result. Mirrors the daemon's WebInfo plus an optional
 * `error` the main-process handler synthesizes when the daemon control pipe is
 * unreachable (so the renderer can render a quiet failure instead of throwing).
 */
export interface WebTerminalInfo {
  running: boolean;
  port?: number;
  host?: string;
  allowInput?: boolean;
  token?: string;
  urls?: string[];
  clients?: number;
  pairCode?: string;
  pairExpiresAt?: number;
  /**
   * Whether per-device credentials are armed (M3). False means pairing hands
   * out the shared token as 3.34.0 shipped it and there is nothing to revoke
   * one device at a time — an operator must never believe revocation is
   * available when it is not, so every status surface says so out loud.
   */
  deviceCredentials?: boolean;
  /**
   * Set ONLY by the main-process handler when it could not reach the daemon
   * (no control pipe, or the RPC threw/timed out). Absent on a normal reply.
   */
  error?: string;
}

/** Renderer → main start request. `expose` maps to the 0.0.0.0 bind. */
export interface WebStartArgs {
  /** Enable keyboard input (default false — read-only preserves the default). */
  allowInput?: boolean;
  /** Bind all interfaces instead of loopback (default false). */
  expose?: boolean;
}

/**
 * Resolve the bind host from the `expose` flag. Loopback unless the caller
 * explicitly opted into network exposure — mirrors the CLI host precedence.
 */
export function webBindHost(expose: boolean | undefined): string {
  return expose ? WEB_EXPOSE_HOST : WEB_LOOPBACK_HOST;
}

/** Whether an info's bind host is a loopback address (not phone-reachable). */
export function webIsLoopback(info: WebTerminalInfo): boolean {
  return info.host === WEB_LOOPBACK_HOST || info.host === '::1';
}

/** Whether an info's bind host is exposed on all interfaces. */
export function webIsExposed(info: WebTerminalInfo): boolean {
  return info.host === WEB_EXPOSE_HOST || info.host === '::';
}
