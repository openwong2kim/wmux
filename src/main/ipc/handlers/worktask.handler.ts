// J3 태스크 수명주기 IPC 핸들러(renderer → main). channelLocal·fanout과 동일
// renderer-trusted 신원(Electron 프로세스 경계, 파이프 미노출).
//
// 4 채널:
//   task:close        — TaskCloseService(remove 성공→close 순서 역전 §1).
//   task:create-pr    — TaskPrService(gh 4중 게이트 1클릭 PR §2).
//   worktask:scan     — WorktaskScanService(디스크 정본 정리 스캔 §1).
//   worktask:refire   — 미발사 재발사(prompt.md 실존 검사 후 원래 initialCommand 재전송 §3·F2).
//
// close·createPr는 taskId만 받고 물질화 필드(branch·worktreePath·title)는 데몬
// projection(task.mission.list)에서 역참조한다 — 렌더러가 stale 필드를 실어보내
// 엉뚱한 worktree를 건드리는 표면을 없앤다(단일 정본).

import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import type { RpcMethod } from '../../../shared/rpc';
import { TaskWorktreeManager, metaDirForWorktree } from '../../worktask/TaskWorktreeManager';
import { TaskCloseService } from '../../worktask/TaskCloseService';
import { TaskPrService } from '../../worktask/TaskPrService';
import { WorktaskScanService, type ScanOpenTask } from '../../worktask/WorktaskScanService';
import { prStatusCache } from '../../metadata/PrStatusCache';
import { getWmuxHomeDir } from '../../../shared/constants';
import { sanitizePtyText } from '../../../shared/types';
import { normalizeWorktreePath } from '../../../shared/workTask';

const execFileAsync = promisify(execFile);

/** projection 태스크 최소 형태(task.mission.list 반환). */
interface ProjectionTask {
  id: string;
  title: string;
  status: 'open' | 'closed';
  branch?: string;
  worktreePath?: string;
  paneGroupId?: string;
  prUrl?: string;
}

