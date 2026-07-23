import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  runMigration,
  detectMigrationState,
  computeStateHash,
  stampWatermark,
  evaluateWatermark,
  performReseed,
  MigrationError,
  type ReseedOptions,
} from '../migrateToEventLog';
import {
  SnapshotStore,
  SNAPSHOT_DIRNAME,
  GENESIS_CHANNEL_REF,
  CHANNEL_PROJECTION_REF,
} from '../SnapshotStore';
import {
  readManifest,
  manifestPath,
  EVENTLOG_FORMAT_VERSION,
} from '../EventLogManifest';
import { AppendOnlyLog } from '../AppendOnlyLog';
import { ChannelStateWriter } from '../../channels/ChannelStateWriter';
import { EMPTY_CHANNEL_STATE, type ChannelState } from '../../../shared/channels';

let wmuxDir: string;
let eventsDir: string;
let channelsPath: string;

beforeEach(() => {
  wmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-migrate-'));
  eventsDir = path.join(wmuxDir, 'events');
  channelsPath = path.join(wmuxDir, 'channels.json');
});

afterEach(() => {
  fs.rmSync(wmuxDir, { recursive: true, force: true });
  // Restore console.warn spies (and any other) so they never leak into a
  // later test file sharing this worker.
  vi.restoreAllMocks();
});

// ── Helpers ──────────────────────────────────────────────────────────────

const syncOk = (): void => {};

/** Test ChannelState structure guard (PR3 injects ChannelStateWriter.isChannelState). */
function isChannelStateLike(d: unknown): boolean {
  if (typeof d !== 'object' || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o['version'] === 'number' &&
    Array.isArray(o['channels']) &&
    typeof o['members'] === 'object' &&
    o['members'] !== null &&
    typeof o['messages'] === 'object' &&
    o['messages'] !== null &&
    typeof o['idempotency'] === 'object' &&
    o['idempotency'] !== null
  );
}

function legacyWithMembers(): ChannelState {
  const t = 1_700_000_000_000;
  return {
    version: 1,
    channels: [
      {
        id: 'ch-1',
        companyId: 'co-default',
        name: 'general',
        visibility: 'public',
        status: 'active',
        createdAt: t,
        createdBy: 'ws-a',
        nextSeq: 3,
      },
      {
        id: 'ch-2',
        companyId: 'co-default',
        name: 'archived-room',
        visibility: 'private',
        status: 'archived',
        createdAt: t,
        createdBy: 'ws-b',
        nextSeq: 1,
        archivedAt: t,
        archivedBy: 'ws-b',
      },
    ],
    members: {
      'ch-1': [
        {
          workspaceId: 'ws-a',
          memberId: 'ws-a',
          joinedAt: t,
          historyFromSeq: 0,
          lastReadSeq: 2,
        },
      ],
      'ch-2': [
        { workspaceId: 'ws-b', memberId: 'ws-b', joinedAt: t, historyFromSeq: 0 },
      ],
    },
    messages: {
      'ch-1': [
        {
          channelId: 'ch-1',
          seq: 1,
          workspaceId: 'ws-a',
          memberId: 'ws-a',
          memberName: 'A',
          text: 'hi',
          postedAt: t,
          deliveryStatus: 'delivered',
        },
        {
          channelId: 'ch-1',
          seq: 2,
          workspaceId: 'ws-a',
          memberId: 'ws-a',
          memberName: 'A',
          text: 'yo',
          postedAt: t,
          deliveryStatus: 'delivered',
          clientMsgId: 'c2',
        },
      ],
    },
    idempotency: { 'ch-1': { '["ws-a","c2"]': 2 } },
  };
}

function loadGenesisProjection(): ChannelState | null {
  const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
  const env = store.load<ChannelState>(GENESIS_CHANNEL_REF, isChannelStateLike);
  return env ? env.projection : null;
}

function migrateOpts(readLegacy: () => ChannelState | null) {
  return {
    eventsDir,
    readLegacyState: readLegacy,
    validateProjection: isChannelStateLike,
  };
}

