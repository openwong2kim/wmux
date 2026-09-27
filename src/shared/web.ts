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
 * Operator-supplied files for the daemon's native HTTPS listener.
 *
 * Only paths cross the control pipe and enter durable web state. Private-key
 * bytes stay inside the daemon process and are never returned by status.
 */
export interface WebTlsConfig {
  certPath: string;
  keyPath: string;
}

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
  /** Whether paired devices may upload files (`--allow-upload`). */
  allowUpload?: boolean;
  /**
   * Whether paired devices may read agent transcripts — the phone's Chat view
   * (`--allow-transcript`). Without it `/turns` answers 403.
   */
  allowTranscript?: boolean;
  /**
   * Whether a chat launch may start an agent with approvals or the sandbox off
   * (`--allow-dangerous-launch`, or the popover's Advanced option).
   */
  allowDangerousLaunch?: boolean;
  /** True when the daemon itself terminates HTTPS (not a Tailscale front). */
  tls?: boolean;
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
   * Extra names the server accepts in the `Host` header. These are normally a
   * `tailscale serve` MagicDNS front; with native TLS they may instead name the
   * certificate's DNS host.
   */
  allowedHosts?: string[];
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
   * The name the CURRENT pairing code will register its device under, or absent
   * when the live code was minted without one.
   *
   * Reported so the popover can be stateless about it. A code exists from the
   * moment the server starts, but a code minted by `start()` has no name behind
   * it — redeeming that one produces the "Unnamed device" rows that make a
   * roster unoperable ("which of these three do I revoke?"). The GUI shows the
   * code only when this is set, so naming cannot be skipped by reopening the
   * popover.
   */
  pendingDeviceName?: string;
  /** The input grant the pending code will register the device with. */
  pendingDeviceAllowInput?: boolean;
  /** Which card the pending code belongs to. Present exactly when the name is. */
  pendingPairFlow?: PairFlow;
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
   * Why naming-and-minting a code failed, on an otherwise healthy server.
   *
   * Separate from `error` deliberately: that field means "the daemon could not
   * be reached at all", and a consumer reading it as such would misreport a
   * running server as offline. This one always arrives alongside
   * `running: true`.
   */
  pairStartError?: string;
  /**
   * Set by the main-process handler when the control operation failed: no
   * daemon, a timeout, or an application-level RPC error such as a durable stop
   * whose on-disk state could not be revoked. Absent on a normal reply.
   */
  error?: string;
}

/**
 * Why a pairing attempt would be refused.
 *
 * `insecure-transport` — the server is bound off-loopback over plain HTTP. A
 * device credential never expires, so it is not handed across a cleartext wire
 * (see WebTerminalServer.mintRefusal). Decided by the DAEMON, which knows the
 * bind.
 *
 * `no-front` — the server is on loopback behind a `tailscale serve` front that
 * has since gone away, so the `https://…` address it advertises reaches
 * nothing. Decided by the MAIN process, which is the only side that can ask
 * tailscale. The daemon replays a persisted `allowedHosts` across a restart
 * and cannot tell whether the front behind it still exists.
 */
export type PairRefusalReason = 'insecure-transport' | 'no-front';

export interface PairRefusal {
  reason: PairRefusalReason;
  /** Operator-readable specifics. For logs and tooltips, never for the UI copy. */
  detail: string;
}

/**
 * One paired device, as the operator's roster shows it.
 *
 * A structural mirror of the daemon's `DeviceSummary` (`daemon/web/DeviceStore`)
 * rather than an import: shared/ must not pull daemon internals into the
 * renderer bundle, and the daemon deliberately keeps that type free of secret
 * material — no secret, no hash, no salt — so mirroring costs nothing but a
 * tsc-checked seam in the handler.
 */
