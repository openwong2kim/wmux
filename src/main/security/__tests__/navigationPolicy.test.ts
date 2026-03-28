import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateResolvedNavigationUrl } from '../navigationPolicy';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}));

describe('validateResolvedNavigationUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows public resolved addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await expect(validateResolvedNavigationUrl('https://example.com')).resolves.toEqual({ valid: true });
  });

  it('blocks hostnames that resolve to private IPv4 space', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.1.25', family: 4 }]);

    await expect(validateResolvedNavigationUrl('https://internal.example')).resolves.toEqual({
      valid: false,
      reason: 'Blocked resolved address 192.168.1.25: Blocked private IP address (192.168.0.0/16)',
    });
  });

  it('blocks hostnames that resolve to cloud metadata space', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(validateResolvedNavigationUrl('https://metadata.example')).resolves.toEqual({
      valid: false,
      reason: 'Blocked resolved address 169.254.169.254: Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
  });

  it('blocks mixed resolution results when any resolved address is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.9', family: 4 },
    ]);

    await expect(validateResolvedNavigationUrl('https://mixed.example')).resolves.toEqual({
      valid: false,
      reason: 'Blocked resolved address 10.0.0.9: Blocked private IP address (10.0.0.0/8)',
    });
  });

  it('allows localhost without DNS resolution', async () => {
    await expect(validateResolvedNavigationUrl('http://localhost:3000')).resolves.toEqual({ valid: true });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks private IPv6 targets after hostname resolution', async () => {
    lookupMock.mockResolvedValue([{ address: 'fd12:3456:789a::1', family: 6 }]);

    await expect(validateResolvedNavigationUrl('https://ipv6.example')).resolves.toEqual({
      valid: false,
      reason: 'Blocked resolved address fd12:3456:789a::1: Blocked private IPv6 address (fc00::/7)',
    });
  });
});
