import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService, type TransitionInput } from '../A2aTaskService';
import type { A2aTaskTransitionPayload } from '../../../shared/a2aEventlog';
import type { CompletionEvidence } from '../../../shared/types';
import type { EventEnvelope } from '../../../shared/eventlog';
import { panePrincipalId } from '../../../shared/principals';

let dir: string;
const syncOk = (): void => {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2a-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir, fsync: syncOk });
  log.open();
  return log;
}

function newService(log: AppendOnlyLog): A2aTaskService {
  return new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 } });
}

async function seedWorkingTask(svc: A2aTaskService, id = 'task-1'): Promise<string> {
  const created = await svc.createTask({
    id,
    title: 'T',
    from: { workspaceId: 'ws-sender', name: 'Sender' },
    to: { workspaceId: 'ws-receiver', name: 'Receiver' },
  });
  expect(created.ok).toBe(true);
  const working = await svc.transition({ taskId: id, to: 'working', callerWorkspaceId: 'ws-receiver' });
  expect(working.ok).toBe(true);
  return id;
}

function transitionRecords(log: AppendOnlyLog, taskId: string): A2aTaskTransitionPayload[] {
  return log
    .readAllRecords()
    .filter((r) => r.domain === 'a2a')
    .map((r) => r.payload as { kind?: string })
    .filter((p): p is A2aTaskTransitionPayload => p.kind === 'task.transition' && (p as A2aTaskTransitionPayload).taskId === taskId);
}

/** domain:'a2a' envelope(authContext 포함)을 payload.kind로 찾는다(§7 어서트용). */
function a2aEnvelope(log: AppendOnlyLog, kind: string): EventEnvelope | undefined {
  return log
    .readAllRecords()
    .filter((r) => r.domain === 'a2a')
    .find((r) => (r.payload as { kind?: string }).kind === kind);
}

// ── T-A2A 전이 게이트: VALID_TRANSITIONS 데몬측 강제 ────────────────────

describe('T-A2A VALID_TRANSITIONS 데몬 강제', () => {
  it('submitted→completed 직행 거부', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-1',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const r = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(false);
    // 거부된 전이는 로그에 append되지 않는다(정본 무오염).
    expect(transitionRecords(log, 'task-1')).toHaveLength(0);
    // projection도 submitted 그대로.
    expect(svc.getTask('task-1')?.status.state).toBe('submitted');
  });

  it('working→completed 허용', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    // 완료증거 게이트(PR-B) 활성 후 completed는 구조화 증거 필수 — 최소 컴플라이언트 증거 첨부.
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] },
    });
    expect(r.ok).toBe(true);
    expect(svc.getTask('task-1')?.status.state).toBe('completed');
  });

  it('수신자가 아닌 호출자의 전이 거부', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-sender' });
    expect(r.ok).toBe(false);
  });
});

// ── T-A2A: 전이가 데몬 로그에 도달(C12) + evidence payload 실림 ──────────

