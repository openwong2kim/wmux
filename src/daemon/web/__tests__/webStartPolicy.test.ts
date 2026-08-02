import { describe, expect, it } from 'vitest';
import type { WebTlsConfig } from '../../../shared/web';
import type { WebPersistedState } from '../webStateStore';
import { decideWebStartPolicy, type WebStartPolicyInput } from '../webStartPolicy';

const TLS: WebTlsConfig = {
  certPath: '/absolute/certificate.pem',
  keyPath: '/absolute/private-key.pem',
};

function previous(overrides: Partial<WebPersistedState> = {}): WebPersistedState {
  return {
    version: 1,
    enabled: true,
    port: 7681,
    host: '127.0.0.1',
    allowInput: false,
    allowUpload: false,
    allowedHosts: [],
    tailscale: false,
    token: 'previous-token',
    ...overrides,
  };
}

function decide(overrides: Partial<WebStartPolicyInput> = {}) {
  return decideWebStartPolicy({
    requestedTls: undefined,
    liveTls: undefined,
    previous: previous(),
    previousTransportInvalid: false,
    host: '127.0.0.1',
    tailscale: false,
    newToken: false,
    ...overrides,
  });
}

describe('web start transport and credential policy', () => {
  it('keeps the token for ordinary HTTP-to-HTTP reconfiguration', () => {
    expect(decide({ requestedTls: false })).toEqual({
      tls: undefined,
      token: 'previous-token',
      rotateCredentials: false,
    });
  });

  it('preserves persisted native TLS for an option-only caller', () => {
    expect(decide({ previous: previous({ tls: TLS }) })).toEqual({
      tls: TLS,
      token: 'previous-token',
      rotateCredentials: false,
    });
  });

  it('rotates every credential on native HTTPS-to-HTTP downgrade', () => {
    expect(
      decide({ requestedTls: false, previous: previous({ tls: TLS }) }),
    ).toEqual({ tls: undefined, token: undefined, rotateCredentials: true });
  });

  it('rotates every credential on HTTP-to-native-HTTPS upgrade', () => {
    expect(decide({ requestedTls: TLS })).toEqual({
      tls: TLS,
      token: undefined,
      rotateCredentials: true,
    });
  });

  it('keeps credentials while moving between encrypted native and Tailscale fronts', () => {
    expect(
      decide({
        tailscale: true,
        previous: previous({ tls: TLS }),
      }),
    ).toEqual({ tls: undefined, token: 'previous-token', rotateCredentials: false });

    expect(
      decide({
        requestedTls: TLS,
        previous: previous({ tailscale: true }),
      }),
    ).toEqual({ tls: TLS, token: 'previous-token', rotateCredentials: false });
  });

  it('does not treat an exposed Tailscale backend as encrypted-only', () => {
    expect(
      decide({
        tailscale: true,
        host: '0.0.0.0',
        previous: previous({ tls: TLS }),
      }),
    ).toEqual({ tls: undefined, token: undefined, rotateCredentials: true });
  });

  it('rejects option-only fallback from malformed persisted TLS', () => {
    expect(() =>
      decide({
        previous: previous({ enabled: false }),
        previousTransportInvalid: true,
      }),
    ).toThrow('persisted web TLS configuration is invalid');
  });

  it('lets an explicit HTTP choice repair malformed TLS and rotates credentials', () => {
    expect(
      decide({
        requestedTls: false,
        previous: previous({ enabled: false }),
        previousTransportInvalid: true,
      }),
    ).toEqual({ tls: undefined, token: undefined, rotateCredentials: true });
  });

  it('always rotates on --new-token without changing the transport', () => {
    expect(decide({ requestedTls: false, newToken: true })).toEqual({
      tls: undefined,
      token: undefined,
      rotateCredentials: true,
    });
  });

  it('rejects native TLS combined with Tailscale', () => {
    expect(() => decide({ requestedTls: TLS, tailscale: true })).toThrow(
      'native TLS cannot be combined with the Tailscale transport',
    );
  });
});
