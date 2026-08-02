import { webHostIsLoopback, type WebTlsConfig } from '../../shared/web';
import type { WebPersistedState } from './webStateStore';

export interface WebStartPolicyInput {
  requestedTls: WebTlsConfig | false | undefined;
  liveTls: WebTlsConfig | undefined;
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
    liveTls,
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
    liveTls === undefined &&
    previousTransportInvalid
  ) {
    throw new Error(
      'persisted web TLS configuration is invalid; explicitly choose native TLS, Tailscale, or plain HTTP',
    );
  }

  const tls =
    requestedTls === false || (requestedTls === undefined && tailscale)
      ? undefined
      : requestedTls ?? liveTls ?? previous.tls;
  if (tls && tailscale) {
    throw new Error('native TLS cannot be combined with the Tailscale transport');
  }

  // A Tailscale flag proves confidentiality only when the backend is confined
  // to loopback. `--tailscale --expose` deliberately keeps a plaintext LAN
  // listener too (with a CLI warning), so it is not an encrypted-only state.
  const previousWasEncrypted =
    previousTransportInvalid ||
    previous.tls !== undefined ||
    (previous.tailscale && webHostIsLoopback(previous.host));
  const nextIsEncrypted = tls !== undefined || (tailscale && webHostIsLoopback(host));
  const crossesEncryptionBoundary =
    previous.token !== '' && previousWasEncrypted !== nextIsEncrypted;
  const rotateCredentials = newToken || crossesEncryptionBoundary;

  // #596 keeps credentials stable for same-transport reconfiguration. Crossing
  // the encrypted/plaintext boundary rotates both directions: a downgrade must
  // not expose an HTTPS credential, and an upgrade must not trust one that may
  // already have been observed in cleartext.
  const canReusePreviousToken =
    !rotateCredentials && (previous.enabled || tls !== undefined);
  const token = canReusePreviousToken ? previous.token || undefined : undefined;

  return { tls, token, rotateCredentials };
}
