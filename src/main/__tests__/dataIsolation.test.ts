import { describe, it, expect } from 'vitest';
import { checkUserDataIsolation } from '../dataIsolation';

describe('checkUserDataIsolation (P2b suffix isolation guard)', () => {
  it('passes for an EMPTY suffix even when userData is the prod default (legit production)', () => {
    // The load-bearing case: no isolation requested → must NEVER crash a normal
    // production boot, even though userData equals the prod path.
    expect(checkUserDataIsolation('', 'C:\\Users\\x\\AppData\\Roaming\\wmux')).toEqual({ ok: true });
  });

  it('passes when the suffix IS reflected in userData', () => {
    expect(checkUserDataIsolation('-dev', 'C:\\Users\\x\\AppData\\Roaming\\wmux-dev')).toEqual({ ok: true });
  });

  it('passes for a custom isolation suffix (sandbox / dogfood)', () => {
    expect(checkUserDataIsolation('-sandbox-42', '/home/u/.config/wmux-sandbox-42')).toEqual({ ok: true });
  });

  it('FAILS LOUD when a non-empty suffix is NOT reflected (setPath threw → prod dir)', () => {
    const r = checkUserDataIsolation('-dev', 'C:\\Users\\x\\AppData\\Roaming\\wmux');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/isolation broken/);
    expect(r.ok === false && r.error).toMatch(/-dev/);
  });

  it('does not fail-loud on the prod path purely because it lacks a suffix', () => {
    // Distinguishes the ENV axis (no suffix at all → legitimate prod) from the
    // CODE axis (suffix set but setPath failed → the bug). Only the latter trips,
    // so this guard can never turn a normal production launch into a crash.
    expect(checkUserDataIsolation('', '/home/u/.config/wmux').ok).toBe(true);
  });
});
