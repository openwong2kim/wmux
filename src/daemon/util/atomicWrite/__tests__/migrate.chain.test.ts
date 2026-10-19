/**
 * T11 — Golden-fixture migration chaining tests.
 *
 * This suite complements `migrate.test.ts` by pinning the engine's
 * behaviour against concrete on-disk payload shapes (v1 / v2 / v3
 * session documents) and by exercising the `atomicReadJSON` migrator
 * hook end-to-end. The fixtures under `./fixtures/` act as a
 * golden-file regression guard: any accidental change to shape
 * semantics (key names, default values, version markers) will break
 * the deep-equal assertions below.
 *
 * We explicitly do NOT use the production `SESSION_DATA_REGISTRY` for
 * chaining — production ships as identity and we do not want this
 * test to drift if future releases add real steps. Instead we build
 * a local `CHAIN_REGISTRY` that mirrors the fixture pair v1→v2→v3.
 *
 * Scope guard: no source-code edits, no mutation of the exported
 * registries. The file lives next to `migrate.test.ts` and shares
 * its scope guardrails.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { atomicReadJSON } from '../core';
import {
  applyMigrations,
  createMigrator,
  SESSION_DATA_REGISTRY,
  type MigrationRegistry,
} from '../migrate';
import { deliberateSleep } from '../../../../test-utils/waitFor';

// ── Fixture loaders ──────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const V1_FIXTURE_PATH = path.join(FIXTURES_DIR, 'session.v1.json');
const V2_FIXTURE_PATH = path.join(FIXTURES_DIR, 'session.v2.json');
const V3_FIXTURE_PATH = path.join(FIXTURES_DIR, 'session.v3.json');

function loadFixture<T>(p: string): T {
  // We read via sync fs (not `require`) so the JSON is parsed fresh
  // each time — this keeps one test's mutations from leaking into
  // another's input.
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

interface SessionV1 {
  version: 1;
  workspaceId: string;
  panes: Array<{ id: string; cwd: string }>;
}
interface SessionV2 {
  version: 2;
  workspaceId: string;
  panes: Array<{ id: string; cwd: string; scrollbackLimit: number }>;
}
interface SessionV3 {
  version: 3;
  id: string;
  createdAt: number;
  panes: Array<{ id: string; cwd: string; scrollbackLimit: number }>;
}

// ── Test-local migration registry ────────────────────────────────────
//
// These step functions mirror the fixture diffs exactly:
//   v1 -> v2 : every pane gets `scrollbackLimit: 1000`.
//   v2 -> v3 : `workspaceId` renamed to `id`, `createdAt` defaulted
//              to 0 (the fixture's test-time clock value).
//
// Keeping the steps here rather than in the production registry
// means this suite is a pure engine test — it exercises the chain
// without touching shipped behaviour.

const CHAIN_REGISTRY: MigrationRegistry = {
  currentVersion: 3,
  steps: [
    {
      fromVersion: 1,
      toVersion: 2,
      migrate: (input: unknown): SessionV2 => {
        const v1 = input as SessionV1;
        return {
          version: 2,
          workspaceId: v1.workspaceId,
          panes: v1.panes.map((p) => ({ ...p, scrollbackLimit: 1000 })),
        };
      },
    },
    {
      fromVersion: 2,
      toVersion: 3,
      migrate: (input: unknown): SessionV3 => {
        const v2 = input as SessionV2;
        const { workspaceId, panes } = v2;
        return {
          version: 3,
          id: workspaceId,
          createdAt: 0,
          panes: panes.map((p) => ({ ...p })),
        };
      },
    },
  ],
};

// ── tmpdir scaffolding for integration cases ─────────────────────────

let tmpDir: string;

beforeEach(() => {
  // Random suffix avoids collisions when vitest runs specs in
  // parallel. `fs.mkdtempSync` already appends 6 random chars.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-t11-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Pure engine × golden fixtures ────────────────────────────────────

describe('migration chaining (golden fixtures)', () => {
  it('case 1: v1 -> v2 produces the v2 golden fixture exactly', () => {
    // We build a single-step registry so the assertion isolates the
    // v1->v2 transform (no accidental advancement into v3).
    const v1ToV2Only: MigrationRegistry = {
      currentVersion: 2,
      steps: [CHAIN_REGISTRY.steps[0]],
    };

    const v1 = loadFixture<SessionV1>(V1_FIXTURE_PATH);
    const expectedV2 = loadFixture<SessionV2>(V2_FIXTURE_PATH);

    const result = applyMigrations<SessionV2>(v1, 1, v1ToV2Only);

    expect(result.version).toBe(2);
    expect(result.data).toEqual(expectedV2);
  });

  it('case 2: v2 -> v3 produces the v3 golden fixture exactly', () => {
    const v2ToV3Only: MigrationRegistry = {
      currentVersion: 3,
      steps: [CHAIN_REGISTRY.steps[1]],
    };

    const v2 = loadFixture<SessionV2>(V2_FIXTURE_PATH);
    const expectedV3 = loadFixture<SessionV3>(V3_FIXTURE_PATH);

    // Engine allows starting mid-chain as long as a matching step
    // exists — here we enter at cursor=2, advance to 3 in one hop.
    const result = applyMigrations<SessionV3>(v2, 2, v2ToV3Only);

    expect(result.version).toBe(3);
    expect(result.data).toEqual(expectedV3);
  });

  it('case 3: v1 -> v3 chaining produces the v3 golden fixture exactly', () => {
    const v1 = loadFixture<SessionV1>(V1_FIXTURE_PATH);
    const expectedV3 = loadFixture<SessionV3>(V3_FIXTURE_PATH);

    const result = applyMigrations<SessionV3>(v1, 1, CHAIN_REGISTRY);

    expect(result.version).toBe(3);
    expect(result.data).toEqual(expectedV3);
    // Spot-check the two shape-level changes that define v3:
    //  - `workspaceId` was renamed to `id`
    //  - `createdAt` is present and numeric
    expect((result.data as SessionV3).id).toBe('ws-1');
    expect(result.data).not.toHaveProperty('workspaceId');
    expect(typeof result.data.createdAt).toBe('number');
  });

  it('case 4: throws when a required step is missing from the chain', () => {
    // Only the v2->v3 step is registered; v1->v2 is absent. Starting
    // from v1 we must fail loudly rather than silently handing a
    // half-migrated payload to validate/consumers.
    const missingV1: MigrationRegistry = {
      currentVersion: 3,
      steps: [CHAIN_REGISTRY.steps[1]],
    };
    const v1 = loadFixture<SessionV1>(V1_FIXTURE_PATH);

    expect(() => applyMigrations(v1, 1, missingV1)).toThrow(
      /no migration step registered from v1/,
    );
  });

  it('case 5: currentVersion == fromVersion is a no-op', () => {
    // The fixture is already v3 and registry targets v3 → nothing to
    // do. The engine returns the same reference so downstream code
    // can still rely on object identity when no migration runs.
    const v3 = loadFixture<SessionV3>(V3_FIXTURE_PATH);
    const expectedV3 = loadFixture<SessionV3>(V3_FIXTURE_PATH);

    const result = applyMigrations<SessionV3>(v3, 3, CHAIN_REGISTRY);

    expect(result.version).toBe(3);
    // Identity preserved (no clone) — matches the engine contract.
    expect(result.data).toBe(v3);
    // And deep equal to the on-disk golden for good measure.
    expect(result.data).toEqual(expectedV3);
  });

  it('case 6: propagates step failure with identifying context', () => {
    // We inject a failing v2->v3 step so the chain reaches it via
    // the real v1->v2 step first. The wrapped error must name the
    // failing hop so operators can triage without a stack trace.
    const failingAtV2: MigrationRegistry = {
      currentVersion: 3,
      steps: [
        CHAIN_REGISTRY.steps[0],
        {
          fromVersion: 2,
          toVersion: 3,
          migrate: () => {
            throw new Error('v2->v3 boom');
          },
        },
      ],
    };
    const v1 = loadFixture<SessionV1>(V1_FIXTURE_PATH);

    expect(() => applyMigrations(v1, 1, failingAtV2)).toThrow(
      /step v2->v3 failed: v2->v3 boom/,
    );
  });
});

// ── atomicReadJSON integration (premigrate.bak behaviour) ────────────

describe('migration chaining (atomicReadJSON integration)', () => {
  /** Convenience: copy the v1 golden fixture into tmpdir. */
  function seedV1OnDisk(targetName = 'session.json'): string {
    const target = path.join(tmpDir, targetName);
    fs.copyFileSync(V1_FIXTURE_PATH, target);
    return target;
  }

  it('case 7: loading a v1 file upgrades to v3 and writes .v1.premigrate.bak', async () => {
    const target = seedV1OnDisk();
    const snapshot = `${target}.v1.premigrate.bak`;
    const expectedV3 = loadFixture<SessionV3>(V3_FIXTURE_PATH);
    const originalV1 = loadFixture<SessionV1>(V1_FIXTURE_PATH);

    const data = await atomicReadJSON<SessionV3>(target, {
      migrator: createMigrator<SessionV3>(CHAIN_REGISTRY, target),
    });

    expect(data).toEqual(expectedV3);

    // The snapshot lives next to the primary file and captures the
    // pre-migration payload byte-for-byte (modulo formatting).
    expect(fs.existsSync(snapshot)).toBe(true);
    const snapshotContent = JSON.parse(fs.readFileSync(snapshot, 'utf-8'));
    expect(snapshotContent).toEqual(originalV1);
  });

  it('case 8: second load does not overwrite the existing premigrate snapshot', async () => {
    const target = seedV1OnDisk();
    const snapshot = `${target}.v1.premigrate.bak`;

    // First load creates the snapshot.
    await atomicReadJSON<SessionV3>(target, {
      migrator: createMigrator<SessionV3>(CHAIN_REGISTRY, target),
    });
    expect(fs.existsSync(snapshot)).toBe(true);
    const firstStat = fs.statSync(snapshot);
    const firstContent = fs.readFileSync(snapshot, 'utf-8');

    // Pause so any mtime change would be observable on platforms
    // with coarse timestamp resolution.
    await deliberateSleep(15, 'clock: mtime resolution is coarse on some platforms');

    // Corrupt the on-disk file (still v1-shaped but with a different
    // workspaceId) — if the snapshot logic were broken and rewrote
    // the .bak, its content would now reflect the mutation.
    const tampered: SessionV1 = {
      version: 1,
      workspaceId: 'ws-TAMPERED',
      panes: [{ id: 'p1', cwd: '/tmp/x' }],
    };
    await fsp.writeFile(target, JSON.stringify(tampered, null, 2), 'utf-8');

    // Second load — migrator runs again, but the snapshot path is
    // write-once and must not be clobbered.
    await atomicReadJSON<SessionV3>(target, {
      migrator: createMigrator<SessionV3>(CHAIN_REGISTRY, target),
    });

    const secondContent = fs.readFileSync(snapshot, 'utf-8');
    expect(secondContent).toBe(firstContent);
    const secondStat = fs.statSync(snapshot);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    // Most importantly: the pinned snapshot still reflects the
    // *original* on-disk payload, not the tampered version.
    expect(JSON.parse(secondContent)).toEqual(
      loadFixture<SessionV1>(V1_FIXTURE_PATH),
    );
  });

  it('case 9: migrator that throws causes atomicReadJSON to return null', async () => {
    // Per core.ts, a migrator throw is treated as a parse-level
    // failure: the primary attempt returns null and the fallback
    // chain is walked. With no `.bak` present the final answer is
    // null (not the unmigrated payload).
    const target = seedV1OnDisk();
    const explosive: MigrationRegistry = {
      currentVersion: 2,
      steps: [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: () => {
            throw new Error('chain exploded');
          },
        },
      ],
    };

    const data = await atomicReadJSON<SessionV2>(target, {
      migrator: createMigrator<SessionV2>(explosive, target),
    });

    expect(data).toBeNull();
  });

  it('case 10: premigrate snapshot is written before a mid-chain step fails', async () => {
    // `createMigrator` writes the snapshot *before* invoking the
    // chain. Even when a later step throws, the pre-migration
    // payload must already be on disk so operators can recover.
    const target = seedV1OnDisk();
    const snapshot = `${target}.v1.premigrate.bak`;
    const originalV1 = loadFixture<SessionV1>(V1_FIXTURE_PATH);

    const failingAtV2: MigrationRegistry = {
      currentVersion: 3,
      steps: [
        CHAIN_REGISTRY.steps[0],
        {
          fromVersion: 2,
          toVersion: 3,
          migrate: () => {
            throw new Error('late-chain failure');
          },
        },
      ],
    };

    const data = await atomicReadJSON<SessionV3>(target, {
      migrator: createMigrator<SessionV3>(failingAtV2, target),
    });

    // atomicReadJSON swallows the throw and returns null (see
    // case 9 rationale). The *snapshot* is what we actually care
    // about here: it must exist and match the pre-migration payload.
    expect(data).toBeNull();
    expect(fs.existsSync(snapshot)).toBe(true);
    expect(JSON.parse(fs.readFileSync(snapshot, 'utf-8'))).toEqual(
      originalV1,
    );
  });
});