export function registerWorktaskHandlers(getDaemonClient: () => DaemonClient | null): () => void {
  const daemonPort = {
    rpc: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const dc = getDaemonClient();
      if (!dc) throw new Error('Daemon not connected');
      return dc.rpc(method as RpcMethod, params);
    },
  };

  // 프로세스 수명 단일 인스턴스: TaskWorktreeManager는 repoHash 단위 뮤텍스 체인을
  // 유지해야 하므로(index.lock 경합 차단) 재사용한다. fan-out과는 별도 인스턴스지만
  // 크로스 인스턴스 worktree add/remove 경합은 git 자체의 index.lock이 backstop.
  const worktrees = new TaskWorktreeManager();
  const closeService = new TaskCloseService({ daemon: daemonPort, worktrees });
  const prService = new TaskPrService({ daemon: daemonPort, cache: prStatusCache });
  const scanService = new WorktaskScanService();

  // ── task:close ──────────────────────────────────────────────────────
  ipcMain.removeHandler(IPC.TASK_CLOSE);
  ipcMain.handle(
    IPC.TASK_CLOSE,
    wrapHandler(IPC.TASK_CLOSE, async (_event, raw: unknown) => {
      const { taskId, verifiedWorkspaceId, error } = parseTaskRef(raw);
      if (error) return { ok: false, taskId: '', reason: 'error' as const, error };

      const task = await resolveTask(daemonPort, taskId, verifiedWorkspaceId);
      if (!task) return { ok: false, taskId, reason: 'error' as const, error: 'task:close: 태스크를 찾을 수 없음(projection 부재)' };

      // F3 — close-only 라우팅: worktreePath 부재(미물질화 CX4) / 디스크 결측
      // (fs.existsSync false) / 본 repo 해석 불가(worktree 손상)면 remove 단계를
      // 건너뛰고 mission.close만. 이게 스캔의 disk-missing 정합화 버튼과
      // TaskCloseService 계약(remove 성공↔close 실패 크래시 재시도)을 살린다.
      if (!task.worktreePath || !fs.existsSync(task.worktreePath)) {
        return closeService.closeTask({ taskId, verifiedWorkspaceId });
      }
      const repo = await resolveRepoInfo(task.worktreePath);
      if (!repo) {
        // worktree 디렉토리는 있으나 본 repo 해석 불가 — remove가 어차피 실패하므로
        // close-only로 정합화(닫히지 않고 영영 붙잡히는 것 방지).
        return closeService.closeTask({ taskId, verifiedWorkspaceId });
      }
      return closeService.closeTask({
        taskId,
        verifiedWorkspaceId,
        repoRoot: repo.repoRoot,
        repoHash: repo.repoHash,
        worktreePath: task.worktreePath,
        metaDir: metaDirForWorktree(task.worktreePath),
      });
    }),
  );

  // ── task:create-pr ──────────────────────────────────────────────────
  ipcMain.removeHandler(IPC.TASK_CREATE_PR);
  ipcMain.handle(
    IPC.TASK_CREATE_PR,
    wrapHandler(IPC.TASK_CREATE_PR, async (_event, raw: unknown) => {
      const { taskId, verifiedWorkspaceId, error } = parseTaskRef(raw);
      if (error) return { ok: false, reason: 'error' as const, error };

      const task = await resolveTask(daemonPort, taskId, verifiedWorkspaceId);
      if (!task) return { ok: false, reason: 'error' as const, error: 'task:create-pr: 태스크를 찾을 수 없음' };
      if (!task.worktreePath || !task.branch) {
        return {
          ok: false,
          reason: 'error' as const,
          error: 'task:create-pr: 미물질화 태스크(worktree·branch 부재)는 PR을 생성할 수 없습니다',
        };
      }
      return prService.createPr({
        taskId,
        verifiedWorkspaceId,
        worktreePath: task.worktreePath,
        branch: task.branch,
        title: task.title,
      });
    }),
  );

  // ── worktask:scan ───────────────────────────────────────────────────
  ipcMain.removeHandler(IPC.WORKTASK_SCAN);
  ipcMain.handle(
    IPC.WORKTASK_SCAN,
    wrapHandler(IPC.WORKTASK_SCAN, async (_event, raw: unknown) => {
      const verifiedWorkspaceId =
        raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).verifiedWorkspaceId === 'string'
          ? ((raw as Record<string, unknown>).verifiedWorkspaceId as string)
          : '';
      if (!verifiedWorkspaceId) {
        return { ok: false, error: 'worktask:scan: verifiedWorkspaceId가 필요합니다', scannedRoot: '', entries: [] };
      }
      const tasks = await listMissions(daemonPort, verifiedWorkspaceId);
      // 정본=디스크, 보조=projection(§1 CL5). reconcile 대상 open 집합은 데몬
      // 권위 목록(요청 owner) ∪ 렌더러가 아는 전체 open(다른 부모 워크스페이스의
      // 활성 worktree가 orphan으로 오분류되는 것을 방지). taskId로 dedup.
      const byId = new Map<string, ScanOpenTask>();
      for (const t of tasks) {
        if (t.status !== 'open') continue;
        // 데몬 목록은 요청 owner 스코프라 owner = verifiedWorkspaceId(F1: close가
        // owner 스코프 authz라 엔트리에 owner를 실어 정합화 버튼이 올바른 신원을 쓰게).
        byId.set(t.id, {
          taskId: t.id,
          title: t.title,
          ownerWorkspaceId: verifiedWorkspaceId,
          ...(t.worktreePath ? { worktreePath: t.worktreePath } : {}),
        });
      }
      const known = Array.isArray((raw as Record<string, unknown>).knownOpen)
        ? ((raw as Record<string, unknown>).knownOpen as unknown[])
        : [];
      for (const k of known) {
        if (!k || typeof k !== 'object') continue;
        const kt = k as Record<string, unknown>;
        const taskId = typeof kt.taskId === 'string' ? kt.taskId : '';
        if (!taskId || byId.has(taskId)) continue;
        byId.set(taskId, {
          taskId,
          title: typeof kt.title === 'string' ? kt.title : taskId,
          // 다른 부모의 태스크는 렌더러가 실어준 owner를 그대로 쓴다(없으면 요청 owner).
          ownerWorkspaceId: typeof kt.ownerWorkspaceId === 'string' ? kt.ownerWorkspaceId : verifiedWorkspaceId,
          ...(typeof kt.worktreePath === 'string' ? { worktreePath: kt.worktreePath } : {}),
        });
      }
      const result = await scanService.scan([...byId.values()]);
      return { ok: true, ...result };
    }),
  );

  // ── worktask:refire ─────────────────────────────────────────────────
  // 미발사 재발사(§3·F2). exhausted 페인은 기동 명령이 한 번도 전달 안 됨 = 맨 셸
  // (에이전트 없음). 원문 프롬프트를 흘리면 셸이 그걸 명령으로 실행하므로, 원래
  // initialCommand(에이전트 기동 + `$(cat prompt.md)` 주입)를 정상 경로와 동일한
  // sanitizePtyText 규율로 재전송한다. prompt.md가 소실됐으면 재발사할 원본이 없어
  // 거부(F7: worktreePath는 전용 루트 하위여야 — 경로 오라클 차단).
  ipcMain.removeHandler(IPC.WORKTASK_REFIRE);
  ipcMain.handle(
    IPC.WORKTASK_REFIRE,
    wrapHandler(IPC.WORKTASK_REFIRE, async (_event, raw: unknown) => {
      const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const ptyId = typeof r.ptyId === 'string' ? r.ptyId : '';
      const worktreePath = typeof r.worktreePath === 'string' ? r.worktreePath : '';
      const initialCommand = typeof r.initialCommand === 'string' ? r.initialCommand : '';
      if (!ptyId || !worktreePath || !initialCommand) {
        return { ok: false as const, error: 'worktask:refire: ptyId·worktreePath·initialCommand가 필요합니다' };
      }
      // F7 — worktreePath가 전용 루트({wmux home}/worktrees) 하위인지 검증. 임의
      // 경로로 prompt.md 실존을 프로빙하는 오라클/탈출을 차단한다.
      if (!isUnderWorktreeRoot(worktreePath)) {
        return { ok: false as const, error: 'worktask:refire: worktreePath가 전용 루트 밖입니다' };
      }
      // prompt.md 실존 검사(initialCommand의 `$(cat …)` 대상이 소실됐으면 무의미).
      const promptPath = path.join(metaDirForWorktree(worktreePath), 'prompt.md');
      if (!fs.existsSync(promptPath)) {
        return { ok: false as const, error: '프롬프트 파일이 소실되었습니다 — 재발사할 원본이 없습니다' };
      }
      const dc = getDaemonClient();
      if (!dc) return { ok: false as const, error: 'worktask:refire: 데몬 미연결' };
      // 정상 경로(scheduleInitialCommand.write)와 동일: sanitize + CR.
      dc.writeToSession(ptyId, sanitizePtyText(initialCommand) + '\r');
      return { ok: true as const };
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.TASK_CLOSE);
    ipcMain.removeHandler(IPC.TASK_CREATE_PR);
    ipcMain.removeHandler(IPC.WORKTASK_SCAN);
    ipcMain.removeHandler(IPC.WORKTASK_REFIRE);
  };
}