// ── T-migration round-trip (required) ───────────────────────────────────────────

describe('T-Migration round trip', () => {
  it('legacy channels.json → genesis+machine-id+Bin log → replay → projection Same', () => {
    const state = legacyWithMembers();
    fs.writeFileSync(channelsPath, JSON.stringify(state));
    // Migration input canonical: read via ChannelStateWriter.load() (via reaper·validator).
    const writer = new ChannelStateWriter(wmuxDir);
    const expected = writer.load();

    const result = runMigration(migrateOpts(() => writer.load()));

    expect(result.detection).toBe('migrate');
    // genesis = legacy projection as-is (snapshotLamport 0 baseline).
    expect(loadGenesisProjection()).toEqual(expected);
    // machine-id minted·durable.
    expect(fs.existsSync(path.join(eventsDir, 'machine-id'))).toBe(true);
    expect(result.machineId.length).toBeGreaterThan(0);
    // One empty log segment (00000001.ndjson, size 0).
    expect(fs.statSync(path.join(eventsDir, '00000001.ndjson')).size).toBe(0);
    // manifest completion marker.
    const manifest = readManifest(eventsDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.formatVersion).toBe(EVENTLOG_FORMAT_VERSION);
    expect(manifest!.machineId).toBe(result.machineId);
    expect(manifest!.snapshotLamport).toBe(0);

    // replay: log empty so genesis (fallback chain) itself is projection. Verify same.
    const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
    const fallback = store.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF,
      genesisRef: manifest!.genesisRef,
      reseedRefs: manifest!.reseedRefs,
      validateProjection: isChannelStateLike,
    });
    expect(fallback!.source).toBe('genesis');
    expect(fallback!.projection).toEqual(expected);
  });

  it('empty legacy(absence of file=first-boot) → bean genesis baseline', () => {
    const result = runMigration(migrateOpts(() => null));
    expect(result.detection).toBe('migrate');
    expect(loadGenesisProjection()).toEqual(EMPTY_CHANNEL_STATE);
    expect(readManifest(eventsDir)).not.toBeNull();
  });

  it('conversion failed(Legacy Read throw) → Legacy intact + manifest unrecorded + Idempotent retry', () => {
    const state = legacyWithMembers();
    fs.writeFileSync(channelsPath, JSON.stringify(state));
    const before = fs.readFileSync(channelsPath, 'utf8');

    expect(() =>
      runMigration(
        migrateOpts(() => {
          throw new Error('inject legacy read failure');
        }),
      ),
    ).toThrow(MigrationError);

    // Legacy intact + manifest not written.
    expect(fs.readFileSync(channelsPath, 'utf8')).toBe(before);
    expect(fs.existsSync(manifestPath(eventsDir))).toBe(false);

    // Retry (normal reader) → complete.
    const writer = new ChannelStateWriter(wmuxDir);
    const result = runMigration(migrateOpts(() => writer.load()));
    expect(result.detection).toBe('migrate');
    expect(readManifest(eventsDir)).not.toBeNull();
  });

  it('Idempotent retry: manifest Rerun after completion → active(No reconversion or reminting)', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const first = runMigration(migrateOpts(() => writer.load()));

    const reader = vi.fn(() => writer.load());
    const second = runMigration(migrateOpts(reader));

    expect(second.detection).toBe('active');
    expect(second.machineId).toBe(first.machineId); // no re-mint
    expect(reader).not.toHaveBeenCalled(); // no re-conversion (no legacy re-read)
  });

  it('A(pristine window blockade): Stamped immediately after completion evaluateWatermark → unchanged', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const stampedWrites: unknown[] = [];
    const result = runMigration({
      ...migrateOpts(() => writer.load()),
      writeLegacyStamped: (s) => stampedWrites.push(s),
    });

    // Hook performs rewrite with lamport 0 (genesis baseline) watermark.
    expect(stampedWrites).toHaveLength(1);
    expect(result.legacyStamped).toBeDefined();
    expect(result.legacyStamped!.eventLogWatermark.lamport).toBe(0);
    expect(stampedWrites[0]).toEqual(result.legacyStamped);
    // First boot verdict before dual-write = unchanged — blocks absent false-positive (pristine window).
    expect(evaluateWatermark(result.legacyStamped).kind).toBe('unchanged');
  });

  it('A(Legacy caller without hook injection): maintain motion + Include legacyStamped in return value(Delivery of storage obligations)', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const result = runMigration(migrateOpts(() => writer.load())); // no hook

    expect(result.detection).toBe('migrate');
    expect(readManifest(eventsDir)).not.toBeNull(); // completion preserved
    expect(result.legacyStamped).toBeDefined();
    expect(evaluateWatermark(result.legacyStamped).kind).toBe('unchanged');
  });
});