describe('T-A2A 로그 도달 + evidence 수용', () => {
  it('completed 전이가 domain:a2a envelope로 append되고 evidence를 verbatim 저장', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);

    const evidence: CompletionEvidence = {
      summary: 'built and tested',
      items: [
        { kind: 'command', status: 'passed', summary: 'unit tests', command: 'npm test' },
        { kind: 'inspection', status: 'unverified', summary: 'eyeballed output' },
      ],
    };
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence,
    });
    expect(r.ok).toBe(true);
    // 검증 등급(감사): command/passed 1건만 verified → 1(게이트 아님).
    expect(r.ok && r.verifiedItemCount).toBe(1);

    const recs = transitionRecords(log, 'task-1');
    const completed = recs.find((p) => p.to === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.evidence?.summary).toBe('built and tested');
    expect(completed?.evidence?.items).toHaveLength(2);
    expect(completed?.verifiedItemCount).toBe(1);
    // envelope 계약: domain:'a2a'로 커밋됐다.
    const a2aRecs = log.readAllRecords().filter((rec) => rec.domain === 'a2a');
    expect(a2aRecs.length).toBeGreaterThan(0);
    // projection에도 evidence가 반영.
    expect(svc.getTask('task-1')?.status.evidence?.summary).toBe('built and tested');
  });

  it('비종단 전이(working→input-required)는 evidence 없이 통과 — 게이트는 종단 전이 전용', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc); // submitted→working 자체가 evidence 없이 성공(게이트 비대상)
    const r = await svc.transition({ taskId: 'task-1', to: 'input-required', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(true); // completed/failed가 아니면 게이트 미호출
    expect(r.ok && r.verifiedItemCount).toBeUndefined();
  });

  it('malformed evidence는 렌더러 wire 가드와 동형으로 거부(위생 — 완료증거 게이트 아님)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { items: [{ kind: 'bogus' }] }, // summary 없음 + 미지 kind
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_malformed');
    // 거부된 전이는 로그·projection 무오염.
    expect(transitionRecords(log, 'task-1').find((p) => p.to === 'completed')).toBeUndefined();
    expect(svc.getTask('task-1')?.status.state).toBe('working');
  });

  it('S-C2: 페인 핀 태스크 + 페인 신원 주장 호출자는 soft-defer(렌더러 게이트로 폴백)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-pin',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-7' }, // 페인 핀
    });
    const deferred = await svc.transition({
      taskId: 'task-pin',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
      callerHasPaneIdentity: true, // senderPtyId 주장 — 해석은 렌더러 소유
    });
    expect(deferred.ok).toBe(false);
    expect(!deferred.ok && deferred.error).toContain('pane-authz deferred');
    // 헤드리스(페인 신원 없음 — ClaudeWorker)는 ws-authz로 통과(워커 전이 불변식).
    const headless = await svc.transition({
      taskId: 'task-pin',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
    });
    expect(headless.ok).toBe(true);
  });
});

// ── T-A2A authContext 서버 유도(§7 PR5) ────────────────────────────────

