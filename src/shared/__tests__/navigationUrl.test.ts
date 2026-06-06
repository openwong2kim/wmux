import { describe, expect, it } from 'vitest';
import { validateNavigationUrl } from '../types';

describe('validateNavigationUrl', () => {
  it('allows public HTTP(S), localhost, and exact loopback development URLs', () => {
    expect(validateNavigationUrl('https://example.com')).toEqual({ valid: true });
    expect(validateNavigationUrl('http://localhost:3000')).toEqual({ valid: true });
    expect(validateNavigationUrl('http://127.0.0.1:5173')).toEqual({ valid: true });
    expect(validateNavigationUrl('http://[::1]:5173')).toEqual({ valid: true });
  });

  it('blocks private and link-local IPv4 literal URLs', () => {
    expect(validateNavigationUrl('http://10.0.0.1/')).toEqual({
      valid: false,
      reason: 'Blocked private IP address (10.0.0.0/8)',
    });
    expect(validateNavigationUrl('http://169.254.169.254/')).toEqual({
      valid: false,
      reason: 'Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
  });

  it('blocks bracketed private and link-local IPv6 literal URLs', () => {
    expect(validateNavigationUrl('http://[fc00::1]/')).toEqual({
      valid: false,
      reason: 'Blocked private IPv6 address (fc00::/7)',
    });
    expect(validateNavigationUrl('http://[fd00::1]/')).toEqual({
      valid: false,
      reason: 'Blocked private IPv6 address (fc00::/7)',
    });
    expect(validateNavigationUrl('http://[fe80::1]/')).toEqual({
      valid: false,
      reason: 'Blocked link-local IPv6 address (fe80::/10)',
    });
  });

  it('blocks IPv4-mapped and IPv4-compatible IPv6 forms with private embedded addresses', () => {
    expect(validateNavigationUrl('http://[::ffff:169.254.169.254]/')).toEqual({
      valid: false,
      reason: 'Blocked IPv4-mapped/compatible IPv6: embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
    expect(validateNavigationUrl('http://[::ffff:a9fe:a9fe]/')).toEqual({
      valid: false,
      reason: 'Blocked IPv4-mapped/compatible IPv6: embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
    expect(validateNavigationUrl('http://[::169.254.169.254]/')).toEqual({
      valid: false,
      reason: 'Blocked IPv4-mapped/compatible IPv6: embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
  });
});
