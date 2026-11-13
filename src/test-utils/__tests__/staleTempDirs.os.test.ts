// The sweep of a killed run's temp dirs removes only stale, unused dirs of its
// own prefix, directly in the temp dir, and never follows a link out of it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STALE_TEMP_DIR_AGE_MS, chromeHoldsProfile, sweepStaleTempDirs } from '../staleTempDirs';

const isWin = process.platform === 'win32';
const PREFIX = 'wmux-sweep-test-';
const DAY = STALE_TEMP_DIR_AGE_MS;
let root = '';
let outside = '';

/** A dir named and moded as mkdtemp makes it, with a file in it, made `ageMs` old. */
function leftover(name: string, ageMs: number): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'Preferences'), '{}');
  age(dir, ageMs);
  return dir;
}

function age(p: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  for (const name of fs.readdirSync(p)) fs.lutimesSync(path.join(p, name), t, t);
  fs.utimesSync(p, t, t);
}

const kept = () => fs.readdirSync(root).sort();
const host = os.hostname();
// Above any pid Linux (pid_max at most 2^22) or macOS hands out, yet seven digits.
const DEAD_PID = 4194305;
// A boot long before these tests' aged dirs, so only the pid and host decide.
const bootLongAgo = () => Date.now() - 30 * DAY;
const holds = (dir: string) => chromeHoldsProfile(dir, process.platform, bootLongAgo());
// No live Chrome in these dirs unless a test gives one a lock.
const unused = () => false;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sweep-root-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sweep-outside-')));
  fs.writeFileSync(path.join(outside, 'keep-me'), 'x');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('sweepStaleTempDirs', () => {
  it('removes a stale, unused dir of its prefix, and keeps a fresh one', () => {
    const stale = leftover(`${PREFIX}aB3dE9`, 2 * DAY);
    leftover(`${PREFIX}Fresh1`, 60_000);
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: unused })).toEqual([stale]);
    expect(kept()).toEqual([`${PREFIX}Fresh1`]);
  });

  it('keeps a dir whose newest entry is recent, though the dir itself is old', () => {
    const dir = leftover(`${PREFIX}Touch1`, 2 * DAY);
    fs.utimesSync(path.join(dir, 'Preferences'), new Date(), new Date());
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: unused })).toEqual([]);
    expect(kept()).toEqual([`${PREFIX}Touch1`]);
  });

  it('keeps a dir with recent activity deep inside, though its top level is old', () => {
    const dir = leftover(`${PREFIX}Deep01`, 2 * DAY);
    fs.mkdirSync(path.join(dir, 'Default', 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Default', 'Cache', 'data_0'), 'x');
    const t = new Date(Date.now() - 2 * DAY);
    fs.utimesSync(path.join(dir, 'Default'), t, t);
    fs.utimesSync(dir, t, t);
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: unused })).toEqual([]);
    expect(kept()).toEqual([`${PREFIX}Deep01`]);
  });

  it.skipIf(isWin)('keeps a dir open to other users, as mkdtemp never makes one', () => {
    const dir = leftover(`${PREFIX}Open01`, 2 * DAY);
    fs.chmodSync(dir, 0o755);
    age(dir, 2 * DAY);
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: unused })).toEqual([]);
    expect(kept()).toEqual([`${PREFIX}Open01`]);
  });

  it.skipIf(isWin)('sweeps nothing in a temp dir any user can rename entries in, unless it is sticky', () => {
    const stale = leftover(`${PREFIX}aB3dE9`, 2 * DAY);
    fs.chmodSync(root, 0o777);
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: unused })).toEqual([]);
    fs.chmodSync(root, 0o770);
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: unused })).toEqual([]);
    fs.chmodSync(root, 0o1777);
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: unused })).toEqual([stale]);
    fs.chmodSync(root, 0o700);
  });

  it('keeps every name that is not exactly the prefix plus six characters', () => {
    const names = [
      'other-prefix-aB3dE9',
      `${PREFIX}extra-aB3dE9`,
      `${PREFIX}aB3dE`,
      `${PREFIX}aB3dE9x`,
      `x${PREFIX}aB3dE9`,
      `${PREFIX}aB.dE9`,
    ];
    for (const name of names) leftover(name, 2 * DAY);
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: unused })).toEqual([]);
    expect(kept()).toEqual([...names].sort());
  });

  it('refuses a prefix that is not a plain mkdtemp prefix ending in a dash', () => {
    leftover(`${PREFIX}aB3dE9`, 2 * DAY);
    // What mkdtemp would make for a dashless prefix: still refused.
    leftover('wmux-sweep-testaB3dE9', 2 * DAY);
    for (const bad of ['', '-', '../wmux-sweep-test-', 'wmux-sweep-test', 'a/b-', '.*-']) {
      expect(sweepStaleTempDirs(bad, { root, inUse: unused }), JSON.stringify(bad)).toEqual([]);
    }
    expect(kept()).toEqual([`${PREFIX}aB3dE9`, 'wmux-sweep-testaB3dE9']);
  });

  it.skipIf(isWin)('keeps a link named like its prefix, and what it points to', () => {
    const link = path.join(root, `${PREFIX}Link01`);
    fs.symlinkSync(outside, link);
    fs.lutimesSync(link, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
    age(outside, 2 * DAY);
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: unused })).toEqual([]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'keep-me'), 'utf8')).toBe('x');
  });

  it.skipIf(isWin)('removes a stale dir holding a link out of the temp dir without following it', () => {
    const dir = path.join(root, `${PREFIX}Inner1`);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(dir, 'Default'));
    age(dir, 2 * DAY);
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: unused })).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'keep-me'), 'utf8')).toBe('x');
  });

  it('keeps a dir something still uses', () => {
    const dir = leftover(`${PREFIX}InUse1`, 2 * DAY);
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: (d) => d === dir })).toEqual([]);
    expect(kept()).toEqual([`${PREFIX}InUse1`]);
  });

  it('counts the temp dir it is given through its realpath', () => {
    const viaLink = path.join(outside, 'root-link');
    if (!isWin) fs.symlinkSync(root, viaLink);
    const stale = leftover(`${PREFIX}aB3dE9`, 2 * DAY);
    expect(sweepStaleTempDirs(PREFIX, { root: isWin ? root : viaLink, inUse: unused })).toEqual([stale]);
  });
});

