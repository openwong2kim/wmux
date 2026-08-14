// J1 fan-out IPC 핸들러(renderer → main). 프롬프트 1개 → N 격리 태스크.
//
// 렌더러 신뢰 신원(verifiedWorkspaceId)은 channelLocal.handler와 동일 trust basis
// (Electron 프로세스 경계). 이 경로의 모든 필드는 사람이 GUI 모달에 입력한 값이라
// 그대로 신뢰한다 — agentCmd·repoPath·verifiedWorkspaceId 포함. 사람의 클릭이 곧
// 인가이므로 승인 프롬프트도 없다.
//
// The pipe/MCP front door is a DIFFERENT handler (pipe/handlers/fanout.rpc.ts)
// with a deliberately narrower input contract: it never reads agentCmd,
// repoPath, verifiedWorkspaceId or memberId from the caller, and it does ask
// for approval. Both share ONE FanOutService instance, built by
// worktask/createFanOutService.ts — the §2 G1 idempotency LRU is an instance
// field, so a second instance would accept one key twice and fan out twice.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { ORCH_ROLES, sanitizeOrchRole } from '../../../shared/orchestratorRole';

/** A role name only if it is one wmux actually defines; '' otherwise. */
function asOrchRole(raw: unknown): string {
  const cleaned = sanitizeOrchRole(raw);
  return cleaned && (ORCH_ROLES as readonly string[]).includes(cleaned) ? cleaned : '';
}
import type { FanOutRequest, FanOutService } from '../../worktask/FanOutService';

export function registerFanOutHandler(service: FanOutService): () => void {
  ipcMain.removeHandler(IPC.FANOUT_START);
  ipcMain.handle(
    IPC.FANOUT_START,
    wrapHandler(IPC.FANOUT_START, async (_event: Electron.IpcMainInvokeEvent, rawReq: unknown) => {
      const req = normalizeRequest(rawReq);
      if ('error' in req) return { ok: false, error: req.error, tasks: [] };
      return service.start(req);
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.FANOUT_START);
  };
}

/** wire 방어적 파싱 — 렌더러 신뢰이나 형태는 검증한다. export=테스트 전용(리뷰 발견
 *  — titles·taskPrompts 인덱스 정렬 회귀 방지, Codex 리뷰). */
export function normalizeRequest(raw: unknown): FanOutRequest | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'fanout:start: request object required' };
  }
  const r = raw as Record<string, unknown>;
  const idempotencyKey = typeof r['idempotencyKey'] === 'string' ? r['idempotencyKey'] : '';
  const prompt = typeof r['prompt'] === 'string' ? r['prompt'] : '';
  // titles·taskPrompts는 인덱스로 정렬된 쌍이다(FanOutService.run()이 같은 인덱스로
  // 재결합). 리뷰 발견(Codex) — 예전엔 titles만 .filter()로 비문자열 항목을 압축(구멍
  // 제거)하고 taskPrompts는 .map()으로 원본 인덱스를 그대로 보존해, titles에 비문자열
  // 항목이 섞이면 압축으로 인덱스가 밀려 다른 태스크의 프롬프트가 오배달됐다
  // (예: titles=['A',null,'B'], taskPrompts=['pa','ignored','pb'] → 압축 후
  // titles=['A','B']가 taskPrompts[0,1]=['pa','ignored']와 페어링돼 B가 'pb' 대신
  // 'ignored'를 받음). 페어링 후에 필터링해 인덱스를 함께 유지한다.
  const rawTitles = Array.isArray(r['titles']) ? (r['titles'] as unknown[]) : [];
  const rawTaskPrompts = Array.isArray(r['taskPrompts']) ? (r['taskPrompts'] as unknown[]) : [];
  // roles ride the same index-aligned pairing as taskPrompts, for the same
  // reason: a non-string title must not shift another task's role onto it.
  const rawRoles = Array.isArray(r['roles']) ? (r['roles'] as unknown[]) : [];
  const pairedEntries = rawTitles
    .map((rt, k) => ({
      title: rt,
      taskPrompt: typeof rawTaskPrompts[k] === 'string' ? (rawTaskPrompts[k] as string) : '',
      // Membership-checked, not merely sanitized: the role is stamped onto pane
      // metadata and used as a lookup key into the operator's bindings, so an
      // arbitrary 64-char string reaching either would be a wider surface than
      // the wire path allows (it rejects out-of-vocabulary roles outright).
      role: asOrchRole(rawRoles[k]),
    }))
    .filter((e): e is { title: string; taskPrompt: string; role: string } => typeof e.title === 'string');
  const titles = pairedEntries.map((e) => e.title);
  const taskPrompts = Array.isArray(r['taskPrompts']) ? pairedEntries.map((e) => e.taskPrompt) : undefined;
  const roles = Array.isArray(r['roles']) ? pairedEntries.map((e) => e.role) : undefined;
  const repoPath = typeof r['repoPath'] === 'string' ? r['repoPath'] : '';
  const agentCmd = typeof r['agentCmd'] === 'string' ? r['agentCmd'] : 'claude';
  const verifiedWorkspaceId = typeof r['verifiedWorkspaceId'] === 'string' ? r['verifiedWorkspaceId'] : '';
  const memberId = typeof r['memberId'] === 'string' ? r['memberId'] : undefined;
  if (!repoPath) return { error: 'fanout:start: repoPath is required' };
  return {
    idempotencyKey,
    prompt,
    titles,
    ...(taskPrompts ? { taskPrompts } : {}),
    ...(roles ? { roles } : {}),
    repoPath,
    agentCmd,
    verifiedWorkspaceId,
    ...(memberId ? { memberId } : {}),
  };
}
