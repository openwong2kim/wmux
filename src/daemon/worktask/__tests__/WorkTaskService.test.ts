// ─── WorkTaskService tests (J0 §0 성공기준 + §1~§3 계약) ────────────────
//
// 성공기준(§0) E2E 왕복: mission.start → 채널 post → mission.close → 데몬 재시작
// 시뮬레이션(서비스 재생성 + boot replay) → projection 복원(closed) · archive 멱등
// 재시도 no-op. 이 테스트가 "R3 블로커 해소"의 판정식이다.
//
// 인프라: 실 AppendOnlyLog(A2aTaskService.test.ts fixture 재사용) + 실
// ChannelService(ChannelService.test.ts fake writer 패턴 재사용, E2E fidelity),
// 또는 주입 가능한 fake ChannelPort(reconcile/보상 archive 실패 케이스).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { ChannelService } from '../../channels/ChannelService';
import type { ChannelServiceDeps } from '../../channels/ChannelService';
import type { ChannelState } from '../../../shared/channels';
import { WorkTaskService } from '../WorkTaskService';
import type { WorkTaskChannelPort } from '../WorkTaskService';
import { missionTopicFor, taskIdFromMissionTopic, normalizeWorktreePath } from '../../../shared/workTask';

let dir: string;
const syncOk = (): void => {
  /* no-op fsync stub for the test log */
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-worktask-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir, fsync: syncOk });
  log.open();
  return log;
}

// ── 실 ChannelService fake writer (ChannelService.test.ts 패턴 재사용) ──
function makeFakeWriter() {
  let lastSaved: ChannelState | null = null;
  const freshState = (): ChannelState => ({
    version: 1,
    channels: [],
    members: {},
    messages: {},
    idempotency: {},
  });
  const clone = (state: ChannelState): ChannelState => ({
    version: state.version,
    channels: state.channels.map((c) => ({ ...c })),
    members: Object.fromEntries(
      Object.entries(state.members).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    messages: Object.fromEntries(
      Object.entries(state.messages).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    idempotency: Object.fromEntries(
      Object.entries(state.idempotency).map(([k, v]) => [k, { ...v }]),
    ),
  });
  return {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      lastSaved = clone(state);
      return true;
    }),
    load: vi.fn((): ChannelState => (lastSaved ? clone(lastSaved) : freshState())),
  };
}

function newChannelService(writer: ReturnType<typeof makeFakeWriter>): ChannelService {
  const deps: ChannelServiceDeps = {
    writer: writer as unknown as ChannelServiceDeps['writer'],
    companyId: 'co-1',
    emit: vi.fn(),
    now: () => Date.now(),
  };
  return new ChannelService(deps);
}

function newWorkTaskService(
  log: AppendOnlyLog,
  channels: WorkTaskChannelPort,
  opts?: { now?: () => number; ceoWorkspaceId?: string },
): WorkTaskService {
  return new WorkTaskService({
    log,
    channels,
    origin: { machineId: 'm1', daemonEpoch: 1 },
    ...(opts?.ceoWorkspaceId !== undefined ? { ceoWorkspaceId: opts.ceoWorkspaceId } : {}),
    ...(opts?.now ? { now: opts.now } : {}),
  });
}

