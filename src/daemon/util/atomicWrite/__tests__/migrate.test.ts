import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyMigrations,
  createMigrator,
  writePremigrateSnapshot,
  writePremigrateSnapshotSync,
  SESSION_DATA_REGISTRY,
  DAEMON_STATE_REGISTRY,
  type MigrationRegistry,
} from '../migrate';
import { deliberateSleep } from '../../../../test-utils/waitFor';

let tmpDir: string;
let targetPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-migrate-test-'));
  targetPath = path.join(tmpDir, 'data.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Test fixture registry (separate from production registries) ──────
//
// We keep test migrations local to this file so they can't leak into
// production load paths. Each step is intentionally small and
// side-effect-free — the engine contract is that steps are pure
// functions invoked at most once per load cycle.

interface V1Payload {
  version: 1;
  name: string;
}
interface V2Payload {
  version: 2;
  name: string;
  tags: string[];
}
interface V3Payload {
  version: 3;
  name: string;
  tags: string[];
  createdAt: number;
}

const TEST_REGISTRY: MigrationRegistry = {
  currentVersion: 3,
  steps: [
    {
      fromVersion: 1,
      toVersion: 2,
      migrate: (input: unknown): V2Payload => {
        const v1 = input as V1Payload;
        return { version: 2, name: v1.name, tags: [] };
      },
    },
    {
      fromVersion: 2,
      toVersion: 3,
      migrate: (input: unknown): V3Payload => {
        const v2 = input as V2Payload;
        return {
          version: 3,
          name: v2.name,
          tags: v2.tags,
          createdAt: 1700000000,
        };
      },
    },
  ],
};

// ── applyMigrations ──────────────────────────────────────────────────

describe('applyMigrations', () => {
  it('chains v1 -> v2 -> v3 in order', () => {
    const v1: V1Payload = { version: 1, name: 'alpha' };
    const result = applyMigrations<V3Payload>(v1, 1, TEST_REGISTRY);

    expect(result.version).toBe(3);
    expect(result.data).toEqual({
      version: 3,
      name: 'alpha',
      tags: [],
      createdAt: 1700000000,
    });
  });

  it('returns data unchanged when already at currentVersion', () => {
    const payload = { version: 3, name: 'beta', tags: ['x'], createdAt: 1 };
    const result = applyMigrations(payload, 3, TEST_REGISTRY);

    expect(result.version).toBe(3);
    expect(result.data).toBe(payload);
  });

  it('returns data unchanged when fromVersion exceeds currentVersion', () => {
    // Forward-compat: an on-disk payload from a future build should
    // pass through untouched so the caller can reject or tolerate it.
    const payload = { version: 5, name: 'gamma' };
    const result = applyMigrations(payload, 5, TEST_REGISTRY);

    expect(result.version).toBe(5);
    expect(result.data).toBe(payload);
  });

  it('runs only the subset of steps needed (v2 -> v3)', () => {
    // Starting at v2 should skip the v1->v2 step entirely, not run
    // it "just to be safe". Each step runs at most once.
    const spy = vi.spyOn(TEST_REGISTRY.steps[0], 'migrate');
    const v2: V2Payload = { version: 2, name: 'delta', tags: ['k'] };
    const result = applyMigrations<V3Payload>(v2, 2, TEST_REGISTRY);

    expect(spy).not.toHaveBeenCalled();
    expect(result.version).toBe(3);
    expect(result.data.createdAt).toBe(1700000000);
    expect(result.data.name).toBe('delta');
  });

  it('throws when the chain has a missing link', () => {
    const broken: MigrationRegistry = {
      currentVersion: 3,
      steps: [
        // Only the v1->v2 step is registered — v2->v3 is missing.
        TEST_REGISTRY.steps[0],
      ],
    };
    const v1: V1Payload = { version: 1, name: 'epsilon' };
    expect(() => applyMigrations(v1, 1, broken)).toThrow(
      /no migration step registered from v2/,
    );
  });

  it('throws with step context when a step throws', () => {
    const explosive: MigrationRegistry = {
      currentVersion: 2,
      steps: [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: () => {
            throw new Error('kaboom');
          },
        },
      ],
    };
    expect(() =>
      applyMigrations({ version: 1 }, 1, explosive),
    ).toThrow(/step v1->v2 failed: kaboom/);
  });

  it('rejects non-+1 hop registrations', () => {
    // A step that claims to jump two versions is a registration bug.
    // We fail loudly rather than silently mis-applying it.
    const weird: MigrationRegistry = {
      currentVersion: 3,
      steps: [
        {
          fromVersion: 1,
          toVersion: 3,
          migrate: (x) => x,
        },
      ],
    };
    expect(() =>
      applyMigrations({ version: 1 }, 1, weird),
    ).toThrow(/must target v2, got v3/);
  });
});

// ── writePremigrateSnapshot (async + sync) ───────────────────────────

