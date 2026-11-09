/**
 * SnapshotStore — projection 스냅샷 저장/로드 + 폴백 체인 + 컴팩션 판정
 * (envelope-design §5·§9). PR2 범위: 순수 라이브러리. 서비스 배선은 PR3.
 *
 * 계약 요약(스펙 문면):
 *   - 스냅샷 쓰기는 전부 durable(§2.3 D13) — projection 스냅샷은 manifest.snapshotLamport가
 *     참조하고 §9 컴팩션이 "durable 확정 후에만 절단"하므로 fsync 없는 쓰기는 이중 소실을 낳는다.
 *   - genesis(immutable)·reseed(genesis급 immutable)·projection 스냅샷은 하나의 SnapshotEnvelope
 *     형식을 공유한다 — snapshotLamport 마커를 **파일 자체에** 실어야 폴백 체인이 .bak/reseed로
 *     내려갈 때 replay 하한을 정확히 안다(manifest.snapshotLamport는 최신 스냅샷 기준이라
 *     폴백된 구 스냅샷엔 부정확 → 데이터 유실). 그래서 각 스냅샷은 자족적이다.
 *   - 폴백 체인(§5): 최신 스냅샷 → .bak → reseed(최신순) → genesis. 손상 시 다음 단계로.
 *     ".bak" 단계는 atomicReadJSONSync의 primary→.bak 폴백이 담당한다.
 *   - 컴팩션 트리거는 **판정 함수만**(planCompaction) — 실행(절단)은 미래(PR3+). 가드:
 *     durable 스냅샷 확정 전 절단 금지, genesis·reseed는 절대 비절단(§9 함정, D14).
 */

import path from 'node:path';
import {
  atomicWriteJSON,
  atomicWriteJSONSync,
  atomicReadJSONSync,
} from '../util/atomicWrite';
import { AsyncQueue } from '../util/AsyncQueue';

/**
 * 스냅샷 파일 1개의 봉투(§5). projection(도메인 상태)과 snapshotLamport 마커를 함께 실어
 * 폴백 체인이 파일만으로 자족적이게 한다.
 *
 * additive-only: 필드 추가만, 기존 필드 제거·개명 금지(디스크 영속 계약).
 */
export interface SnapshotEnvelope<T> {
  version: number;
  /** 이 스냅샷에 반영된 최대 lamport. 부트 replay는 `lamport > snapshotLamport`만 적용(§5). */
  snapshotLamport: number;
  /** 도메인 projection(ChannelState 등). 로그 계층은 미해석. */
  projection: T;
}

export const SNAPSHOT_ENVELOPE_VERSION = 1;

/** `events/snapshot/` 서브디렉토리 이름(§2.1). */
export const SNAPSHOT_DIRNAME = 'snapshot';

/** genesis 채널 스냅샷 참조명(§2.1, D14 immutable). */
export const GENESIS_CHANNEL_REF = 'genesis-channel.json';
/** 활성 채널 projection 스냅샷 참조명(§2.1·§5). */
export const CHANNEL_PROJECTION_REF = 'channel.json';
/** 활성 A2A projection 스냅샷 참조명(§2.1·§5). */
export const A2A_PROJECTION_REF = 'a2a.json';

/** reseed 스냅샷 참조명 빌더(§6.4c, genesis급 immutable). */
export function reseedRef(n: number): string {
  return `reseed-${n}.json`;
}

/** SnapshotEnvelope 구조 가드(projection 내용은 별도 validator가 검사). */
export function isSnapshotEnvelope(v: unknown): v is SnapshotEnvelope<unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['version'] === 'number' &&
    typeof o['snapshotLamport'] === 'number' &&
    'projection' in o
  );
}

/** 폴백 체인 로드 결과. source가 어느 단계에서 왔는지 알려 감사·테스트에 쓴다. */
export interface FallbackLoad<T> {
  projection: T;
  snapshotLamport: number;
  source: 'snapshot' | 'reseed' | 'genesis';
  ref: string;
}

/** planCompaction 입력의 세그먼트 메타. */
export interface SegmentMeta {
  num: number;
  /** 세그먼트 내 최대 lamport. 빈 세그먼트는 0. */
  maxLamport: number;
  empty: boolean;
}