/** F7 — worktreePath 정규화 후 전용 루트({wmux home}/worktrees) 하위 여부.
 *  path.resolve로 `..`를 먼저 붕괴시킨다 — normalizeWorktreePath는 구분자/대소문자만
 *  다루므로 그것만으로는 `{root}/worktrees/../../etc`가 prefix 검사를 통과한다. */
function isUnderWorktreeRoot(worktreePath: string): boolean {
  const root = normalizeWorktreePath(path.resolve(getWmuxHomeDir(), 'worktrees'));
  const p = normalizeWorktreePath(path.resolve(worktreePath));
  return p === root || p.startsWith(root + '/');
}

/** {taskId, verifiedWorkspaceId} 방어적 파싱(렌더러 신뢰이나 형태 검증). */
function parseTaskRef(raw: unknown): { taskId: string; verifiedWorkspaceId: string; error?: string } {
  if (!raw || typeof raw !== 'object') return { taskId: '', verifiedWorkspaceId: '', error: '요청 객체가 필요합니다' };
  const r = raw as Record<string, unknown>;
  const taskId = typeof r.taskId === 'string' ? r.taskId : '';
  const verifiedWorkspaceId = typeof r.verifiedWorkspaceId === 'string' ? r.verifiedWorkspaceId : '';
  if (!taskId) return { taskId, verifiedWorkspaceId, error: 'taskId가 필요합니다' };
  if (!verifiedWorkspaceId) return { taskId, verifiedWorkspaceId, error: 'verifiedWorkspaceId가 필요합니다' };
  return { taskId, verifiedWorkspaceId };
}