// ── T-genesis ──────────────────────────────────────────────────────────

describe('T-genesis', () => {
  it('genesis Other snapshot total loss → genesis + Residual log replay recovery', async () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const expected = writer.load();
    const result = runMigration(migrateOpts(() => writer.load()));

    // Two post-migration events (lamport 1,2).
    const log = new AppendOnlyLog({ dir: eventsDir, fsync: syncOk });
    log.open();
    await log.append({
      origin: { machineId: result.machineId, daemonEpoch: 1 },
      authContext: {
        principalId: 'p',
        verifiedWorkspaceId: 'ws-a',
        trustTier: 'trusted',
      },
      domain: 'channel',
      payload: { seq: 3 },
    });
    await log.append({
      origin: { machineId: result.machineId, daemonEpoch: 1 },
      authContext: {
        principalId: 'p',
        verifiedWorkspaceId: 'ws-a',
        trustTier: 'trusted',
      },
      domain: 'channel',
      payload: { seq: 4 },
    });
    log.close();

    // After active projection snapshot scenario, "total loss except genesis": delete channel.json + .bak.
    const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
    store.writeDurableSync(CHANNEL_PROJECTION_REF, expected, 2);
    fs.rmSync(store.snapshotPath(CHANNEL_PROJECTION_REF), { force: true });
    fs.rmSync(`${store.snapshotPath(CHANNEL_PROJECTION_REF)}.bak`, { force: true });

    const manifest = readManifest(eventsDir)!;
    const fallback = store.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF,
      genesisRef: manifest.genesisRef,
      reseedRefs: manifest.reseedRefs,
      validateProjection: isChannelStateLike,
    });
    // genesis recovers pre-migration data from fallback chain floor.
    expect(fallback!.source).toBe('genesis');
    expect(fallback!.projection).toEqual(expected);
    // Remaining log (lamport > snapshotLamport=0) all replayable.
    const log2 = new AppendOnlyLog({ dir: eventsDir });
    log2.open();
    const replayable = log2
      .readAllRecords()
      .filter((r) => r.lamport > fallback!.snapshotLamport);
    expect(replayable.map((r) => r.lamport)).toEqual([1, 2]);
    log2.close();
  });
});

// ── T-manifest crash three branches + §6.1-4 post-crash ──────────────────────────

