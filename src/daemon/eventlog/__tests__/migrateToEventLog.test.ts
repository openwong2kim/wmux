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

// ── 헬퍼 ──────────────────────────────────────────────────────────────

const syncOk = (): void => {};

/** 테스트용 ChannelState 구조 가드(PR3는 ChannelStateWriter.isChannelState 주입). */
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

// ── T-마이그레이션 왕복(필수) ───────────────────────────────────────────

describe('T-마이그레이션 왕복', () => {
  it('레거시 channels.json → genesis+machine-id+빈로그 → replay → projection 동일', () => {
    const state = legacyWithMembers();
    fs.writeFileSync(channelsPath, JSON.stringify(state));
    // 마이그레이션 입력의 정본: ChannelStateWriter.load()로 읽는다(reaper·validator 경유).
    const writer = new ChannelStateWriter(wmuxDir);
    const expected = writer.load();

    const result = runMigration(migrateOpts(() => writer.load()));

    expect(result.detection).toBe('migrate');
    // genesis = 레거시 projection 그대로(snapshotLamport 0 baseline).
    expect(loadGenesisProjection()).toEqual(expected);
    // machine-id 민팅·durable.
    expect(fs.existsSync(path.join(eventsDir, 'machine-id'))).toBe(true);
    expect(result.machineId.length).toBeGreaterThan(0);
    // 빈 로그 세그먼트 1개(00000001.ndjson, size 0).
    expect(fs.statSync(path.join(eventsDir, '00000001.ndjson')).size).toBe(0);
    // manifest 완료 표지.
    const manifest = readManifest(eventsDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.formatVersion).toBe(EVENTLOG_FORMAT_VERSION);
    expect(manifest!.machineId).toBe(result.machineId);
    expect(manifest!.snapshotLamport).toBe(0);

    // replay: 로그가 비었으므로 genesis(폴백 체인) 자체가 projection. 동일 확인.
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

  it('빈 레거시(파일 부재=first-boot) → 빈 genesis baseline', () => {
    const result = runMigration(migrateOpts(() => null));
    expect(result.detection).toBe('migrate');
    expect(loadGenesisProjection()).toEqual(EMPTY_CHANNEL_STATE);
    expect(readManifest(eventsDir)).not.toBeNull();
  });

  it('변환 실패(레거시 읽기 throw) → 레거시 무손상 + manifest 미기록 + 재시도 멱등', () => {
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

    // 레거시 무손상 + manifest 미기록.
    expect(fs.readFileSync(channelsPath, 'utf8')).toBe(before);
    expect(fs.existsSync(manifestPath(eventsDir))).toBe(false);

    // 재시도(정상 리더) → 완결.
    const writer = new ChannelStateWriter(wmuxDir);
    const result = runMigration(migrateOpts(() => writer.load()));
    expect(result.detection).toBe('migrate');
    expect(readManifest(eventsDir)).not.toBeNull();
  });

  it('재시도 멱등: manifest 완결 후 재실행 → active(재변환·재민팅 없음)', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const first = runMigration(migrateOpts(() => writer.load()));

    const reader = vi.fn(() => writer.load());
    const second = runMigration(migrateOpts(reader));

    expect(second.detection).toBe('active');
    expect(second.machineId).toBe(first.machineId); // 재민팅 없음
    expect(reader).not.toHaveBeenCalled(); // 재변환 없음(레거시 재읽기 안 함)
  });

  it('A(pristine 창 봉쇄): 완결 직후 스탬프된 상태로 evaluateWatermark → unchanged', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const stampedWrites: unknown[] = [];
    const result = runMigration({
      ...migrateOpts(() => writer.load()),
      writeLegacyStamped: (s) => stampedWrites.push(s),
    });

    // 훅이 lamport 0(genesis 베이스라인) 워터마크로 되쓰기를 수행.
    expect(stampedWrites).toHaveLength(1);
    expect(result.legacyStamped).toBeDefined();
    expect(result.legacyStamped!.eventLogWatermark.lamport).toBe(0);
    expect(stampedWrites[0]).toEqual(result.legacyStamped);
    // 첫 dual-write 전 부트 판정 = unchanged — absent 오발동(pristine 창) 봉쇄.
    expect(evaluateWatermark(result.legacyStamped).kind).toBe('unchanged');
  });

  it('A(훅 미주입 레거시 호출자): 동작 유지 + 반환값에 legacyStamped 포함(저장 의무 전달)', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const result = runMigration(migrateOpts(() => writer.load())); // 훅 없음

    expect(result.detection).toBe('migrate');
    expect(readManifest(eventsDir)).not.toBeNull(); // 완결 유지
    expect(result.legacyStamped).toBeDefined();
    expect(evaluateWatermark(result.legacyStamped).kind).toBe('unchanged');
  });
});

