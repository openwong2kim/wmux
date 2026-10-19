import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../AppendOnlyLog';
import { makeEnvelope } from '../../../shared/eventlog';
import type {
  EventEnvelope,
  EventEnvelopeDraft,
} from '../../../shared/eventlog';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-eventlog-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 헬퍼 ──────────────────────────────────────────────────────────────

/** append 입력 초안(순서 필드는 append가 발급). */
function draft(payload: unknown = {}): EventEnvelopeDraft {
  return makeEnvelope({
    domain: 'channel',
    payload,
    origin: { machineId: 'm1', daemonEpoch: 1 },
    authContext: {
      principalId: 'p',
      verifiedWorkspaceId: 'ws',
      trustTier: 'trusted',
    },
  });
}

/** 완결 레코드 1줄(raw 세그먼트 주입용 — 크래시 상태 구성). */
function envLine(lamport: number, seq: number, payload: unknown = {}): string {
  const env: EventEnvelope = {
    eventId: `evt-${lamport}`,
    origin: { machineId: 'm1', daemonEpoch: 1, seq },
    lamport,
    wallClock: 1000 + lamport,
    authContext: {
      principalId: 'p',
      verifiedWorkspaceId: 'ws',
      trustTier: 'trusted',
    },
    domain: 'channel',
    payload,
  };
  return `${JSON.stringify(env)}\n`;
}

function seg(n: number): string {
  return path.join(dir, `${String(n).padStart(8, '0')}.ndjson`);
}

const syncOk = (): void => {};

// ── T-크래시: 전방 스캔·최초 불량 절단·at-least-once 승격 ─────────────────

describe('T-크래시 복구', () => {
  it('커밋 프리픽스 무손실 + valid unsynced tail 승격 + torn 말미 절단', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk });
    log.open();
    await log.append(draft({ n: 1 }));
    await log.append(draft({ n: 2 }));
    log.close();

    // 크래시 모사: 커밋 2건 뒤 (a) valid 줄 1건(승격 후보) + (b) torn 미완결 줄 주입.
    fs.appendFileSync(seg(1), envLine(3, 3, { n: 3 }));
    fs.appendFileSync(seg(1), '{"lamport":4,"origin":{"seq":4'); // 비-\n-종단

    const log2 = new AppendOnlyLog({ dir });
    log2.open();
    // 1,2 커밋 + 3 승격 → 무손실. torn 4 → 폐기.
    expect(log2.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3]);
    // 승격 레코드가 hwm 스캔에 반영(재사용 불가).
    expect(log2.lamportHwm).toBe(3);
    log2.close();
  });

  it('코얼레싱 배치 중간 torn(비순서 writeback) → 불량 이후 valid 줄도 폐기(부분 승격 금지)', () => {
    fs.writeFileSync(
      seg(1),
      envLine(1, 1, { n: 1 }) + 'GARBAGE-not-json\n' + envLine(3, 3, { n: 3 }),
    );
    const log = new AppendOnlyLog({ dir });
    log.open();
    // 최초 불량(중간 garbage)에서 절단 → 그 뒤 valid(lamport 3)도 폐기.
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1]);
    expect(log.lamportHwm).toBe(1);
    // 활성 세그먼트가 물리적으로 절단(불량 이후 바이트 제거).
    expect(fs.readFileSync(seg(1), 'utf8')).toBe(envLine(1, 1, { n: 1 }));
    log.close();
  });

  it('fsync 직전 kill(전량 valid unsynced tail) → 전량 승격(절단 아님), 부분 승격 없음', () => {
    fs.writeFileSync(
      seg(1),
      envLine(1, 1) + envLine(2, 2) + envLine(3, 3),
    );
    const log = new AppendOnlyLog({ dir });
    log.open();
    // 절단 or 승격 둘 중 하나 — 전량 valid이므로 승격.
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3]);
    expect(log.lamportHwm).toBe(3);
    log.close();
  });
});

// ── T-fsync실패: 배치 단일 롤백 ─────────────────────────────────────────

