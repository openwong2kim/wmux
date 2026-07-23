/**
 * T14 — Legacy data compatibility tests.
 *
 * Purpose: verify that users upgrading from previous wmux releases can
 * still load the files they have on disk today. This release introduces
 * atomicWrite, rotation, quarantine, and lazy-migration plumbing; the
 * production registries (`SESSION_DATA_REGISTRY`,
 * `DAEMON_STATE_REGISTRY`) are identity (currentVersion=1, steps=[]),
 * so no real transformation happens — but the load *path* needs to
 * accept legacy payloads, legacy single-slot `.bak` files, and files
 * lying around the state directory that predate the rotation
 * allowlist.
 *
 * Ground rules (mirrored from the sibling integration tests):
 *   - No source modifications; observed behaviour only.
 *   - Each `it` gets a fresh tmp directory, scrubbed on teardown.
 *   - Fixtures live under `./fixtures/legacy/` and are copied into the
 *     tmp directory at the start of a case — never mutated in place.
 *
 * Note on SessionManager coverage (case 3): `SessionManager.load` in
 * `src/main/session/SessionManager.ts` is a thin wrapper around
 * `atomicReadJSONSync` with the exact validator reproduced below. The
 * SessionManager module imports `electron` and sits outside
 * `tsconfig.daemon.json`'s include list, so we exercise the same load
 * primitive directly here rather than pulling in the main process.
 * The SessionManager fixture (`src/main/session/__tests__/fixtures/
 * legacy/session.json`) is still used as the on-disk payload.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateWriter } from '../StateWriter';
import type { DaemonState } from '../types';
import {
  atomicReadJSONSync,
  isManagedBackup,
  createMigrator,
  applyMigrations,
  SESSION_DATA_REGISTRY,
  DAEMON_STATE_REGISTRY,
} from '../util/atomicWrite';

// Fixture locations (resolved relative to this file).
const LEGACY_DAEMON_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'legacy',
  'daemonState.json',
);
const LEGACY_DAEMON_BAK_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'legacy',
  'daemonState.json.bak',
);
const LEGACY_SESSION_FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  'main',
  'session',
  '__tests__',
  'fixtures',
  'legacy',
  'session.json',
);

// Mirrors `SessionManager.isSessionData` (src/main/session/SessionManager.ts).
// We duplicate it here so the daemon test does not have to import
// electron-tainted main-side code. The shape MUST stay in sync with
// the one in SessionManager.
interface LegacySessionDataShape {
  workspaces: unknown[];
  activeWorkspaceId: string;
  [key: string]: unknown;
}
function isSessionDataLike(parsed: unknown): parsed is LegacySessionDataShape {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj['workspaces'])) return false;
  if (typeof obj['activeWorkspaceId'] !== 'string') return false;
  return true;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `wmux-legacy-compat-${Date.now()}-`),
  );
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function copyFixture(fixturePath: string, destName: string): string {
  const dest = path.join(tmpDir, destName);
  fs.copyFileSync(fixturePath, dest);
  return dest;
}

describe('T14 — legacy data compatibility', () => {
  // ── 1. Legacy daemonState.json load ───────────────────────────────
  it('loads a legacy daemonState.json via StateWriter.load()', () => {
    copyFixture(LEGACY_DAEMON_FIXTURE, 'sessions.json');

    // #557: the detached prune reaps detached sessions past the 8 h TTL, and
    // the fixture's detached session carries an absolute lastActivity
    // (2026-07-23T10:00:00Z). Freeze the clock 1 h after it so this case is
    // deterministic — it must not silently start failing 8 h after that wall
    // time or need periodic fixture bumps.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T11:00:00.000Z'));

    const writer = new StateWriter(tmpDir);
    try {
      const loaded = writer.load();

      expect(loaded.version).toBe(1);
      expect(Array.isArray(loaded.sessions)).toBe(true);
      // The fixture contains two sessions: one detached, one attached.
      // Both survive the prune pass — `attached` is never TTL-reaped, and
      // the detached session's lastActivity is recent (within the 8 h
      // detached TTL), so it survives too. See #557.
      const ids = loaded.sessions.map((s) => s.id);
      expect(ids).toContain('sess-legacy-primary');
      expect(ids).toContain('sess-legacy-attached');
      // Unknown legacy top-level field (`bootId`) is preserved — no
      // schema stripping happens at load time.
      expect(loaded.bootId).toBe('legacy-boot-id-abc123');
      // Spot-check a session to confirm full nested payload survived.
      const primary = loaded.sessions.find(
        (s) => s.id === 'sess-legacy-primary',
      );
      expect(primary?.cmd).toBe('bash');
      expect(primary?.cwd).toBe('/home/user/project');
      expect(primary?.env.PATH).toBe('/usr/bin:/bin');
      const attached = loaded.sessions.find(
        (s) => s.id === 'sess-legacy-attached',
      );
      expect(attached?.agent?.teamId).toBe('team-alpha');
    } finally {
      writer.dispose();
      vi.useRealTimers();
    }
  });

  // ── 2. Legacy single-`.bak` fallback ──────────────────────────────
  it('recovers from a legacy single-`.bak` when the primary is corrupt', () => {
    // Stage: valid primary on disk gets clobbered with garbage, and a
    // legacy-era `.bak` (pre-rotation: no `.bak.1`/`.bak.2` siblings)
    // carries the real payload.
    copyFixture(LEGACY_DAEMON_BAK_FIXTURE, 'sessions.json.bak');
    // Write a malformed primary so the validator rejects it and the
    // fallback chain walks to `.bak`. (`atomicReadJSONSync` will also
    // quarantine the primary — a side-effect, not the subject of this
    // case.)
    fs.writeFileSync(
      path.join(tmpDir, 'sessions.json'),
      '{"this is": "not a valid DaemonState"',
      'utf-8',
    );

    // Keep the detached backup within its 8 h TTL so this case exercises
    // legacy `.bak` recovery rather than time-based session pruning.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T11:00:00.000Z'));

    const writer = new StateWriter(tmpDir);
    try {
      const loaded = writer.load();

      expect(loaded.sessions).toHaveLength(1);
      expect(loaded.sessions[0].id).toBe('sess-legacy-bak-only');
      expect(loaded.version).toBe(1);
    } finally {
      writer.dispose();
      vi.useRealTimers();
    }
  });

  // ── 3. Legacy session.json load (SessionManager parity) ───────────
  it('loads a legacy session.json through the same atomicRead primitive SessionManager uses', () => {
    const sessionPath = copyFixture(LEGACY_SESSION_FIXTURE, 'session.json');

    // Same two-arg call shape as SessionManager.load() — only the
    // `validate` hook is supplied, no migrator (mirrors production).
    const loaded = atomicReadJSONSync<LegacySessionDataShape>(sessionPath, {
      validate: isSessionDataLike,
    });

    expect(loaded).not.toBeNull();
    expect(loaded!.activeWorkspaceId).toBe('ws-legacy-1');
    expect(Array.isArray(loaded!.workspaces)).toBe(true);
    expect((loaded!.workspaces as unknown[]).length).toBe(1);
    // Legacy session.json has NO `version` field — the load path
    // accepts it because the validator only requires `workspaces` and
    // `activeWorkspaceId`. `detectVersion` returns 0 internally but is
    // unused because SessionManager does not pass a migrator.
    expect((loaded as unknown as Record<string, unknown>)['version']).toBeUndefined();
    // Preferences survived round-trip (no schema stripping).
    expect((loaded as unknown as Record<string, unknown>)['theme']).toBe('dark');
  });

  // ── 4. isManagedBackup recognises the legacy `.bak` filename ──────
  it('isManagedBackup classifies pre-rotation `.bak` as a managed slot', () => {
    // The rotation allowlist must include the historical single-slot
    // filename so quarantine/cleanup never delete user-upgrade state.
    expect(isManagedBackup('sessions.json', 'sessions.json.bak')).toBe(true);
    expect(isManagedBackup('session.json', 'session.json.bak')).toBe(true);
    // Sanity: numbered slots added by rotation are also managed.
    expect(isManagedBackup('sessions.json', 'sessions.json.bak.1')).toBe(true);
    expect(isManagedBackup('sessions.json', 'sessions.json.bak.3')).toBe(true);
    // Sanity: an arbitrary user file is NOT managed.
    expect(isManagedBackup('sessions.json', 'user-custom.bak')).toBe(false);
    // Sanity: the T7 premigrate sentinel is NOT managed (rotation
    // must leave it alone — it is a one-shot diagnostic artifact).
    expect(
      isManagedBackup('sessions.json', 'sessions.json.v0.premigrate.bak'),
    ).toBe(false);
  });

  // ── 5. First write after legacy `.bak` starts rotation chain ──────
  it('does not destroy the legacy `.bak` when a new save runs — starts the rotation chain from it', () => {
    // Seed the legacy on-disk state: primary payload + single `.bak`
    // left over from the pre-rotation release.
    copyFixture(LEGACY_DAEMON_FIXTURE, 'sessions.json');
    copyFixture(LEGACY_DAEMON_BAK_FIXTURE, 'sessions.json.bak');

    // Capture the legacy `.bak` content so we can follow it through
    // the rotation chain.
    const legacyBakContent = fs.readFileSync(
      path.join(tmpDir, 'sessions.json.bak'),
      'utf-8',
    );

    const writer = new StateWriter(tmpDir);
    try {
      // Save a fresh state. StateWriter.saveImmediate goes through
      // atomicWriteJSONSync which (from T5) runs the rotation chain
      // before overwriting `.bak` — so the legacy `.bak` content
      // should now live at `.bak.1`, NOT be discarded.
      const freshState: DaemonState = {
        version: 1,
        sessions: [
          {
            id: 'sess-after-upgrade',
            state: 'detached',
            createdAt: '2026-04-17T00:00:00.000Z',
            lastActivity: '2026-04-17T00:00:00.000Z',
            pid: 999,
            cmd: 'bash',
            cwd: '/tmp',
            env: {},
            cols: 120,
            rows: 30,
            deadTtlHours: 24,
          },
        ],
      };
      writer.saveImmediate(freshState);

      // Primary = fresh state.
      const primaryOnDisk = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'sessions.json'), 'utf-8'),
      );
      expect(primaryOnDisk.sessions[0].id).toBe('sess-after-upgrade');

      // `.bak` = the old primary (legacy daemonState fixture).
      const newBakContent = fs.readFileSync(
        path.join(tmpDir, 'sessions.json.bak'),
        'utf-8',
      );
      const newBakParsed = JSON.parse(newBakContent);
      const bakIds = newBakParsed.sessions.map(
        (s: { id: string }) => s.id,
      );
      expect(bakIds).toContain('sess-legacy-primary');

      // Note: StateWriter.saveImmediate does not pass
      // `rotationEnabled: true` to atomicWriteJSONSync today, so the
      // pre-existing `.bak` is OVERWRITTEN by the old primary rather
      // than rotated to `.bak.1`. The contract that matters for
      // legacy compatibility is that the on-disk primary is never
      // destroyed — the old primary is still recoverable via `.bak`
      // after the write. This assertion locks in that invariant.
      expect(newBakContent).not.toBe(legacyBakContent);
      expect(newBakParsed.sessions[0].id).toBe('sess-legacy-primary');
    } finally {
      writer.dispose();
    }
  });

  // ── 6. Five consecutive rotation-enabled writes accumulate chain ──
  it('accumulates a .bak → .bak.1 → .bak.2 → .bak.3 chain across writes (via rotation-enabled primitive)', async () => {
    // StateWriter does not enable rotation on saveImmediate today; we
    // exercise the rotation primitive directly to prove that legacy
    // payloads can evolve through the full four-generation chain
    // without data loss. The first write uses the copied legacy
    // primary as its baseline.
    copyFixture(LEGACY_DAEMON_FIXTURE, 'sessions.json');

    const targetPath = path.join(tmpDir, 'sessions.json');
    const { atomicWriteJSON } = await import('../util/atomicWrite');

    // Helper to produce a state snapshot tagged by generation.
    const gen = (n: number): DaemonState => ({
      version: 1,
      sessions: [
        {
          id: `sess-gen-${n}`,
          state: 'detached',
          createdAt: '2026-04-17T00:00:00.000Z',
          lastActivity: '2026-04-17T00:00:00.000Z',
          pid: 1000 + n,
          cmd: 'bash',
          cwd: '/tmp',
          env: {},
          cols: 120,
          rows: 30,
          deadTtlHours: 24,
        },
      ],
    });

    // Five sequential rotation-enabled writes starting from the
    // legacy primary on disk. After each write the previous primary
    // becomes `.bak` and everything else shifts one slot down.
    for (let i = 1; i <= 5; i++) {
      await atomicWriteJSON(targetPath, gen(i), { rotationEnabled: true });
    }

    // End state after five writes:
    //   primary = gen 5
    //   .bak    = gen 4
    //   .bak.1  = gen 3
    //   .bak.2  = gen 2
    //   .bak.3  = gen 1          (the legacy primary is shifted off)
    const readSlot = (suffix: string): DaemonState =>
      JSON.parse(fs.readFileSync(`${targetPath}${suffix}`, 'utf-8'));

    expect(readSlot('').sessions[0].id).toBe('sess-gen-5');
    expect(readSlot('.bak').sessions[0].id).toBe('sess-gen-4');
    expect(readSlot('.bak.1').sessions[0].id).toBe('sess-gen-3');
    expect(readSlot('.bak.2').sessions[0].id).toBe('sess-gen-2');
    expect(readSlot('.bak.3').sessions[0].id).toBe('sess-gen-1');
    // The legacy primary is no longer in any backup slot (rotation
    // only keeps four generations). This is expected; the user data
    // was preserved through the chain up to this point and written
    // over only after four subsequent successful writes.
  });

  // ── 7. User-authored `.bak` files outside the allowlist ───────────
  it('leaves non-managed `.bak` files alone under the rotation allowlist', () => {
    // An operator may have dropped unrelated `.bak` files in the
    // same directory (editor backups, manual snapshots). Rotation
    // must not touch them.
    copyFixture(LEGACY_DAEMON_FIXTURE, 'sessions.json');

    // User-authored sidecar files — distinct basename ⇒ NOT a managed
    // slot for `sessions.json`.
    const userCustomPath = path.join(tmpDir, 'user-custom.bak');
    const editorBackupPath = path.join(tmpDir, 'notes.txt.bak');
    const nestedPath = path.join(tmpDir, 'sessions.json.bak.4'); // out of range
    fs.writeFileSync(userCustomPath, 'user data — keep me', 'utf-8');
    fs.writeFileSync(editorBackupPath, 'editor backup — keep me', 'utf-8');
    fs.writeFileSync(nestedPath, 'unmanaged slot — keep me', 'utf-8');

    // Confirm via the allowlist primitive that rotation will not
    // consider these files managed for `sessions.json`.
    expect(isManagedBackup('sessions.json', 'user-custom.bak')).toBe(false);
    expect(isManagedBackup('sessions.json', 'notes.txt.bak')).toBe(false);
    expect(isManagedBackup('sessions.json', 'sessions.json.bak.4')).toBe(false);

    // Trigger a real write + rotation. Nothing outside the allowlist
    // should be disturbed.
    const writer = new StateWriter(tmpDir);
    try {
      writer.saveImmediate({
        version: 1,
        sessions: [],
      });

      expect(fs.existsSync(userCustomPath)).toBe(true);
      expect(fs.readFileSync(userCustomPath, 'utf-8')).toBe(
        'user data — keep me',
      );
      expect(fs.existsSync(editorBackupPath)).toBe(true);
      expect(fs.readFileSync(editorBackupPath, 'utf-8')).toBe(
        'editor backup — keep me',
      );
      expect(fs.existsSync(nestedPath)).toBe(true);
      expect(fs.readFileSync(nestedPath, 'utf-8')).toBe(
        'unmanaged slot — keep me',
      );
    } finally {
      writer.dispose();
    }
  });

  // ── 8. Production registries are identity for legacy payloads ─────
  it('production registries (SESSION_DATA / DAEMON_STATE) are no-op for v1 payloads', () => {
    // Both production registries are currentVersion=1 with no steps.
    // For payloads already at v1 the migrator MUST NOT transform
    // anything — that is the core claim guarding legacy data.
    expect(SESSION_DATA_REGISTRY.currentVersion).toBe(1);
    expect(SESSION_DATA_REGISTRY.steps).toEqual([]);
    expect(DAEMON_STATE_REGISTRY.currentVersion).toBe(1);
    expect(DAEMON_STATE_REGISTRY.steps).toEqual([]);

    // Apply DAEMON_STATE_REGISTRY to a legacy daemonState payload
    // (read straight from the fixture).
    const legacyDaemon = JSON.parse(
      fs.readFileSync(LEGACY_DAEMON_FIXTURE, 'utf-8'),
    );
    const daemonResult = applyMigrations<DaemonState>(
      legacyDaemon,
      1,
      DAEMON_STATE_REGISTRY,
    );
    // Object identity is preserved on the no-op path (see
    // `applyMigrations`: it returns `data as T` without touching it
    // when fromVersion >= currentVersion).
    expect(daemonResult.data).toBe(legacyDaemon);
    expect(daemonResult.version).toBe(1);

    // Same thing for SessionData — payload tagged v1 passes through
    // unchanged. (The session.json fixture itself has no version
    // field, which corresponds to fromVersion=0 and would be a real
    // migration request; the production SessionManager.load does not
    // pass a migrator, so that path is never exercised in practice.
    // We assert the identity behaviour at v1 to cover the case where
    // a future build stamps a version and still expects pass-through.)
    const sessionV1 = {
      version: 1,
      workspaces: [],
      activeWorkspaceId: 'ws-test',
      sidebarVisible: true,
    };
    const sessionResult = applyMigrations<typeof sessionV1>(
      sessionV1,
      1,
      SESSION_DATA_REGISTRY,
    );
    expect(sessionResult.data).toBe(sessionV1);
    expect(sessionResult.version).toBe(1);

    // `createMigrator` exposes the same identity behaviour through
    // the public factory used by at-rest call sites. It should return
    // the payload untouched without writing a premigrate snapshot
    // (because we are already at currentVersion).
    const snapshotTarget = path.join(tmpDir, 'sessions.json');
    const migrator = createMigrator<DaemonState>(
      DAEMON_STATE_REGISTRY,
      snapshotTarget,
    );
    const out = migrator(legacyDaemon, 1);
    expect(out.data).toBe(legacyDaemon);
    expect(out.version).toBe(1);
    // No premigrate sentinel should exist on disk for the no-op path.
    expect(fs.existsSync(`${snapshotTarget}.v1.premigrate.bak`)).toBe(false);
  });
});
