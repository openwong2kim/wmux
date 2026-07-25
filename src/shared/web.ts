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
   * Why pairing cannot succeed right now, or absent when it can.
   *
   * Carries a `reason` the UI switches on and a `detail` for logs and tooltips,
   * mirroring the shape `/api/pair` already answers a refused redemption with
   * (`{ error: 'insecure-transport', detail }`). The daemon's prose must never
   * be rendered directly — every string the popover shows goes through `t()`,
   * and a daemon-authored English sentence would be the one line that cannot
   * be translated.
   *
   * When this is set the server also withholds `pairCode`: a code that can
   * only ever be answered with a 403 is worse than no code, because the
   * operator reads it onto a phone before discovering it was never going to
   * work.
   */
  pairRefusal?: PairRefusal;
  /**
   * Whether this server was started behind a `tailscale serve` front.
   *
   * The daemon does not act on it — the main process owns the serve. It is
   * persisted and replayed so the popover can seed its checkbox from what is
   * actually running. Without it a daemon restart brought the server back on
   * the tailnet while the checkbox read `false`, and the operator's next
   * Stop → Start silently dropped them onto loopback.
   */
  tailscale?: boolean;
  /**
   * Why the transport could not be brought up, when a start asked for one it
   * could not get (tailscale absent, logged out, someone else serving on :443).
   *
   * Set by the MAIN process, never the daemon — the daemon is not involved in a
   * start that failed before it was called. Same split as `pairRefusal`: a
   * `reason` the UI switches on to pick translated copy, plus `lines` that
   * quote what tailscale actually said. The quoted text stays English because
   * it is tailscale's own stderr; translating a quote would misrepresent it.
   */
  transportError?: { reason: string; lines: string[] };
  /**
   * Set ONLY by the main-process handler when it could not reach the daemon
   * (no control pipe, or the RPC threw/timed out). Absent on a normal reply.
   */
  error?: string;
}

/**
 * Why a pairing attempt would be refused.
 *
 * `insecure-transport` — the server is bound off-loopback over plain HTTP. A
 * device credential never expires, so it is not handed across a cleartext wire
 * (see WebTerminalServer.mintRefusal).
 */
export type PairRefusalReason = 'insecure-transport';

export interface PairRefusal {
  reason: PairRefusalReason;
  /** Operator-readable specifics. For logs and tooltips, never for the UI copy. */
  detail: string;
}

/** Renderer → main start request. `expose` maps to the 0.0.0.0 bind. */
export interface WebStartArgs {
  /** Enable keyboard input (default false — read-only preserves the default). */
  allowInput?: boolean;
  /** Bind all interfaces instead of loopback (default false). */
  expose?: boolean;
  /**
   * Put the server behind a `tailscale serve` HTTPS front.
   *
   * This field stops at the MAIN process — it is the main process that runs the
   * serve registration, exactly as the CLI does, and the daemon only ever
   * receives the resulting `allowedHosts`. Mutually exclusive with `expose`:
   * `tailscale serve` proxies loopback, so a wildcard bind is a different
   * (and weaker) transport, not an addition to this one.
   */
  tailscale?: boolean;
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