describe('T-fsync실패 주입', () => {
  it('배치 전체 ftruncate(batchStartOffset) 1회 + 전원 false + replay 미출현', async () => {
    let failSync = true;
    const log = new AppendOnlyLog({
      dir,
      fsync: () => {
        if (failSync) throw new Error('inject fsync failure');
      },
    });
    log.open();

    // 절단은 경로 기반(close→truncate→reopen — win32 'a' fd ftruncate EPERM 회피).
    const truncSpy = vi.spyOn(fs, 'truncateSync');
    const results = await Promise.all([
      log.append(draft({ n: 1 })),
      log.append(draft({ n: 2 })),
      log.append(draft({ n: 3 })),
    ]);

    // 배치 Promise 전원 false.
    expect(results).toEqual([false, false, false]);
    // 단일 truncate로 배치 전체 물리 제거(순서의존 null 매장 없음).
    expect(truncSpy).toHaveBeenCalledTimes(1);
    expect(truncSpy).toHaveBeenCalledWith(expect.any(String), 0);
    // 디스크에 롤백 이벤트 없음.
    expect(log.readAllRecords()).toEqual([]);

    // 롤백 후 정상 append는 소비된 hwm 뒤(gap)에서 재개, 재사용 없음.
    failSync = false;
    const ok = await log.append(draft({ n: 4 }));
    expect(ok).toBe(true);
    const recs = log.readAllRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].lamport).toBe(4);
    log.close();
    truncSpy.mockRestore();

    // 재부트 replay에 롤백 이벤트 미출현.
    const log2 = new AppendOnlyLog({ dir });
    log2.open();
    expect(log2.readAllRecords().map((r) => r.lamport)).toEqual([4]);
    log2.close();
  });
});

// ── T-롤크래시: 빈 신규 세그먼트를 first-boot로 오인 금지 ──────────────────

describe('T-롤 직후 크래시', () => {
  it('빈 신규 세그먼트 → 직전 세그먼트에서 hwm 복원(리셋·재사용 없음)', async () => {
    fs.writeFileSync(seg(1), envLine(1, 1) + envLine(2, 2) + envLine(3, 3));
    fs.writeFileSync(seg(2), ''); // 롤이 만든 빈 신규 세그먼트, 쓰기 전 크래시

    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.lamportHwm).toBe(3); // first-boot 오인 시 0이 됐을 값
    expect(log.seqHwm).toBe(3);

    const ok = await log.append(draft({ n: 4 }));
    expect(ok).toBe(true);
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3, 4]);
    // 신규 레코드는 활성(최고번호=2) 세그먼트에 기록.
    expect(fs.readFileSync(seg(2), 'utf8')).toContain('"lamport":4');
    log.close();
  });

  it('torn 부분쓰기 신규 세그먼트 → 절단 후 빔 → 직전 세그먼트 복원', async () => {
    fs.writeFileSync(seg(1), envLine(1, 1) + envLine(2, 2) + envLine(3, 3));
    fs.writeFileSync(seg(2), '{"lamport":4,"orig'); // torn 부분쓰기

    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.lamportHwm).toBe(3);
    expect(fs.readFileSync(seg(2), 'utf8')).toBe(''); // torn 절단됨

    const ok = await log.append(draft({ n: 4 }));
    expect(ok).toBe(true);
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3, 4]);
    log.close();
  });

  it('세그먼트 롤: 임계 초과 시 신규 세그먼트, 경계 넘어 순서·연속 보존', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk, maxSegmentBytes: 300 });
    log.open();
    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await log.append(draft({ i }));
    }
    const segs = fs
      .readdirSync(dir)
      .filter((f) => /^\d{8}\.ndjson$/.test(f));
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    log.close();
  });
});

// ── T-lamport: 재개·gap·승격 반영 ──────────────────────────────────────