describe('T-manifestCrash Q3', () => {
  it('(a) 0 segments + manifest Absence → Legacy Migration', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const detection = detectMigrationState({
      eventsDir,
      validateProjection: isChannelStateLike,
    });
    expect(detection.kind).toBe('migrate');
    const result = runMigration(migrateOpts(() => writer.load()));
    expect(result.detection).toBe('migrate');
    expect(readManifest(eventsDir)).not.toBeNull();
  });

  it('(b) empty segment + genesis effectiveness + manifest Absence → only manifest reconstruction(No reconversion)', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const first = runMigration(migrateOpts(() => writer.load()));
    const genesisBefore = fs.readFileSync(
      new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME)).snapshotPath(
        GENESIS_CHANNEL_REF,
      ),
      'utf8',
    );

    // Simulate steps 2~3 crash: manifest only lost (genesis·machine-id·empty segments remain).
    fs.rmSync(manifestPath(eventsDir), { force: true });
    fs.rmSync(`${manifestPath(eventsDir)}.bak`, { force: true });

    const detection = detectMigrationState({
      eventsDir,
      validateProjection: isChannelStateLike,
    });
    expect(detection.kind).toBe('reconstruct-manifest');

    const reader = vi.fn(() => writer.load());
    const result = runMigration(migrateOpts(reader));
    expect(result.detection).toBe('reconstruct-manifest');
    expect(reader).not.toHaveBeenCalled(); // no re-conversion
    expect(result.machineId).toBe(first.machineId); // reuse existing machine-id
    // genesis unchanged (no rewrite).
    const genesisAfter = fs.readFileSync(
      new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME)).snapshotPath(
        GENESIS_CHANNEL_REF,
      ),
      'utf8',
    );
    expect(genesisAfter).toBe(genesisBefore);
    expect(readManifest(eventsDir)).not.toBeNull();
  });

  it('(c) non-empty segment + manifest Absence → Retry legacy after quarantine(preservation)', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    runMigration(migrateOpts(() => writer.load()));

    // Abnormal: manifest lost + segment non-empty (unreachable via normal path).
    fs.rmSync(manifestPath(eventsDir), { force: true });
    fs.rmSync(`${manifestPath(eventsDir)}.bak`, { force: true });
    const segPath = path.join(eventsDir, '00000001.ndjson');
    fs.writeFileSync(segPath, '{"lamport":1,"eventId":"x","origin":{"seq":1}}\n');
    const segContent = fs.readFileSync(segPath, 'utf8');

    const detection = detectMigrationState({
      eventsDir,
      validateProjection: isChannelStateLike,
    });
    expect(detection.kind).toBe('quarantine-and-migrate');

    // G② (§6.1-1(c)): on quarantine execution explicitly notify manual recovery via console.warn.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = runMigration(migrateOpts(() => writer.load()));
    expect(
      warnSpy.mock.calls.some(
        (args) =>
          String(args[0]).includes('quarantined') &&
          String(args[0]).includes('manual recovery'),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
    expect(result.detection).toBe('quarantine-and-migrate');
    expect(result.quarantined.length).toBe(1);
    // Quarantine file preserved (not deleted) + content intact.
    expect(fs.existsSync(result.quarantined[0])).toBe(true);
    expect(fs.readFileSync(result.quarantined[0], 'utf8')).toBe(segContent);
    // Exists under quarantine/.
    expect(result.quarantined[0]).toContain(
      `${path.sep}quarantine${path.sep}`,
    );
    // Re-conversion complete.
    expect(readManifest(eventsDir)).not.toBeNull();
    expect(fs.statSync(path.join(eventsDir, '00000001.ndjson')).size).toBe(0);
  });

  it('B(containment failure = interruption): rename failed injection → MigrationError + No legacy/segment damage + manifest unrecorded', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    runMigration(migrateOpts(() => writer.load()));

    // (c) state: manifest lost + non-empty segment.
    fs.rmSync(manifestPath(eventsDir), { force: true });
    fs.rmSync(`${manifestPath(eventsDir)}.bak`, { force: true });
    const segPath = path.join(eventsDir, '00000001.ndjson');
    const foreignLine = '{"lamport":1,"eventId":"x","origin":{"seq":1}}\n';
    fs.writeFileSync(segPath, foreignLine);
    const legacyBefore = fs.readFileSync(channelsPath, 'utf8');

    // Inject segment file rename failure only (other renames — atomicWrite tmp etc. — pass).
    const realRename = fs.renameSync;
    const renameSpy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementation((src, dest) => {
        if (/\d{8}\.ndjson$/.test(String(src))) {
          throw new Error('inject rename failure');
        }
        return realRename(src, dest);
      });

    expect(() => runMigration(migrateOpts(() => writer.load()))).toThrow(
      MigrationError,
    );
    renameSpy.mockRestore();

    // Intact: segment in place·original content, legacy unchanged, manifest not written (next boot retry).
    expect(fs.readFileSync(segPath, 'utf8')).toBe(foreignLine);
    expect(fs.readFileSync(channelsPath, 'utf8')).toBe(legacyBefore);
    expect(fs.existsSync(manifestPath(eventsDir))).toBe(false);

    // Retry (injection removed) → quarantine success + complete. Foreign events do not pollute replay
    // (active segment recreated empty — B③ premise).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retry = runMigration(migrateOpts(() => writer.load()));
    warnSpy.mockRestore();
    expect(retry.detection).toBe('quarantine-and-migrate');
    expect(readManifest(eventsDir)).not.toBeNull();
    expect(fs.statSync(segPath).size).toBe(0);
  });

  it('§6.1-4 Crash immediately after(manifest Yes, Before the first append) → Remigration does not occur', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const first = runMigration(migrateOpts(() => writer.load()));

    const reader = vi.fn(() => writer.load());
    const detection = detectMigrationState({
      eventsDir,
      validateProjection: isChannelStateLike,
    });
    expect(detection.kind).toBe('active');
    const result = runMigration(migrateOpts(reader));
    expect(result.detection).toBe('active');
    expect(reader).not.toHaveBeenCalled();
    expect(result.machineId).toBe(first.machineId);
  });
});

