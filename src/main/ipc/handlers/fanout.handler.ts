// J1 fan-out IPC 핸들러(renderer → main). 프롬프트 1개 → N 격리 태스크.
//
// FanOutService(main)를 매 호출 조립한다: 데몬 RPC 포트(daemonClient) + 렌더러 spawn
// 포트(sendToRenderer('fanout.spawnWorkspace')). 렌더러 신뢰 신원(verifiedWorkspaceId)은
// channelLocal.handler와 동일 trust basis(Electron 프로세스 경계 — 파이프 미노출).
//
// 멱등(§2 G1)은 FanOutService 인스턴스가 키→결과 LRU로 관리하므로, 서비스 인스턴스는
// 프로세스 수명 동안 재사용해야 한다(핸들러 등록 시 1회 생성, 클로저로 보존).

import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import type { RpcMethod } from '../../../shared/rpc';
import { sendToRenderer } from '../../pipe/handlers/_bridge';
import { FanOutService } from '../../worktask/FanOutService';
import type { FanOutRequest } from '../../worktask/FanOutService';

type GetWindow = () => BrowserWindow | null;

/** 스폰은 몇 초 걸릴 수 있으니 렌더러 spawn 타임아웃을 넉넉히(PTY 생성 포함). */
const SPAWN_TIMEOUT_MS = 30000;

export function registerFanOutHandler(
  getDaemonClient: () => DaemonClient | null,
  getWindow: GetWindow,
): () => void {
  // 프로세스 수명 단일 인스턴스 — 멱등 LRU가 재호출 사이에 유지돼야 한다.
  const service = new FanOutService({
    daemon: {
      rpc: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        const dc = getDaemonClient();
        if (!dc) throw new Error('Daemon not connected');
        return dc.rpc(method as RpcMethod, params);
      },
    },
    renderer: {
      spawnWorkspace: async (p) => {
        const res = (await sendToRenderer(getWindow, 'fanout.spawnWorkspace', p, {
          timeoutMs: SPAWN_TIMEOUT_MS,
        })) as { workspaceId?: string; ptyId?: string; error?: string };
        if (res && typeof res.error === 'string') return { error: res.error };
        if (res && typeof res.workspaceId === 'string') {
          return { workspaceId: res.workspaceId, ...(res.ptyId ? { ptyId: res.ptyId } : {}) };
        }
        return { error: 'fanout.spawnWorkspace: renderer returned no workspaceId' };
      },
    },
  });

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
  const pairedEntries = rawTitles
    .map((rt, k) => ({
      title: rt,
      taskPrompt: typeof rawTaskPrompts[k] === 'string' ? (rawTaskPrompts[k] as string) : '',
    }))
    .filter((e): e is { title: string; taskPrompt: string } => typeof e.title === 'string');
  const titles = pairedEntries.map((e) => e.title);
  const taskPrompts = Array.isArray(r['taskPrompts']) ? pairedEntries.map((e) => e.taskPrompt) : undefined;
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
    repoPath,
    agentCmd,
    verifiedWorkspaceId,
    ...(memberId ? { memberId } : {}),
  };
}
