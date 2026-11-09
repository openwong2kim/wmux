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

// 패널 E 재현용 게이트: async atomicWriteJSON을 게이트에서 블록해 flushSync가
// in-flight 창에 끼어드는 인터리빙을 결정적으로 재현한다. sync 쓰기 호출은
// syncCalls로 기록해 "복원 쓰기 발생"을 관측한다.
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

// ── 헬퍼 ──────────────────────────────────────────────────────────────

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

/** 마커로 구분되는 최소 ChannelState-유사 projection. */
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

// ── T-스냅샷 손상 폴백(§5): 최신 → .bak → reseed → genesis ────────────────

describe('T-스냅샷 손상 폴백', () => {
  it('최신 → .bak → reseed → genesis 순으로 강등', () => {
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

    // 1. 정상 → 최신 active-new.
    let fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('snapshot');
    expect(fb!.snapshotLamport).toBe(10);
    expect(fb!.projection.channels[0].id).toBe('ch-active-new');

    // 2. primary 손상 → .bak(active-old).
    fs.writeFileSync(store.snapshotPath(CHANNEL_PROJECTION_REF), 'CORRUPT{');
    fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('snapshot');
    expect(fb!.snapshotLamport).toBe(9);
    expect(fb!.projection.channels[0].id).toBe('ch-active-old');

    // 3. .bak도 손상 → reseed.
    fs.writeFileSync(
      `${store.snapshotPath(CHANNEL_PROJECTION_REF)}.bak`,
      'CORRUPT{',
    );
    fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('reseed');
    expect(fb!.snapshotLamport).toBe(5);
    expect(fb!.projection.channels[0].id).toBe('ch-reseed');

    // 4. reseed 손상 → genesis(바닥).
    fs.writeFileSync(store.snapshotPath(reseedRef(1)), 'CORRUPT{');
    fs.rmSync(`${store.snapshotPath(reseedRef(1))}.bak`, { force: true });
    fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('genesis');
    expect(fb!.snapshotLamport).toBe(0);
    expect(fb!.projection.channels[0].id).toBe('ch-genesis');
  });

  it('reseed 다수 → 최신(높은 번호)부터 시도', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(GENESIS_CHANNEL_REF, proj('genesis'), 0);
    store.writeDurableSync(reseedRef(1), proj('reseed-1'), 3);
    store.writeDurableSync(reseedRef(2), proj('reseed-2'), 7);

    const fb = store.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF, // 부재
      genesisRef: GENESIS_CHANNEL_REF,
      reseedRefs: [reseedRef(1), reseedRef(2)],
      validateProjection: isChannelStateLike,
    });
    expect(fb!.source).toBe('reseed');
    expect(fb!.projection.channels[0].id).toBe('ch-reseed-2'); // 최신
    expect(fb!.snapshotLamport).toBe(7);
  });

  it('genesis마저 손상 → null(파국은 상위가 처리)', () => {
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

describe('durable 스냅샷 write/load', () => {
  it('writeDurableSync → load 왕복(snapshotLamport 보존)', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(CHANNEL_PROJECTION_REF, proj('x'), 42, isChannelStateLike);
    const env = store.load<ChannelState>(CHANNEL_PROJECTION_REF, isChannelStateLike);
    expect(env!.snapshotLamport).toBe(42);
    expect(env!.projection.channels[0].id).toBe('ch-x');
    expect(isSnapshotEnvelope(env)).toBe(true);
  });

  it('projection 검증 실패 스냅샷은 load에서 null(폴백 유도)', () => {
    const store = new SnapshotStore(dir);
    // 봉투는 유효하나 projection이 ChannelState-유사가 아님.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      store.snapshotPath(CHANNEL_PROJECTION_REF),
      JSON.stringify({ version: 1, snapshotLamport: 1, projection: { bogus: true } }),
    );
    expect(
      store.load(CHANNEL_PROJECTION_REF, isChannelStateLike),
    ).toBeNull();
  });

  it('saveDebounced → flushSync가 pending을 durable 동기 쓰기로 소진', () => {
    const store = new SnapshotStore(dir, { debounceMs: 1_000_000 });
    store.saveDebounced(CHANNEL_PROJECTION_REF, proj('deb'), 7);
    store.flushSync();
    const env = store.load<ChannelState>(CHANNEL_PROJECTION_REF, isChannelStateLike);
    expect(env!.snapshotLamport).toBe(7);
    expect(env!.projection.channels[0].id).toBe('ch-deb');
    store.dispose();
  });
});

// ── T-컴팩션 순서(§9 가드) ──────────────────────────────────────────────