describe('writePremigrateSnapshot', () => {
  it('writes the snapshot at the expected path on first call', async () => {
    const payload = { version: 1, name: 'zeta' };
    await writePremigrateSnapshot(targetPath, payload, 1);

    const snapshotPath = `${targetPath}.v1.premigrate.bak`;
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))).toEqual(
      payload,
    );
  });

  it('skips rewriting when the snapshot already exists', async () => {
    const first = { version: 1, name: 'first' };
    await writePremigrateSnapshot(targetPath, first, 1);

    const snapshotPath = `${targetPath}.v1.premigrate.bak`;
    const firstStat = fs.statSync(snapshotPath);

    // Second call with different payload — snapshot must stay
    // pinned to the original so operators can recover the true
    // pre-migration state.
    await deliberateSleep(10, 'clock: mtime resolution is coarse on some platforms');
    await writePremigrateSnapshot(
      targetPath,
      { version: 1, name: 'overwritten' },
      1,
    );

    const secondStat = fs.statSync(snapshotPath);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))).toEqual(
      first,
    );
  });

  it('uses the suffix ".v{N}.premigrate.bak" so rotation ignores it', async () => {
    // Rotation (T5) scans for `.bak`, `.bak.1`, etc. A
    // `.premigrate.bak` name must not match those — the suffix
    // contains a `.v{N}.premigrate` segment which is our contract
    // with T5's isManagedBackup check.
    await writePremigrateSnapshot(targetPath, { v: 1 }, 2);
    const expected = `${targetPath}.v2.premigrate.bak`;
    expect(fs.existsSync(expected)).toBe(true);
    // Explicit shape check — this is the contract with T5.
    expect(expected.endsWith('.v2.premigrate.bak')).toBe(true);
  });

  it('sync variant behaves identically for first-write and skip', () => {
    const payload = { version: 1, name: 'sync-first' };
    writePremigrateSnapshotSync(targetPath, payload, 1);

    const snapshotPath = `${targetPath}.v1.premigrate.bak`;
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))).toEqual(
      payload,
    );

    // Second sync call — must not overwrite.
    writePremigrateSnapshotSync(
      targetPath,
      { version: 1, name: 'ignored' },
      1,
    );
    expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))).toEqual(
      payload,
    );
  });
});

// ── createMigrator ───────────────────────────────────────────────────

describe('createMigrator', () => {
  it('is a no-op (no snapshot) when data is already at currentVersion', () => {
    const migrator = createMigrator<V3Payload>(TEST_REGISTRY, targetPath);
    const payload: V3Payload = {
      version: 3,
      name: 'uptodate',
      tags: [],
      createdAt: 42,
    };

    const result = migrator(payload, 3);

    expect(result.version).toBe(3);
    expect(result.data).toBe(payload);
    // No snapshot should be written for already-current payloads —
    // there's nothing pre-migration to preserve.
    expect(fs.existsSync(`${targetPath}.v3.premigrate.bak`)).toBe(false);
  });

  it('writes snapshot then applies chain when upgrade is needed', () => {
    const migrator = createMigrator<V3Payload>(TEST_REGISTRY, targetPath);
    const v1: V1Payload = { version: 1, name: 'upgrade-me' };

    const result = migrator(v1, 1);

    expect(result.version).toBe(3);
    expect(result.data.name).toBe('upgrade-me');
    expect(result.data.tags).toEqual([]);
    expect(result.data.createdAt).toBe(1700000000);

    const snapshotPath = `${targetPath}.v1.premigrate.bak`;
    expect(fs.existsSync(snapshotPath)).toBe(true);
    // Snapshot captures the *pre*-migration payload, not the
    // upgraded one — that's the whole point.
    expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))).toEqual(v1);
  });

  it('propagates step failures without writing a stale payload', () => {
    const explosive: MigrationRegistry = {
      currentVersion: 2,
      steps: [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: () => {
            throw new Error('disk on fire');
          },
        },
      ],
    };
    const migrator = createMigrator(explosive, targetPath);
    expect(() => migrator({ version: 1 }, 1)).toThrow(/disk on fire/);

    // Snapshot is still written — it precedes the failing step.
    // That's intended: the pre-migration payload is our recovery
    // anchor if the upgrade ever gets patched.
    expect(fs.existsSync(`${targetPath}.v1.premigrate.bak`)).toBe(true);
  });
});

// ── Production registries ────────────────────────────────────────────

describe('production registries', () => {
  it('ships SESSION_DATA_REGISTRY as identity (v1, no steps)', () => {
    expect(SESSION_DATA_REGISTRY.currentVersion).toBe(1);
    expect(SESSION_DATA_REGISTRY.steps).toEqual([]);
  });

  it('ships DAEMON_STATE_REGISTRY as identity (v1, no steps)', () => {
    expect(DAEMON_STATE_REGISTRY.currentVersion).toBe(1);
    expect(DAEMON_STATE_REGISTRY.steps).toEqual([]);
  });

  it('identity registry is a true no-op via createMigrator', () => {
    // Regression guard: if the engine ever evolves we want the
    // identity registry to stay cost-free for existing payloads.
    const migrator = createMigrator(SESSION_DATA_REGISTRY, targetPath);
    const payload = { version: 1, sessions: [] };
    const result = migrator(payload, 1);

    expect(result.data).toBe(payload);
    expect(result.version).toBe(1);
    expect(fs.existsSync(`${targetPath}.v1.premigrate.bak`)).toBe(false);
  });
});
