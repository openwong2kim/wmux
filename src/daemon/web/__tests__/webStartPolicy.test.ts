import { describe, expect, it } from 'vitest';
import type { WebTlsConfig } from '../../../shared/web';
import type { WebPersistedState } from '../webStateStore';
import {
  decideWebStartPolicy,
  resolveWebInlineImages,
  resolveWebStartGrants,
  type WebStartPolicyInput,
} from '../webStartPolicy';

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
    live: undefined,
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

  it('rotates credentials when explicit native TLS repairs an invalid record', () => {
    expect(
      decide({
        requestedTls: TLS,
        previous: previous({ enabled: false }),
        previousTransportInvalid: true,
      }),
    ).toEqual({ tls: TLS, token: undefined, rotateCredentials: true });
  });

  it('uses the live transport and token when persisted state is stale', () => {
    expect(
      decide({
        previous: previous(),
        live: {
          tls: TLS,
          tailscale: false,
          host: '127.0.0.1',
          token: 'live-token',
        },
      }),
    ).toEqual({ tls: TLS, token: 'live-token', rotateCredentials: false });

    expect(
      decide({
        previous: previous({ tls: TLS }),
        live: {
          tls: undefined,
          tailscale: false,
          host: '127.0.0.1',
          token: 'live-http-token',
        },
      }),
    ).toEqual({
      tls: undefined,
      token: 'live-http-token',
      rotateCredentials: false,
    });
  });

  it('always rotates on --new-token without changing the transport', () => {
    expect(decide({ requestedTls: false, newToken: true })).toEqual({
      tls: undefined,
      token: undefined,
      rotateCredentials: true,
    });
  });

  it('leaves token generation to the server when disabled state has no token', () => {
    expect(
      decide({
        requestedTls: false,
        previous: previous({ enabled: false, token: '' }),
      }),
    ).toEqual({ tls: undefined, token: undefined, rotateCredentials: false });
  });

  it('rejects native TLS combined with Tailscale', () => {
    expect(() => decide({ requestedTls: TLS, tailscale: true })).toThrow(
      'native TLS cannot be combined with the Tailscale transport',
    );
  });
});

describe('web start grant resolution', () => {
  const liveGrants = {
    allowInput: false,
    allowUpload: true,
    allowTranscript: true,
    allowDangerousLaunch: true,
  };

  it('keeps the CLI contract: an absent grant is off unless the caller opts into inheritance', () => {
    expect(
      resolveWebStartGrants({ allowInput: true }, liveGrants, previous({ allowTranscript: true })),
    ).toEqual({
      allowInput: true,
      allowUpload: false,
      allowTranscript: false,
      allowDangerousLaunch: false,
    });
  });

  it('a desktop start over a running server keeps the grants it does not send', () => {
    expect(
      resolveWebStartGrants(
        { allowInput: true, allowUpload: false, inheritUnsetGrants: true },
        liveGrants,
        previous(),
      ),
    ).toEqual({
      allowInput: true,
      allowUpload: false,
      allowTranscript: true,
      allowDangerousLaunch: true,
    });
  });

  it('a desktop start with no live server inherits the persisted, still-enabled record', () => {
    expect(
      resolveWebStartGrants(
        { allowInput: false, inheritUnsetGrants: true },
        undefined,
        previous({ allowUpload: true, allowTranscript: true, allowDangerousLaunch: true }),
      ),
    ).toEqual({
      allowInput: false,
      allowUpload: true,
      allowTranscript: true,
      allowDangerousLaunch: true,
    });
  });

  it('inherits nothing from a record an operator stop has disabled', () => {
    expect(
      resolveWebStartGrants(
        { inheritUnsetGrants: true },
        undefined,
        previous({ enabled: false, allowTranscript: true, allowDangerousLaunch: true }),
      ),
    ).toEqual({
      allowInput: false,
      allowUpload: false,
      allowTranscript: false,
      allowDangerousLaunch: false,
    });
  });

  it('never coerces a non-boolean grant into a decision', () => {
    expect(
      resolveWebStartGrants(
        { allowTranscript: 'yes', allowDangerousLaunch: 1 },
        undefined,
        previous(),
      ),
    ).toEqual({
      allowInput: false,
      allowUpload: false,
      allowTranscript: false,
      allowDangerousLaunch: false,
    });
  });
});

describe('inline images switch (#1641)', () => {
  it('is on for a fresh server', () => {
    expect(resolveWebInlineImages(undefined, undefined, previous({ enabled: false }))).toBe(true);
  });

  it('an explicit value always wins', () => {
    expect(resolveWebInlineImages(false, { inlineImages: true }, previous())).toBe(false);
    expect(resolveWebInlineImages(true, { inlineImages: false }, previous({ inlineImages: false }))).toBe(true);
  });

  it('a re-run that does not say keeps the running server\'s choice', () => {
    expect(resolveWebInlineImages(undefined, { inlineImages: false }, previous())).toBe(false);
    expect(resolveWebInlineImages(undefined, { inlineImages: true }, previous({ inlineImages: false }))).toBe(true);
  });

  it('a restart keeps the persisted off, and an operator stop clears it', () => {
    expect(resolveWebInlineImages(undefined, undefined, previous({ inlineImages: false }))).toBe(false);
    expect(
      resolveWebInlineImages(undefined, undefined, previous({ enabled: false, inlineImages: false })),
    ).toBe(true);
  });
});