export interface WebDeviceSummary {
  deviceId: string;
  /** Operator-chosen label. Empty for devices paired before naming was required. */
  name: string;
  createdAt: number;
  lastSeenAt: number;
  /**
   * Whether this device may type, spawn/close panes, toggle the permission
   * gate, and approve tool permissions. RESOLVED by the daemon, so a roster
   * written before per-device grants existed reports the grandfathered `true`
   * rather than an absent field the UI would have to interpret.
   *
   * The server's `--allow-input` is still the ceiling: a device can show
   * `true` here while the server is read-only, meaning "allowed once input is
   * switched on", which is what the roster has to display to be operable.
   */
  allowInput: boolean;
  /** Set once and never cleared — revocation is permanent; a device re-pairs to return. */
  revokedAt?: number;
  /** What the device said it was when it paired. Display only. */
  kind?: DeviceKind;
  /**
   * Seen within `DEVICE_ACTIVE_WINDOW_MS`, or holding a live stream right now.
   * Computed by the daemon at list time; never true for a revoked device.
   */
  activeNow?: boolean;
}

/** Result of changing one device's input grant. Fail-closed, like the revoke. */
export interface WebDeviceSetInputResult {
  ok: boolean;
  reason?: 'not-found' | 'revoked' | 'persist-failed' | 'unavailable' | 'unknown';
}

/**
 * Result of revoking one device. Fail-closed: `ok` means the roster write
 * PERSISTED and survives a restart.
 *
 * The failure reasons are kept apart because the UI makes a SAFETY CLAIM from
 * them, and the claims are not interchangeable:
 *
 *   `persist-failed`  the daemon ran the revoke: the device is blocked in
 *                     memory and its live streams were cut, but the write did
 *                     not land, so the credential returns on the next boot.
 *   `unknown`         the daemon never answered (RPC timeout, pipe cut,
 *                     unknown method on an older daemon). NOTHING can be
 *                     claimed — the revoke may not have run at all.
 *   `unavailable`     no daemon connection; nothing was attempted.
 *   `not-found`       no such device on the roster.
 *
 * Collapsing `unknown` into `persist-failed` is how a screen ends up telling an
 * operator their connections were cut when the request never left the machine.
 */
export interface WebDeviceRevokeResult {
  ok: boolean;
  reason?: 'not-found' | 'persist-failed' | 'unavailable' | 'unknown';
  /**
   * Live SSE streams actually torn down, straight from the daemon.
   *
   * Load-bearing, not diagnostics: `{ok:false, closed:2}` and
   * `{ok:false, closed:0}` are different facts about whether the device is off
   * the air RIGHT NOW, and the copy differs accordingly. Absent whenever the
   * daemon did not answer.
   */
  closed?: number;
}

/** Why a roster read produced nothing. Translated renderer-side, like the revoke reasons. */
export type WebDeviceListError = 'unavailable' | 'malformed';

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
  /**
   * Let paired devices read agent transcripts (the phone's Chat view). Absent
   * means "not the popover's decision": the daemon keeps the running or
   * persisted value rather than resetting it.
   */
  allowTranscript?: boolean;
  /** Let paired devices upload photos and files. Absent behaves as above. */
  allowUpload?: boolean;
  /**
   * Let a phone start Claude/Codex with approvals or the sandbox off. The
   * popover's Advanced option; absent behaves as above.
   */
  allowDangerousLaunch?: boolean;
}

/**
 * Grants the popover changes on a RUNNING server. Only the fields present are
 * changed; the server keeps its port, bind, allowed hosts, transport, token
 * and paired devices.
 */
export interface WebGrantArgs {
  allowInput?: boolean;
  allowTranscript?: boolean;
  allowUpload?: boolean;
  allowDangerousLaunch?: boolean;
}

/**
 * Resolve the bind host from the `expose` flag. Loopback unless the caller
 * explicitly opted into network exposure — mirrors the CLI host precedence.
 */
export function webBindHost(expose: boolean | undefined): string {
  return expose ? WEB_EXPOSE_HOST : WEB_LOOPBACK_HOST;
}

