import { webHostIsLoopback, type WebTlsConfig } from '../../shared/web';
import type { WebPersistedState } from './webStateStore';

export interface WebStartPolicyInput {
  requestedTls: WebTlsConfig | false | undefined;
  live: {
    tls: WebTlsConfig | undefined;
    tailscale: boolean;
    host: string;
    token: string;
  } | undefined;
  previous: WebPersistedState;
  previousTransportInvalid: boolean;
  host: string;
  tailscale: boolean;
  newToken: boolean;
}

export interface WebStartPolicyDecision {
  tls: WebTlsConfig | undefined;
  token: string | undefined;
  /** Revoke device credentials as well as minting a new operator token. */
  rotateCredentials: boolean;
}

/**
 * Resolve the transport and credential boundary for one daemon.web.start.
 *
 * Kept pure so every security-sensitive transition is covered on all CI
 * platforms without a daemon bundle, a socket, or OpenSSL.
 */
export function decideWebStartPolicy(input: WebStartPolicyInput): WebStartPolicyDecision {
  const {
    requestedTls,
    live,
    previous,
    previousTransportInvalid,
    host,
    tailscale,
    newToken,
  } = input;

  // An option-only caller did not choose a transport. A corrupt persisted
  // transport must therefore remain fail-closed rather than becoming HTTP.
  // Explicit native TLS, Tailscale, or `tls:false` can repair the record.
  if (
    requestedTls === undefined &&
    !tailscale &&
    live === undefined &&
    previousTransportInvalid
  ) {
    throw new Error(
      'persisted web TLS configuration is invalid; explicitly choose native TLS, Tailscale, or plain HTTP',
    );
  }

  const tls =
    requestedTls === false || (requestedTls === undefined && tailscale)
      ? undefined
      : requestedTls ?? (live ? live.tls : previous.tls);
  if (tls && tailscale) {
    throw new Error('native TLS cannot be combined with the Tailscale transport');
  }

  // A Tailscale flag proves confidentiality only when the backend is confined
  // to loopback. `--tailscale --expose` deliberately keeps a plaintext LAN
  // listener too (with a CLI warning), so it is not an encrypted-only state.
  const previousWasEncrypted = live
    ? live.tls !== undefined || (live.tailscale && webHostIsLoopback(live.host))
    : previousTransportInvalid ||
      previous.tls !== undefined ||
      (previous.tailscale && webHostIsLoopback(previous.host));
  const nextIsEncrypted = tls !== undefined || (tailscale && webHostIsLoopback(host));
  const hadPreviousTransport = live !== undefined || previous.token !== '';
  const crossesEncryptionBoundary =
    hadPreviousTransport && previousWasEncrypted !== nextIsEncrypted;
  // A record whose transport could not be validated cannot safely vouch for
  // any credential it carries, even when the explicit repair chooses TLS.
  const rotateCredentials =
    newToken || (live === undefined && previousTransportInvalid) || crossesEncryptionBoundary;

  // #596 keeps credentials stable for same-transport reconfiguration. Crossing
  // the encrypted/plaintext boundary rotates both directions: a downgrade must
  // not expose an HTTPS credential, and an upgrade must not trust one that may
  // already have been observed in cleartext.
  const canReusePreviousToken =
    !rotateCredentials && (live !== undefined || previous.enabled || tls !== undefined);
  const previousToken = live?.token || previous.token;
  const token = canReusePreviousToken ? previousToken || undefined : undefined;

  return { tls, token, rotateCredentials };
}

/**
 * Whether the web client draws inline images (#1641).
 *
 * Not a grant: it is on by default and only the operator turns it off
 * (`wmux web --no-inline-images`). So it is always inherited when a start does
 * not say — from the running server, else from the persisted record while that
 * record is still enabled — and every caller that does not know about it (the
 * desktop popover, an older CLI) keeps the operator's choice.
 */
export function resolveWebInlineImages(
  explicit: unknown,
  live: { inlineImages?: boolean } | undefined,
  previous: WebPersistedState,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  if (live) return live.inlineImages !== false;
  return !(previous.enabled && previous.inlineImages === false);
}

/** The four per-server phone grants a `daemon.web.start` decides. */
export interface WebStartGrants {
  allowInput: boolean;
  allowUpload: boolean;
  allowTranscript: boolean;
  allowDangerousLaunch: boolean;
}

const GRANT_KEYS = ['allowInput', 'allowUpload', 'allowTranscript', 'allowDangerousLaunch'] as const;

/**
 * Resolve the grants for one daemon.web.start.
 *
 * An explicit boolean always wins. Otherwise a grant is OFF — the fail-closed
 * default the CLI relies on (`wmux web` without `--allow-transcript` means
 * "no transcript") — unless the caller set `inheritUnsetGrants`. The desktop
 * sets it because it does not own every grant: it has no control for the
 * dangerous-launch ceiling, and a start or in-place restart from the popover
 * used to reset a ceiling the operator set with the CLI. With inheritance an
 * unsent grant keeps the running server's value, or the persisted record's
 * when nothing is running and that record is still enabled. An operator stop
 * clears the record, so inheritance never revives a revoked grant.
 */
export function resolveWebStartGrants(
  params: Partial<Record<(typeof GRANT_KEYS)[number] | 'inheritUnsetGrants', unknown>>,
  live: Partial<WebStartGrants> | undefined,
  previous: WebPersistedState,
): WebStartGrants {
  const inherit = params.inheritUnsetGrants === true;
  const resolve = (key: (typeof GRANT_KEYS)[number]): boolean => {
    const explicit = params[key];
    if (typeof explicit === 'boolean') return explicit;
    if (!inherit) return false;
    if (live) return live[key] === true;
    return previous.enabled && previous[key] === true;
  };
  return {
    allowInput: resolve('allowInput'),
    allowUpload: resolve('allowUpload'),
    allowTranscript: resolve('allowTranscript'),
    allowDangerousLaunch: resolve('allowDangerousLaunch'),
  };
}