describe('T-A2A authContext 서버 유도(§7)', () => {
  it('pane-핀 task 전이 → principalId = panePrincipalId(to.ws, to.paneId), trustTier=semi-trusted', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-pin',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-7' },
    });
    const r = await svc.transition({ taskId: 'task-pin', to: 'working', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(true);
    const env = a2aEnvelope(log, 'task.transition');
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-receiver', 'pane-7'));
    expect(env?.authContext.verifiedWorkspaceId).toBe('ws-receiver'); // 서버핀 authz 앵커
    expect(env?.authContext.trustTier).toBe('semi-trusted');
  });

  it('ws-level task(pane 미핀) 전이 → principalId = verifiedWorkspaceId 폴백', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc); // to={ws-receiver}(paneId 없음) — working 전이가 append됨
    const env = a2aEnvelope(log, 'task.transition');
    expect(env?.authContext.principalId).toBe('ws-receiver'); // ws 폴백
    expect(env?.authContext.verifiedWorkspaceId).toBe('ws-receiver');
  });

  it('발신자가 principalId/trustTier를 주장해도 무시 — 서버 유도값 우선', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-spoof',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-9' },
    });
    // PR5에서 TransitionInput의 principalId/trustTier 오버라이드 필드는 제거됐다 —
    // 런타임에 임의 필드를 얹어도(위조 시뮬레이션) 서비스는 서버 유도값만 스탬프한다.
    const spoofed = {
      taskId: 'task-spoof',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
      principalId: 'pane:evil/spoof',
      trustTier: 'trusted',
    } as unknown as TransitionInput;
    const r = await svc.transition(spoofed);
    expect(r.ok).toBe(true);
    const env = a2aEnvelope(log, 'task.transition');
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-receiver', 'pane-9')); // 'pane:evil/spoof' 아님
    expect(env?.authContext.trustTier).toBe('semi-trusted'); // 'trusted' 아님
  });

  it('cancel(발신자) → principalId = 발신자(caller) 측 pane 좌표(수신 pane 아님)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-c',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S', paneId: 'pane-s' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-r' },
    });
    const cancel = await svc.cancelTask({ taskId: 'task-c', callerWorkspaceId: 'ws-sender' });
    expect(cancel.ok).toBe(true);
    const env = a2aEnvelope(log, 'task.cancel');
    // 취소 행위자 = 발신자 → from 측 pane 좌표(derivePrincipalId가 caller 측 선택).
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-sender', 'pane-s'));
    expect(env?.authContext.verifiedWorkspaceId).toBe('ws-sender');
  });

  it('create → principalId = 발신자(from) pane 좌표(create 행위자=sender)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-cr',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S', paneId: 'pane-s' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-r' },
    });
    const env = a2aEnvelope(log, 'task.create');
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-sender', 'pane-s'));
    expect(env?.authContext.verifiedWorkspaceId).toBe('ws-sender');
    expect(env?.authContext.trustTier).toBe('semi-trusted');
  });

  // 리뷰 3모델 합의(Codex·GLM·Claude): self-address task(from.ws===to.ws)에서는
  // workspaceId 일치로 행위자 역할을 추론할 수 없다 — role 파라미터로 명시해야 한다.
  it('self-address create → 발신자(from) pane 좌표 (역할 미구분 시 to 우선 오기 회귀가드)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-self-cr',
      title: 'T',
      from: { workspaceId: 'ws-x', name: 'S', paneId: 'pane-from' },
      to: { workspaceId: 'ws-x', name: 'R', paneId: 'pane-to' },
    });
    const env = a2aEnvelope(log, 'task.create');
    // create 행위자 = sender → from pane. to-우선 버그면 pane-to로 오기됐다.
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-x', 'pane-from'));
  });

  it('self-address cancel(발신자) → 발신자(from) pane 좌표 (수신 pane 아님)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-self-cx',
      title: 'T',
      from: { workspaceId: 'ws-x', name: 'S', paneId: 'pane-from' },
      to: { workspaceId: 'ws-x', name: 'R', paneId: 'pane-to' },
    });
    const cancel = await svc.cancelTask({ taskId: 'task-self-cx', callerWorkspaceId: 'ws-x' });
    expect(cancel.ok).toBe(true);
    const env = a2aEnvelope(log, 'task.cancel');
    // isSender·isReceiver 둘 다 참 → sender 우선(취소는 통상 발신자 행위) → from pane.
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-x', 'pane-from'));
  });
});

// ── T-A2A 멱등: 동일 키 재시도 → 로그 1건 ──────────────────────────────

describe('T-A2A 멱등', () => {
  it('동일 idempotencyKey 재시도는 append 없이 원본 결과(로그 1건)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-1',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const first = await svc.transition({ taskId: 'task-1', to: 'working', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'k1' });
    const second = await svc.transition({ taskId: 'task-1', to: 'working', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'k1' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // working 전이 레코드는 정확히 1건.
    const workingRecs = transitionRecords(log, 'task-1').filter((p) => p.to === 'working');
    expect(workingRecs).toHaveLength(1);
  });
});

// ── T-A2A 크로스-재시작: projection 복원 ───────────────────────────────

describe('T-A2A 크로스-재시작', () => {
  it('재시작 후 restoreFromLog가 태스크를 최종 상태로 복원', async () => {
    const log1 = newLog();
    const svc1 = newService(log1);
    await seedWorkingTask(svc1);
    await svc1.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'verified', summary: 'ok' }] },
    });
    log1.close();

    // 재시작: 새 로그(디스크 replay) + 새 서비스 + restoreFromLog.
    const log2 = newLog();
    const svc2 = newService(log2);
    expect(svc2.taskCount).toBe(0); // 복원 전엔 비어있음
    svc2.restoreFromLog();
    const task = svc2.getTask('task-1');
    expect(task).toBeDefined();
    expect(task?.status.state).toBe('completed');
    expect(task?.status.evidence?.summary).toBe('done');
    expect(task?.metadata.to.workspaceId).toBe('ws-receiver');
    log2.close();
  });
});

// ── T-A2A 취소 + 쿼리 ─────────────────────────────────────────────────

