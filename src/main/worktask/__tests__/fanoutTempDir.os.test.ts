// ─── Per-worker private temp dir: creation, env, and the close sweep ────────
//
// The first case is adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src-tauri/src/control.rs — workers_get_distinct_private_scratch_and_matching_temp_environment),
// MIT License, Copyright (c) 2026 Nick.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FANOUT_TEMP_ENV_KEYS,
  TEMPDIR_ABSENT_GRACE_MS,
  TEMPDIR_BOOT_GRACE_MS,
  WorkerTempDirSweeper,
  createWorkerTempDir,
  isDirectChildOfTempRoot,
  liveTempDirsFromSessions,
  removeWorkerTempDir,
  workerTempEnv,
} from '../fanoutTempDir';

let base: string;
let root: string;
let registry: string;

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-tempdir-test-')));
  root = path.join(base, 'tmp');
  fs.mkdirSync(root);
  registry = path.join(base, 'fanout-tempdirs.json');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('createWorkerTempDir', () => {
  it('gives each worker a distinct owner-only dir and a matching temp env', () => {
    const first = createWorkerTempDir(root);
    const second = createWorkerTempDir(root);
    expect(first).not.toBe(second);
    expect(path.isAbsolute(first)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(first).mode & 0o777).toBe(0o700);
    }
    const env = workerTempEnv(first);
    for (const key of FANOUT_TEMP_ENV_KEYS) expect(env[key]).toBe(first);
  });
});

describe('removeWorkerTempDir', () => {
  it('removes only a real prefixed dir that is a direct child of the real temp root', async () => {
    const ours = createWorkerTempDir(root);
    fs.writeFileSync(path.join(ours, 'scratch.txt'), 'x');

    const foreign = path.join(root, 'keep-me');
    fs.mkdirSync(foreign);
    expect(await removeWorkerTempDir(foreign, root)).toBe('refused');

    // Prefixed but nested deeper (a tampered registry entry).
    const nested = path.join(foreign, 'wmux-task-deep');
    fs.mkdirSync(nested);
    expect(await removeWorkerTempDir(nested, root)).toBe('refused');
    expect(fs.existsSync(nested)).toBe(true);

    if (process.platform !== 'win32') {
      // The dir itself is a symlink.
      const link = path.join(root, 'wmux-task-link');
      fs.symlinkSync(foreign, link);
      expect(await removeWorkerTempDir(link, root)).toBe('refused');
      expect(fs.existsSync(foreign)).toBe(true);
      // The parent is a symlink that resolves to the temp root.
      const aliasRoot = path.join(base, 'alias');
      fs.symlinkSync(root, aliasRoot);
      expect(await removeWorkerTempDir(path.join(aliasRoot, path.basename(ours)), root)).toBe('refused');
      expect(fs.existsSync(ours)).toBe(true);
    }

    expect(await removeWorkerTempDir(ours, root)).toBe('removed');
    expect(fs.existsSync(ours)).toBe(false);
    expect(await removeWorkerTempDir(ours, root)).toBe('gone');
  });
});

describe('isDirectChildOfTempRoot', () => {
  const LONG = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
  it('accepts the native long spelling on win32, in any case', () => {
    expect(isDirectChildOfTempRoot(`${LONG}\\wmux-task-abc`, LONG, 'c:\\users\\RUNNERADMIN\\appdata\\local\\temp\\', 'win32')).toBe(true);
  });
  it('refuses an 8.3 short-name parent, a nested dir and a case-only mismatch on POSIX', () => {
    expect(isDirectChildOfTempRoot('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\wmux-task-abc', LONG, LONG, 'win32')).toBe(false);
    expect(isDirectChildOfTempRoot(`${LONG}\\x\\wmux-task-abc`, `${LONG}\\x`, LONG, 'win32')).toBe(false);
    expect(isDirectChildOfTempRoot('/Tmp/wmux-task-abc', '/tmp', '/tmp', 'linux')).toBe(false);
    expect(isDirectChildOfTempRoot('/tmp/wmux-task-abc', '/tmp', '/tmp', 'linux')).toBe(true);
  });
});