// ── T-genesis ──────────────────────────────────────────────────────────

describe('T-genesis', () => {
  it('genesis 외 스냅샷 전손 → genesis + 잔여 로그 replay 복구', async () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const expected = writer.load();
    const result = runMigration(migrateOpts(() => writer.load()));

    // 마이그레이션-후 신규 이벤트 2건(lamport 1,2).
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

    // 활성 projection 스냅샷 존재 시나리오 후 "genesis 외 전손": channel.json + .bak 삭제.
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
    // genesis가 폴백 체인 바닥에서 마이그레이션-전 데이터를 복구.
    expect(fallback!.source).toBe('genesis');
    expect(fallback!.projection).toEqual(expected);
    // 잔여 로그(lamport > snapshotLamport=0)가 전부 살아 replay 가능.
    const log2 = new AppendOnlyLog({ dir: eventsDir });
    log2.open();
    const replayable = log2
      .readAllRecords()
      .filter((r) => r.lamport > fallback!.snapshotLamport);
    expect(replayable.map((r) => r.lamport)).toEqual([1, 2]);
    log2.close();
  });
});

// ── T-manifest크래시 3분기 + §6.1-4 직후 크래시 ──────────────────────────

describe('T-manifest크래시 3분기', () => {
  it('(a) 세그먼트 0개 + manifest 부재 → 레거시 마이그레이션', () => {
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

  it('(b) 빈 세그먼트 + genesis 유효 + manifest 부재 → manifest 재구성만(재변환 없음)', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const first = runMigration(migrateOpts(() => writer.load()));
    const genesisBefore = fs.readFileSync(
      new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME)).snapshotPath(
        GENESIS_CHANNEL_REF,
      ),
      'utf8',
    );

    // 2~3단계 크래시 모사: manifest만 소실(genesis·machine-id·빈 세그먼트 잔존).
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
    expect(reader).not.toHaveBeenCalled(); // 재변환 없음
    expect(result.machineId).toBe(first.machineId); // 기존 machine-id 재사용
    // genesis 불변(재작성 없음).
    const genesisAfter = fs.readFileSync(
      new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME)).snapshotPath(
        GENESIS_CHANNEL_REF,
      ),
      'utf8',
    );
    expect(genesisAfter).toBe(genesisBefore);
    expect(readManifest(eventsDir)).not.toBeNull();
  });

  it('(c) 비어있지-않은 세그먼트 + manifest 부재 → quarantine 격리 후 레거시 재시도(보존)', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    runMigration(migrateOpts(() => writer.load()));

    // 비정상: manifest 소실 + 세그먼트가 비어있지 않음(정상 경로로 도달 불가능한 상태).
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

    // G②(§6.1-1(c)): 격리 실행 시 수동 복구 대상임을 console.warn으로 명시 고지.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = runMigration(migrateOpts(() => writer.load()));
    expect(
      warnSpy.mock.calls.some(
        (args) =>
          String(args[0]).includes('격리') &&
          String(args[0]).includes('수동 복구'),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
    expect(result.detection).toBe('quarantine-and-migrate');
    expect(result.quarantined.length).toBe(1);
    // 격리 파일이 보존(삭제 아님) + 내용 그대로.
    expect(fs.existsSync(result.quarantined[0])).toBe(true);
    expect(fs.readFileSync(result.quarantined[0], 'utf8')).toBe(segContent);
    // quarantine/ 하위에 존재.
    expect(result.quarantined[0]).toContain(
      `${path.sep}quarantine${path.sep}`,
    );
    // 재변환 완결.
    expect(readManifest(eventsDir)).not.toBeNull();
    expect(fs.statSync(path.join(eventsDir, '00000001.ndjson')).size).toBe(0);
  });

  it('B(격리 실패 = 중단): rename 실패 주입 → MigrationError + 레거시·세그먼트 무손상 + manifest 미기록', () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    runMigration(migrateOpts(() => writer.load()));

    // (c) 상태 구성: manifest 소실 + 비어있지-않은 세그먼트.
    fs.rmSync(manifestPath(eventsDir), { force: true });
    fs.rmSync(`${manifestPath(eventsDir)}.bak`, { force: true });
    const segPath = path.join(eventsDir, '00000001.ndjson');
    const foreignLine = '{"lamport":1,"eventId":"x","origin":{"seq":1}}\n';
    fs.writeFileSync(segPath, foreignLine);
    const legacyBefore = fs.readFileSync(channelsPath, 'utf8');

    // 세그먼트 파일 rename만 실패 주입(다른 rename — atomicWrite tmp 등 — 은 통과).
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

    // 무손상: 세그먼트 원위치·원내용, 레거시 불변, manifest 미기록(다음 부트 재시도).
    expect(fs.readFileSync(segPath, 'utf8')).toBe(foreignLine);
    expect(fs.readFileSync(channelsPath, 'utf8')).toBe(legacyBefore);
    expect(fs.existsSync(manifestPath(eventsDir))).toBe(false);

    // 재시도(주입 해제) → 격리 성공 + 완결. 외래 이벤트가 replay에 오염되지 않음
    // (활성 세그먼트가 빈 것으로 재생성 — B③ 전제).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retry = runMigration(migrateOpts(() => writer.load()));
    warnSpy.mockRestore();
    expect(retry.detection).toBe('quarantine-and-migrate');
    expect(readManifest(eventsDir)).not.toBeNull();
    expect(fs.statSync(segPath).size).toBe(0);
  });

  it('§6.1-4 직후 크래시(manifest 있음, 첫 append 전) → 재마이그레이션 미발생', () => {
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

// ── T-다운그레이드(6.4c 워터마크) ───────────────────────────────────────

describe('T-다운그레이드 워터마크', () => {
  it('신 데몬 정상 재시작 N회 → stateHash 일치 → reseed 오발동 0', () => {
    const base = legacyWithMembers();
    let disk = stampWatermark(base, 0);
    for (let i = 0; i < 5; i++) {
      const verdict = evaluateWatermark(disk);
      expect(verdict.kind).toBe('unchanged');
      // dual-write 재-스탬프(내용 변경 없음) — 여전히 일치.
      disk = stampWatermark(disk, verdict.kind === 'unchanged' ? verdict.watermark.lamport : 0);
    }
  });

  it('워터마크 부재 → downgrade-write(absent)', () => {
    const verdict = evaluateWatermark(legacyWithMembers());
    expect(verdict.kind).toBe('downgrade-write');
    expect(verdict).toMatchObject({ reason: 'absent' });
  });

  it('구-데몬 쓰기 모사(내용 변경·워터마크 필드 왕복 보존) → 불일치 → reseed 스냅샷+마커+폴백 편입', async () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const migrated = runMigration(migrateOpts(() => writer.load()));
    const genesisStore = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
    const genesisBefore = fs.readFileSync(
      genesisStore.snapshotPath(GENESIS_CHANNEL_REF),
      'utf8',
    );

    // 신 데몬이 lamport 0에서 dual-write.
    const stamped = stampWatermark(writer.load(), 0);
    // 구 데몬: 내용 변경(채널 추가) + 워터마크 필드는 통째 재직렬화로 보존(왕복).
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

    // reseed 실행: 마커 append + reseed 스냅샷 + manifest 편입 + 워터마크 재스탬프(A).
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

    // A(루프 봉쇄): 재스탬프된 상태가 훅으로 되써지고, 재부트 판정이 unchanged —
    // 같은 hash-mismatch를 재검출해 reseed-{n}이 증식하는 경로가 닫힌다.
    expect(stampedWrites).toHaveLength(1);
    expect(reseed.legacyStamped).toBeDefined();
    expect(reseed.legacyStamped!.eventLogWatermark.lamport).toBe(1);
    expect(evaluateWatermark(reseed.legacyStamped).kind).toBe('unchanged');
    // 재스탬프본은 구-데몬 내용(ch-old)을 보존하고 워터마크만 신선하다.
    expect(
      reseed.legacyStamped!.channels.some((c) => c.id === 'ch-old'),
    ).toBe(true);
    // 로그에 reseed 마커 1건.
    const markers = log.readAllRecords();
    expect(markers).toHaveLength(1);
    expect((markers[0].payload as { kind: string }).kind).toBe('legacy-reseed');
    log.close();

    // manifest 편입 + snapshotLamport 전진.
    expect(reseed.manifest.reseedRefs).toEqual(['reseed-1.json']);
    expect(reseed.manifest.snapshotLamport).toBe(1);
    const onDisk = readManifest(eventsDir)!;
    expect(onDisk.reseedRefs).toEqual(['reseed-1.json']);

    // genesis 불변(immutable).
    expect(
      fs.readFileSync(genesisStore.snapshotPath(GENESIS_CHANNEL_REF), 'utf8'),
    ).toBe(genesisBefore);

    // 폴백 체인 편입: 활성 스냅샷 손상 시 reseed로 복구(구-데몬 내용 포함).
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

  it('D(append 실패): 마커 미커밋 → reseed 중단·부작용 0(스냅샷·manifest·훅 전부 미실행)', async () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const migrated = runMigration(migrateOpts(() => writer.load()));
    const manifestBefore = fs.readFileSync(manifestPath(eventsDir), 'utf8');

    const stampedWrites: unknown[] = [];
    const reseed = await performReseed({
      eventsDir,
      manifest: migrated.manifest,
      downgradeState: writer.load(),
      append: async () => false, // 마커 커밋 실패 주입
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
    // 부작용 0: reseed 스냅샷 없음, manifest 불변, 훅 미호출.
    const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
    expect(fs.existsSync(store.snapshotPath('reseed-1.json'))).toBe(false);
    expect(fs.readFileSync(manifestPath(eventsDir), 'utf8')).toBe(
      manifestBefore,
    );
    expect(stampedWrites).toHaveLength(0);
    expect(reseed.legacyStamped).toBeUndefined();
  });

  it('D(reseed 재시도 사이클): 1차 append 실패 → channels.json 신호 무손상 → 2차 재시도로 다운그레이드 데이터 무손실 복구', async () => {
    // 이 테스트는 index.ts 부트 게이트의 fail-closed 결정이 의존하는 불변식을 못박는다:
    // active 부트에서 reseed가 미완이면 그 부트는 fail-closed로 중단되어 dual-write가
    // channels.json을 재-스탬프하지 못하고, 그 결과 다운그레이드 신호(stale 워터마크)가
    // 다음 부트까지 살아남아 재시도가 다운그레이드 데이터를 손실 없이 로그에 편입한다.
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const migrated = runMigration(migrateOpts(() => writer.load()));

    // 신 데몬 lamport 0 dual-write 후 구-데몬이 채널을 추가한(다운그레이드) channels.json.
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

    // 1차: 마커 append 실패 주입 → reseed 미완(부트라면 여기서 fail-closed 중단).
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
    // 핵심 불변식: 훅 미호출 → channels.json 되쓰기 없음 → 다운그레이드 신호 무손상.
    // (index.ts fail-closed가 dual-write를 막아 이 신호를 다음 부트까지 보존한다.)
    expect(stampedWrites).toHaveLength(0);
    expect(evaluateWatermark(downgrade).kind).toBe('downgrade-write');

    // 2차(다음 부트 재시도 등가): append 정상 → reseed 완결.
    appendEnabled = true;
    const second = await performReseed(reseedOpts());
    expect(second.ok).toBe(true);
    expect(second.markerLamport).toBe(1);
    // 구-데몬이 추가한 채널이 reseed로 로그에 편입되어 무손실 복구된다.
    expect(
      second.legacyStamped!.channels.some((c) => c.id === 'ch-old'),
    ).toBe(true);

    // 폴백 체인 확인: 활성 스냅샷 손상 시 reseed에서 구-데몬 데이터 복구.
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

  it('D(lamport race): hwm이 before+1이 아니면 중단(부트-단독 전제 위반) — 부작용 0', async () => {
    fs.writeFileSync(channelsPath, JSON.stringify(legacyWithMembers()));
    const writer = new ChannelStateWriter(wmuxDir);
    const migrated = runMigration(migrateOpts(() => writer.load()));
    const manifestBefore = fs.readFileSync(manifestPath(eventsDir), 'utf8');

    // 동시 append 개입 모사: 마커 append 사이 hwm이 2 전진(0 → 2).
    let hwm = 0;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reseed = await performReseed({
      eventsDir,
      manifest: migrated.manifest,
      downgradeState: writer.load(),
      append: async () => {
        hwm += 2; // 마커 + 끼어든 이벤트
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
    // 부작용 0: 스냅샷·manifest 미기록(다음 부트 재시도).
    const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
    expect(fs.existsSync(store.snapshotPath('reseed-1.json'))).toBe(false);
    expect(fs.readFileSync(manifestPath(eventsDir), 'utf8')).toBe(
      manifestBefore,
    );
  });
});

// ── computeStateHash 계약 ──────────────────────────────────────────────

describe('computeStateHash(워터마크 필드 자신 제외 + 키순서 불변)', () => {
  it('워터마크 필드는 해시에서 제외 — lamport만 바뀌면 해시 동일', () => {
    const s = legacyWithMembers();
    const a = stampWatermark(s, 1);
    const b = stampWatermark(s, 999);
    expect(computeStateHash(a)).toBe(computeStateHash(b));
  });

  it('내용이 바뀌면 해시 변경', () => {
    const s = legacyWithMembers();
    const mutated: ChannelState = {
      ...s,
      channels: [...s.channels, { ...s.channels[0], id: 'ch-3', name: 'new' }],
    };
    expect(computeStateHash(s)).not.toBe(computeStateHash(mutated));
  });

  it('키 순서가 달라도 해시 동일(정준 직렬화)', () => {
    const a = { version: 1, channels: [], members: {}, messages: {}, idempotency: {} };
    const b = { idempotency: {}, messages: {}, members: {}, channels: [], version: 1 };
    expect(computeStateHash(a)).toBe(computeStateHash(b));
  });
});

describe('손상 manifest ≠ 부재 (패널 델타 — fail-closed)', () => {
  it('manifest 존재하나 판독 불가 + 비어있지-않은 세그먼트 → MigrationError, 격리·재마이그레이션 없음', () => {
    fs.mkdirSync(eventsDir, { recursive: true });
            // 손상 manifest(파싱 불가) — .bak 없음.
    fs.writeFileSync(manifestPath(eventsDir), '{corrupt!!');
    const segPath = path.join(eventsDir, '00000001.ndjson');
    const segLine = '{"lamport":1,"eventId":"x","origin":{"seq":1}}\n';
    fs.writeFileSync(segPath, segLine); // 로그-only 커밋 모사

    expect(() =>
      detectMigrationState({ eventsDir, validateProjection: isChannelStateLike }),
    ).toThrow(MigrationError);

    // 무손상: 세그먼트 원위치·원내용, quarantine 미생성, 손상 manifest도 보존(수동 복구 물증).
    expect(fs.readFileSync(segPath, 'utf8')).toBe(segLine);
    expect(fs.existsSync(path.join(eventsDir, 'quarantine'))).toBe(false);
    expect(fs.readFileSync(manifestPath(eventsDir), 'utf8')).toBe('{corrupt!!');
  });

  it('손상 primary + 유효 .bak → .bak 폴백으로 active (throw 아님)', () => {
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
    // read-time 격리 이동 없음(quarantineOnCorruption:false) — 손상 primary 보존.
    expect(fs.existsSync(manifestPath(eventsDir))).toBe(true);
  });
});
