// ─── ChannelService × 이벤트로그 (PR3 통합) ────────────────────────────
// envelope-design §5 커밋경로 반전의 계약 고정:
//   - 1 커밋 = 1 envelope, 커밋 실패(fsync 주입) → PERSIST_FAILED + 롤백 + 무이벤트
//   - 재부트 = 스냅샷 폴백 체인 + tail replay → 라이브 projection과 수렴
//   - 스냅샷 마커 지연(stale marker) → 멱등 재적용으로 수렴
//   - dual-write 워터마크(§6.4c): 정상 재기동 오발동 0 / 구-데몬 쓰기 감지

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ChannelService } from '../ChannelService';
import type { ChannelServiceEventLog } from '../ChannelService';
import { ChannelStateWriter } from '../ChannelStateWriter';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import {
  SnapshotStore,
  SNAPSHOT_DIRNAME,
  GENESIS_CHANNEL_REF,
  CHANNEL_PROJECTION_REF,
} from '../../eventlog/SnapshotStore';
import { evaluateWatermark, stampWatermark } from '../../eventlog/migrateToEventLog';
import { EMPTY_CHANNEL_STATE, type ChannelState } from '../../../shared/channels';

let dir: string;
let eventsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-svc-eventlog-'));
  eventsDir = path.join(dir, 'events');
  // 마이그레이션 완료 상태 모사: genesis(빈 상태, lamport 0) 존재.
  const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
  store.writeDurableSync(
    GENESIS_CHANNEL_REF,
    { ...EMPTY_CHANNEL_STATE, channels: [], members: {}, messages: {}, idempotency: {} },
    0,
    ChannelStateWriter.isChannelState,
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  svc: ChannelService;
  writer: ChannelStateWriter;
  log: AppendOnlyLog;
  snapshots: SnapshotStore;
  emit: ReturnType<typeof vi.fn>;
  deps: ChannelServiceEventLog;
}

function makeHarness(opts: { fsync?: (fd: number) => void } = {}): Harness {
  const writer = new ChannelStateWriter(dir);
  const log = new AppendOnlyLog({
    dir: eventsDir,
    fsync: opts.fsync ?? ((): void => {}),
  });
  log.open();
  const snapshots = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
  writer.enableEventLogDualWrite({
    // index.ts 부트 게이트와 동일 배선 — write 시점 워터마크(§6.4c).
    stamp: (s) => stampWatermark(s, log.lamportHwm),
    durableFlush: true,
  });
  const deps: ChannelServiceEventLog = {
    log,
    snapshots,
    genesisRef: GENESIS_CHANNEL_REF,
    reseedRefs: [],
    machineId: 'machine-test',
  };
  const emit = vi.fn();
  const svc = new ChannelService({
    writer,
    eventLog: deps,
    companyId: 'co-test',
    emit,
    now: (() => {
      let t = 1_700_000_000_000;
      return () => ++t;
    })(),
  });
  return { svc, writer, log, snapshots, emit, deps };
}

/** 라이브 projection 스냅숏(비교용 deep clone). */
function stateOf(svc: ChannelService): ChannelState {
  return JSON.parse(
    JSON.stringify((svc as unknown as { state: ChannelState }).state),
  ) as ChannelState;
}