describe('T-lamport 재개', () => {
  it('재시작 후 첫 신규 = 직전 max+1 (오프바이원 없음)', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk });
    log.open();
    await log.append(draft({ n: 1 }));
    await log.append(draft({ n: 2 }));
    await log.append(draft({ n: 3 }));
    expect(log.lamportHwm).toBe(3);
    expect(log.seqHwm).toBe(3);
    log.close();

    const log2 = new AppendOnlyLog({ dir, fsync: syncOk });
    log2.open();
    expect(log2.lamportHwm).toBe(3); // 디스크 라운드트립 복원
    expect(log2.seqHwm).toBe(3);
    await log2.append(draft({ n: 4 }));
    const recs = log2.readAllRecords();
    expect(recs.map((r) => r.lamport)).toEqual([1, 2, 3, 4]); // 첫 신규 = max+1
    expect(recs[recs.length - 1].origin.seq).toBe(4);
    log2.close();
  });

  it('배치 실패 후 hwm gap 허용·재사용 금지', async () => {
    let failSync = false;
    const log = new AppendOnlyLog({
      dir,
      fsync: () => {
        if (failSync) throw new Error('inject');
      },
    });
    log.open();
    await log.append(draft({ n: 1 }));
    await log.append(draft({ n: 2 }));
    await log.append(draft({ n: 3 })); // 1,2,3 커밋

    failSync = true;
    const failed = await Promise.all([
      log.append(draft({ n: 'a' })),
      log.append(draft({ n: 'b' })),
    ]);
    expect(failed).toEqual([false, false]); // 4,5 소비되나 미커밋(롤백)

    failSync = false;
    await log.append(draft({ n: 6 }));
    // gap(4,5)은 허용하되 재사용 금지 → 다음 성공값은 6.
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3, 6]);
    expect(log.lamportHwm).toBe(6);
    log.close();
  });

  it('승격 레코드의 lamport가 hwm 스캔에 반영', () => {
    // 커밋 1,2 + 승격(unsynced valid) 5 → hwm 스캔은 max=5.
    fs.writeFileSync(seg(1), envLine(1, 1) + envLine(2, 2) + envLine(5, 5));
    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.lamportHwm).toBe(5);
    expect(log.seqHwm).toBe(5);
    log.close();
  });
});

// ── 패널 반영: 발급 필드·fail-stop·비동기 배리어·롤·close 계약 ─────────────

/** 수동 게이트 async fsync — await 창의 late-arrival 인터리빙을 결정적으로 재현. */
function gatedFsync(): {
  fsync: () => Promise<void>;
  gates: Array<{ resolve: () => void; reject: (e: Error) => void }>;
} {
  const gates: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  return {
    gates,
    fsync: () =>
      new Promise<void>((resolve, reject) => {
        gates.push({ resolve, reject });
      }),
  };
}

/** 마이크로태스크를 펌핑해 배리어 시작(gates 채워짐)을 기다린다. */
async function untilGates(gates: unknown[], n: number): Promise<void> {
  for (let i = 0; i < 50 && gates.length < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  expect(gates.length).toBeGreaterThanOrEqual(n);
}

describe('발급 필드 @ append (eventId 유일성)', () => {
  it('같은 draft를 재사용(재시도 모사)해도 커밋 레코드마다 eventId 신규 발급', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk });
    log.open();
    const d = draft({ n: 1 });
    expect('eventId' in d).toBe(false); // draft엔 발급 필드 없음
    await log.append(d);
    await log.append(d);
    const recs = log.readAllRecords();
    expect(recs).toHaveLength(2);
    expect(typeof recs[0].eventId).toBe('string');
    expect(typeof recs[0].wallClock).toBe('number');
    expect(recs[0].eventId).not.toBe(recs[1].eventId); // 전역 유일성 유지
    log.close();
  });
});