/** task.mission.list → 태스크 배열(형태 방어). */
async function listMissions(
  daemon: { rpc(m: string, p: Record<string, unknown>): Promise<unknown> },
  verifiedWorkspaceId: string,
): Promise<ProjectionTask[]> {
  const res = (await daemon.rpc('task.mission.list', { verifiedWorkspaceId })) as {
    ok?: boolean;
    tasks?: ProjectionTask[];
  };
  if (!res || res.ok !== true || !Array.isArray(res.tasks)) return [];
  return res.tasks;
}

/** taskId → projection 태스크(owner 스코프). 부재면 null. */
async function resolveTask(
  daemon: { rpc(m: string, p: Record<string, unknown>): Promise<unknown> },
  taskId: string,
  verifiedWorkspaceId: string,
): Promise<ProjectionTask | null> {
  const tasks = await listMissions(daemon, verifiedWorkspaceId);
  return tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * worktree 경로 → 본 repo 루트 + repoHash. diff.handler.resolveTargetRepo와 동형:
 * common-dir(`<repo>/.git`)의 상위에서 `--show-toplevel`을 실행해 본 repo 루트를
 * 얻는다(worktree cwd 직접 --show-toplevel은 worktree 자신을 반환). repoHash는
 * preflight와 동일 규칙(realpath sha256 12자)이라 뮤텍스 키가 정합.
 */
async function resolveRepoInfo(worktreePath: string): Promise<{ repoRoot: string; repoHash: string } | null> {
  try {
    // F10 — `--path-format=absolute`는 git≥2.31 전용. 실패(구식 git)하면 플래그
    // 없이 재시도해 상대/절대 혼재 출력을 worktreePath 기준으로 절대화한다.
    let commonDir: string;
    try {
      const common = await execFileAsync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktreePath, timeout: 30000, windowsHide: true },
      );
      commonDir = common.stdout.trim();
    } catch {
      const legacy = await execFileAsync(
        'git',
        ['rev-parse', '--git-common-dir'],
        { cwd: worktreePath, timeout: 30000, windowsHide: true },
      );
      const raw = legacy.stdout.trim();
      commonDir = raw ? path.resolve(worktreePath, raw) : '';
    }
    if (!commonDir) return null;
    const top = await execFileAsync(
      'git',
      ['-C', path.dirname(commonDir), 'rev-parse', '--show-toplevel'],
      { cwd: worktreePath, timeout: 30000, windowsHide: true },
    );
    const repoRoot = top.stdout.trim();
    if (!repoRoot) return null;
    let real: string;
    try {
      real = fs.realpathSync(repoRoot);
    } catch {
      real = repoRoot;
    }
    const repoHash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 12);
    return { repoRoot, repoHash };
  } catch {
    return null;
  }
}