/** 대표 mutation 배터리 — 전 이벤트 종류를 커버한다. */
async function runBattery(svc: ChannelService): Promise<string> {
  const created = await svc.create({
    name: 'general',
    visibility: 'public',
    createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
    verifiedWorkspaceId: 'ws-1',
  });
  if (!created.ok) throw new Error('create failed');
  const chId = created.channel.id;
  expect((await svc.join({
    channelId: chId,
    member: { workspaceId: 'ws-2', memberId: 'm-2' },
    includeHistory: true,
    verifiedWorkspaceId: 'ws-2',
  })).ok).toBe(true);
  expect((await svc.invite({
    channelId: chId,
    invitedMember: { workspaceId: 'ws-3', memberId: 'm-3' },
    verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  expect((await svc.post({
    channelId: chId,
    sender: { workspaceId: 'ws-1', memberId: 'm-1' },
    text: 'hello @ws-2',
    verifiedWorkspaceId: 'ws-1',
    clientMsgId: 'cli-1',
    mentions: [{ workspaceId: 'ws-2', name: 'two' }],
  })).ok).toBe(true);
  expect((await svc.post({
    channelId: chId,
    sender: { workspaceId: 'ws-2', memberId: 'm-2' },
    text: 'reply',
    verifiedWorkspaceId: 'ws-2',
  })).ok).toBe(true);
  expect((await svc.ack({
    channelId: chId, verifiedWorkspaceId: 'ws-2', uptoSeq: 2, memberId: 'm-2',
  })).ok).toBe(true);
  expect((await svc.ack({
    channelId: chId, verifiedWorkspaceId: 'ws-3', uptoSeq: 2, // receipt-only
  })).ok).toBe(true);
  expect((await svc.leave({
    channelId: chId, workspaceId: 'ws-3', memberId: 'm-3', verifiedWorkspaceId: 'ws-3',
  })).ok).toBe(true);
  const second = await svc.create({
    name: 'ops',
    visibility: 'public',
    createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
    verifiedWorkspaceId: 'ws-1',
    members: [{ workspaceId: 'ws-2', memberId: 'm-2b' }],
  });
  if (!second.ok) throw new Error('second create failed');
  expect((await svc.kick({
    channelId: second.channel.id,
    targetWorkspaceId: 'ws-2',
    targetMemberId: 'm-2b',
    verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  expect((await svc.purgeMembership({
    workspaceId: 'ws-2', verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  expect((await svc.archive({
    channelId: second.channel.id, archivedBy: 'ws-1', verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  return chId;
}

describe('ChannelService × 이벤트로그 (§5 커밋경로 반전)', () => {
  it('1 커밋 = 1 envelope — 배터리의 커밋 수와 로그 레코드 수·kind가 일치', async () => {
    const h = makeHarness();
    await runBattery(h.svc);
    const kinds = h.log.readAllRecords().map(
      (r) => (r.payload as { kind: string }).kind,
    );
    // create/join/invite/post/post/ack/ack/leave/create/kick/purge/archive = 12 커밋.
    expect(kinds).toEqual([
      'create', 'join', 'invite', 'post', 'post', 'ack', 'ack', 'leave',
      'create', 'kick', 'purge', 'archive',
    ]);
    // 도메인·origin 스탬프(§1): 전 레코드 channel 도메인 + machineId.
    for (const rec of h.log.readAllRecords()) {
      expect(rec.domain).toBe('channel');
      expect(rec.origin.machineId).toBe('machine-test');
      expect(rec.authContext.verifiedWorkspaceId.length).toBeGreaterThan(0);
    }
    h.log.close();
  });

  it('재부트(스냅샷 없음): genesis + 전체 replay가 라이브 projection과 수렴', async () => {
    const h = makeHarness();
    await runBattery(h.svc);
    const live = stateOf(h.svc);
    h.log.close();

    const h2 = makeHarness();
    expect(stateOf(h2.svc)).toEqual(live);
    // lamport hwm도 복원(재시작 후 재사용 없음 — §3).
    expect(h2.log.lamportHwm).toBe(12);
    h2.log.close();
  });

  it('operator-join: 좌석+시스템 메시지가 1 envelope로 커밋되고 재부트 replay가 수렴', async () => {
    const h = makeHarness();
    // 에이전트가 만든 비공개 채널.
    const created = await h.svc.create({
      name: 'secret',
      visibility: 'private',
      createdBy: { workspaceId: 'ws-agent', memberId: 'agent-1' },
      verifiedWorkspaceId: 'ws-agent',
    });
    if (!created.ok) throw new Error('create failed');
    const before = h.log.readAllRecords().length;
    const res = await h.svc.operatorJoin({
      channelId: created.channel.id,
      verifiedWorkspaceId: 'ws-human',
    });
    expect(res.ok).toBe(true);
    // 좌석 push + 시스템 메시지 append가 단 하나의 operator-join envelope다(1 커밋 = 1 envelope).
    const recs = h.log.readAllRecords();
    expect(recs.length).toBe(before + 1);
    expect((recs.at(-1)?.payload as { kind: string }).kind).toBe('operator-join');
    const live = stateOf(h.svc);
    h.log.close();

    // 재부트: genesis + 전체 replay가 라이브 projection과 정확히 수렴(원자 재적용).
    const h2 = makeHarness();
    expect(stateOf(h2.svc)).toEqual(live);
    h2.log.close();
  });

  it('#1318 observer cursor: a seatless human mention + observer-ack commit one envelope each and survive a reboot', async () => {
    const h = makeHarness();
    const created = await h.svc.create({
      name: 'secret',
      visibility: 'private',
      createdBy: { workspaceId: 'ws-agent', memberId: 'agent-1' },
      verifiedWorkspaceId: 'ws-agent',
    });
    if (!created.ok) throw new Error('create failed');
    const chId = created.channel.id;
    const mention = (text: string) =>
      h.svc.post({
        channelId: chId,
        sender: { workspaceId: 'ws-agent', memberId: 'agent-1' },
        text,
        verifiedWorkspaceId: 'ws-agent',
        mentions: [{ workspaceId: 'ws-human', name: 'Operator' }],
      });
    expect((await mention('@operator one')).ok).toBe(true); // seq 1
    expect((await mention('@operator two')).ok).toBe(true); // seq 2
    // Snapshot here, so the ack below is replayed from the tail.
    h.snapshots.flushSync();
    expect(await h.svc.ackAsPhone(chId, 1)).toEqual({ ok: true, lastReadSeq: 1 });
    // A backwards ack commits nothing.
    expect(await h.svc.ackAsPhone(chId, 0)).toEqual({ ok: true, lastReadSeq: 1 });
    const kinds = h.log.readAllRecords().map((r) => (r.payload as { kind: string }).kind);
    expect(kinds).toEqual(['create', 'post', 'post', 'observer-ack']);
    const row = h.svc.listForPhone().find((r) => r.channelId === chId);
    expect(row).toMatchObject({ observed: true, observerUnreadMentions: 1, observerLastReadSeq: 1 });
    expect(h.svc.getMembers(chId, 'ws-human').some((m) => m.workspaceId === 'ws-human')).toBe(false);
    const live = stateOf(h.svc);
    h.log.close();

    const h2 = makeHarness();
    expect(stateOf(h2.svc)).toEqual(live);
    expect(h2.svc.listForPhone().find((r) => r.channelId === chId)).toEqual(row);
    h2.log.close();
  });

  it('재부트(스냅샷 가속): flush된 스냅샷 + tail replay가 수렴', async () => {
    const h = makeHarness();
    const chId = await runBattery(h.svc);
    // 스냅샷 flush(마커 = 현재 hwm 12) 후 추가 커밋 2건(tail).
    h.snapshots.flushSync();
    await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'after snapshot', verifiedWorkspaceId: 'ws-1',
    });
    await h.svc.ack({ channelId: chId, verifiedWorkspaceId: 'ws-1', uptoSeq: 3, memberId: 'm-1' });
    const live = stateOf(h.svc);
    h.log.close();

    const h2 = makeHarness();
    expect(stateOf(h2.svc)).toEqual(live);
    h2.log.close();
  });

  it('스냅샷 마커 지연(내용 > 마커): 멱등 재적용으로 수렴 — 이중 적용 없음', async () => {
    const h = makeHarness();
    const chId = await runBattery(h.svc);
    // 레이스 산물 모사: 전체 내용(hwm 12 반영)을 옛 마커(lamport 4)로 기록 —
    // 부트가 lamport 5..12를 이미 반영된 내용 위에 재적용해도 수렴해야 한다.
    h.snapshots.writeDurableSync(
      CHANNEL_PROJECTION_REF,
      (h.svc as unknown as { state: ChannelState }).state,
      4,
      ChannelStateWriter.isChannelState,
    );
    const live = stateOf(h.svc);
    h.log.close();

    const h2 = makeHarness();
    const replayed = stateOf(h2.svc);
    expect(replayed).toEqual(live);
    // 이중 적용의 대표 증상 부재: 메시지 중복 없음.
    const msgs = replayed.messages[chId] ?? [];
    expect(new Set(msgs.map((m) => m.seq)).size).toBe(msgs.length);
    h2.log.close();
  });

  it('커밋 실패(fsync 주입): PERSIST_FAILED + 인메모리 롤백 + 무이벤트 + 로그 무기록, 이후 재개', async () => {
    let fail = false;
    const h = makeHarness({
      fsync: () => {
        if (fail) throw new Error('inject');
      },
    });
    const created = await h.svc.create({
      name: 'general', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' }, verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('setup create failed');
    const before = stateOf(h.svc);
    h.emit.mockClear();

    fail = true;
    const r = await h.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'doomed', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-x',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PERSIST_FAILED');
    // 인메모리 롤백: nextSeq·messages·멱등 엔트리 원복(기존 롤백 블록 형태 보존).
    expect(stateOf(h.svc)).toEqual(before);
    // 이벤트 방출 없음(persist-first 계약).
    expect(h.emit).not.toHaveBeenCalled();
    // 디스크에 롤백 레코드 없음(§2.4-4 배치 롤백).
    expect(h.log.readAllRecords()).toHaveLength(1); // create뿐

    // 실패 후 재개: lamport gap 허용·재사용 금지(§3 함정).
    fail = false;
    const retry = await h.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'retry', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-x',
    });
    expect(retry.ok).toBe(true);
    const recs = h.log.readAllRecords();
    expect(recs).toHaveLength(2);
    expect(recs[1].lamport).toBe(3); // 2가 gap(소비 후 롤백), 재사용 없음
    h.log.close();
  });

  it('멱등 replay 재구성(§4): 재부트 후 같은 clientMsgId 재시도가 원본을 반환(중복 커밋 없음)', async () => {
    const h = makeHarness();
    const created = await h.svc.create({
      name: 'general', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' }, verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('setup');
    const first = await h.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'once', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-dup',
    });
    if (!first.ok) throw new Error('post');
    h.log.close();

    const h2 = makeHarness();
    const retry = await h2.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'twice', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-dup',
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.idempotent).toBe(true);
      expect(retry.message.seq).toBe(first.message.seq);
      expect(retry.message.text).toBe('once');
    }
    // 로그에 post는 1건뿐(재시도는 append 없이 원본 반환).
    expect(
      h2.log.readAllRecords().filter((r) => (r.payload as { kind: string }).kind === 'post'),
    ).toHaveLength(1);
    h2.log.close();
  });

  it('워터마크(§6.4c): flush된 dual-write는 unchanged(오발동 0), 구-데몬 쓰기 모사는 감지', async () => {
    const h = makeHarness();
    await runBattery(h.svc);
    // dual-write 강제 flush(§6.4b 셧다운 경로) — write 시점 스탬프.
    h.writer.flushSync();
    const channelsJson = path.join(dir, 'channels.json');
    const raw1 = JSON.parse(fs.readFileSync(channelsJson, 'utf8')) as Record<string, unknown>;
    expect(evaluateWatermark(raw1).kind).toBe('unchanged'); // 정상 재기동 — reseed 오발동 0

    // 구-데몬 쓰기 모사: 내용 변경 + 워터마크 필드 왕복 보존(§6.4c 감지 근거).
    (raw1['channels'] as Array<{ name: string }>)[0].name = 'renamed-by-old-daemon';
    fs.writeFileSync(channelsJson, JSON.stringify(raw1));
    const raw2 = JSON.parse(fs.readFileSync(channelsJson, 'utf8'));
    const verdict = evaluateWatermark(raw2);
    expect(verdict.kind).toBe('downgrade-write');
    if (verdict.kind === 'downgrade-write') expect(verdict.reason).toBe('hash-mismatch');
    h.log.close();
  });

  // ─── G1 — 커밋-후-적용(append-then-apply): dirty read 구조적 제거 ─────────
  // 구 saveOrFail은 동기라 mutation 임계구역에 yield가 없었지만 append는 await를
  // 도입했다. G1은 적용을 fsync 배리어 **뒤**로 미뤄, 그 await 창 동안 뮤텍스를
  // 안 타는 동기 읽기(list/getMessages)가 미커밋 낙관 상태를 보는 일이 없게 한다.
  describe('G1 커밋-후-적용', () => {
    it('① in-flight 비가시 ② fsync reject 후에도 비가시(무롤백) ③ resolve 후 가시', async () => {
      // 수동 fsync 게이트: 테스트가 각 배리어의 resolve/reject를 직접 쥔다.
      let release: (() => void) | null = null;
      let fail: ((err: Error) => void) | null = null;
      const gate = (): Promise<void> =>
        new Promise<void>((res, rej) => {
          release = res;
          fail = rej;
        });
      let gated = false;
      const h = makeHarness({
        fsync: () => (gated ? gate() : Promise.resolve()) as never,
      });
      const created = await h.svc.create({
        name: 'general', visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1' }, verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('setup create failed');
      const chId = created.channel.id;
      const before = stateOf(h.svc);
      h.emit.mockClear();

      // ① in-flight: append의 write는 끝났지만 배리어 미해소 — projection 비가시.
      gated = true;
      const postPromise = h.svc.post({
        channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
        text: 'optimistic', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-g1',
      });
      await new Promise((r) => setTimeout(r, 10)); // write+배리어 진입 대기
      expect(h.svc.getMessages(chId, undefined, 'ws-1')).toHaveLength(0); // dirty read 없음
      expect(stateOf(h.svc)).toEqual(before);
      expect(h.emit).not.toHaveBeenCalled();

      // ② 배리어 reject: 미적용 그대로 — 롤백이 필요한 상태 자체가 없다.
      fail!(new Error('inject barrier failure'));
      const r1 = await postPromise;
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error.code).toBe('PERSIST_FAILED');
      expect(h.svc.getMessages(chId, undefined, 'ws-1')).toHaveLength(0);
      expect(stateOf(h.svc)).toEqual(before);
      expect(h.emit).not.toHaveBeenCalled();

      // ③ 배리어 resolve: 적용·가시 + 이벤트 방출.
      const postPromise2 = h.svc.post({
        channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
        text: 'committed', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-g1', // 재시도(같은 키)
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(h.svc.getMessages(chId, undefined, 'ws-1')).toHaveLength(0); // 아직 비가시
      release!();
      const r2 = await postPromise2;
      expect(r2.ok).toBe(true);
      const visible = h.svc.getMessages(chId, undefined, 'ws-1');
      expect(visible).toHaveLength(1);
      expect(visible[0].text).toBe('committed');
      expect(visible[0].seq).toBe(1); // 실패 시도는 seq를 소비하지 않음(선결정·무적용)
      expect(h.emit).toHaveBeenCalled();
      h.log.close();
    });

    it('멤버십 계열(join)도 배리어 전 비가시 — 적용은 커밋 뒤', async () => {
      let release: (() => void) | null = null;
      let gated = false;
      const h = makeHarness({
        fsync: () =>
          (gated
            ? new Promise<void>((res) => {
                release = res;
              })
            : Promise.resolve()) as never,
      });
      const created = await h.svc.create({
        name: 'general', visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1' }, verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('setup');
      gated = true;
      const joinPromise = h.svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2' },
        verifiedWorkspaceId: 'ws-2',
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(h.svc.getMembers(created.channel.id, 'ws-1')).toHaveLength(1); // 미커밋 join 비가시
      release!();
      expect((await joinPromise).ok).toBe(true);
      expect(h.svc.getMembers(created.channel.id, 'ws-1')).toHaveLength(2);
      h.log.close();
    });
  });
});

// ─── 패널 반영: trim 역사 가드(CL-3) + 로그 모드 시멘틱 파리티(CL-4 확장) ─────

import { applyChannelEvent } from '../channelEvents';

describe('replay trim 역사 가드 (패널 CL-3)', () => {
  it('보존 범위 이전의 과거 post(seq < nextSeq, msgs에 없음) 재적용은 전체 no-op', () => {
    const state: ChannelState = JSON.parse(JSON.stringify(EMPTY_CHANNEL_STATE));
    state.channels.push({
      id: 'ch-1', name: 'g', visibility: 'public', createdBy: 'ws-1',
      createdAt: 1, nextSeq: 101, companyId: 'co',
    } as unknown as ChannelState['channels'][number]);
    // 히스토리 캡이 seq 100만 보존한 상태 모사(50은 이미 절단됨).
    state.messages['ch-1'] = [
      { seq: 100, workspaceId: 'ws-1', memberId: 'm-1', memberName: 'a', text: 'newest', ts: 100 } as unknown as NonNullable<ChannelState['messages']['x']>[number],
    ];
    const before = JSON.parse(JSON.stringify(state));
    applyChannelEvent(state, {
      kind: 'post', channelId: 'ch-1',
      message: { seq: 50, workspaceId: 'ws-1', memberId: 'm-1', memberName: 'a', text: 'trimmed-old', ts: 50 },
    });
    // 순서 붕괴·보존분 축출·커서/멱등 부작용 전무.
    expect(state).toEqual(before);
  });

  it('nextSeq 이상의 신규 post는 정상 적용(가드가 신규를 막지 않음)', () => {
    const state: ChannelState = JSON.parse(JSON.stringify(EMPTY_CHANNEL_STATE));
    state.channels.push({
      id: 'ch-1', name: 'g', visibility: 'public', createdBy: 'ws-1',
      createdAt: 1, nextSeq: 101, companyId: 'co',
    } as unknown as ChannelState['channels'][number]);
    state.messages['ch-1'] = [];
    applyChannelEvent(state, {
      kind: 'post', channelId: 'ch-1',
      message: { seq: 101, workspaceId: 'ws-1', memberId: 'm-1', memberName: 'a', text: 'new', ts: 101 },
    });
    expect(state.messages['ch-1'].map((m) => m.seq)).toEqual([101]);
    expect(state.channels[0].nextSeq).toBe(102);
  });
});

describe('로그 모드 시멘틱 파리티 — 핵심 표면 (패널 CL-4 확장)', () => {
  it('per-member 커서: 한 멤버의 ack가 다른 멤버 unread에 불간섭 + 재부트 후 유지', async () => {
    const h = makeHarness();
    const created = await h.svc.create({
      name: 'cur', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
      verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('create failed');
    const chId = created.channel.id;
    expect((await h.svc.join({
      channelId: chId, member: { workspaceId: 'ws-2', memberId: 'm-2' },
      includeHistory: true, verifiedWorkspaceId: 'ws-2',
    })).ok).toBe(true);
    expect((await h.svc.join({
      channelId: chId, member: { workspaceId: 'ws-3', memberId: 'm-3' },
      includeHistory: true, verifiedWorkspaceId: 'ws-3',
    })).ok).toBe(true);
    expect((await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'one', verifiedWorkspaceId: 'ws-1',
    })).ok).toBe(true);
    expect((await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'two', verifiedWorkspaceId: 'ws-1',
    })).ok).toBe(true);
    expect((await h.svc.ack({
      channelId: chId, verifiedWorkspaceId: 'ws-2', uptoSeq: 2, memberId: 'm-2',
    })).ok).toBe(true);

    const rows = stateOf(h.svc).members[chId];
    // 발신자 m-1은 자기 발신 자동 읽음(라이브 시멘틱) — 파리티 대상은 제3의
    // 비-ack 멤버 m-3의 불간섭이다.
    const m3Before = rows.find((r) => r.memberId === 'm-3')?.lastReadSeq;
    expect(rows.find((r) => r.memberId === 'm-2')?.lastReadSeq).toBe(2);
    expect(m3Before).not.toBe(2); // 타 멤버 ack가 m-3 커서에 불간섭

    // 재부트(스냅샷 없음 → genesis+replay) 후 커서 보존.
    h.log.close();
    const h2 = makeHarness();
    const rows2 = stateOf(h2.svc).members[chId];
    expect(rows2.find((r) => r.memberId === 'm-2')?.lastReadSeq).toBe(2);
    expect(rows2.find((r) => r.memberId === 'm-3')?.lastReadSeq).toBe(m3Before);
    h2.log.close();
  });

  it('existence-hiding: 비멤버 list()에 private 채널 비노출 — 재부트 후에도', async () => {
    const h = makeHarness();
    const created = await h.svc.create({
      name: 'secret', visibility: 'private',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
      verifiedWorkspaceId: 'ws-1',
    });
    expect(created.ok).toBe(true);
    expect(h.svc.list('ws-1').map((c) => c.name)).toContain('secret');
    expect(h.svc.list('ws-9').map((c) => c.name)).not.toContain('secret');
    h.log.close();
    const h2 = makeHarness();
    expect(h2.svc.list('ws-9').map((c) => c.name)).not.toContain('secret');
    expect(h2.svc.list('ws-1').map((c) => c.name)).toContain('secret');
    h2.log.close();
  });

  it('멱등 재시도: 동일 clientMsgId 재post → 메시지 1건 — 재부트 리플레이 후에도 1건', async () => {
    const h = makeHarness();
    const created = await h.svc.create({
      name: 'g', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
      verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('create failed');
    const chId = created.channel.id;
    const p1 = await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'once', verifiedWorkspaceId: 'ws-1', clientMsgId: 'dup-1',
    });
    const p2 = await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'once', verifiedWorkspaceId: 'ws-1', clientMsgId: 'dup-1',
    });
    expect(p1.ok && p2.ok).toBe(true);
    expect(stateOf(h.svc).messages[chId]).toHaveLength(1);
    h.log.close();
    const h2 = makeHarness();
    expect(stateOf(h2.svc).messages[chId]).toHaveLength(1); // 로그에도 1건(멱등 no-append)
    h2.log.close();
  });
});

describe('코얼레싱 배치 롤백 — 서비스 레벨 (패널 2R INFO)', () => {
  it('동일 tick 다중 post(채널 3개) → 공유 배리어 실패 → 전원 PERSIST_FAILED + 로그 무잔존', async () => {
    let fail = false;
    const h = makeHarness({
      fsync: () => {
        if (fail) throw new Error('inject barrier failure');
      },
    });
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const created = await h.svc.create({
        name, visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('create failed');
      ids.push(created.channel.id);
    }
    const before = h.log.readAllRecords().length; // create 3
    fail = true;
    // 서로 다른 채널이라 per-channel 락에 안 걸리고 같은 tick에 append → 한 배리어로 코얼레싱.
    const results = await Promise.all(ids.map((channelId) =>
      h.svc.post({
        channelId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
        text: 'x', verifiedWorkspaceId: 'ws-1',
      }),
    ));
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('PERSIST_FAILED');
    }
    // §2.4-4: 배치 전량 물리 제거 — 중간 null 매장 없이 로그가 배리어 이전으로 복귀.
    expect(h.log.readAllRecords()).toHaveLength(before);
    // projection에도 미적용(G1 append-then-apply).
    for (const channelId of ids) {
      expect(stateOf(h.svc).messages[channelId] ?? []).toHaveLength(0);
    }
    fail = false;
    const retry = await h.svc.post({
      channelId: ids[0], sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'retry', verifiedWorkspaceId: 'ws-1',
    });
    expect(retry.ok).toBe(true);
    expect(stateOf(h.svc).messages[ids[0]].map((m) => m.seq)).toEqual([1]); // seq 미소비 재확인
  });
});

// ─── 공유 로그 통합 (PR3×PR4 단일화 — §2.1 단일 논리 스트림) ───────────────

import { A2aTaskService } from '../../a2a/A2aTaskService';

describe('공유 로그: 채널 × A2A 단일 인스턴스', () => {
  it('도메인 혼재 커밋 → lamport 전역 단조 + 양쪽 replay가 자기 도메인만 소비', async () => {
    const h = makeHarness();
    const a2a = new A2aTaskService({
      log: h.log,
      origin: { machineId: 'machine-test', daemonEpoch: 1 },
    });

    // 채널·A2A 커밋을 교차 배치 — 한 로그, 한 lamport 시계.
    const created = await h.svc.create({
      name: 'shared', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
      verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('create failed');
    const chId = created.channel.id;
    expect((await a2a.createTask({
      id: 'task-x', title: 'T',
      from: { workspaceId: 'ws-1', name: 'S' },
      to: { workspaceId: 'ws-2', name: 'R' },
    })).ok).toBe(true);
    expect((await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'hi', verifiedWorkspaceId: 'ws-1',
    })).ok).toBe(true);
    expect((await a2a.transition({
      taskId: 'task-x', to: 'working', callerWorkspaceId: 'ws-2',
    })).ok).toBe(true);

    // 단일 스트림: 도메인 혼재 + lamport 빈틈없이 단조(1..4) — 이중 인스턴스였다면
    // hwm이 갈라져 중복 lamport가 발급된다.
    const recs = h.log.readAllRecords();
    expect(recs.map((r) => r.domain)).toEqual(['channel', 'a2a', 'channel', 'a2a']);
    expect(recs.map((r) => r.lamport)).toEqual([1, 2, 3, 4]);

    // 재부트: 채널 replay는 a2a 레코드 무시, a2a restore는 channel 무시 — 상호 무오염.
    const channelLive = stateOf(h.svc);
    h.log.close();
    const h2 = makeHarness();
    const a2a2 = new A2aTaskService({
      log: h2.log,
      origin: { machineId: 'machine-test', daemonEpoch: 1 },
    });
    a2a2.restoreFromLog();
    expect(stateOf(h2.svc)).toEqual(channelLive);
    const restored = a2a2.queryTasks('ws-2', {});
    expect(restored).toHaveLength(1);
    expect(restored[0].status.state).toBe('working');
    expect(h2.log.lamportHwm).toBe(4);
    h2.log.close();
  });
});
