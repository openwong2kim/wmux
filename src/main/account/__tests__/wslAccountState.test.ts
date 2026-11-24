import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageTrail } from '../../usage/usageTrail';
import { isWslStateKey, MAX_WSL_STATE_KEY_LEN, seedWslAccountState, WslAccountState, wslStateKey } from '../wslAccountState';

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

  it('(e) a restart seeds each home\'s last mirrored reading from the trail, and ignores other or over-long keys', () => {
    const now = 10_000_000;
    const s = new WslAccountState(() => now);
    const key = wslStateKey('a', PLACE)!;
    const trail: Record<string, Array<{ t: number; s5: number; r5: number; s7: number; r7: number }>> = {
      [key]: [{ t: now - 60 * 60_000, s5: 50, r5: RESET, s7: 5, r7: RESET }, { t: now - 30 * 60_000, s5: 100, r5: RESET, s7: 9, r7: RESET }],
      a: [{ t: now, s5: 1, r5: RESET, s7: 1, r7: RESET }],
      [`${'x'.repeat(120)}@wsl:0123456789abcdef`]: [{ t: now, s5: 1, r5: RESET, s7: 1, r7: RESET }],
    };
    seedWslAccountState(s, { keys: () => Object.keys(trail), read: (k) => trail[k] ?? [] });
    // The last sample, as the bound account's reading at any age; too old to be a candidate.
    expect(s.reading('a', PLACE, 'bound')?.windows[0]?.remaining).toBe(0);
    expect(s.reading('a', PLACE, 'candidate')).toBeNull();
    expect(s.all().map(([k]) => k)).toEqual([key]);
  });

  it('a home whose last turn failed on its sign-in has no reading, and a one-window plan gets one from its first sample', () => {
    const s = new WslAccountState(() => 1_000);
    s.noteSample('a', PLACE, { weekly: { pct: 70, resetEpochSec: RESET } });
    expect(s.reading('a', PLACE, 'candidate')?.windows).toEqual([{ remaining: expect.closeTo(0.3), resetAtMs: RESET * 1000 }]);
    s.noteAuth('a', PLACE, false);
    expect(s.reading('a', PLACE, 'candidate')).toBeNull();
    expect(s.reading('a', PLACE, 'bound')).toBeNull();
    s.noteAuth('a', PLACE, true);
    expect(s.reading('a', PLACE, 'bound')).not.toBeNull();
  });

  it('keeps the default places across a restart, so the first plain launch after one has a place', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-places-'));
    try {
      const file = path.join(dir, 'wsl-default-places.json');
      const before = new WslAccountState(() => 0, file);
      before.noteDefaultPlace('Ubuntu', PLACE);
      before.noteDefaultPlace(null, { distribution: 'Debian', user: 'root' });
      const restarted = new WslAccountState(() => 0, file);
      expect(restarted.defaultPlace('ubuntu')).toEqual(PLACE);
      // wsl.exe's default distro can change while wmux is closed: learned again each run.
      expect(restarted.defaultPlace(null)).toBeUndefined();
      expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(['ubuntu']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('learns the start place again after a restart only from a plain pane still running as the same process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-plain-'));
    try {
      const file = path.join(dir, 'wsl-default-places.json');
      let now = 1;
      const before = new WslAccountState(() => now, file);
      before.notePlainPane('s-old', { pid: 10, pidCreatedAtFt: 'ft-10' }, null);
      now = 2;
      before.notePlainPane('s-live', { pid: 11, pidCreatedAtFt: 'ft-11' }, null);
      before.notePlainPane('s-respawned', { pid: 12 }, null);
      before.notePlainPane('s-placeholder', { pid: 13, pidCreatedAtFt: 'ft-13' }, 'Debian');
      before.notePlainPane('s-recycled', { pid: 14, pidCreatedAtFt: 'ft-14' }, 'Alpine');
      before.notePlainPane('s-gone', { pid: 15 }, null);
      const after = new WslAccountState(() => 3, file);
      expect(after.hasUnlearnedPlainPanes()).toBe(true);
      after.learnFromLiveSessions([
        // A respawn (another process), a daemon restart's placeholder (old pid and target, 'suspended'),
        // and a pid now held by another process: none says where the distro starts now.
        { id: 's-respawned', pid: 99, state: 'attached', wslTarget: { distribution: 'Ubuntu', user: 'root' } },
        { id: 's-placeholder', pid: 13, pidCreatedAtFt: 'ft-13', state: 'suspended', wslTarget: { distribution: 'Debian', user: 'root' } },
        { id: 's-recycled', pid: 14, pidCreatedAtFt: 'ft-other', state: 'detached', wslTarget: { distribution: 'Alpine', user: 'root' } },
        // Two live reattaches for the unnamed default: the newer one wins.
        { id: 's-live', pid: 11, pidCreatedAtFt: 'ft-11', state: 'detached', wslTarget: PLACE },
        { id: 's-old', pid: 10, pidCreatedAtFt: 'ft-10', state: 'attached', wslTarget: { distribution: 'Ubuntu', user: 'old' } },
      ]);
      expect(after.defaultPlace('Debian')).toBeUndefined();
      expect(after.defaultPlace('Alpine')).toBeUndefined();
      expect(after.defaultPlace(null)).toEqual(PLACE);
      // Nothing left to learn: no further daemon read is needed.
      expect(after.hasUnlearnedPlainPanes()).toBe(false);
      // Only the live ones stay in the file; the unnamed default's place itself is never written.
      expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'wsl-plain-panes.json'), 'utf8'))).sort()).toEqual(['s-live', 's-old']);
      expect(fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))) : []).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a one-window plan is mirrored to the trail and seeded back without the window it does not have', () => {
    const trail = new UsageTrail();
    const key = wslStateKey('a', PLACE)!;
    expect(trail.record(key, { weeklyPct: 70, weeklyResetEpochSec: RESET, fetchedAtMs: 1 }, 1_000)).toBe(true);
    // Any other key still needs both windows.
    expect(trail.record('acc', { weeklyPct: 70, weeklyResetEpochSec: RESET, fetchedAtMs: 1 }, 1_000)).toBe(false);
    const s = new WslAccountState(() => 2_000);
    seedWslAccountState(s, trail);
    expect(s.reading('a', PLACE, 'bound')?.windows).toEqual([{ remaining: expect.closeTo(0.3), resetAtMs: RESET * 1000 }]);
  });
});