/** planCompaction 판정 결과(실행 없음 — 절단 대상 목록 + 보호 스냅샷 목록). */
export interface CompactionPlan {
  /** 안전하게 절단(삭제)할 수 있는 세그먼트 번호. durable 미확정이면 항상 빈 배열. */
  truncatableSegments: number[];
  /** 절대 절단 금지 스냅샷(§9 D14) — genesis + 전 reseed. 계약을 명시적·검증가능하게. */
  protectedSnapshots: string[];
  /** 판정 근거(감사·테스트용). */
  reason: string;
}

const DEFAULT_DEBOUNCE_MS = 30_000;

interface DebounceSlot<T> {
  timer: NodeJS.Timeout | null;
  pending: SnapshotEnvelope<T> | null;
  /**
   * 세대 가드(패널 E): sync 쓰기(writeDurableSync·flushSync)마다 단조 증가. in-flight
   * async 쓰기는 시작 세대를 캡처하고, 완료 시 세대가 전진했으면(= 자기 rename이 더
   * 신선한 sync 내용을 되덮은 것) lastSync를 복원한다 — ChannelStateWriter의
   * immediateEpoch race recovery(:142-160)와 동형 패턴.
   */
  epoch: number;
  /** 마지막 sync 쓰기 내용(세대 가드 복원 원본). */
  lastSync: SnapshotEnvelope<T> | null;
}

/**
 * projection 스냅샷 저장소. `snapshotDir`(= `events/snapshot`) 아래 파일을 durable로 쓴다.
 * debounced 경로는 부트 가속용 활성 projection 스냅샷(channel.json 등)에, writeDurableSync는
 * 마이그레이션의 순서 있는 시퀀스(genesis·reseed)에 쓴다.
 */
export class SnapshotStore {
  private readonly dir: string;
  private readonly debounceMs: number;
  private readonly queue = new AsyncQueue();
  // ref별 독립 debounce(channel.json·a2a.json이 서로를 지연시키지 않게).
  private readonly slots = new Map<string, DebounceSlot<unknown>>();