describe('fail-stop: 롤백 ftruncate 실패 (3모델 합의)', () => {
  it('절단 실패 → broken: 배치 false + 이후 append 즉시 false·무기록, reopen으로 재개', async () => {
    let failSync = false;
    const log = new AppendOnlyLog({
      dir,
      fsync: () => {
        if (failSync) throw new Error('inject fsync');
      },
    });
    log.open();
    await log.append(draft({ n: 1 })); // 커밋

    failSync = true;
    const truncSpy = vi
      .spyOn(fs, 'truncateSync')
      .mockImplementationOnce(() => {
        throw new Error('inject truncate failure');
      });
    const r2 = await log.append(draft({ n: 2 }));
    expect(r2).toBe(false);

    // broken — 좌표 불변식 붕괴 상태로는 어떤 write도 하지 않는다.
    failSync = false;
    const sizeBefore = fs.statSync(seg(1)).size;
    const r3 = await log.append(draft({ n: 3 }));
    expect(r3).toBe(false);
    expect(fs.statSync(seg(1)).size).toBe(sizeBefore); // 추가 바이트 0
    log.close();
    truncSpy.mockRestore();

    // 재개는 reopen — 절단 못 한 tail(n:2)은 valid 줄이라 at-least-once 승격(§2.6 계약).
    const log2 = new AppendOnlyLog({ dir, fsync: syncOk });
    log2.open();
    expect(log2.readAllRecords().map((r) => r.lamport)).toEqual([1, 2]);
    expect(log2.lamportHwm).toBe(2);
    log2.close();
  });
});

describe('fail-closed: 부트 복구 절단 실패 (3모델 합의)', () => {
  it('절단 불가면 open()이 throw — 불량 tail 위에 열지 않는다', () => {
    fs.writeFileSync(seg(1), envLine(1, 1) + 'GARBAGE-tail\n');
    const truncSpy = vi.spyOn(fs, 'truncateSync').mockImplementation(() => {
      /* 절단이 조용히 무효인 최악 케이스 모사 */
    });
    const log = new AppendOnlyLog({ dir });
    expect(() => log.open()).toThrow(/복구 절단 실패/);
    truncSpy.mockRestore();
  });
});

describe('비동기 배리어 인터리빙 (코얼레싱 계약)', () => {
  it('배리어 성공 경계에서 롤 — 지속 부하에서도 세그먼트가 임계에서 롤된다', async () => {
    const { fsync, gates } = gatedFsync();
    const log = new AppendOnlyLog({ dir, fsync, maxSegmentBytes: 1 });
    log.open();

    const p1 = log.append(draft({ n: 1 }));
    await untilGates(gates, 1); // 배리어1 in-flight
    const p2 = log.append(draft({ n: 2 })); // await 창 도착 → 다음 배리어로

    gates[0].resolve();
    await expect(p1).resolves.toBe(true);
    // 배리어1 성공 시점엔 unsynced(p2) 비어있지 않아 롤 없음 → 배리어2로.
    await untilGates(gates, 2);
    gates[1].resolve();
    await expect(p2).resolves.toBe(true);

    // 배리어2 성공 경계(unsynced 빔)에서 롤 성사 — 기아 없음.
    expect(log.activeSegment).toContain('00000002');
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2]);
    log.close();
  });

  it('배리어 실패는 await 창 도착분까지 전원 false + 단일 ftruncate, 이후 정상 재개', async () => {
    const { fsync, gates } = gatedFsync();
    const log = new AppendOnlyLog({ dir, fsync });
    log.open();

    const p1 = log.append(draft({ n: 1 }));
    await untilGates(gates, 1);
    const p2 = log.append(draft({ n: 2 })); // late-arrival — 배리어1 밖

    const truncSpy = vi.spyOn(fs, 'truncateSync');
    gates[0].reject(new Error('inject barrier failure'));
    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBe(false); // 후속 대기분 포함 전원 false(§2.4-4)
    expect(truncSpy).toHaveBeenCalledTimes(1); // 단일 truncate(경로 기반)
    truncSpy.mockRestore();

    const p3 = log.append(draft({ n: 3 }));
    await untilGates(gates, 2);
    gates[1].resolve();
    await expect(p3).resolves.toBe(true);
    expect(log.readAllRecords().map((r) => r.payload)).toEqual([{ n: 3 }]);
    log.close();
  });

  it('close()는 미확정 append를 false로 확정한다(영구 pending 없음)', async () => {
    const log = new AppendOnlyLog({
      dir,
      fsync: () => new Promise<void>(() => {}), // 영구 대기 배리어
    });
    log.open();
    const p = log.append(draft({ n: 1 }));
    await Promise.resolve(); // 배리어 시작
    log.close();
    await expect(p).resolves.toBe(false);
  });
});