// ── Regression guards ───────────────────────────────────────────────

describe('migration chaining (regression guards)', () => {
  it('case 11: production SESSION_DATA_REGISTRY ships as identity', () => {
    // If this ever changes, downstream consumers need to re-review
    // the migration rollout plan before shipping. The T11 suite
    // pins the *engine* contract; production steps are a separate
    // decision.
    expect(SESSION_DATA_REGISTRY.currentVersion).toBe(1);
    expect(SESSION_DATA_REGISTRY.steps).toHaveLength(0);
    expect(SESSION_DATA_REGISTRY.steps).toEqual([]);
  });

  it('case 12: golden fixtures keep their expected shape on disk', () => {
    // A belt-and-braces check so a typo in a fixture file is
    // surfaced as a targeted failure rather than as a confusing
    // deep-equal mismatch in the chaining tests above.
    const v1 = loadFixture<SessionV1>(V1_FIXTURE_PATH);
    expect(v1.version).toBe(1);
    expect(v1.workspaceId).toBe('ws-1');
    expect(v1.panes).toHaveLength(1);
    expect(v1.panes[0]).toEqual({ id: 'p1', cwd: '/home/user/project-a' });
    expect(v1).not.toHaveProperty('id');
    expect(v1).not.toHaveProperty('createdAt');

    const v2 = loadFixture<SessionV2>(V2_FIXTURE_PATH);
    expect(v2.version).toBe(2);
    expect(v2.workspaceId).toBe('ws-1');
    expect(v2.panes[0].scrollbackLimit).toBe(1000);
    expect(v2).not.toHaveProperty('id');
    expect(v2).not.toHaveProperty('createdAt');

    const v3 = loadFixture<SessionV3>(V3_FIXTURE_PATH);
    expect(v3.version).toBe(3);
    expect(v3.id).toBe('ws-1');
    expect(v3.createdAt).toBe(0);
    expect(v3.panes[0].scrollbackLimit).toBe(1000);
    expect(v3).not.toHaveProperty('workspaceId');
  });

  it('case 13: chain is idempotent when replayed against the already-migrated output', () => {
    // Running the full chain on a payload that is already at v3
    // must be a no-op. This catches regressions where a step
    // accidentally becomes non-pure (e.g. mutates input) and the
    // "already current" short-circuit stops triggering.
    const v1 = loadFixture<SessionV1>(V1_FIXTURE_PATH);
    const once = applyMigrations<SessionV3>(v1, 1, CHAIN_REGISTRY);
    const twice = applyMigrations<SessionV3>(
      once.data,
      once.version,
      CHAIN_REGISTRY,
    );

    expect(twice.version).toBe(3);
    expect(twice.data).toBe(once.data);
    expect(twice.data).toEqual(loadFixture<SessionV3>(V3_FIXTURE_PATH));
  });
});
