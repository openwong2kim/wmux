// The real Windows read: the PowerShell script runs against this machine's own
// addresses and answers with one of the four categories.
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { readNetCategory } from '../netCategory';

function firstExternalIPv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

describe.runIf(process.platform === 'win32')('readNetCategory on Windows', () => {
  it('reads a category for a live external address', async () => {
    const ip = firstExternalIPv4();
    if (!ip) return; // a runner with no external IPv4 has nothing to read
    await expect(readNetCategory(ip)).resolves.toMatch(/^(Private|Public|Domain|Unknown)$/);
  }, 20_000);

  it('rejects for an address this machine does not have', async () => {
    await expect(readNetCategory('203.0.113.250')).rejects.toThrow();
  }, 20_000);
});

describe.runIf(process.platform !== 'win32')('readNetCategory elsewhere', () => {
  it('is not-applicable', async () => {
    await expect(readNetCategory('192.168.1.10')).resolves.toBe('not-applicable');
  });
});