  constructor(
    snapshotDir: string,
    opts: { debounceMs?: number } = {},
  ) {
    this.dir = snapshotDir;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** 스냅샷 파일 절대 경로. */
  snapshotPath(ref: string): string {
    return path.join(this.dir, ref);
  }

  /** ref별 debounce 슬롯 확보. */
  private getSlot(ref: string): DebounceSlot<unknown> {
    let slot = this.slots.get(ref);
    if (!slot) {
      slot = { timer: null, pending: null, epoch: 0, lastSync: null };
      this.slots.set(ref, slot);
    }
    return slot;
  }

  /**
   * durable 동기 쓰기(§2.3). 마이그레이션 시퀀스(genesis)·reseed처럼 순서가 중요한 지점에서
   * 사용. validateProjection이 있으면 projection 내용까지 검증(genesis 무결 보장).
   * 세대 가드(패널 E): sync 쓰기이므로 세대를 올려, 같은 ref의 in-flight async 쓰기가
   * 이 내용을 되덮으면 복원되게 한다.
   */
  writeDurableSync<T>(
    ref: string,
    projection: T,
    snapshotLamport: number,
    validateProjection?: (data: unknown) => boolean,
  ): void {
    const envelope: SnapshotEnvelope<T> = {
      version: SNAPSHOT_ENVELOPE_VERSION,
      snapshotLamport,
      projection,
    };
    atomicWriteJSONSync(this.snapshotPath(ref), envelope, {
      durable: true,
      validate: validateProjection
        ? (d) => isSnapshotEnvelope(d) && validateProjection(d.projection)
        : isSnapshotEnvelope,
    });
    // 쓰기 성공 후에만 세대 전진(실패한 sync를 복원 원본으로 삼지 않는다).
    const slot = this.getSlot(ref);
    slot.epoch++;
    slot.lastSync = envelope;
  }

  /**
   * debounced durable 쓰기(§5). 잦은 갱신을 debounceMs 창으로 코얼레싱한다.
   * 커밋 경로가 아니다(정본은 로그) — 부트 가속용 캐시일 뿐이라 손실돼도 replay로 복구된다.
   */
  saveDebounced<T>(
    ref: string,
    projection: T,
    snapshotLamport: number,
  ): void {
    const envelope: SnapshotEnvelope<T> = {
      version: SNAPSHOT_ENVELOPE_VERSION,
      snapshotLamport,
      projection,
    };
    const slot = this.getSlot(ref);
    slot.pending = envelope;
    if (slot.timer !== null) return;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      const snap = slot.pending;
      if (snap === null) return;
      void this.queue.enqueue(ref, async () => {
        const payload = slot.pending;
        if (payload === null) return;
        // 세대 가드(패널 E): await 창에 sync 쓰기(flushSync·writeDurableSync)가 끼면
        // 이 async rename이 더 신선한 내용을 stale로 되덮는다 → 완료 후 세대 비교로 복원.
        const epochAtStart = slot.epoch;
        try {
          await atomicWriteJSON(this.snapshotPath(ref), payload, {
            durable: true,
            validate: isSnapshotEnvelope,
          });
          if (slot.epoch !== epochAtStart && slot.lastSync !== null) {
            // stale rename이 최신 sync 내용을 덮었다 — 복원(durable 동기).
            try {
              atomicWriteJSONSync(this.snapshotPath(ref), slot.lastSync, {
                durable: true,
                validate: isSnapshotEnvelope,
              });
            } catch (err) {
              console.error(
                '[SnapshotStore] 세대 가드 복원 쓰기 실패:',
                err,
              );
            }
          }
          if (slot.pending === payload) slot.pending = null;
        } catch (err) {
          // 스냅샷은 캐시 — 실패해도 정본(로그) 무영향. 로그만 남기고 계속.
          console.error('[SnapshotStore] debounced 스냅샷 쓰기 실패:', err);
        }
      });
    }, this.debounceMs);
  }

  /** debounce 타이머를 즉시 소진(durable 동기 쓰기로). 프로세스 종료 경로용(§6.4b PR3). */
  flushSync(): void {
    for (const [ref, slot] of this.slots) {
      if (slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      if (slot.pending !== null) {
        const snap = slot.pending;
        slot.pending = null;
        try {
          atomicWriteJSONSync(this.snapshotPath(ref), snap, {
            durable: true,
            validate: isSnapshotEnvelope,
          });
          // 세대 전진(패널 E): in-flight async 쓰기가 이 내용을 되덮으면 복원되도록.
          slot.epoch++;
          slot.lastSync = snap;
        } catch (err) {
          console.error('[SnapshotStore] flushSync 스냅샷 쓰기 실패:', err);
        }
      }
    }
    this.queue.flushSync();
  }

  /** 타이머 정리(데몬 종료). 남은 pending은 flushSync로 소진. */
  dispose(): void {
    this.flushSync();
  }

  /**
   * 스냅샷 1개 로드(primary→.bak 폴백은 atomicReadJSONSync가 내장). envelope 구조 +
   * projection 내용을 함께 검증해 손상 스냅샷은 null을 반환(폴백 체인이 다음 단계로).
   *
   * preserveOnCorruption(패널 G①): true면 validate 거부 시에도 파일을 격리 **이동하지
   * 않는다** — genesis·reseed는 §6.2 불변 계약("어떤 경로도 수정·삭제 안 함") 대상이라
   * read 경로조차 파일을 옮겨선 안 된다. 활성 projection 스냅샷(재작성 캐시)은 기본
   * false(기존 격리 증거 보존 동작 유지).
   */
  load<T>(
    ref: string,
    validateProjection: (data: unknown) => boolean,
    opts: { preserveOnCorruption?: boolean } = {},
  ): SnapshotEnvelope<T> | null {
    return atomicReadJSONSync<SnapshotEnvelope<T>>(this.snapshotPath(ref), {
      validate: (d): d is SnapshotEnvelope<T> =>
        isSnapshotEnvelope(d) && validateProjection(d.projection),
      quarantineOnCorruption: opts.preserveOnCorruption ? false : undefined,
    });
  }

  /**
   * 폴백 체인 로드(§5): 최신 스냅샷 → .bak → reseed(최신순) → genesis.
   * 각 단계는 자족적 snapshotLamport를 실어 반환하므로, 호출자는 그 값 초과 로그만 replay하면 된다.
   * 전 단계가 손상이면 null(genesis마저 손상된 파국 — 상위가 처리).
   */
  loadWithFallback<T>(opts: {
    activeRef: string;
    genesisRef: string;
    reseedRefs: string[];
    validateProjection: (data: unknown) => boolean;
  }): FallbackLoad<T> | null {
    const { activeRef, genesisRef, reseedRefs, validateProjection } = opts;

    const active = this.load<T>(activeRef, validateProjection);
    if (active) {
      return {
        projection: active.projection,
        snapshotLamport: active.snapshotLamport,
        source: 'snapshot',
        ref: activeRef,
      };
    }

    // reseed는 최신(높은 번호)부터 — 가장 최근 구-데몬 구간을 우선 복구.
    // preserveOnCorruption: reseed·genesis는 §6.2 불변 아티팩트 — 손상돼도 이동 금지(G①).
    for (const ref of [...reseedRefs].reverse()) {
      const rs = this.load<T>(ref, validateProjection, {
        preserveOnCorruption: true,
      });
      if (rs) {
        return {
          projection: rs.projection,
          snapshotLamport: rs.snapshotLamport,
          source: 'reseed',
          ref,
        };
      }
    }

    const genesis = this.load<T>(genesisRef, validateProjection, {
      preserveOnCorruption: true,
    });
    if (genesis) {
      return {
        projection: genesis.projection,
        snapshotLamport: genesis.snapshotLamport,
        source: 'genesis',
        ref: genesisRef,
      };
    }

    return null;
  }

  /**
   * 컴팩션 트리거 판정(§9) — **판정만, 절단 실행 없음**(PR2 범위). 가드:
   *   - durable 스냅샷 미확정(durableSnapshotConfirmed=false)이면 절단 후보 0 —
   *     fsync 없는 스냅샷을 전제로 절단하면 전원손실 시 이중 소실(§9 함정, D13이 닫음).
   *   - protectedFloorLamport 이하의 비어있지-않은 세그먼트만 후보이되, **가장 최근 후보
   *     1개는 감사용으로 보존**(§9 "감사용 1버전 보존").
   *   - 활성 세그먼트는 절대 후보 아님.
   *   - genesis·reseed는 세그먼트가 아니라 스냅샷이라 세그먼트 후보 집합에 구조적으로 없다 —
   *     그 계약을 protectedSnapshots로 명시(D14, 검증가능).
   */
  static planCompaction(input: {
    segments: SegmentMeta[];
    /**
     * 절단 보호 하한(패널 F). **호출자 계약: 폴백 체인에 참여하는 생존 스냅샷들
     * (primary·`.bak` 등)의 snapshotLamport 중 최솟값(min)을 전달하라** — manifest의
     * 최신 lamport(Y)만으로 절단하면, primary 손상 시 .bak(더 오래된 X)로 폴백했을 때
     * (X, Y] 구간 이벤트가 절단돼 복구 불가가 된다. min이 그 창을 닫는다.
     */
    protectedFloorLamport: number;
    durableSnapshotConfirmed: boolean;
    activeSegment: number;
    genesisRef: string;
    reseedRefs: string[];
  }): CompactionPlan {
    const protectedSnapshots = [input.genesisRef, ...input.reseedRefs];

    if (!input.durableSnapshotConfirmed) {
      return {
        truncatableSegments: [],
        protectedSnapshots,
        reason: 'durable 스냅샷 미확정 — 절단 금지(§9 함정)',
      };
    }

    // 후보 = 비어있지-않고, 전부 보호 하한 이하이며, 활성이 아닌 세그먼트.
    const candidates = input.segments
      .filter(
        (s) =>
          !s.empty &&
          s.maxLamport <= input.protectedFloorLamport &&
          s.num !== input.activeSegment,
      )
      .map((s) => s.num)
      .sort((a, b) => a - b);

    if (candidates.length === 0) {
      return {
        truncatableSegments: [],
        protectedSnapshots,
        reason: 'protectedFloorLamport 이하 세그먼트 없음',
      };
    }

    // 가장 최근 후보 1개(최고 번호)는 감사용 보존 → 그 앞의 것만 절단 가능.
    const truncatableSegments = candidates.slice(0, candidates.length - 1);
    return {
      truncatableSegments,
      protectedSnapshots,
      reason:
        truncatableSegments.length > 0
          ? `durable 확정 — protectedFloorLamport ${input.protectedFloorLamport} 이하 세그먼트 절단(감사용 1개 보존)`
          : '후보 1개뿐 — 감사용 보존으로 절단 0',
    };
  }
}
