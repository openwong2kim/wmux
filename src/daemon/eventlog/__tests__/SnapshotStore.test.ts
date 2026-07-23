import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  SnapshotStore,
  GENESIS_CHANNEL_REF,
  CHANNEL_PROJECTION_REF,
  reseedRef,
  isSnapshotEnvelope,
} from '../SnapshotStore';
import type { ChannelState } from '../../../shared/channels';

// Panel E reproduction gate: block async atomicWriteJSON at the gate so flushSync can
// interleave into the in-flight window deterministically. Sync write calls are
// recorded via syncCalls to observe "restore write occurred".
const gate = vi.hoisted(() => ({
  block: null as Promise<void> | null,
  entered: false,
  syncCalls: [] as string[],
}));

vi.mock('../../util/atomicWrite', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../util/atomicWrite')>();
  return {
    ...actual,
    atomicWriteJSON: async (
      targetPath: string,
      data: unknown,
      opts?: unknown,
    ): Promise<void> => {
      if (gate.block) {
        gate.entered = true;
        await gate.block;
      }
      return actual.atomicWriteJSON(
        targetPath,
        data,
        opts as Parameters<typeof actual.atomicWriteJSON>[2],
      );
    },
    atomicWriteJSONSync: (
      targetPath: string,
      data: unknown,
      opts?: unknown,
    ): void => {
      gate.syncCalls.push(targetPath);
      return actual.atomicWriteJSONSync(
        targetPath,
        data,
        opts as Parameters<typeof actual.atomicWriteJSONSync>[2],
      );
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-snap-'));
  gate.block = null;
  gate.entered = false;
  gate.syncCalls = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────

function isChannelStateLike(d: unknown): boolean {
  if (typeof d !== 'object' || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o['version'] === 'number' &&
    Array.isArray(o['channels']) &&
    typeof o['members'] === 'object' &&
    o['members'] !== null
  );
}

/** Minimal ChannelState-like projection distinguished by marker. */
function proj(marker: string): ChannelState {
  return {
    version: 1,
    channels: [
      {
        id: `ch-${marker}`,
        companyId: 'co',
        name: marker,
        visibility: 'public',
        status: 'active',
        createdAt: 0,
        createdBy: 'ws',
        nextSeq: 1,
      },
    ],
    members: {},
    messages: {},
    idempotency: {},
  };
}

// ── T-snapshot corruption fallback (§5): latest → .bak → reseed → genesis ────────────────

describe('T-snapshot corruption fallback', () => {
  it('degrades latest → .bak → reseed → genesis in order', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(GENESIS_CHANNEL_REF, proj('genesis'), 0);
    store.writeDurableSync(reseedRef(1), proj('reseed'), 5);
    store.writeDurableSync(CHANNEL_PROJECTION_REF, proj('active-old'), 9);
    store.writeDurableSync(CHANNEL_PROJECTION_REF, proj('active-new'), 10); // .bak=active-old

    const opts = {
      activeRef: CHANNEL_PROJECTION_REF,
      genesisRef: GENESIS_CHANNEL_REF,
      reseedRefs: [reseedRef(1)],
      validateProjection: isChannelStateLike,
    };

    // 1. Normal → latest active-new.
    let fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('snapshot');
    expect(fb!.snapshotLamport).toBe(10);
    expect(fb!.projection.channels[0].id).toBe('ch-active-new');

    // 2. Primary corrupt → .bak (active-old).
    fs.writeFileSync(store.snapshotPath(CHANNEL_PROJECTION_REF), 'CORRUPT{');
    fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('snapshot');
    expect(fb!.snapshotLamport).toBe(9);
    expect(fb!.projection.channels[0].id).toBe('ch-active-old');

    // 3. .bak also corrupt → reseed.
    fs.writeFileSync(
      `${store.snapshotPath(CHANNEL_PROJECTION_REF)}.bak`,
      'CORRUPT{',
    );
    fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('reseed');
    expect(fb!.snapshotLamport).toBe(5);
    expect(fb!.projection.channels[0].id).toBe('ch-reseed');

    // 4. Reseed corrupt → genesis (floor).
    fs.writeFileSync(store.snapshotPath(reseedRef(1)), 'CORRUPT{');
    fs.rmSync(`${store.snapshotPath(reseedRef(1))}.bak`, { force: true });
    fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('genesis');
    expect(fb!.snapshotLamport).toBe(0);
    expect(fb!.projection.channels[0].id).toBe('ch-genesis');
  });

  it('multiple reseeds → tries newest (highest number) first', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(GENESIS_CHANNEL_REF, proj('genesis'), 0);
    store.writeDurableSync(reseedRef(1), proj('reseed-1'), 3);
    store.writeDurableSync(reseedRef(2), proj('reseed-2'), 7);

    const fb = store.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF, // absent
      genesisRef: GENESIS_CHANNEL_REF,
      reseedRefs: [reseedRef(1), reseedRef(2)],
      validateProjection: isChannelStateLike,
    });
    expect(fb!.source).toBe('reseed');
    expect(fb!.projection.channels[0].id).toBe('ch-reseed-2'); // newest
    expect(fb!.snapshotLamport).toBe(7);
  });

  it('genesis also corrupt → null (catastrophe handled upstream)', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(GENESIS_CHANNEL_REF, proj('genesis'), 0);
    fs.writeFileSync(store.snapshotPath(GENESIS_CHANNEL_REF), 'CORRUPT{');
    fs.rmSync(`${store.snapshotPath(GENESIS_CHANNEL_REF)}.bak`, { force: true });
    const fb = store.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF,
      genesisRef: GENESIS_CHANNEL_REF,
      reseedRefs: [],
      validateProjection: isChannelStateLike,
    });
    expect(fb).toBeNull();
  });
});

