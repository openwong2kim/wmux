import { describe, it, expect } from 'vitest';
import { isDeviceActiveNow, withActivity } from '../deviceActivity';
import { DEVICE_ACTIVE_WINDOW_MS } from '../../../shared/web';

/**
 * "N devices · M active now". Clock-driven rather than slept: each case is a
 * kind of client the daemon actually sees.
 */
const NOW = 1_800_000_000_000;
const stale = NOW - DEVICE_ACTIVE_WINDOW_MS - 1;
const none = new Set<string>();

describe('isDeviceActiveNow', () => {
  it('counts an SSE-only device by its live stream, even with a stale lastSeenAt', () => {
    // A stream never re-authenticates, so lastSeenAt stops at the ticket request.
    expect(isDeviceActiveNow({ deviceId: 'sse', lastSeenAt: stale }, new Set(['sse']), NOW)).toBe(true);
  });

  it('counts a polling-only device by its recent authenticated request', () => {
    expect(isDeviceActiveNow({ deviceId: 'poll', lastSeenAt: NOW - 5_000 }, none, NOW)).toBe(true);
    expect(isDeviceActiveNow({ deviceId: 'poll', lastSeenAt: NOW - DEVICE_ACTIVE_WINDOW_MS }, none, NOW)).toBe(true);
  });

  it('does not count a push-only device: a registered token is not presence', () => {
    // Receives notifications in a pocket; no stream, nothing recent.
    expect(isDeviceActiveNow({ deviceId: 'push', lastSeenAt: stale }, none, NOW)).toBe(false);
  });

  it('counts a device as inactive right after it is revoked, whatever else says otherwise', () => {
    const revoked = { deviceId: 'gone', lastSeenAt: NOW - 1_000, revokedAt: NOW };
    expect(isDeviceActiveNow(revoked, new Set(['gone']), NOW)).toBe(false);
  });
});

describe('withActivity', () => {
  it('stamps each row and leaves the rest of it alone', () => {
    const rows = withActivity(
      [
        { deviceId: 'a', lastSeenAt: NOW - 1_000, name: 'Phone' },
        { deviceId: 'b', lastSeenAt: stale, name: 'Laptop' },
        { deviceId: 'c', lastSeenAt: NOW, name: 'Revoked', revokedAt: NOW },
      ],
      none,
      NOW,
    );
    expect(rows.map((r) => [r.name, r.activeNow])).toEqual([
      ['Phone', true],
      ['Laptop', false],
      ['Revoked', false],
    ]);
    expect(rows.filter((r) => r.activeNow)).toHaveLength(1);
  });
});
