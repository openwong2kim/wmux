import { describe, it, expect } from 'vitest';
import { newerTimestamp } from '../idleAnchor';

describe('newerTimestamp (#1316)', () => {
  it('takes the later of two live sources', () => {
    expect(newerTimestamp(100, 500)).toBe(500);
    expect(newerTimestamp(500, 100)).toBe(500);
  });

  it('treats null as "this source has never seen anybody", not as zero', () => {
    // The whole point: a daemon that has never had a pipe client but IS being
    // used from a phone must anchor on the phone, and folding null in as 0
    // would instead have Watchdog measure from the epoch.
    expect(newerTimestamp(null, 500)).toBe(500);
    expect(newerTimestamp(500, null)).toBe(500);
  });

  it('answers null only when no source has seen anybody', () => {
    // Watchdog falls back to the daemon's startTime for this case, so a daemon
    // that booted and was never touched still counts its idle window from boot.
    expect(newerTimestamp(null, null)).toBeNull();
  });
});