describe('A2aTaskService cancel + query', () => {
  it('sender가 취소 가능, 쿼리는 참여 workspace로 필터', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-1',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const cancel = await svc.cancelTask({ taskId: 'task-1', callerWorkspaceId: 'ws-sender' });
    expect(cancel.ok).toBe(true);
    expect(svc.getTask('task-1')?.status.state).toBe('canceled');

    expect(svc.queryTasks('ws-sender')).toHaveLength(1);
    expect(svc.queryTasks('ws-receiver')).toHaveLength(1);
    expect(svc.queryTasks('ws-other')).toHaveLength(0);
    expect(svc.queryTasks('ws-sender', { role: 'agent' })).toHaveLength(0); // sender는 user role
  });
});

// ── 패널 수정: GC(A) · teardown force-fail(B) · 멱등 재시드(E) · idempotent cancel(G) ──

function newServiceAt(log: AppendOnlyLog, now: () => number): A2aTaskService {
  return new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 }, now });
}

describe('A(패널) projection GC', () => {
  it('30분 경과 종단 태스크는 gcTerminalTasks가 제거, 미경과·비종단은 유지', async () => {
    const t0 = 1_700_000_000_000;
    let clock = t0;
    const log = newLog();
    const svc = newServiceAt(log, () => clock);
    await svc.createTask({ id: 'done-1', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    await svc.transition({ taskId: 'done-1', to: 'working', callerWorkspaceId: 'ws-r' });
    await svc.transition({ taskId: 'done-1', to: 'completed', callerWorkspaceId: 'ws-r', evidence: { summary: 'ok', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] } });
    await svc.createTask({ id: 'live-1', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    await svc.transition({ taskId: 'live-1', to: 'working', callerWorkspaceId: 'ws-r' });

    clock = t0 + 31 * 60 * 1000; // 31분 경과
    svc.gcTerminalTasks();
    expect(svc.getTask('done-1')).toBeUndefined(); // 종단·경과 → 제거
    expect(svc.getTask('live-1')?.status.state).toBe('working'); // 비종단 → 유지
    log.close();
  });

  it('restoreFromLog가 부트 직후 GC를 적용 — 오래된 종단 태스크를 부활시키지 않는다', async () => {
    const t0 = 1_700_000_000_000;
    const log1 = newLog();
    const svc1 = newServiceAt(log1, () => t0);
    await svc1.createTask({ id: 'old-done', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    await svc1.transition({ taskId: 'old-done', to: 'working', callerWorkspaceId: 'ws-r' });
    await svc1.transition({ taskId: 'old-done', to: 'completed', callerWorkspaceId: 'ws-r', evidence: { summary: 'ok', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] } });
    log1.close();

    // 재시작이 31분 뒤라면: 로그는 영구지만 부트 GC가 오래된 종단분을 즉시 정리.
    const log2 = newLog();
    const svc2 = newServiceAt(log2, () => t0 + 31 * 60 * 1000);
    svc2.restoreFromLog();
    expect(svc2.getTask('old-done')).toBeUndefined(); // 부활 없음
    expect(svc2.taskCount).toBe(0);
    log2.close();
  });
});

describe('B(패널) teardown force-fail 진입점', () => {
  it('workspace 제거 시 non-terminal 수신 태스크를 forced 마커로 failed 커밋 + 재시작 생존', async () => {
    const log = newLog();
    const svc = newService(log);
    // ws-gone으로 향한 submitted + working, 그리고 무관한 ws-keep 태스크.
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    await svc.createTask({ id: 'wrk', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    await svc.transition({ taskId: 'wrk', to: 'working', callerWorkspaceId: 'ws-gone' });
    await svc.createTask({ id: 'keep', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-keep', name: 'K' } });

    const n = await svc.failTasksForWorkspaceRemoved('ws-gone', 'gone');
    expect(n).toBe(2); // submitted + working 둘 다(그래프 우회)
    expect(svc.getTask('sub')?.status.state).toBe('failed');
    expect(svc.getTask('wrk')?.status.state).toBe('failed');
    expect(svc.getTask('keep')?.status.state).toBe('submitted'); // 무관 ws 불간섭

    // 로그에 forced 마커 + 합성 evidence.
    const subRec = transitionRecords(log, 'sub').find((p) => p.to === 'failed');
    expect(subRec?.forced).toBe('workspace_removed');
    expect(subRec?.evidence?.summary).toBe('gone');

    // 재시작: 정본이 failed로 복원(부활 없음 — teardown이 정본에 도달).
    log.close();
    const log2 = newLog();
    const svc2 = newService(log2);
    svc2.restoreFromLog();
    expect(svc2.getTask('sub')?.status.state).toBe('failed');
    expect(svc2.getTask('wrk')?.status.state).toBe('failed');
    log2.close();
  });

  it('일반 transition API는 submitted→failed를 여전히 거부(진입점이 그래프 완화 아님)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    const r = await svc.transition({ taskId: 'sub', to: 'failed', callerWorkspaceId: 'ws-r' });
    expect(r.ok).toBe(false);
    log.close();
  });

  it('force-fail은 멱등 — 락 대기 중 종단된 태스크는 재커밋하지 않는다(재호출 no-op)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    expect(await svc.failTasksForWorkspaceRemoved('ws-gone', 'gone')).toBe(1);
    expect(await svc.failTasksForWorkspaceRemoved('ws-gone', 'gone')).toBe(0); // 이미 종단 → 0
    log.close();
  });
});

describe('E(패널) 크로스-재시작 멱등 재시드', () => {
  it('재시작 후 같은 키 재시도 → 원본 결과(invalid transition 아님), 로그 무증가', async () => {
    const log1 = newLog();
    const svc1 = newService(log1);
    await seedWorkingTask(svc1); // submitted→working (키 없음)
    // completed를 멱등키와 함께 커밋.
    await svc1.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'kc', evidence: { summary: 'ok', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] } });
    log1.close();

    const log2 = newLog();
    const svc2 = newService(log2);
    svc2.restoreFromLog();
    const recBefore = log2.readAllRecords().length;
    // 같은 키 재시도 — 재시드가 없으면 completed→completed로 invalid transition이 된다.
    const retry = await svc2.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'kc' });
    expect(retry.ok).toBe(true); // 멱등 흡수
    expect(log2.readAllRecords().length).toBe(recBefore); // append 없음
    log2.close();
  });
});

describe('G(패널) idempotent cancel', () => {
  it('이미 종단(completed)인 태스크의 cancel은 no-op 성공(로그 무증가)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', evidence: { summary: 'ok', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] } });
    const recBefore = log.readAllRecords().length;
    const cancel = await svc.cancelTask({ taskId: 'task-1', callerWorkspaceId: 'ws-sender' });
    expect(cancel.ok).toBe(true); // reject 아님(회귀 방지)
    expect(svc.getTask('task-1')?.status.state).toBe('completed'); // 상태 불변
    expect(log.readAllRecords().length).toBe(recBefore); // append 없음
    log.close();
  });
});

