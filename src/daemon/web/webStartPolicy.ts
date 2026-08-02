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