// ── durable write/load + debounce ──────────────────────────────────────

describe('durable snapshot write/load', () => {
  it('writeDurableSync → load round trip (snapshotLamport preserved)', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(CHANNEL_PROJECTION_REF, proj('x'), 42, isChannelStateLike);
    const env = store.load<ChannelState>(CHANNEL_PROJECTION_REF, isChannelStateLike);
    expect(env!.snapshotLamport).toBe(42);
    expect(env!.projection.channels[0].id).toBe('ch-x');
    expect(isSnapshotEnvelope(env)).toBe(true);
  });

  it('projection validation failure → null on load (induces fallback)', () => {
    const store = new SnapshotStore(dir);
    // Envelope valid but projection is not ChannelState-like.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      store.snapshotPath(CHANNEL_PROJECTION_REF),
      JSON.stringify({ version: 1, snapshotLamport: 1, projection: { bogus: true } }),
    );
    expect(
      store.load(CHANNEL_PROJECTION_REF, isChannelStateLike),
    ).toBeNull();
  });

  it('saveDebounced → flushSync drains pending via durable sync write', () => {
    const store = new SnapshotStore(dir, { debounceMs: 1_000_000 });
    store.saveDebounced(CHANNEL_PROJECTION_REF, proj('deb'), 7);
    store.flushSync();
    const env = store.load<ChannelState>(CHANNEL_PROJECTION_REF, isChannelStateLike);
    expect(env!.snapshotLamport).toBe(7);
    expect(env!.projection.channels[0].id).toBe('ch-deb');
    store.dispose();
  });
});

// ── T-compaction order (§9 guard) ──────────────────────────────────────────────

describe('T-compaction order', () => {
  const G = 'genesis-channel.json';

  it('durable unconfirmed → zero truncate candidates (§9 trap)', () => {
    const plan = SnapshotStore.planCompaction({
      segments: [{ num: 1, maxLamport: 5, empty: false }],
      protectedFloorLamport: 10,
      durableSnapshotConfirmed: false,
      activeSegment: 2,
      genesisRef: G,
      reseedRefs: [reseedRef(1)],
    });
    expect(plan.truncatableSegments).toEqual([]);
    // genesis·reseed always on protect list (never truncate, D14).
    expect(plan.protectedSnapshots).toEqual([G, reseedRef(1)]);
  });

  it('durable confirmed → truncates segments below snapshotLamport (keeps 1 for audit)', () => {
    const plan = SnapshotStore.planCompaction({
      segments: [
        { num: 1, maxLamport: 5, empty: false }, // < 20 candidate
        { num: 2, maxLamport: 15, empty: false }, // < 20 candidate (recent → audit preserve)
        { num: 3, maxLamport: 25, empty: false }, // > 20 → not a candidate
        { num: 4, maxLamport: 0, empty: true }, // active (empty)
      ],
      protectedFloorLamport: 20,
      durableSnapshotConfirmed: true,
      activeSegment: 4,
      genesisRef: G,
      reseedRefs: [],
    });
    // Among candidates {1,2} highest (2) kept for audit → truncate = [1].
    expect(plan.truncatableSegments).toEqual([1]);
    expect(plan.protectedSnapshots).toEqual([G]);
  });

  it('active segment is never a truncate candidate even at or below snapshotLamport', () => {
    const plan = SnapshotStore.planCompaction({
      segments: [{ num: 1, maxLamport: 5, empty: false }],
      protectedFloorLamport: 10,
      durableSnapshotConfirmed: true,
      activeSegment: 1,
      genesisRef: G,
      reseedRefs: [],
    });
    expect(plan.truncatableSegments).toEqual([]);
  });

  it('only one candidate → audit retention yields zero truncations', () => {
    const plan = SnapshotStore.planCompaction({
      segments: [
        { num: 1, maxLamport: 5, empty: false },
        { num: 2, maxLamport: 0, empty: true },
      ],
      protectedFloorLamport: 10,
      durableSnapshotConfirmed: true,
      activeSegment: 2,
      genesisRef: G,
      reseedRefs: [reseedRef(1), reseedRef(2)],
    });
    expect(plan.truncatableSegments).toEqual([]);
    expect(plan.protectedSnapshots).toEqual([G, reseedRef(1), reseedRef(2)]);
  });

  it('fallback floor (panel F): floor=min(primary,.bak) protects (X,Y] range segments', () => {
    // primary snapshotLamport=9, .bak=5 → per caller contract floor=min=5 passed.
    // If manifest latest (9) were used, seg2 (maxLamport 7) would truncate → (5,9] loss on .bak fallback.
    const plan = SnapshotStore.planCompaction({
      segments: [
        { num: 1, maxLamport: 3, empty: false }, // ≤5 candidate
        { num: 2, maxLamport: 7, empty: false }, // >5 → protected (X,Y] range)
        { num: 3, maxLamport: 0, empty: true },
      ],
      protectedFloorLamport: 5,
      durableSnapshotConfirmed: true,
      activeSegment: 3,
      genesisRef: G,
      reseedRefs: [],
    });
    // Only candidate {1} → audit retention so truncate 0. seg2 not even a candidate (above floor).
    expect(plan.truncatableSegments).toEqual([]);
    // If floor wrongly set to 9 (latest), seg2 enters candidates and seg1 truncates — contrast check.
    const wrong = SnapshotStore.planCompaction({
      segments: [
        { num: 1, maxLamport: 3, empty: false },
        { num: 2, maxLamport: 7, empty: false },
        { num: 3, maxLamport: 0, empty: true },
      ],
      protectedFloorLamport: 9,
      durableSnapshotConfirmed: true,
      activeSegment: 3,
      genesisRef: G,
      reseedRefs: [],
    });
    expect(wrong.truncatableSegments).toEqual([1]);
  });
});

