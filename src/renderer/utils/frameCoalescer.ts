/**
 * frameCoalescer — per-key 프레임 코얼레싱 게이트 (자립 유틸, 의존성 0).
 *
 * 표준 프레임 배칭 패턴의 자체 구현: 같은 key로 도착하는
 * 연속 갱신을 "프레임당 1회"로 병합해 렌더러 스토어 쓰기 팬아웃을 줄인다.
 * 마지막 값 승리(last-write-wins) — 프레임 사이에 N번 갱신돼도 flush 시점의
 * 최신 값만 커밋된다.
 *
 * 동작 불변 관점(NB2 파동 0 A3):
 *   - 이 게이트는 렌더러 스토어 반영을 최대 한 프레임(~16ms) 늦출 뿐이다.
 *   - 데몬 정본·session.json 영속에는 무영향 — 메타/타이틀/cwd는 이미 main이
 *     소유하며, 여기서 미루는 것은 "렌더러 스토어에 값을 반영하는 시점"뿐이다.
 *   - 시각/기능/저장 시맨틱은 동일. 리렌더 횟수만 감소한다.
 *
 * in-flight/pending 게이트: flush 콜백(스토어 set) 실행 중에 새 값이 들어오면
 * 즉시 재-flush하지 않고 pending에만 적재한다. flush 종료 후, pending이 남아
 * 있으면 다음 프레임에 한 번 더 스케줄한다. 이렇게 하면 flush 도중 발생한
 * 갱신이 유실되지도, 재귀적으로 폭주하지도 않는다.
 */

/** 프레임 예산(ms). RAF가 없는 환경(node 테스트)의 setTimeout 폴백에 쓰인다. */
const FRAME_MS = 16;

/** RAF 우선, 없으면 16ms setTimeout. 스케줄러는 취소 핸들과 함께 반환한다. */
type CancelHandle = () => void;
function scheduleFrame(cb: () => void): CancelHandle {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => cb());
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, FRAME_MS);
  return () => clearTimeout(id);
}

/**
 * key별로 값을 프레임 단위로 병합해 `commit`으로 흘려보내는 코얼레서.
 *
 * @param commit key의 최신 값을 실제로 반영하는 콜백(스토어 set 등). 프레임당
 *               key마다 최대 1회 호출된다.
 */
export class FrameCoalescer<K, V> {
  private readonly commit: (key: K, value: V) => void;
  /** flush를 기다리는 최신 값(key → value). 마지막 값 승리. */
  private readonly pending = new Map<K, V>();
  /** 프레임이 이미 예약돼 있는지 — 중복 스케줄 방지. */
  private cancelFrame: CancelHandle | null = null;
  /** commit 실행 중 플래그(in-flight). 이때 들어온 값은 pending에만 남는다. */
  private flushing = false;

  constructor(commit: (key: K, value: V) => void) {
    this.commit = commit;
  }

  /**
   * key의 값을 갱신 예약한다. 같은 key로 여러 번 불러도 프레임당 commit은 1회,
   * 마지막 값만 반영된다.
   */
  push(key: K, value: V): void {
    this.pending.set(key, value);
    this.ensureScheduled();
  }

  private ensureScheduled(): void {
    // 이미 프레임이 예약됐거나 flush 진행 중이면 새로 잡지 않는다. flush 진행
    // 중 들어온 값은 flush 끝에서 pending 잔량을 보고 재스케줄한다.
    if (this.cancelFrame !== null || this.flushing) return;
    this.cancelFrame = scheduleFrame(() => this.flush());
  }

  private flush(): void {
    this.cancelFrame = null;
    // 이번 프레임에 반영할 스냅샷을 확정하고 pending은 비운다. commit 도중
    // push된 값은 새 pending 항목으로 쌓이므로 이 배치에 섞이지 않는다.
    const batch = Array.from(this.pending.entries());
    this.pending.clear();
    this.flushing = true;
    try {
      for (const [key, value] of batch) {
        this.commit(key, value);
      }
    } finally {
      this.flushing = false;
    }
    // flush 도중 새 값이 들어왔으면(pending 비어있지 않음) 다음 프레임에 한 번
    // 더 흘려보낸다 — 유실 없이, 재귀 폭주 없이.
    if (this.pending.size > 0) {
      this.ensureScheduled();
    }
  }

  /**
   * 예약된 프레임을 취소하고 남은 pending 값을 즉시 동기 반영한다. 언마운트
   * 시점에서 "마지막 값이 스토어에 안 들어간 채 사라지는" 것을 막는다.
   */
  flushNow(): void {
    if (this.cancelFrame !== null) {
      this.cancelFrame();
      this.cancelFrame = null;
    }
    if (this.pending.size === 0) return;
    this.flush();
  }

  /** 예약 프레임 취소 + pending 폐기(반영하지 않음). 하드 teardown용. */
  dispose(): void {
    if (this.cancelFrame !== null) {
      this.cancelFrame();
      this.cancelFrame = null;
    }
    this.pending.clear();
  }

  /** 테스트/디버그용: 아직 flush되지 않은 key 수. */
  get pendingSize(): number {
    return this.pending.size;
  }
}