describe('스캔 스키마 가드', () => {
  it('발급 필드 없는 JSON 줄({})은 최초 불량 — 이후 절단, hwm 미오염', () => {
    fs.writeFileSync(seg(1), envLine(1, 1) + '{}\n' + envLine(3, 3));
    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1]);
    expect(log.lamportHwm).toBe(1);
    log.close();
  });
});

describe('롤 open-then-swap', () => {
  it('신규 세그먼트 개방 실패 시 현 세그먼트 유지(append 계속 성공), 다음 경계에서 롤', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk, maxSegmentBytes: 1 });
    log.open();
    const openSpy = vi.spyOn(fs, 'openSync');
    openSpy.mockImplementationOnce(() => {
      throw new Error('inject roll open failure');
    });

    const r1 = await log.append(draft({ n: 1 })); // 배리어 성공 경계의 롤 시도가 실패
    expect(r1).toBe(true);
    expect(log.activeSegment).toContain('00000001'); // 상태 불변 — 현 세그먼트 유지

    const r2 = await log.append(draft({ n: 2 })); // 다음 경계(append 시점)에서 롤 성사
    expect(r2).toBe(true);
    // r1은 seg1에 남고(스왑 실패 시 상태 불변), r2는 롤 성사 후 seg2에 기록.
    expect(fs.readFileSync(seg(1), 'utf8')).toContain('"lamport":1');
    expect(fs.readFileSync(seg(1), 'utf8')).not.toContain('"lamport":2');
    expect(fs.readFileSync(seg(2), 'utf8')).toContain('"lamport":2');
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2]);
    openSpy.mockRestore();
    log.close();
  });
});

// ── hwmFloor(§3-4 클램프, 패널 C): 컴팩션-후 재사용 차단 ───────────────────

describe('hwmFloor 하한 클램프', () => {
  it('빈 세그먼트만 잔존(컴팩션 절단 모사) + floor{5,5} → hwm 5, 첫 신규 6', async () => {
    // 컴팩션이 비어있지-않은 세그먼트를 전부 절단하고 빈 활성 세그먼트만 남은 상태.
    fs.writeFileSync(seg(3), '');
    const log = new AppendOnlyLog({
      dir,
      fsync: syncOk,
      hwmFloor: { lamport: 5, seq: 5 },
    });
    log.open();
    // floor 없인 스캔 hwm=0 → lamport/seq 재사용(§6.L 함정). floor가 차단.
    expect(log.lamportHwm).toBe(5);
    expect(log.seqHwm).toBe(5);

    const ok = await log.append(draft({ n: 'post-compaction' }));
    expect(ok).toBe(true);
    const recs = log.readAllRecords();
    expect(recs.map((r) => r.lamport)).toEqual([6]); // 첫 신규 = floor+1
    expect(recs[0].origin.seq).toBe(6);
    log.close();
  });

  it('세그먼트 전무(first-boot 경로)에서도 floor 적용', async () => {
    const log = new AppendOnlyLog({
      dir,
      fsync: syncOk,
      hwmFloor: { lamport: 7, seq: 7 },
    });
    log.open();
    expect(log.lamportHwm).toBe(7);
    await log.append(draft({ n: 1 }));
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([8]);
    log.close();
  });

  it('스캔 hwm이 floor보다 크면 스캔 값 우선(클램프는 하한일 뿐)', () => {
    fs.writeFileSync(seg(1), envLine(9, 9));
    const log = new AppendOnlyLog({ dir, hwmFloor: { lamport: 5, seq: 5 } });
    log.open();
    expect(log.lamportHwm).toBe(9);
    expect(log.seqHwm).toBe(9);
    log.close();
  });
});