describe('chromeHoldsProfile', () => {
  it.skipIf(isWin)('a SingletonLock naming a live pid holds the profile; one naming a gone pid does not', () => {
    const live = leftover(`${PREFIX}Live01`, 2 * DAY);
    fs.symlinkSync(`${host}-${process.pid}`, path.join(live, 'SingletonLock'));
    // Old again after the lock: only the lock keeps it.
    age(live, 2 * DAY);
    expect(holds(live)).toBe(true);

    const gone = leftover(`${PREFIX}Gone01`, 2 * DAY);
    fs.symlinkSync(`${host}-${DEAD_PID}`, path.join(gone, 'SingletonLock'));
    age(gone, 2 * DAY);
    expect(holds(gone)).toBe(false);

    // Through the sweep: the live one stays, the gone one goes.
    expect(sweepStaleTempDirs(PREFIX, { root, inUse: holds })).toEqual([gone]);
    expect(kept()).toEqual([`${PREFIX}Live01`]);
  });

  it.skipIf(isWin)('a lock naming another host, or a pid of another shape, counts as held', () => {
    const gone = String(DEAD_PID);
    const targets = [`not-${host}-${gone}`, `${host}-0`, `${host}-0${gone}`, `${host}-99999999`, `${host}-${gone}x`, `${host}-`, `-${gone}`, gone];
    for (const [i, target] of targets.entries()) {
      const dir = leftover(`${PREFIX}Shape${i}`, 2 * DAY);
      fs.symlinkSync(target, path.join(dir, 'SingletonLock'));
      expect(holds(dir), target).toBe(true);
    }
  });

  it.skipIf(isWin)('a lock made before the last boot is free, whatever pid or host it names', () => {
    for (const [i, target] of [`${host}-${process.pid}`, `not-${host}-${process.pid}`].entries()) {
      const dir = leftover(`${PREFIX}Boot0${i}`, 2 * DAY);
      fs.symlinkSync(target, path.join(dir, 'SingletonLock'));
      age(dir, 2 * DAY);
      // Booted a day ago: the lock is older, so nothing alive made it.
      expect(chromeHoldsProfile(dir, process.platform, Date.now() - DAY), target).toBe(false);
      expect(holds(dir), target).toBe(true);
    }
  });

  it.skipIf(isWin)('a lock it cannot read counts as held', () => {
    const dir = leftover(`${PREFIX}Odd001`, 2 * DAY);
    fs.writeFileSync(path.join(dir, 'SingletonLock'), 'not a link');
    expect(holds(dir)).toBe(true);
  });

  it('no lock: not held; on Windows a lockfile holds it', () => {
    const dir = leftover(`${PREFIX}NoLck1`, 2 * DAY);
    expect(chromeHoldsProfile(dir, 'darwin')).toBe(false);
    expect(chromeHoldsProfile(dir, 'win32')).toBe(false);
    fs.writeFileSync(path.join(dir, 'lockfile'), '');
    expect(chromeHoldsProfile(dir, 'win32')).toBe(true);
  });
});