describe('A 델타: 하드캡은 종단만 축출 — 활성 태스크는 정본에서 잃지 않는다', () => {
  it('캡(500) 초과가 전부 non-terminal이면 축출 0(모두 생존)', async () => {
    const log = newLog();
    const svc = newService(log);
    for (let i = 0; i < 502; i++) {
      // eslint-disable-next-line no-await-in-loop
      await svc.createTask({ id: `t-${i}`, title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    }
    expect(svc.taskCount).toBe(502);
    svc.gcTerminalTasks(); // 종단 후보 0 → 하드캡이 활성을 지우지 않는다
    expect(svc.taskCount).toBe(502); // 정본 무결(활성 보존)
    log.close();
  });
});

// ── §6.M PR-B: 완료증거 게이트 활성(게이트=구조, verified=등급) ──────────────

describe('PR-B 완료증거 게이트', () => {
  it('T-gate-missing ★수용기준: evidence 없이 completed → completion_evidence_missing 거부, 상태·로그 불변', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const recBefore = log.readAllRecords().length;
    const r = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_missing');
    // projection working 유지(전이 미적용).
    expect(svc.getTask('task-1')?.status.state).toBe('working');
    // completed 전이 레코드 append 없음(정본 무오염).
    expect(transitionRecords(log, 'task-1').find((p) => p.to === 'completed')).toBeUndefined();
    expect(log.readAllRecords().length).toBe(recBefore);
  });

  it('completed + well-formed(command/passed 포함) → ok + verifiedItemCount + status.evidence 저장', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: {
        summary: 'built + tested',
        items: [
          { kind: 'command', status: 'passed', summary: 'unit', command: 'npm test' },
          { kind: 'inspection', status: 'unverified', summary: 'eyeballed' },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.verifiedItemCount).toBe(1); // command/passed 1건만 verified(등급)
    expect(svc.getTask('task-1')?.status.evidence?.summary).toBe('built + tested');
  });

  it('completed + unverified-only 아이템 → ok + verifiedItemCount=0 (E9 등급 — 세탁 불가)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'unverified', summary: 'self-reported' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.verifiedItemCount).toBe(0); // 정직 표기: 완료됐으나 미검증
  });

  it('completed + 빈 items → completion_evidence_no_items 거부', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'x', items: [] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_no_items');
    expect(svc.getTask('task-1')?.status.state).toBe('working');
  });

  it('completed + 공백 summary → completion_evidence_empty_summary 거부', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: '   ', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_empty_summary');
  });

  it('completed + shape는 맞지만 빈 command 아이템 → completion_evidence_invalid_item (게이트가 잡음)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    // command 아이템의 shape(kind/status/command:string)는 normalize를 통과하나
    // command가 빈 문자열이라 well-formed가 아니다 → 게이트가 invalid_item으로 거부.
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'x', items: [{ kind: 'command', status: 'passed', summary: 'ok', command: '' }] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_invalid_item');
  });

  it('failed + evidence 없음 → failure_reason_missing 거부', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({ taskId: 'task-1', to: 'failed', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('failure_reason_missing');
    expect(svc.getTask('task-1')?.status.state).toBe('working');
  });

  it('failed + 사유 summary만(items 없음) → ok (비대칭 E3)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'failed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'build broke', items: [] },
    });
    expect(r.ok).toBe(true);
    expect(svc.getTask('task-1')?.status.state).toBe('failed');
    expect(r.ok && r.verifiedItemCount).toBe(0);
  });

  it('failed + malformed 아이템(미지 kind) → completion_evidence_malformed (normalize 단계에서 사멸)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    // 미지 kind는 normalizeCompletionEvidenceWire가 먼저 거부한다(X8 형태 위생) —
    // 게이트의 completion_evidence_invalid_item에 도달하기 전에 malformed로 사멸.
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'failed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'reason', items: [{ kind: 'bogus', status: 'passed', summary: 'x' }] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_malformed');
    expect(svc.getTask('task-1')?.status.state).toBe('working');
  });

  it('게이트 거부는 멱등 캐시에 기록되지 않는다 — 같은 키로 evidence 붙여 재시도 → 성공', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    // evidence 없이 completed(같은 키) → 게이트 거부(append 전이라 멱등 미기록).
    const rejected = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'kX' });
    expect(rejected.ok).toBe(false);
    expect(svc.getTask('task-1')?.status.state).toBe('working'); // 상태 불변
    // 같은 키로 컴플라이언트 evidence 재시도 → 캐시 미스라 정상 판정 → 성공(로드맵 마이그레이션 경로).
    const ok = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      idempotencyKey: 'kX',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] },
    });
    expect(ok.ok).toBe(true);
    expect(svc.getTask('task-1')?.status.state).toBe('completed');
  });

  it('teardown force-fail은 완료증거 게이트를 우회한다 — items:[] 합성 evidence로 submitted→failed 커밋', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    // submitted→failed는 그래프상 불가하고 게이트도 별도지만, force-fail은 둘 다 우회한다.
    const n = await svc.failTasksForWorkspaceRemoved('ws-gone', 'workspace removed');
    expect(n).toBe(1);
    expect(svc.getTask('sub')?.status.state).toBe('failed');
    const rec = transitionRecords(log, 'sub').find((p) => p.to === 'failed');
    expect(rec?.forced).toBe('workspace_removed');
    expect(rec?.evidence?.items).toHaveLength(0); // 게이트 미경유(합성 evidence 그대로)
  });

  it('순서 고정(리뷰 GLM): pane-authz 거부가 게이트보다 먼저 — sibling pane + evidence 부재는 pane 에러', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-p',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-B' },
    });
    const working = await svc.transition({ taskId: 'task-p', to: 'working', callerWorkspaceId: 'ws-receiver' });
    expect(working.ok).toBe(true);
    // 일부러 evidence 없이 — 게이트가 authz 앞으로 회귀하면 completion_evidence_missing이 먼저 나온다.
    const r = await svc.transition({
      taskId: 'task-p',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      callerAddr: { paneId: 'pane-A' },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('caller pane is not the addressed receiver pane');
    expect(!r.ok && r.error).not.toContain('completion_evidence');
  });

  it('비종단 전이 + evidence(리뷰 GLM): 게이트 비대상이나 수용 + verifiedItemCount 산출은 유지', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-w',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const r = await svc.transition({
      taskId: 'task-w',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'progress', items: [{ kind: 'command', status: 'passed', summary: 'lint', command: 'npm run lint' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.verifiedItemCount).toBe(1); // else-if 분기(비종단 카운트) 회귀 가드
    expect(svc.getTask('task-w')?.status.evidence?.summary).toBe('progress');
  });

  it('순서 고정(리뷰 codex 델타): soft-defer가 게이트보다 먼저 — 실파이프 경로(callerHasPaneIdentity, callerAddr 미해석)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-sd',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-B' },
    });
    const working = await svc.transition({ taskId: 'task-sd', to: 'working', callerWorkspaceId: 'ws-receiver' });
    expect(working.ok).toBe(true);
    // 데몬 파이프 핸들러는 callerAddr를 절대 해석하지 않는다(senderPtyId → callerHasPaneIdentity만).
    // evidence 없이 — 게이트가 soft-defer 앞으로 회귀하면 completion_evidence_missing이 나와
    // 도그푸드(렌더러 폴백 pane-authz 기대)가 깨진다. 이 테스트가 그 순서를 유닛으로 고정.
    const r = await svc.transition({
      taskId: 'task-sd',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      callerHasPaneIdentity: true,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('pane-authz deferred');
    expect(!r.ok && r.error).not.toContain('completion_evidence');
  });

  it('멱등 히트는 authz 뒤(리뷰 codex 델타): 키를 아는 비참여자가 커밋 스냅샷을 재생 조회할 수 없다', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const ok = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      idempotencyKey: 'kR',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] },
    });
    expect(ok.ok).toBe(true);
    // 제3 워크스페이스가 (taskId, key)를 알아도 캐시 재생 대신 authz 거부를 받는다.
    const intruder = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-intruder',
      idempotencyKey: 'kR',
    });
    expect(intruder.ok).toBe(false);
    expect(!intruder.ok && intruder.error).toContain('is not the receiver');
  });

  it('멱등 op 네임스페이스(리뷰 codex 델타): cancel 키로 transition 결과를 재생할 수 없다', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-x',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const canceled = await svc.cancelTask({ taskId: 'task-x', callerWorkspaceId: 'ws-sender', idempotencyKey: 'kC' });
    expect(canceled.ok).toBe(true);
    // 같은 키의 transition은 CancelOk를 오반환하지 않고 정직하게 판정된다(canceled는 종단).
    const r = await svc.transition({
      taskId: 'task-x',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      idempotencyKey: 'kC',
      evidence: { summary: 'x', items: [{ kind: 'inspection', status: 'unverified', summary: 'y' }] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('invalid transition');
  });
});