// ── T-downgrade (6.4c watermark) ───────────────────────────────────────

describe('T-Downgrade watermark', () => {
  it('New daemon normal restart N times → stateHash matching → reseed misfire 0', () => {
    const base = legacyWithMembers();
    let disk = stampWatermark(base, 0);
    for (let i = 0; i < 5; i++) {
      const verdict = evaluateWatermark(disk);
      expect(verdict.kind).toBe('unchanged');
      // dual-write re-stamp (no content change) — still matches.
      disk = stampWatermark(disk, verdict.kind === 'unchanged' ? verdict.watermark.lamport : 0);
    }
  });

  it('Absence of watermark → downgrade-write(absent)', () => {
    const verdict = evaluateWatermark(legacyWithMembers());
    expect(verdict.kind).toBe('downgrade-write');
    expect(verdict).toMatchObject({ reason: 'absent' });
  });

  it('Copying old-daemon writing(Content change/watermark field round trip preservation) → Mismatch → reseed snapshot+marker+Fallback transfer', async () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const migrated = runMigration(migrateOpts(() => writer.load()));
    const genesisStore = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
    const genesisBefore = fs.readFileSync(
      genesisStore.snapshotPath(GENESIS_CHANNEL_REF),
      'utf8',
    );

    // New daemon dual-write at lamport 0.
    const stamped = stampWatermark(writer.load(), 0);
    // Old daemon: content change (add channel) + watermark field preserved via full re-serialization (round-trip).
    const oldDaemonWrite: ChannelState & { eventLogWatermark: unknown } = {
      ...stamped,
      channels: [
        ...stamped.channels,
        {
          id: 'ch-old',
          companyId: 'co-default',
          name: 'old-daemon',
          visibility: 'public',
          status: 'active',
          createdAt: 1_700_000_000_001,
          createdBy: 'ws-x',
          nextSeq: 1,
        },
      ],
    };
    const verdict = evaluateWatermark(oldDaemonWrite);
    expect(verdict.kind).toBe('downgrade-write');
    expect(verdict).toMatchObject({ reason: 'hash-mismatch' });

    // reseed execution: marker append + reseed snapshot + manifest inclusion + watermark re-stamp (A).
    const log = new AppendOnlyLog({ dir: eventsDir, fsync: syncOk });
    log.open();
    const stampedWrites: unknown[] = [];
    const reseed = await performReseed({
      eventsDir,
      manifest: migrated.manifest,
      downgradeState: oldDaemonWrite as unknown as ChannelState,
      append: (d) => log.append(d),
      lamportHwm: () => log.lamportHwm,
      origin: { machineId: migrated.machineId, daemonEpoch: 1 },
      authContext: {
        principalId: 'p',
        verifiedWorkspaceId: 'ws-a',
        trustTier: 'trusted',
      },
      validateProjection: isChannelStateLike,
      writeLegacyStamped: (s) => stampedWrites.push(s),
    });

    expect(reseed.ok).toBe(true);
    expect(reseed.reseedRef).toBe('reseed-1.json');
    expect(reseed.markerLamport).toBe(1);

    // A (loop closure): re-stamped state written via hook, reboot verdict unchanged —
    // closes path where same hash-mismatch re-detects and reseed-{n} proliferates.
    expect(stampedWrites).toHaveLength(1);
    expect(reseed.legacyStamped).toBeDefined();
    expect(reseed.legacyStamped!.eventLogWatermark.lamport).toBe(1);
    expect(evaluateWatermark(reseed.legacyStamped).kind).toBe('unchanged');
    // Re-stamp preserves old-daemon content (ch-old) with fresh watermark only.
    expect(
      reseed.legacyStamped!.channels.some((c) => c.id === 'ch-old'),
    ).toBe(true);
    // One reseed marker in log.
    const markers = log.readAllRecords();
    expect(markers).toHaveLength(1);
    expect((markers[0].payload as { kind: string }).kind).toBe('legacy-reseed');
    log.close();

    // manifest inclusion + snapshotLamport advance.
    expect(reseed.manifest.reseedRefs).toEqual(['reseed-1.json']);
    expect(reseed.manifest.snapshotLamport).toBe(1);
    const onDisk = readManifest(eventsDir)!;
    expect(onDisk.reseedRefs).toEqual(['reseed-1.json']);

    // genesis unchanged (immutable).
    expect(
      fs.readFileSync(genesisStore.snapshotPath(GENESIS_CHANNEL_REF), 'utf8'),
    ).toBe(genesisBefore);

    // Fallback chain: recover from reseed when active snapshot corrupt (includes old-daemon content).
    fs.writeFileSync(
      genesisStore.snapshotPath(CHANNEL_PROJECTION_REF),
      'CORRUPT{',
    );
    fs.rmSync(`${genesisStore.snapshotPath(CHANNEL_PROJECTION_REF)}.bak`, {
      force: true,
    });
    const fallback = genesisStore.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF,
      genesisRef: onDisk.genesisRef,
      reseedRefs: onDisk.reseedRefs,
      validateProjection: isChannelStateLike,
    });
    expect(fallback!.source).toBe('reseed');
    expect(fallback!.snapshotLamport).toBe(1);
    expect(fallback!.projection.channels.some((c) => c.id === 'ch-old')).toBe(
      true,
    );
  });

  it('D(append failure): Marker not committed → reseed interruption/side effects 0(Snapshot, manifest, and hook all not executed)', async () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const migrated = runMigration(migrateOpts(() => writer.load()));
    const manifestBefore = fs.readFileSync(manifestPath(eventsDir), 'utf8');

    const stampedWrites: unknown[] = [];
    const reseed = await performReseed({
      eventsDir,
      manifest: migrated.manifest,
      downgradeState: writer.load(),
      append: async () => false, // inject marker commit failure
      lamportHwm: () => 0,
      origin: { machineId: migrated.machineId, daemonEpoch: 1 },
      authContext: {
        principalId: 'p',
        verifiedWorkspaceId: 'ws-a',
        trustTier: 'trusted',
      },
      validateProjection: isChannelStateLike,
      writeLegacyStamped: (s) => stampedWrites.push(s),
    });

    expect(reseed.ok).toBe(false);
    expect(reseed.failReason).toBe('append-failed');
    // Zero side effects: no reseed snapshot, manifest unchanged, hook not called.
    const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
    expect(fs.existsSync(store.snapshotPath('reseed-1.json'))).toBe(false);
    expect(fs.readFileSync(manifestPath(eventsDir), 'utf8')).toBe(
      manifestBefore,
    );
    expect(stampedWrites).toHaveLength(0);
    expect(reseed.legacyStamped).toBeUndefined();
  });

  it('D(reseed retry cycle): 1Primary append failed → channels.json No signal damage → 2nd retry to recover downgrade data without loss', async () => {
    // This test pins invariant index.ts boot gate fail-closed decision depends on:
    // if reseed incomplete on active boot that boot halts fail-closed so dual-write cannot
    // re-stamp channels.json, preserving downgrade signal (stale watermark) until next boot
    // so retry incorporates downgrade data into log losslessly.
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const migrated = runMigration(migrateOpts(() => writer.load()));

    // New daemon lamport 0 dual-write then old daemon added channel (downgrade) channels.json.
    const stamped = stampWatermark(writer.load(), 0);
    const downgrade = {
      ...stamped,
      channels: [
        ...stamped.channels,
        {
          id: 'ch-old',
          companyId: 'co-default',
          name: 'old-daemon',
          visibility: 'public',
          status: 'active',
          createdAt: 1_700_000_000_001,
          createdBy: 'ws-x',
          nextSeq: 1,
        },
      ],
    } as unknown as ChannelState;
    expect(evaluateWatermark(downgrade).kind).toBe('downgrade-write');

    const log = new AppendOnlyLog({ dir: eventsDir, fsync: syncOk });
    log.open();

    // Round 1: inject marker append failure → reseed incomplete (on boot would fail-closed halt here).
    let appendEnabled = false;
    const stampedWrites: unknown[] = [];
    const reseedOpts = (): ReseedOptions => ({
      eventsDir,
      manifest: migrated.manifest,
      downgradeState: downgrade,
      append: async (d) => (appendEnabled ? log.append(d) : false),
      lamportHwm: () => log.lamportHwm,
      origin: { machineId: migrated.machineId, daemonEpoch: 1 },
      authContext: {
        principalId: 'p',
        verifiedWorkspaceId: 'ws-a',
        trustTier: 'trusted',
      },
      validateProjection: isChannelStateLike,
      writeLegacyStamped: (s) => {
        stampedWrites.push(s);
      },
    });

    const first = await performReseed(reseedOpts());
    expect(first.ok).toBe(false);
    expect(first.failReason).toBe('append-failed');
    // Key invariant: hook not called → no channels.json rewrite → downgrade signal intact.
    // (index.ts fail-closed blocks dual-write preserving signal until next boot.)
    expect(stampedWrites).toHaveLength(0);
    expect(evaluateWatermark(downgrade).kind).toBe('downgrade-write');

    // Round 2 (equivalent next boot retry): append normal → reseed complete.
    appendEnabled = true;
    const second = await performReseed(reseedOpts());
    expect(second.ok).toBe(true);
    expect(second.markerLamport).toBe(1);
    // Channel old daemon added incorporated into log via reseed losslessly.
    expect(
      second.legacyStamped!.channels.some((c) => c.id === 'ch-old'),
    ).toBe(true);

    // Fallback chain check: recover old-daemon data from reseed when active snapshot corrupt.
    const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
    fs.writeFileSync(store.snapshotPath(CHANNEL_PROJECTION_REF), 'CORRUPT{');
    fs.rmSync(`${store.snapshotPath(CHANNEL_PROJECTION_REF)}.bak`, {
      force: true,
    });
    const fallback = store.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF,
      genesisRef: second.manifest.genesisRef,
      reseedRefs: second.manifest.reseedRefs,
      validateProjection: isChannelStateLike,
    });
    expect(fallback!.source).toBe('reseed');
    expect(fallback!.projection.channels.some((c) => c.id === 'ch-old')).toBe(
      true,
    );
    log.close();
  });

  it('D(lamport race): hwmthis before+1Either this or stop(boot-exclusive premise violation) — side effect 0', async () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const migrated = runMigration(migrateOpts(() => writer.load()));
    const manifestBefore = fs.readFileSync(manifestPath(eventsDir), 'utf8');

    // Simulate concurrent append: hwm advances 0→2 between marker append.
    let hwm = 0;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reseed = await performReseed({
      eventsDir,
      manifest: migrated.manifest,
      downgradeState: writer.load(),
      append: async () => {
        hwm += 2; // marker + interleaved event
        return true;
      },
      lamportHwm: () => hwm,
      origin: { machineId: migrated.machineId, daemonEpoch: 1 },
      authContext: {
        principalId: 'p',
        verifiedWorkspaceId: 'ws-a',
        trustTier: 'trusted',
      },
      validateProjection: isChannelStateLike,
    });
    warnSpy.mockRestore();

    expect(reseed.ok).toBe(false);
    expect(reseed.failReason).toBe('lamport-race');
    // Zero side effects: snapshot·manifest not written (next boot retry).
    const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
    expect(fs.existsSync(store.snapshotPath('reseed-1.json'))).toBe(false);
    expect(fs.readFileSync(manifestPath(eventsDir), 'utf8')).toBe(
      manifestBefore,
    );
  });
});