// ── Panel E: flushSync vs in-flight async write (generation guard) ─────────────────

describe('flushSync vs in-flight async write (generation guard)', () => {
  it('stale async rename overwriting flushSync content is restored — final file = flushSync content', async () => {
    let release!: () => void;
    gate.block = new Promise<void>((r) => {
      release = r;
    });

    const store = new SnapshotStore(dir, { debounceMs: 1 });
    store.saveDebounced(CHANNEL_PROJECTION_REF, proj('stale'), 1);
    // Wait until debounce fires + async task enters atomicWriteJSON (gate blocked).
    for (let i = 0; i < 200 && !gate.entered; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(gate.entered).toBe(true);

    // Staging new state in in-flight window → flushSync sync durable write + generation advance.
    store.saveDebounced(CHANNEL_PROJECTION_REF, proj('fresh'), 2);
    store.flushSync();
    expect(gate.syncCalls.length).toBe(1); // flushSync fresh write

    // Stale async resumes → rename lands (overwrites fresh) → generation guard restores fresh (2nd sync).
    release();
    gate.block = null;
    for (let i = 0; i < 200 && gate.syncCalls.length < 2; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(gate.syncCalls.length).toBeGreaterThanOrEqual(2); // restore write occurred

    const env = store.load<ChannelState>(
      CHANNEL_PROJECTION_REF,
      isChannelStateLike,
    );
    expect(env!.snapshotLamport).toBe(2);
    expect(env!.projection.channels[0].id).toBe('ch-fresh');
    store.dispose();
  });
});

// ── Panel G①: immutable artifacts must not move on read path either ───────────────────────

describe('genesis·reseed corruption must not quarantine-move (§6.2)', () => {
  it('projection validation failure on genesis/reseed → fallback proceeds but files stay in place', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(GENESIS_CHANNEL_REF, proj('genesis'), 0);
    store.writeDurableSync(reseedRef(1), proj('reseed'), 5);
    // Valid JSON but invalid projection — validate reject path (isolation move trigger point).
    const badEnvelope = JSON.stringify({
      version: 1,
      snapshotLamport: 9,
      projection: { bogus: true },
    });
    fs.writeFileSync(store.snapshotPath(reseedRef(1)), badEnvelope);
    fs.rmSync(`${store.snapshotPath(reseedRef(1))}.bak`, { force: true });
    fs.writeFileSync(store.snapshotPath(GENESIS_CHANNEL_REF), badEnvelope);
    fs.rmSync(`${store.snapshotPath(GENESIS_CHANNEL_REF)}.bak`, {
      force: true,
    });

    const fb = store.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF, // absent
      genesisRef: GENESIS_CHANNEL_REF,
      reseedRefs: [reseedRef(1)],
      validateProjection: isChannelStateLike,
    });
    expect(fb).toBeNull(); // total loss — but file must not be moved.

    // Preserved in place (no isolation move) — §6.2 "no path modifies or deletes".
    expect(fs.existsSync(store.snapshotPath(GENESIS_CHANNEL_REF))).toBe(true);
    expect(fs.existsSync(store.snapshotPath(reseedRef(1)))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'corrupted'))).toBe(false);
  });

  it('active projection snapshot keeps default behavior (quarantine move on validate reject)', () => {
    const store = new SnapshotStore(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      store.snapshotPath(CHANNEL_PROJECTION_REF),
      JSON.stringify({ version: 1, snapshotLamport: 1, projection: { bogus: true } }),
    );
    expect(store.load(CHANNEL_PROJECTION_REF, isChannelStateLike)).toBeNull();
    // Existing T6 isolation convention — active snapshot (rewrite cache) moved for evidence preservation.
    expect(fs.existsSync(store.snapshotPath(CHANNEL_PROJECTION_REF))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(dir, 'corrupted'))).toBe(true);
  });
});
