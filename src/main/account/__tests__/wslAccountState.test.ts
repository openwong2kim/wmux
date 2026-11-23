import { describe, expect, it } from 'vitest';
import { isWslStateKey, MAX_WSL_STATE_KEY_LEN, WslAccountState, wslStateKey } from '../wslAccountState';

const PLACE = { distribution: 'Ubuntu', user: 'me' };
const RESET = 1_900_000_000;

describe('wslAccountState', () => {
  it('keys (account, distro, user) by a hash that fits the trail and reserve cap, and refuses one that would not', () => {
    const id = '0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
    const key = wslStateKey(id, PLACE);
    expect(key).toMatch(new RegExp(`^${id}@wsl:[0-9a-f]{16}$`));
    expect(key!.length).toBeLessThanOrEqual(MAX_WSL_STATE_KEY_LEN);
    expect(isWslStateKey(key!)).toBe(true);
    expect(wslStateKey(id, { distribution: 'ubuntu', user: 'me' })).toBe(key);
    expect(wslStateKey(id, { distribution: 'Ubuntu', user: 'other' })).not.toBe(key);
    expect(wslStateKey('x'.repeat(120), PLACE)).toBeNull();
    // No path or name of the distro is in the key.
    expect(key).not.toContain('Ubuntu');
  });

  it('stamps a reading by arrival, keeps the sign-in evidence apart, and seeds only what is older', () => {
    let now = 1_000_000;
    const s = new WslAccountState(() => now);
    expect(s.noteSample('a', PLACE, { session: { pct: 40, resetEpochSec: RESET }, weekly: { pct: 5, resetEpochSec: RESET + 86_400 } })?.sessionPct).toBe(40);
    s.noteAuth('a', PLACE, false);
    expect(s.get('a', PLACE)).toMatchObject({ sampleAtMs: 1_000_000, signedIn: false });
    now += 5_000;
    s.noteSample('a', PLACE, { session: { pct: 40, resetEpochSec: RESET }, weekly: { pct: 5, resetEpochSec: RESET + 86_400 } });
    expect(s.get('a', PLACE)?.sampleAtMs).toBe(1_005_000);
    const key = wslStateKey('a', PLACE)!;
    s.seed(key, { sessionPct: 99, fetchedAtMs: 0 }, 900_000);
    expect(s.get('a', PLACE)?.snapshot?.sessionPct).toBe(40);
    s.seed(wslStateKey('b', PLACE)!, { sessionPct: 99, fetchedAtMs: 0 }, now - 11 * 60_000);
    expect(s.reading('b', PLACE, 'bound')?.windows[0]?.remaining).toBeCloseTo(0.01);
    expect(s.reading('b', PLACE, 'candidate')).toBeNull();
    s.seed('not-a-wsl-key', { sessionPct: 1, fetchedAtMs: 0 }, 900_000);
    expect(s.all().map(([k]) => k)).not.toContain('not-a-wsl-key');
  });

  it('remembers where a plain pane asking for a distro (or the default one) starts', () => {
    const s = new WslAccountState();
    expect(s.defaultPlace('Ubuntu')).toBeUndefined();
    s.noteDefaultPlace('Ubuntu', PLACE);
    s.noteDefaultPlace(null, { distribution: 'Debian', user: 'root' });
    expect(s.defaultPlace('UBUNTU')).toEqual(PLACE);
    expect(s.defaultPlace(null)).toEqual({ distribution: 'Debian', user: 'root' });
  });
});