// ── 주입 가능한 fake ChannelPort (실패·상태 제어) ──────────────────────
function makeFakeChannelPort(opts?: { failCreate?: boolean }) {
  let seq = 0;
  const channels = new Map<
    string,
    { id: string; topic?: string; status: 'active' | 'archived'; createdByWorkspaceId?: string }
  >();
  const archiveCalls: string[] = [];
  /** archive 호출의 신원 관측(R1' — 고아 reconcile이 창설 ws로 archive하는지). */
  const archiveIdentities: Array<{ channelId: string; verifiedWorkspaceId: string }> = [];
  const port: WorkTaskChannelPort = {
    create: vi.fn(async (params) => {
      if (opts?.failCreate) {
        return { ok: false as const, error: { code: 'PERSIST_FAILED', message: 'forced' } };
      }
      const id = `ch-${++seq}`;
      channels.set(id, {
        id,
        ...(params.topic !== undefined ? { topic: params.topic } : {}),
        status: 'active',
        createdByWorkspaceId: params.createdBy.workspaceId,
      });
      return { ok: true as const, channel: { id } };
    }),
    archive: vi.fn(async (params) => {
      archiveCalls.push(params.channelId);
      archiveIdentities.push({
        channelId: params.channelId,
        verifiedWorkspaceId: params.verifiedWorkspaceId,
      });
      const ch = channels.get(params.channelId);
      if (!ch) return { ok: false as const, error: { code: 'CHANNEL_NOT_FOUND', message: 'nf' } };
      ch.status = 'archived';
      return { ok: true as const };
    }),
    listAllForReconcile: () => [...channels.values()].map((c) => ({ ...c })),
  };
  // 테스트 헬퍼: 크래시/외부 변이 시뮬레이션(non-null assertion 회피).
  const setStatus = (id: string, status: 'active' | 'archived'): void => {
    const ch = channels.get(id);
    if (ch) ch.status = status;
  };
  return { port, channels, archiveCalls, archiveIdentities, setStatus };
}

// ═══ §2 경로 정규화 유틸 ═══════════════════════════════════════════════

describe('normalizeWorktreePath (§2 배타 불변식 정규화)', () => {
  it('trailing slash·중복 슬래시 제거', () => {
    expect(normalizeWorktreePath('/a/b//c/', 'linux')).toBe('/a/b/c');
  });
  it('대소문자 무구분 FS는 lower-case canonical', () => {
    expect(normalizeWorktreePath('/A/B', 'darwin')).toBe('/a/b');
    expect(normalizeWorktreePath('/A/B', 'linux')).toBe('/A/B');
  });
  it('백슬래시(win)를 슬래시로 통일', () => {
    expect(normalizeWorktreePath('C:\\Repo\\WT', 'win32')).toBe('c:/repo/wt');
  });
});

describe('missionTopic 앵커 (§3)', () => {
  it('round-trips taskId', () => {
    expect(taskIdFromMissionTopic(missionTopicFor('wtask-abc'))).toBe('wtask-abc');
  });
  it('비앵커 topic은 null', () => {
    expect(taskIdFromMissionTopic('random topic')).toBeNull();
    expect(taskIdFromMissionTopic(undefined)).toBeNull();
  });
});

// ═══ §0 성공기준 — E2E 왕복 ════════════════════════════════════════════