// ── computeStateHash contract ──────────────────────────────────────────────

describe('computeStateHash(Watermark field excludes itself + Key order is unchanged)', () => {
  it('Watermark field is excluded from hash — hash is same as long as lamport is changed', () => {
    const s = legacyWithMembers();
    const a = stampWatermark(s, 1);
    const b = stampWatermark(s, 999);
    expect(computeStateHash(a)).toBe(computeStateHash(b));
  });

  it('Change hash when content changes', () => {
    const s = legacyWithMembers();
    const mutated: ChannelState = {
      ...s,
      channels: [...s.channels, { ...s.channels[0], id: 'ch-3', name: 'new' }],
    };
    expect(computeStateHash(s)).not.toBe(computeStateHash(mutated));
  });

  it('Hash is the same even if the key order is different(Canonical serialization)', () => {
    const a = { version: 1, channels: [], members: {}, messages: {}, idempotency: {} };
    const b = { idempotency: {}, messages: {}, members: {}, channels: [], version: 1 };
    expect(computeStateHash(a)).toBe(computeStateHash(b));
  });
});

describe('impairment manifest ≠ absence (panel delta — fail-closed)', () => {
  it('manifest Exists but unreadable + non-empty segment → MigrationError, No quarantine or remigration', () => {
    fs.mkdirSync(eventsDir, { recursive: true });
            // Corrupt manifest (unparseable) — no .bak.
    fs.writeFileSync(manifestPath(eventsDir), '{corrupt!!');
    const segPath = path.join(eventsDir, '00000001.ndjson');
    const segLine = '{"lamport":1,"eventId":"x","origin":{"seq":1}}\n';
    fs.writeFileSync(segPath, segLine); // simulate log-only commit

    expect(() =>
      detectMigrationState({ eventsDir, validateProjection: isChannelStateLike }),
    ).toThrow(MigrationError);

    // Intact: segment in place·original content, no quarantine, corrupt manifest preserved (manual recovery evidence).
    expect(fs.readFileSync(segPath, 'utf8')).toBe(segLine);
    expect(fs.existsSync(path.join(eventsDir, 'quarantine'))).toBe(false);
    expect(fs.readFileSync(manifestPath(eventsDir), 'utf8')).toBe('{corrupt!!');
  });

  it('impairment primary + effectiveness .bak → .bak As a fallback active (throw Not)', () => {
    fs.mkdirSync(eventsDir, { recursive: true });
            const valid = {
      formatVersion: 1, machineId: 'm-1', genesisRef: 'genesis-channel',
      reseedRefs: [], snapshotLamport: 0, activeSegment: 1,
    };
    fs.writeFileSync(`${manifestPath(eventsDir)}.bak`, JSON.stringify(valid));
    fs.writeFileSync(manifestPath(eventsDir), '{corrupt!!');

    const detection = detectMigrationState({
      eventsDir, validateProjection: isChannelStateLike,
    });
    expect(detection.kind).toBe('active');
    // No read-time isolation move (quarantineOnCorruption:false) — corrupt primary preserved.
    expect(fs.existsSync(manifestPath(eventsDir))).toBe(true);
  });
});