/** A dotted-quad IPv4 literal (each octet 0-255, no leading junk). */
function ipv4Octets(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/**
 * Whether a host is confined to this machine — and therefore whether a
 * credential may go to it over plain http.
 *
 * STRICT on purpose: a hostname is not an address. `127.0.0.1.nip.io` or
 * `127.evil.example` START with "127." but resolve wherever their owner says,
 * so only these count:
 *
 *   - an IPv4 literal in 127.0.0.0/8
 *   - exactly `localhost` (a trailing root dot is tolerated)
 *   - `::1`, bracketed or not
 *   - an IPv4-mapped IPv6 address whose IPv4 is in 127.0.0.0/8, in either
 *     the dotted (`::ffff:127.0.0.1`) or hex (`::ffff:7f00:1`) spelling
 *
 * Everything else — including `0.0.0.0`, which binds EVERY interface — is not.
 */
export function webHostIsLoopback(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.') && !h.endsWith('..')) h = h.slice(0, -1);
  if (h === 'localhost') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const v4 = ipv4Octets(h);
  if (v4) return v4[0] === 127;
  const mapped = /^(?:0{0,4}:){0,4}:?:ffff:(.+)$/.exec(h);
  if (mapped) {
    const tail = mapped[1];
    const dotted = ipv4Octets(tail);
    if (dotted) return dotted[0] === 127;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) return (parseInt(hex[1], 16) >> 8) === 127;
  }
  return false;
}

/** Whether an info's bind host is a loopback address (not phone-reachable). */
export function webIsLoopback(info: WebTerminalInfo): boolean {
  return typeof info.host === 'string' && webHostIsLoopback(info.host);
}

/** Whether an info's bind host is exposed on all interfaces. */
export function webIsExposed(info: WebTerminalInfo): boolean {
  return info.host === WEB_EXPOSE_HOST || info.host === '::';
}

// ─── Pairing flows, device kinds and the computer pairing link ─────────────

/**
 * Which card minted the current pairing code. The server has ONE code slot, so
 * the two flows are mutually exclusive: the pending name, input grant and flow
 * are held together and replaced together, never mixed.
 */
export type PairFlow = 'phone' | 'computer';

/**
 * What a paired device says it is. DISPLAY ONLY: it picks an icon in the
 * roster and is never read by an authorization decision. `unknown` covers
 * every record written before the field existed and any value outside the
 * allowlist.
 */
export type DeviceKind = 'phone' | 'computer' | 'unknown';

/** Request header the desktop client sends on `GET /api/pair`. */
export const DEVICE_KIND_HEADER = 'x-wmux-device-kind';

/** Allowlist a claimed device kind. Anything else is `unknown`. */
export function normalizeDeviceKind(raw: unknown): DeviceKind {
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim().toLowerCase();
  return value === 'phone' || value === 'computer' ? value : 'unknown';
}

/**
 * Fragment key of a computer pairing link: `<origin>/pair#wmux-desktop-code=X`.
 *
 * The code rides in the FRAGMENT so it never reaches a server log or a
 * Referer, and under a key the browser page recognises and refuses to redeem:
 * a computer link opened in a browser must not pair that browser. The same
 * string is duplicated in `daemon/web/frontend/pairQuery.js` (no bundler
 * there); a test keeps the two equal.
 */
export const DESKTOP_PAIR_FRAGMENT_KEY = 'wmux-desktop-code';

/** Build the computer pairing link for a pair origin (`https://host[:port]`). */
export function buildDesktopPairLink(origin: string, code: string): string {
  return `${origin}/pair#${DESKTOP_PAIR_FRAGMENT_KEY}=${encodeURIComponent(code)}`;
}

/**
 * The origin a computer pairing link may point at, or '' when none qualifies.
 *
 * Only an HTTPS address that another machine can reach: a Tailscale front or
 * the daemon's own TLS listener. A plaintext or loopback origin is never
 * offered — a device credential never expires, so it is not handed over in
 * the clear, and 127.0.0.1 means nothing on another computer.
 */
export function webComputerPairOrigin(info: WebTerminalInfo): string {
  if (!info.running || info.pairRefusal) return '';
  for (const raw of info.urls ?? []) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    if (webHostIsLoopback(url.hostname)) continue;
    return url.origin;
  }
  return '';
}

/** A device is "active now" when it was seen within this window. */
export const DEVICE_ACTIVE_WINDOW_MS = 120_000;