describe('T-컴팩션 순서', () => {
  const G = 'genesis-channel.json';

  it('durable 미확정 → 절단 후보 0(§9 함정)', () => {
    const plan = SnapshotStore.planCompaction({
      segments: [{ num: 1, maxLamport: 5, empty: false }],
      protectedFloorLamport: 10,
      durableSnapshotConfirmed: false,
      activeSegment: 2,
      genesisRef: G,
      reseedRefs: [reseedRef(1)],
    });
    expect(plan.truncatableSegments).toEqual([]);
    // genesis·reseed는 항상 보호 목록에(절대 비절단, D14).
    expect(plan.protectedSnapshots).toEqual([G, reseedRef(1)]);
  });

  it('durable 확정 → snapshotLamport 미만 세그먼트 절단(감사용 최근 1개 보존)', () => {
    const plan = SnapshotStore.planCompaction({
      segments: [
        { num: 1, maxLamport: 5, empty: false }, // < 20 후보
        { num: 2, maxLamport: 15, empty: false }, // < 20 후보(최근 → 감사 보존)
        { num: 3, maxLamport: 25, empty: false }, // > 20 → 후보 아님
        { num: 4, maxLamport: 0, empty: true }, // 활성(빈)
      ],
      protectedFloorLamport: 20,
      durableSnapshotConfirmed: true,
      activeSegment: 4,
      genesisRef: G,
      reseedRefs: [],
    });
    // 후보 {1,2} 중 최고번호(2)는 감사 보존 → 절단 = [1].
    expect(plan.truncatableSegments).toEqual([1]);
    expect(plan.protectedSnapshots).toEqual([G]);
  });

  it('활성 세그먼트는 snapshotLamport 이하라도 절단 후보 아님', () => {
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

  it('후보 1개뿐 → 감사 보존으로 절단 0', () => {
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

  it('폴백 하한(패널 F): floor=min(primary,.bak)이면 (X,Y] 구간 세그먼트가 보호된다', () => {
    // primary snapshotLamport=9, .bak=5 → 호출자 계약대로 floor=min=5 전달.
    // manifest 최신(9) 기준이었다면 seg2(maxLamport 7)가 절단돼 .bak 폴백 시 (5,9] 유실.
    const plan = SnapshotStore.planCompaction({
      segments: [
        { num: 1, maxLamport: 3, empty: false }, // ≤5 후보
        { num: 2, maxLamport: 7, empty: false }, // >5 → 보호(X,Y] 구간)
        { num: 3, maxLamport: 0, empty: true },
      ],
      protectedFloorLamport: 5,
      durableSnapshotConfirmed: true,
      activeSegment: 3,
      genesisRef: G,
      reseedRefs: [],
    });
    // 후보 {1}뿐 → 감사 보존으로 절단 0. seg2는 floor 초과라 후보조차 아님.
    expect(plan.truncatableSegments).toEqual([]);
    // floor를 9(최신)로 잘못 주면 seg2가 후보에 들어가 seg1이 절단됨 — 대비 검증.
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

// ── 패널 E: flushSync vs in-flight async 쓰기(세대 가드) ─────────────────

describe('flushSync vs in-flight async 쓰기 (세대 가드)', () => {
  it('stale async rename이 flushSync 내용을 되덮으면 복원 — 최종 파일 = flushSync 내용', async () => {
    let release!: () => void;
    gate.block = new Promise<void>((r) => {
      release = r;
    });

    const store = new SnapshotStore(dir, { debounceMs: 1 });
    store.saveDebounced(CHANNEL_PROJECTION_REF, proj('stale'), 1);
    // debounce 발화 + async task가 atomicWriteJSON에 진입(게이트 블록)할 때까지 대기.
    for (let i = 0; i < 200 && !gate.entered; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(gate.entered).toBe(true);

    // in-flight 창에 신규 상태 staging → flushSync가 sync durable 기록 + 세대 전진.
    store.saveDebounced(CHANNEL_PROJECTION_REF, proj('fresh'), 2);
    store.flushSync();
    expect(gate.syncCalls.length).toBe(1); // flushSync의 fresh 쓰기

    // stale async 재개 → rename 착지(fresh를 되덮음) → 세대 가드가 fresh 복원(sync 2번째).
    release();
    gate.block = null;
    for (let i = 0; i < 200 && gate.syncCalls.length < 2; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(gate.syncCalls.length).toBeGreaterThanOrEqual(2); // 복원 쓰기 발생

    const env = store.load<ChannelState>(
      CHANNEL_PROJECTION_REF,
      isChannelStateLike,
    );
    expect(env!.snapshotLamport).toBe(2);
    expect(env!.projection.channels[0].id).toBe('ch-fresh');
    store.dispose();
  });
});

// ── 패널 G①: 불변 아티팩트는 read 경로도 이동 금지 ───────────────────────

describe('genesis·reseed 손상 시 격리 이동 금지 (§6.2)', () => {
  it('projection 검증 실패 genesis/reseed → 폴백은 진행하되 파일은 원위치 보존', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(GENESIS_CHANNEL_REF, proj('genesis'), 0);
    store.writeDurableSync(reseedRef(1), proj('reseed'), 5);
    // 유효 JSON이지만 projection이 무효 — validate 거부 경로(격리 이동 트리거 지점).
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
      activeRef: CHANNEL_PROJECTION_REF, // 부재
      genesisRef: GENESIS_CHANNEL_REF,
      reseedRefs: [reseedRef(1)],
      validateProjection: isChannelStateLike,
    });
    expect(fb).toBeNull(); // 전손 — 그러나 파일은 이동되지 않아야 한다.

    // 원위치 보존(격리 이동 없음) — §6.2 "어떤 경로도 수정·삭제 안 함".
    expect(fs.existsSync(store.snapshotPath(GENESIS_CHANNEL_REF))).toBe(true);
    expect(fs.existsSync(store.snapshotPath(reseedRef(1)))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'corrupted'))).toBe(false);
  });

  it('활성 projection 스냅샷은 기본 동작 유지(validate 거부 시 격리 이동)', () => {
    const store = new SnapshotStore(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      store.snapshotPath(CHANNEL_PROJECTION_REF),
      JSON.stringify({ version: 1, snapshotLamport: 1, projection: { bogus: true } }),
    );
    expect(store.load(CHANNEL_PROJECTION_REF, isChannelStateLike)).toBeNull();
    // 기존 T6 격리 관례 유지 — 활성 스냅샷(재작성 캐시)은 증거 보존을 위해 이동됨.
    expect(fs.existsSync(store.snapshotPath(CHANNEL_PROJECTION_REF))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(dir, 'corrupted'))).toBe(true);
  });
});
