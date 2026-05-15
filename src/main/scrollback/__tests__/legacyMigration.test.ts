import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  migrateScrollbackOnce,
  MIGRATION_FILE,
  SCROLLBACK_DIR,
  LEGACY_DIR_PREFIX,
  DEBOUNCE_MS,
  __resetMigrationStateForTests,
} from '../legacyMigration';

describe('A7 — scrollback legacy migration', () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a7-test-'));
    __resetMigrationStateForTests();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('moves scrollback/ aside and writes the flag file on first run', () => {
    fs.mkdirSync(path.join(userDataDir, SCROLLBACK_DIR));
    fs.writeFileSync(path.join(userDataDir, SCROLLBACK_DIR, 'a.txt'), 'old');

    const result = migrateScrollbackOnce(userDataDir, '2.9.1', 1_700_000_000_000);

    expect(result.status).toBe('migrated');
    expect(result.legacyDir).toBeDefined();
    expect(fs.existsSync(result.legacyDir!)).toBe(true);
    expect(fs.readFileSync(path.join(result.legacyDir!, 'a.txt'), 'utf-8')).toBe('old');
    expect(fs.existsSync(path.join(userDataDir, SCROLLBACK_DIR))).toBe(false);

    const flagPath = path.join(userDataDir, MIGRATION_FILE);
    expect(fs.existsSync(flagPath)).toBe(true);
    const flag = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
    expect(flag.schema).toBe(1);
    expect(flag.fromVersion).toBe('2.9.1');
  });

  it('is idempotent — second call returns already-done', () => {
    fs.mkdirSync(path.join(userDataDir, SCROLLBACK_DIR));
    fs.writeFileSync(path.join(userDataDir, SCROLLBACK_DIR, 'a.txt'), 'old');
    migrateScrollbackOnce(userDataDir, '2.9.1', 1_700_000_000_000);

    const result = migrateScrollbackOnce(userDataDir, '2.9.1', 1_700_000_000_000 + DEBOUNCE_MS + 1);
    expect(result.status).toBe('already-done');
  });

  it('writes the flag with status no-source when scrollback/ does not exist', () => {
    const result = migrateScrollbackOnce(userDataDir, '2.9.1', 1_700_000_000_000);
    expect(result.status).toBe('no-source');
    expect(fs.existsSync(path.join(userDataDir, MIGRATION_FILE))).toBe(true);
  });

  it('debounces concurrent transitions inside the window', () => {
    fs.mkdirSync(path.join(userDataDir, SCROLLBACK_DIR));
    // First call records lastAttemptAt
    const first = migrateScrollbackOnce(userDataDir, '2.9.1', 1_000_000);
    expect(first.status).toBe('migrated');
    // Remove the flag to simulate a failed flag write so the second
    // call hits the debounce branch (not the already-done branch).
    fs.unlinkSync(path.join(userDataDir, MIGRATION_FILE));

    const within = migrateScrollbackOnce(userDataDir, '2.9.1', 1_000_000 + 1_000);
    expect(within.status).toBe('skipped-debounce');
  });

  it('legacy directory name uses unix seconds prefix', () => {
    fs.mkdirSync(path.join(userDataDir, SCROLLBACK_DIR));
    const result = migrateScrollbackOnce(userDataDir, '2.9.1', 1_700_000_000_000);
    const legacyName = path.basename(result.legacyDir!);
    expect(legacyName.startsWith(LEGACY_DIR_PREFIX)).toBe(true);
    expect(legacyName).toMatch(/^scrollback-legacy-\d+$/);
  });

  // Rename failures (EBUSY/EPERM/ENOTEMPTY) cannot be deterministically
  // triggered in a portable test without monkey-patching fs.renameSync.
  // We assert the contract source-side: status === 'retry-needed' must
  // NOT write the flag file so the next transition retries.
  it('returns retry-needed status without writing the flag when rename throws', () => {
    fs.mkdirSync(path.join(userDataDir, SCROLLBACK_DIR));
    // Monkeypatch fs.renameSync for the duration of this test.
    const original = fs.renameSync;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = () => {
      const err = new Error('busy') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    };
    try {
      const result = migrateScrollbackOnce(userDataDir, '2.9.1', 2_000_000);
      expect(result.status).toBe('retry-needed');
      expect(result.error).toMatch(/EBUSY/);
      // Flag NOT written so the next transition retries.
      expect(fs.existsSync(path.join(userDataDir, MIGRATION_FILE))).toBe(false);
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = original;
    }
  });
});
