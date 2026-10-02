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
  createWorkerTempDir,
  reconcileWorkerTempDirs,
  registerWorkerTempDir,
  removeWorkerTempDir,
  workerTempEnv,
} from '../fanoutTempDir';

let root: string;
let registry: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-tempdir-test-')));
  registry = path.join(root, 'fanout-tempdirs.json');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
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
  it('refuses a path without the worker prefix and never follows a symlink', () => {
    const foreign = path.join(root, 'keep-me');
    fs.mkdirSync(foreign);
    expect(removeWorkerTempDir(foreign)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);

    if (process.platform !== 'win32') {
      const link = path.join(root, 'wmux-task-link');
      fs.symlinkSync(foreign, link);
      expect(removeWorkerTempDir(link)).toBe(false);
      expect(fs.existsSync(foreign)).toBe(true);
    }
  });
});

describe('reconcileWorkerTempDirs', () => {
  it('removes a closed task workspace dir only after it stays absent for the grace window', () => {
    const dir = createWorkerTempDir(root);
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'x');
    const t0 = 1_000_000;
    registerWorkerTempDir('ws-task', dir, t0, registry);

    // Still within the registration grace: a push in flight at spawn time.
    expect(reconcileWorkerTempDirs(['ws-other'], t0 + 1_000, registry)).toBe(0);
    // First absent observation only starts the clock.
    const t1 = t0 + TEMPDIR_ABSENT_GRACE_MS;
    expect(reconcileWorkerTempDirs(['ws-other'], t1, registry)).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
    // Reappearing (a boot frame before the session restore) resets it.
    expect(reconcileWorkerTempDirs(['ws-task'], t1 + 1_000, registry)).toBe(0);
    expect(reconcileWorkerTempDirs(['ws-other'], t1 + 2_000, registry)).toBe(0);
    expect(reconcileWorkerTempDirs(['ws-other'], t1 + 2_000 + TEMPDIR_ABSENT_GRACE_MS - 1, registry)).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
    // Absent for the full window → removed and forgotten.
    expect(reconcileWorkerTempDirs(['ws-other'], t1 + 2_000 + TEMPDIR_ABSENT_GRACE_MS, registry)).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(registry, 'utf8'))).toEqual({});
  });

  it('ignores an empty live set and a torn registry', () => {
    const dir = createWorkerTempDir(root);
    registerWorkerTempDir('ws-task', dir, 0, registry);
    expect(reconcileWorkerTempDirs([], 10 * TEMPDIR_ABSENT_GRACE_MS, registry)).toBe(0);
    expect(reconcileWorkerTempDirs([], 20 * TEMPDIR_ABSENT_GRACE_MS, registry)).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);

    fs.writeFileSync(registry, '{not json');
    expect(reconcileWorkerTempDirs(['ws-other'], 30 * TEMPDIR_ABSENT_GRACE_MS, registry)).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
