import fs from 'node:fs';
import path from 'node:path';

// Phase A — A7. One-time scrollback legacy migration.
//
// The renderer .txt scrollback directory is an active hazard while a
// daemon is connected (A6 gates the runtime writes / reads, but the
// directory already on disk still contains the chronic 64-byte rotation
// chain that destroyed prior good backups). A7 moves that directory
// aside on the first daemon-healthy transition so:
//   - Daemon-mode users have a clean userData/scrollback/ directory.
//     A6 keeps it empty going forward.
//   - The legacy data is preserved at scrollback-legacy-<unix-ts>/ for
//     manual recovery during the v2.9.1 → v2.10 transition window.
//
// Trigger contract (codex review #7 + #9 + #10):
//   - Subscribe to `daemon:connected` in main. Migration runs on the
//     FIRST transition into healthy daemon mode (startup OR runtime
//     late-connect). A 60 s debounce prevents flapping on flaky links.
//   - If migration fails with EBUSY / EPERM / ENOTEMPTY, do NOT write
//     the done flag. The next daemon-healthy transition will retry
//     (still subject to the 60 s debounce).
//   - If the source directory does not exist (ENOENT), write the flag
//     anyway so subsequent transitions can skip cheaply.
//   - Order: fs.renameSync first, flag file second. If rename succeeds
//     but the flag write fails, next-boot finds no scrollback/ and the
//     migration naturally no-ops via the ENOENT branch.

export const MIGRATION_FILE = 'scrollback-migration.json';
export const SCROLLBACK_DIR = 'scrollback';
export const LEGACY_DIR_PREFIX = 'scrollback-legacy-';
export const DEBOUNCE_MS = 60_000;

interface MigrationFlag {
  schema: 1;
  migratedAt: string;
  fromVersion?: string;
}

/** Test-only state reset. Production code never calls this. */
export function __resetMigrationStateForTests(): void {
  lastAttemptAt = 0;
}

let lastAttemptAt = 0;

/** Result the runner returns so callers can log a breadcrumb. */
export interface MigrationResult {
  status: 'migrated' | 'already-done' | 'no-source' | 'skipped-debounce' | 'retry-needed';
  legacyDir?: string;
  error?: string;
}

/**
 * Run one migration attempt. Caller passes the userData dir (Electron's
 * `app.getPath('userData')`) and the current app version (recorded in the
 * flag file for forensics). Pure module — no Electron imports — so unit
 * tests can drive it directly with a tmpdir.
 */
export function migrateScrollbackOnce(
  userDataDir: string,
  appVersion?: string,
  now: number = Date.now(),
): MigrationResult {
  const flagPath = path.join(userDataDir, MIGRATION_FILE);
  if (fs.existsSync(flagPath)) {
    return { status: 'already-done' };
  }
  // Debounce repeated transitions inside the 60s window.
  if (now - lastAttemptAt < DEBOUNCE_MS && lastAttemptAt !== 0) {
    return { status: 'skipped-debounce' };
  }
  lastAttemptAt = now;

  const sourceDir = path.join(userDataDir, SCROLLBACK_DIR);
  if (!fs.existsSync(sourceDir)) {
    // Nothing to migrate. Stamp the flag so future transitions skip
    // cheaply (codex review #8: "If rename succeeds but flag write
    // fails, next-boot finds no scrollback/ and no-ops safely").
    writeFlagFile(flagPath, now, appVersion);
    return { status: 'no-source' };
  }

  const ts = Math.floor(now / 1000);
  const legacyDir = path.join(userDataDir, `${LEGACY_DIR_PREFIX}${ts}`);
  try {
    fs.renameSync(sourceDir, legacyDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EBUSY/EPERM/ENOTEMPTY on Windows often clear after antivirus or
    // a stale handle releases. Retry on the next transition; do NOT
    // mark done so we eventually succeed.
    if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
      return { status: 'retry-needed', error: `${code}: ${(err as Error).message}` };
    }
    // Any other error is unexpected. Return a retry-needed so the
    // caller logs it and the next transition tries again.
    return { status: 'retry-needed', error: (err as Error).message };
  }

  writeFlagFile(flagPath, now, appVersion);
  return { status: 'migrated', legacyDir };
}

function writeFlagFile(flagPath: string, now: number, appVersion: string | undefined): void {
  const flag: MigrationFlag = {
    schema: 1,
    migratedAt: new Date(now).toISOString(),
    fromVersion: appVersion,
  };
  try {
    fs.writeFileSync(flagPath, JSON.stringify(flag, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort. If the write fails, next-boot finds no scrollback/
    // (we just renamed it) and the ENOENT branch will safely stamp
    // the flag on the next attempt.
  }
}