describe('liveTempDirsFromSessions', () => {
  it('collects temp vars of non-dead sessions only', () => {
    const live = liveTempDirsFromSessions([
      { state: 'detached', env: { TMPDIR: '/t/a' } },
      { state: 'suspended', env: { TEMP: '/t/b' } },
      { state: 'dead', env: { TMPDIR: '/t/c' } },
      { state: 'attached', env: null },
    ]);
    expect([...live].sort()).toEqual(['/t/a', '/t/b']);
  });
});

describe('WorkerTempDirSweeper', () => {
  function setup(live: () => Promise<Set<string> | null> = async () => new Set()) {
    let clock = 1_000_000;
    const sweeper = new WorkerTempDirSweeper({ file: registry, root, liveTempDirs: live, now: () => clock });
    return { sweeper, tick: (ms: number) => { clock += ms; } };
  }

  it('removes a closed task dir only after boot grace and a full absent window, and a returning owner resets it', async () => {
    const { sweeper, tick } = setup();
    const dir = createWorkerTempDir(root);
    sweeper.register('ws-task', dir);

    tick(TEMPDIR_ABSENT_GRACE_MS);
    expect(sweeper.reconcile(['ws-other'])).toBe(0); // clock starts
    tick(1_000);
    expect(sweeper.reconcile(['ws-task'])).toBe(0); // boot frame: back again
    tick(1_000);
    expect(sweeper.reconcile(['ws-other'])).toBe(0); // clock restarts
    tick(TEMPDIR_ABSENT_GRACE_MS);
    // Absent long enough, but still inside the boot grace.
    expect(sweeper.reconcile(['ws-other'])).toBe(0);
    tick(TEMPDIR_BOOT_GRACE_MS);
    expect(sweeper.reconcile(['ws-other'])).toBe(1);
    await sweeper.idle();
    expect(fs.existsSync(dir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(registry, 'utf8'))).toEqual({});
  });

  it('keeps a dir a live session still uses, and keeps everything when the daemon cannot answer', async () => {
    const dirLive = createWorkerTempDir(root);
    const dirUnknown = createWorkerTempDir(root);
    let answer: Set<string> | null = new Set([dirLive]);
    const { sweeper, tick } = setup(async () => answer);
    sweeper.register('ws-a', dirLive);
    sweeper.register('task:wtask-1', dirUnknown);
    const past = (): void => tick(TEMPDIR_BOOT_GRACE_MS + TEMPDIR_ABSENT_GRACE_MS);

    answer = null;
    past();
    sweeper.reconcile(['ws-other']); // starts the absent clock
    past();
    expect(sweeper.reconcile(['ws-other'])).toBe(2);
    await sweeper.idle();
    expect(fs.existsSync(dirLive) && fs.existsSync(dirUnknown)).toBe(true);

    answer = new Set([dirLive]);
    expect(sweeper.reconcile(['ws-other'])).toBe(2);
    await sweeper.idle();
    expect(fs.existsSync(dirLive)).toBe(true);
    expect(fs.existsSync(dirUnknown)).toBe(false);
    expect(Object.keys(JSON.parse(fs.readFileSync(registry, 'utf8')))).toEqual(['ws-a']);
  });

  it('ignores an empty live set, a persisted absent clock and a torn registry', async () => {
    const dir = createWorkerTempDir(root);
    // A registry from an older build that persisted its absent clock.
    fs.writeFileSync(registry, JSON.stringify({ 'ws-task': { dir, at: 0, missingSince: 0 } }));
    const { sweeper, tick } = setup();
    tick(10 * TEMPDIR_BOOT_GRACE_MS);
    expect(sweeper.reconcile([])).toBe(0);
    // First observation after load only starts the in-memory clock.
    expect(sweeper.reconcile(['ws-other'])).toBe(0);
    await sweeper.idle();
    expect(fs.existsSync(dir)).toBe(true);

    fs.writeFileSync(registry, '{not json');
    const fresh = setup().sweeper;
    expect(fresh.reconcile(['ws-other'])).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