// ── #1598: orphaned tasks (receiver pane gone) + receiver cancel ─────────

describe('#1598 orphaned receiver pane', () => {
  async function seedPinned(svc: A2aTaskService, id = 'task-o'): Promise<void> {
    const created = await svc.createTask({
      id,
      title: 'T',
      from: { workspaceId: 'ws-receiver', name: 'R-old' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-old' },
    });
    expect(created.ok).toBe(true);
  }
  const verified = { callerWorkspaceId: 'ws-receiver', callerAddr: { paneId: 'pane-new' }, requirePaneIdentity: true } as const;

  it('a verified pane of the receiver workspace moves a task whose pane is gone', async () => {
    const svc = newService(newLog());
    await seedPinned(svc);
    const r = await svc.transition({ taskId: 'task-o', to: 'working', ...verified, livePaneIds: ['pane-new', 'pane-other'] });
    expect(r.ok).toBe(true);
    expect(svc.getTask('task-o')?.status.state).toBe('working');
  });

  it('keeps the receiver-pane rule while the addressed pane is live', async () => {
    const svc = newService(newLog());
    await seedPinned(svc);
    const r = await svc.transition({ taskId: 'task-o', to: 'working', ...verified, livePaneIds: ['pane-new', 'pane-old'] });
    expect(!r.ok && r.error).toContain('caller pane is not the addressed receiver pane');
  });

  it('does not relax when the live pane list is unknown', async () => {
    const svc = newService(newLog());
    await seedPinned(svc);
    const r = await svc.transition({ taskId: 'task-o', to: 'working', ...verified });
    expect(!r.ok && r.error).toContain('caller pane is not the addressed receiver pane');
  });

  it('a pane of another workspace can never adopt it', async () => {
    const svc = newService(newLog());
    await seedPinned(svc);
    const r = await svc.transition({
      taskId: 'task-o', to: 'working', callerWorkspaceId: 'ws-other', callerAddr: { paneId: 'pane-x' }, livePaneIds: ['pane-x'],
    });
    expect(!r.ok && r.error).toContain('is not the receiver');
  });

  it('an unverified external caller still has to prove a pane', async () => {
    const svc = newService(newLog());
    await seedPinned(svc);
    const r = await svc.transition({
      taskId: 'task-o', to: 'working', callerWorkspaceId: 'ws-receiver', requirePaneIdentity: true, livePaneIds: [],
    });
    expect(!r.ok && r.error).toContain('no verified pane identity');
  });
});

describe('#1598 receiver cancel through transition', () => {
  it('cancels a submitted task with a reason and logs it as a transition', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({ id: 'task-c', title: 'T', from: { workspaceId: 'ws-sender', name: 'S' }, to: { workspaceId: 'ws-receiver', name: 'R' } });
    const r = await svc.transition({
      taskId: 'task-c', to: 'canceled', callerWorkspaceId: 'ws-receiver', evidence: { summary: 'superseded by task-d', items: [] },
    });
    expect(r.ok).toBe(true);
    expect(svc.getTask('task-c')?.status.state).toBe('canceled');
    expect(transitionRecords(log, 'task-c').at(-1)?.evidence?.summary).toBe('superseded by task-d');
  });

  it('refuses a cancel without a reason', async () => {
    const svc = newService(newLog());
    const id = await seedWorkingTask(svc, 'task-c2');
    const r = await svc.transition({ taskId: id, to: 'canceled', callerWorkspaceId: 'ws-receiver' });
    expect(!r.ok && r.error).toContain('cancel_reason_missing');
  });

  it('refuses a cancel by the sender and a cancel of an ended task', async () => {
    const svc = newService(newLog());
    const id = await seedWorkingTask(svc, 'task-c3');
    const bySender = await svc.transition({ taskId: id, to: 'canceled', callerWorkspaceId: 'ws-sender', evidence: { summary: 'x', items: [] } });
    expect(!bySender.ok && bySender.error).toContain('is not the receiver');
    await svc.transition({ taskId: id, to: 'failed', callerWorkspaceId: 'ws-receiver', evidence: { summary: 'broke', items: [] } });
    const late = await svc.transition({ taskId: id, to: 'canceled', callerWorkspaceId: 'ws-receiver', evidence: { summary: 'x', items: [] } });
    expect(!late.ok && late.error).toContain('invalid transition failed -> canceled');
  });
});