describe('§0 성공기준 E2E 왕복 (mission.start → post → close → 재시작 → 복원·archive 멱등)', () => {
  it('E2E: start → channel post → close → restart replay 복원 + archive 멱등 no-op', async () => {
    const writer = makeFakeWriter();
    const channelSvc = newChannelService(writer);
    const log = newLog();
    const svc = newWorkTaskService(log, channelSvc as unknown as WorkTaskChannelPort);
    await svc.boot();

    // 1) mission.start — 태스크 + 미션 채널 생성.
    const started = await svc.startMission({
      title: 'Ship the widget',
      verifiedWorkspaceId: 'ws-owner',
      memberId: 'lead',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { taskId, channelId } = started;

    // 채널이 실제로 생겼고 topic 앵커가 박혔다.
    const created = channelSvc.get(channelId, 'ws-owner');
    expect(created).not.toBeNull();
    expect(created?.topic).toBe(missionTopicFor(taskId));
    expect(created?.status).toBe('active');

    // 2) 채널 post — 미션 채널은 평범한 채널이라 그대로 소비된다.
    const posted = await channelSvc.post({
      channelId,
      sender: { workspaceId: 'ws-owner', memberId: 'lead' },
      text: 'kickoff',
      verifiedWorkspaceId: 'ws-owner',
    });
    expect(posted.ok).toBe(true);

    // 3) mission.close — 태스크 closed + 채널 archive.
    const closed = await svc.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    expect(closed.ok).toBe(true);
    expect(svc.getTask(taskId)?.status).toBe('closed');
    expect(channelSvc.get(channelId, 'ws-owner')?.status).toBe('archived');

    // 4) 데몬 재시작 시뮬레이션 — 같은 로그·같은 writer 위에 서비스 재생성 + boot replay.
    const channelSvc2 = newChannelService(writer); // writer.load()가 마지막 저장 상태 복원.
    const log2 = newLog(); // 같은 dir → 같은 세그먼트 replay.
    const svc2 = newWorkTaskService(log2, channelSvc2 as unknown as WorkTaskChannelPort);
    await svc2.boot();

    // projection 복원: closed 태스크가 살아있다.
    const restored = svc2.getTask(taskId);
    expect(restored).toBeDefined();
    expect(restored?.status).toBe('closed');
    expect(restored?.missionChannelId).toBe(channelId);

    // archive 멱등 재시도 no-op: 부트 reconcile 태스크 방향이 이미 archived 채널을
    // 다시 archive하려 해도 no-op(에러 없음). 채널은 여전히 archived.
    expect(channelSvc2.get(channelId, 'ws-owner')?.status).toBe('archived');

    // 재close도 멱등 no-op ack.
    const reclose = await svc2.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    expect(reclose.ok).toBe(true);
  });
});

// ═══ 워크스페이스 수명 결속 — 채널 보존 불변식 ═════════════════════════
//
// 오너 정책의 핵심: **미션은 워크스페이스 수명에 묶이지만 채널은 남는다.**
// 렌더러는 태스크 워크스페이스가 삭제될 때 mission.close를 쏘므로, 그 close가
// 채널을 지우지 않는다는 것이 정책 전체가 서 있는 자리다(archive는 접힘일 뿐,
// 삭제는 사람이 명시적으로 휴지통을 비울 때만 일어난다).

describe('mission.close는 채널을 archive할 뿐 지우지 않는다', () => {
  it('워크스페이스 삭제로 close된 뒤에도 채널 행·메시지·멤버가 그대로 남는다', async () => {
    const writer = makeFakeWriter();
    const channelSvc = newChannelService(writer);
    const log = newLog();
    const svc = newWorkTaskService(log, channelSvc as unknown as WorkTaskChannelPort);
    await svc.boot();

    const started = await svc.startMission({
      title: 'Fan out five',
      verifiedWorkspaceId: 'ws-owner',
      memberId: 'lead',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { taskId, channelId } = started;
    await channelSvc.post({
      channelId,
      sender: { workspaceId: 'ws-owner', memberId: 'lead' },
      text: 'what the agent did',
      verifiedWorkspaceId: 'ws-owner',
    });

    // 태스크 워크스페이스가 사라져 렌더러가 쏘는 close.
    const closed = await svc.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    expect(closed.ok).toBe(true);

    // 미션은 닫혔다.
    expect(svc.getTask(taskId)?.status).toBe('closed');
    // 채널은 남는다 — archived(접힘)일 뿐 부재가 아니다.
    const ch = channelSvc.get(channelId, 'ws-owner');
    expect(ch).not.toBeNull();
    expect(ch?.status).toBe('archived');
    // 휴지통에 들어가지도 않는다(삭제 경로는 사람의 명시적 행위 전용).
    expect(ch?.trashedAt).toBeUndefined();
    // 기록 그대로.
    expect(channelSvc.getMessages(channelId, undefined, 'ws-owner').map((m) => m.text)).toEqual([
      'what the agent did',
    ]);
    expect(channelSvc.getMembers(channelId, 'ws-owner').length).toBeGreaterThan(0);
  });
});

// ─── 채널 보존 앵커(ChannelService.sweepRetention이 소비) ──────────────────────

describe('hasOpenTaskForChannel — 살아 있는 미션의 채널을 스윕이 지우지 못하게', () => {
  it('open 미션의 채널만 true이고, close되면 false로 풀린다', async () => {
    const writer = makeFakeWriter();
    const channelSvc = newChannelService(writer);
    const log = newLog();
    const svc = newWorkTaskService(log, channelSvc as unknown as WorkTaskChannelPort);
    await svc.boot();

    const started = await svc.startMission({
      title: 'Anchor me',
      verifiedWorkspaceId: 'ws-owner',
      memberId: 'lead',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(svc.hasOpenTaskForChannel(started.channelId)).toBe(true);
    // 무관한 채널·빈 문자열은 앵커가 아니다.
    expect(svc.hasOpenTaskForChannel('chan-unrelated')).toBe(false);
    expect(svc.hasOpenTaskForChannel('')).toBe(false);

    await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-owner' });
    expect(svc.hasOpenTaskForChannel(started.channelId)).toBe(false);
  });
});

// ═══ §3 멱등 (start 재시도 · 재close) ═══════════════════════════════════

describe('§3 멱등', () => {
  it('같은 idempotency_key start 재시도는 채널·태스크 중복 없이 원본 반환', async () => {
    const { port, create } = (() => {
      const f = makeFakeChannelPort();
      return { port: f.port, create: f.port.create as ReturnType<typeof vi.fn> };
    })();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();

    const r1 = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead', idempotencyKey: 'k1' });
    const r2 = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead', idempotencyKey: 'k1' });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.taskId).toBe(r1.taskId);
    expect(r2.channelId).toBe(r1.channelId);
    // 채널 생성은 정확히 1회.
    expect(create).toHaveBeenCalledTimes(1);
    expect(svc.taskCount).toBe(1);
  });

  it('재close는 멱등 no-op ack (에러 아님)', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const c1 = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    const c2 = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
  });

  it('R2′: 멱등 키는 워크스페이스 스코프 — 타 ws가 같은 키를 써도 남의 결과를 받지 않는다', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const a = await svc.startMission({ title: 'A', verifiedWorkspaceId: 'ws-a', memberId: 'lead', idempotencyKey: 'shared' });
    const b = await svc.startMission({ title: 'B', verifiedWorkspaceId: 'ws-b', memberId: 'lead', idempotencyKey: 'shared' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // 무스코프 전역 키였다면 b가 a의 {taskId, channelId}(private 채널 id 누출)를 받는다.
    expect(b.taskId).not.toBe(a.taskId);
    expect(b.channelId).not.toBe(a.channelId);
    expect(svc.taskCount).toBe(2);
  });

  it('R2′: close 캐시 히트가 요청 taskId와 불일치하면 미스로 취급 — authz·존재 검증 경로를 탄다', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const t1 = await svc.startMission({ title: 'T1', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    const t2 = await svc.startMission({ title: 'T2', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(t1.ok && t2.ok).toBe(true);
    if (!t1.ok || !t2.ok) return;
    const c1 = await svc.closeMission({ taskId: t1.taskId, verifiedWorkspaceId: 'ws-a', idempotencyKey: 'k' });
    expect(c1.ok).toBe(true);
    // 같은 키로 다른 태스크 close — 이전 영수증(t1) 재반환이 아니라 t2가 실제로 닫혀야 한다.
    const c2 = await svc.closeMission({ taskId: t2.taskId, verifiedWorkspaceId: 'ws-a', idempotencyKey: 'k' });
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    expect(c2.taskId).toBe(t2.taskId);
    expect(svc.getTask(t2.taskId)?.status).toBe('closed');
  });

  it('R4′: 같은 ms·같은 title 두 start도 채널명이 달라진다 (shortId = random 세그먼트)', async () => {
    const fixed = 1_700_000_000_000;
    const f = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), f.port, { now: () => fixed });
    await svc.boot();
    const r1 = await svc.startMission({ title: 'Same Title', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    const r2 = await svc.startMission({ title: 'Same Title', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(r1.ok && r2.ok).toBe(true);
    const create = f.port.create as ReturnType<typeof vi.fn>;
    const names = create.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toHaveLength(2);
    // timestamp-shortId였다면 동일명 → 실 ChannelService의 중복 거부로 자기 DoS.
    expect(names[0]).not.toBe(names[1]);
  });
});

// ═══ §3 authz (타 워크스페이스 거부 · CEO 허용) ══════════════════════════

describe('§3 close authz (owner OR CEO)', () => {
  it('타 워크스페이스 close 거부', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-owner', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-intruder' });
    expect(r.ok).toBe(false);
    // 정본 불변: 거부된 close는 태스크를 open으로 남긴다.
    expect(svc.getTask(started.taskId)?.status).toBe('open');
  });

  it('CEO는 타 워크스페이스 태스크도 close 가능', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port, { ceoWorkspaceId: 'ws-ceo' });
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-owner', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-ceo' });
    expect(r.ok).toBe(true);
    expect(svc.getTask(started.taskId)?.status).toBe('closed');
  });
});

// ═══ §3 보상 archive (append 실패) ═════════════════════════════════════

describe('§3 실패 보상 archive', () => {
  it('task.create append 실패 시 생성된 채널을 즉시 보상 archive', async () => {
    const { port, archiveCalls } = makeFakeChannelPort();
    // append를 강제 실패시키는 로그 스텁.
    const failingLog = {
      append: vi.fn(async () => false),
      readAllRecords: () => [],
    };
    const svc = newWorkTaskService(failingLog as never, port);
    await svc.boot();
    const r = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(r.ok).toBe(false);
    // 채널은 만들어졌지만(create 성공) append 실패로 보상 archive가 그 채널을 아카이브.
    expect(archiveCalls).toHaveLength(1);
    // projection에 태스크 없음(append 무커밋).
    expect(svc.taskCount).toBe(0);
  });

  it('채널 create 실패면 태스크 생성 없이 명시 에러', async () => {
    const { port } = makeFakeChannelPort({ failCreate: true });
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const r = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(r.ok).toBe(false);
    expect(svc.taskCount).toBe(0);
  });
});

// ═══ §3 양방향 reconcile (고아 채널 · closed+active) ════════════════════

describe('§3 양방향 부트 reconcile', () => {
  it('채널 방향: projection에 없는 mission-topic 고아 채널을 archive (크래시 창)', async () => {
    // 사전상태: mission-topic 앵커가 박힌 active 채널이 있으나 로그엔 task.create 없음.
    const { port, channels, archiveCalls, archiveIdentities } = makeFakeChannelPort();
    channels.set('ch-orphan', {
      id: 'ch-orphan',
      topic: missionTopicFor('wtask-ghost'),
      status: 'active',
      createdByWorkspaceId: 'ws-creator',
    });
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot(); // reconcile 채널 방향이 고아를 줍는다.
    expect(archiveCalls).toContain('ch-orphan');
    expect(channels.get('ch-orphan')?.status).toBe('archived');
    // R1′: archive 신원은 빈 값이 아니라 채널의 창설 워크스페이스 — 창설자는 항상
    // 멤버로 시드되므로 실 ChannelService의 멤버 게이트를 통과한다('' 는 전패).
    const orphanArchive = archiveIdentities.find((a) => a.channelId === 'ch-orphan');
    expect(orphanArchive?.verifiedWorkspaceId).toBe('ws-creator');
  });

  it('태스크 방향: closed 태스크의 채널이 active면 부트에서 archive 재시도', async () => {
    // 1) 정상 start+close를 실 로그에 남긴 뒤,
    const { port, channels, setStatus } = makeFakeChannelPort();
    const log = newLog();
    const svc = newWorkTaskService(log, port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    // 2) 크래시 창 시뮬레이션: 채널을 다시 active로 되돌린다(close의 archive가 유실됐다고 가정).
    setStatus(started.channelId, 'active');
    // 3) 재부트: 태스크 방향 reconcile이 closed+active를 잡아 archive 재시도.
    const log2 = newLog();
    const svc2 = newWorkTaskService(log2, port);
    await svc2.boot();
    expect(channels.get(started.channelId)?.status).toBe('archived');
    expect(svc2.getTask(started.taskId)?.status).toBe('closed');
  });
});

// ═══ §3 외부 변이 내성 (선archive · 채널 소실) ═════════════════════════

describe('§3 close 채널 상태 무조건 내성', () => {
  it('사람이 채널을 먼저 archive해도 close 성립 (archive no-op)', async () => {
    const { port, setStatus } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // 외부 선archive.
    setStatus(started.channelId, 'archived');
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    expect(r.ok).toBe(true);
    expect(svc.getTask(started.taskId)?.status).toBe('closed');
  });

  it('채널이 reaper로 소실돼도 close 성립 (CHANNEL_NOT_FOUND no-op)', async () => {
    const { port, channels } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    channels.delete(started.channelId); // reaper 소실.
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    expect(r.ok).toBe(true);
  });
});

// ═══ §1 closed GC (7일 + archive 미확인 면제) ══════════════════════════

describe('§1 closed projection GC', () => {
  it('7일 경과 closed(채널 archived)는 projection 퇴출', async () => {
    let clock = 1_000_000;
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port, { now: () => clock });
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    // 8일 경과.
    clock += 8 * 24 * 60 * 60 * 1000;
    svc.gcClosedTasks();
    expect(svc.getTask(started.taskId)).toBeUndefined();
  });

  it('archive 미확인 closed도 GC 퇴출 — 복구는 다음 부트 replay+reconcile이 담당 (R3′)', async () => {
    let clock = 1_000_000;
    const { port, channels, setStatus } = makeFakeChannelPort();
    const log = newLog();
    const svc = newWorkTaskService(log, port, { now: () => clock });
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    // 채널을 강제로 active로 되돌려 archive 미확인 상태 조성.
    setStatus(started.channelId, 'active');
    clock += 8 * 24 * 60 * 60 * 1000;
    svc.gcClosedTasks();
    // 면제 없음: projection에서 퇴출된다(면제를 두면 owner-leave 잔여에서 영구 잔류
    // — 뷰 바운드 무산). 복구 경로가 끊기지 않음을 아래 재부트로 실증한다.
    expect(svc.getTask(started.taskId)).toBeUndefined();
    // 재부트: replay가 로그에서 태스크를 복원하고 reconcile이 archive를 재시도.
    const svc2 = newWorkTaskService(newLog(), port, { now: () => clock });
    await svc2.boot();
    expect(channels.get(started.channelId)?.status).toBe('archived');
  });
});

// ═══ §2 DoS 캡 (워크스페이스당 open 상한) ══════════════════════════════

describe('§2 open 태스크 캡', () => {
  it('list는 owner 스코프만 반환', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    await svc.startMission({ title: 'A', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    await svc.startMission({ title: 'B', verifiedWorkspaceId: 'ws-b', memberId: 'lead' });
    expect(svc.listMissions('ws-a')).toHaveLength(1);
    expect(svc.listMissions('ws-b')).toHaveLength(1);
    expect(svc.listMissions('ws-c')).toHaveLength(0);
  });
});

// ═══ §5 task.update — 단조 물질화·배타 불변식·authz·closed 거부 ══════════

describe('§5 task.mission.update (J1 물질화)', () => {
  async function startedSvc(opts?: { ceoWorkspaceId?: string }) {
    const { port, channels } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port, opts);
    await svc.boot();
    const started = await svc.startMission({
      title: 'Mat task',
      verifiedWorkspaceId: 'ws-owner',
      memberId: 'lead',
    });
    if (!started.ok) throw new Error('start failed');
    return { svc, port, channels, taskId: started.taskId };
  }

  it('물질화 필드를 커밋하고 projection에 반영한다', async () => {
    const { svc, taskId } = await startedSvc();
    const res = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-owner',
      branch: 'wtask/mat-task-abc',
      worktreePath: '/wt/abc',
      paneGroupId: 'ws-task-1',
    });
    expect(res.ok).toBe(true);
    const t = svc.getTask(taskId);
    expect(t?.branch).toBe('wtask/mat-task-abc');
    expect(t?.worktreePath).toBe('/wt/abc');
    expect(t?.paneGroupId).toBe('ws-task-1');
  });

  it('단조: 이미 설정된 필드의 덮어쓰기를 거부한다', async () => {
    const { svc, taskId } = await startedSvc();
    await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', branch: 'wtask/a' });
    const res = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-owner',
      branch: 'wtask/b',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/monotonic/);
    expect(svc.getTask(taskId)?.branch).toBe('wtask/a');
  });

  it('단조: 동일 값 재쓰기는 멱등 no-op 성공', async () => {
    const { svc, taskId } = await startedSvc();
    await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', worktreePath: '/wt/x' });
    const again = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-owner',
      worktreePath: '/wt/x',
    });
    expect(again.ok).toBe(true);
    expect(svc.getTask(taskId)?.worktreePath).toBe('/wt/x');
  });

  it('배타 불변식: 같은 canonical worktreePath를 다른 open 태스크가 못 점유', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    // 두 태스크를 같은 owner로 만들고 첫째에 경로를 심는다.
    const s1 = await svc.startMission({ title: 'T1', verifiedWorkspaceId: 'ws-o', memberId: 'l' });
    const s2 = await svc.startMission({ title: 'T2', verifiedWorkspaceId: 'ws-o', memberId: 'l' });
    if (!s1.ok || !s2.ok) throw new Error('start');
    await svc.updateMission({ taskId: s1.taskId, verifiedWorkspaceId: 'ws-o', worktreePath: '/wt/shared/' });
    // 표기만 다른 같은 경로(trailing slash·대소문자) → 거부.
    const clash = await svc.updateMission({
      taskId: s2.taskId,
      verifiedWorkspaceId: 'ws-o',
      worktreePath: '/wt/shared',
    });
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.error).toMatch(/already claimed/);
  });

  it('authz: owner/CEO 아닌 caller 거부', async () => {
    const { svc, taskId } = await startedSvc({ ceoWorkspaceId: 'ws-ceo' });
    const stranger = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-stranger',
      branch: 'wtask/x',
    });
    expect(stranger.ok).toBe(false);
    if (stranger.ok) return;
    expect(stranger.error).toMatch(/not the task owner or CEO/);
    // CEO는 통과.
    const ceo = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-ceo',
      branch: 'wtask/x',
    });
    expect(ceo.ok).toBe(true);
  });

  it('closed 태스크의 update는 거부', async () => {
    const { svc, taskId } = await startedSvc();
    await svc.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    const res = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-owner',
      branch: 'wtask/x',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/closed/);
  });

  it('물질화 필드가 재시작 replay 후 잔존한다', async () => {
    const { port } = makeFakeChannelPort();
    const log = newLog();
    const svc = newWorkTaskService(log, port);
    await svc.boot();
    const started = await svc.startMission({ title: 'M', verifiedWorkspaceId: 'ws-owner', memberId: 'l' });
    if (!started.ok) throw new Error('start');
    await svc.updateMission({
      taskId: started.taskId,
      verifiedWorkspaceId: 'ws-owner',
      branch: 'wtask/keep',
      worktreePath: '/wt/keep',
      paneGroupId: 'ws-keep',
    });
    // 재부트: 같은 로그·port 위에 서비스 재생성 + replay.
    const svc2 = newWorkTaskService(newLog(), port);
    await svc2.boot();
    const t = svc2.getTask(started.taskId);
    expect(t?.status).toBe('open');
    expect(t?.branch).toBe('wtask/keep');
    expect(t?.worktreePath).toBe('/wt/keep');
    expect(t?.paneGroupId).toBe('ws-keep');
  });
});

describe('J3 §2 prUrl — 비단조·closed 단독 허용·형식 검증', () => {
  async function started() {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const s = await svc.startMission({ title: 'PR task', verifiedWorkspaceId: 'ws-owner', memberId: 'l' });
    if (!s.ok) throw new Error('start');
    return { svc, port, taskId: s.taskId };
  }
  const PR1 = 'https://github.com/acme/repo/pull/12';
  const PR2 = 'https://github.com/acme/repo/pull/13';

  it('open 태스크에 prUrl을 커밋하고, 다른 값으로 갱신(비단조)할 수 있다', async () => {
    const { svc, taskId } = await started();
    const r1 = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR1 });
    expect(r1.ok).toBe(true);
    expect(svc.getTask(taskId)?.prUrl).toBe(PR1);
    // 비단조: 재생성 URL로 갱신 허용(물질화 필드와 달리 write-once 아님).
    const r2 = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR2 });
    expect(r2.ok).toBe(true);
    expect(svc.getTask(taskId)?.prUrl).toBe(PR2);
  });

  it('closed 태스크에 prUrl 단독 갱신은 허용, 물질화 필드 동반은 거부', async () => {
    const { svc, taskId } = await started();
    const closed = await svc.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    expect(closed.ok).toBe(true);
    // prUrl 단독 → 허용(PR은 close 후에도 생성 가능 — CX6).
    const solo = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR1 });
    expect(solo.ok).toBe(true);
    expect(svc.getTask(taskId)?.prUrl).toBe(PR1);
    // 물질화 동반 → 기존 closed 거부 유지.
    const mixed = await svc.updateMission({
      taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR2, branch: 'wtask/x',
    });
    expect(mixed.ok).toBe(false);
    // prUrl 없는 물질화 단독도 여전히 거부(기존 계약 불변).
    const mat = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', branch: 'wtask/x' });
    expect(mat.ok).toBe(false);
  });

  it('GitHub PR URL 형식이 아니면 거부한다(G5 — 임의 URL 차단)', async () => {
    const { svc, taskId } = await started();
    for (const bad of [
      'https://evil.example.com/acme/repo/pull/1',
      'http://github.com/acme/repo/pull/1',
      'https://github.com/acme/repo/issues/1',
      'javascript:alert(1)',
    ]) {
      const r = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: bad });
      expect(r.ok).toBe(false);
    }
    expect(svc.getTask(taskId)?.prUrl).toBeUndefined();
  });

  it('동일 prUrl 재쓰기는 append 없는 멱등 no-op이다', async () => {
    const { svc, taskId } = await started();
    await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR1 });
    const again = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR1 });
    expect(again.ok).toBe(true);
    expect(svc.getTask(taskId)?.prUrl).toBe(PR1);
  });

  it('authz: 타 워크스페이스는 prUrl 갱신 불가', async () => {
    const { svc, taskId } = await started();
    const r = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-intruder', prUrl: PR1 });
    expect(r.ok).toBe(false);
  });

  it('closed 태스크의 prUrl이 재부트 replay에서 복원된다', async () => {
    const { svc, port, taskId } = await started();
    await svc.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR1 });
    const svc2 = newWorkTaskService(newLog(), port);
    await svc2.boot();
    const t = svc2.getTask(taskId);
    expect(t?.status).toBe('closed');
    expect(t?.prUrl).toBe(PR1);
  });
});
