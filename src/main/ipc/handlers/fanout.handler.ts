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

import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { ORCH_ROLES, normalizeRoleBindings, sanitizeOrchRole, type OrchestratorRoleBindings } from '../../../shared/orchestratorRole';

/** A role name only if it is one wmux actually defines; '' otherwise. */
function asOrchRole(raw: unknown): string {
  const cleaned = sanitizeOrchRole(raw);
  return cleaned && (ORCH_ROLES as readonly string[]).includes(cleaned) ? cleaned : '';
}
import type { FanOutRequest, FanOutResult, FanOutService } from '../../worktask/FanOutService';
import { getFanOutGuards, launchedAuditTask, promptDigest } from '../../worktask/fanoutGuards';
import {
  loadFanoutHourlyTaskCap,
  loadFanoutLiveTaskCap,
  loadFanoutRequireApproval,
  loadFanoutTrustAgyFolders,
  loadFanoutWorkerPermissionMode,
  setFanoutHourlyTaskCap,
  setFanoutLiveTaskCap,
  setFanoutRequireApproval,
  setFanoutTrustAgyFolders,
  setFanoutWorkerPermissionMode,
} from '../../worktask/fanoutWorkerPolicy';
import { isWorkerFenceOff, setWorkerFenceOff } from '../../agents/workerFencePolicy';
import { customAgentUsers, loadFanoutPresetsReport, saveFanoutPresets } from '../../worktask/fanoutPresets';
import { loadCustomAgentsReport, saveCustomAgents } from '../../worktask/customAgents';

/** The role bindings the renderer last saved (session.json, the file `wmux role`
 *  reads too). Unreadable = none: the Settings editor checks its live ones. */
function savedRoleBindings(): OrchestratorRoleBindings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'session.json'), 'utf8')) as {
      orchestratorRoleBindings?: unknown;
    };
    return normalizeRoleBindings(raw?.orchestratorRoleBindings);
  } catch {
    return {};
  }
}

export function registerFanOutHandler(service: FanOutService): () => void {
  // The Fleet Approvals tab's "recent unattended fan-outs" list.
  ipcMain.removeHandler(IPC.FANOUT_AUDIT_RECENT);
  ipcMain.handle(
    IPC.FANOUT_AUDIT_RECENT,
    wrapHandler(IPC.FANOUT_AUDIT_RECENT, async (_event: Electron.IpcMainInvokeEvent, limit: unknown) => {
      const n = typeof limit === 'number' && Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
      return getFanOutGuards().recentAuditTail(n);
    }),
  );

  // #1481 — durable owner stamps for the sidebar's fan-out nesting.
  ipcMain.removeHandler(IPC.FANOUT_LINEAGE);
  ipcMain.handle(
    IPC.FANOUT_LINEAGE,
    wrapHandler(IPC.FANOUT_LINEAGE, async (_event: Electron.IpcMainInvokeEvent, ids: unknown) => {
      if (!Array.isArray(ids)) return {};
      const wanted = ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128).slice(0, 512);
      return getFanOutGuards().lineageFor(wanted);
    }),
  );

  // Worker permission mode (Settings → Agents). Main owns it; see
  // fanoutWorkerPolicy.ts for why it is not renderer state.
  ipcMain.removeHandler(IPC.FANOUT_WORKER_MODE_GET);
  ipcMain.handle(
    IPC.FANOUT_WORKER_MODE_GET,
    wrapHandler(IPC.FANOUT_WORKER_MODE_GET, async () => loadFanoutWorkerPermissionMode()),
  );
  ipcMain.removeHandler(IPC.FANOUT_WORKER_MODE_SET);
  ipcMain.handle(
    IPC.FANOUT_WORKER_MODE_SET,
    wrapHandler(IPC.FANOUT_WORKER_MODE_SET, async (_event: Electron.IpcMainInvokeEvent, mode: unknown) =>
      setFanoutWorkerPermissionMode(mode),
    ),
  );

  ipcMain.removeHandler(IPC.FANOUT_REQUIRE_APPROVAL_GET);
  ipcMain.handle(
    IPC.FANOUT_REQUIRE_APPROVAL_GET,
    wrapHandler(IPC.FANOUT_REQUIRE_APPROVAL_GET, async () => loadFanoutRequireApproval()),
  );
  ipcMain.removeHandler(IPC.FANOUT_REQUIRE_APPROVAL_SET);
  ipcMain.handle(
    IPC.FANOUT_REQUIRE_APPROVAL_SET,
    wrapHandler(IPC.FANOUT_REQUIRE_APPROVAL_SET, async (_event: Electron.IpcMainInvokeEvent, value: unknown) =>
      setFanoutRequireApproval(value),
    ),
  );

  // The fan-out caps (fanoutGuards.ts). Written only here, so an agent on the
  // pipe cannot raise its own brakes.
  ipcMain.removeHandler(IPC.FANOUT_LIVE_CAP_GET);
  ipcMain.handle(
    IPC.FANOUT_LIVE_CAP_GET,
    wrapHandler(IPC.FANOUT_LIVE_CAP_GET, async () => loadFanoutLiveTaskCap()),
  );
  ipcMain.removeHandler(IPC.FANOUT_LIVE_CAP_SET);
  ipcMain.handle(
    IPC.FANOUT_LIVE_CAP_SET,
    wrapHandler(IPC.FANOUT_LIVE_CAP_SET, async (_event: Electron.IpcMainInvokeEvent, value: unknown) =>
      setFanoutLiveTaskCap(value),
    ),
  );
  ipcMain.removeHandler(IPC.FANOUT_HOURLY_CAP_GET);
  ipcMain.handle(
    IPC.FANOUT_HOURLY_CAP_GET,
    wrapHandler(IPC.FANOUT_HOURLY_CAP_GET, async () => loadFanoutHourlyTaskCap()),
  );
  ipcMain.removeHandler(IPC.FANOUT_HOURLY_CAP_SET);
  ipcMain.handle(
    IPC.FANOUT_HOURLY_CAP_SET,
    wrapHandler(IPC.FANOUT_HOURLY_CAP_SET, async (_event: Electron.IpcMainInvokeEvent, value: unknown) =>
      setFanoutHourlyTaskCap(value),
    ),
  );

  // The worker fence's off switch, per workspace (workerFencePolicy.ts).
  ipcMain.removeHandler(IPC.WORKER_FENCE_OFF_GET);
  ipcMain.handle(
    IPC.WORKER_FENCE_OFF_GET,
    wrapHandler(IPC.WORKER_FENCE_OFF_GET, async (_event: Electron.IpcMainInvokeEvent, workspaceId: unknown) =>
      typeof workspaceId === 'string' && isWorkerFenceOff(workspaceId)),
  );
  ipcMain.removeHandler(IPC.WORKER_FENCE_OFF_SET);
  ipcMain.handle(
    IPC.WORKER_FENCE_OFF_SET,
    wrapHandler(IPC.WORKER_FENCE_OFF_SET, async (_event: Electron.IpcMainInvokeEvent, workspaceId: unknown, off: unknown) =>
      setWorkerFenceOff(workspaceId, off),
    ),
  );

  ipcMain.removeHandler(IPC.FANOUT_TRUST_AGY_FOLDERS_GET);
  ipcMain.handle(
    IPC.FANOUT_TRUST_AGY_FOLDERS_GET,
    wrapHandler(IPC.FANOUT_TRUST_AGY_FOLDERS_GET, async () => loadFanoutTrustAgyFolders()),
  );
  ipcMain.removeHandler(IPC.FANOUT_TRUST_AGY_FOLDERS_SET);
  ipcMain.handle(
    IPC.FANOUT_TRUST_AGY_FOLDERS_SET,
    wrapHandler(IPC.FANOUT_TRUST_AGY_FOLDERS_SET, async (_event: Electron.IpcMainInvokeEvent, value: unknown) =>
      setFanoutTrustAgyFolders(value),
    ),
  );

  // Fan-out presets (Settings → Agents). Main owns them — see fanoutPresets.ts.
  ipcMain.removeHandler(IPC.FANOUT_PRESETS_GET);
  ipcMain.handle(
    IPC.FANOUT_PRESETS_GET,
    wrapHandler(IPC.FANOUT_PRESETS_GET, async () => loadFanoutPresetsReport()),
  );
  ipcMain.removeHandler(IPC.FANOUT_PRESETS_SET);
  ipcMain.handle(
    IPC.FANOUT_PRESETS_SET,
    wrapHandler(IPC.FANOUT_PRESETS_SET, async (_event: Electron.IpcMainInvokeEvent, presets: unknown) =>
      saveFanoutPresets(presets),
    ),
  );

  // Custom agents (Settings → Roles & fan-out). Main owns them, and only this
  // Settings IPC writes them — see customAgents.ts.
  ipcMain.removeHandler(IPC.FANOUT_CUSTOM_AGENTS_GET);
  ipcMain.handle(
    IPC.FANOUT_CUSTOM_AGENTS_GET,
    wrapHandler(IPC.FANOUT_CUSTOM_AGENTS_GET, async () => loadCustomAgentsReport()),
  );
  ipcMain.removeHandler(IPC.FANOUT_CUSTOM_AGENTS_SET);
  ipcMain.handle(
    IPC.FANOUT_CUSTOM_AGENTS_SET,
    wrapHandler(IPC.FANOUT_CUSTOM_AGENTS_SET, async (_event: Electron.IpcMainInvokeEvent, agents: unknown) =>
      saveCustomAgents(agents, customAgentUsers(savedRoleBindings())),
    ),
  );

  ipcMain.removeHandler(IPC.FANOUT_START);
  ipcMain.handle(
    IPC.FANOUT_START,
    wrapHandler(IPC.FANOUT_START, async (_event: Electron.IpcMainInvokeEvent, rawReq: unknown) => {
      const req = normalizeRequest(rawReq);
      if ('error' in req) return { ok: false, error: req.error, tasks: [] };
      return startGuiFanOut(service, req);
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.FANOUT_START);
    ipcMain.removeHandler(IPC.FANOUT_AUDIT_RECENT);
    ipcMain.removeHandler(IPC.FANOUT_LINEAGE);
    ipcMain.removeHandler(IPC.FANOUT_WORKER_MODE_GET);
    ipcMain.removeHandler(IPC.FANOUT_WORKER_MODE_SET);
    ipcMain.removeHandler(IPC.FANOUT_REQUIRE_APPROVAL_GET);
    ipcMain.removeHandler(IPC.FANOUT_REQUIRE_APPROVAL_SET);
    ipcMain.removeHandler(IPC.FANOUT_LIVE_CAP_GET);
    ipcMain.removeHandler(IPC.FANOUT_LIVE_CAP_SET);
    ipcMain.removeHandler(IPC.FANOUT_HOURLY_CAP_GET);
    ipcMain.removeHandler(IPC.FANOUT_HOURLY_CAP_SET);
    ipcMain.removeHandler(IPC.FANOUT_TRUST_AGY_FOLDERS_GET);
    ipcMain.removeHandler(IPC.FANOUT_TRUST_AGY_FOLDERS_SET);
    ipcMain.removeHandler(IPC.WORKER_FENCE_OFF_GET);
    ipcMain.removeHandler(IPC.WORKER_FENCE_OFF_SET);
    ipcMain.removeHandler(IPC.FANOUT_PRESETS_GET);
    ipcMain.removeHandler(IPC.FANOUT_PRESETS_SET);
    ipcMain.removeHandler(IPC.FANOUT_CUSTOM_AGENTS_GET);
    ipcMain.removeHandler(IPC.FANOUT_CUSTOM_AGENTS_SET);
  };
}

/**
 * A fan-out a person started from the GUI (the dialog, or the quick-launch
 * composer): the click is the approval, and the audit log still records the
 * run with the same no-record-no-run rule as the wire.
 */
export async function startGuiFanOut(service: FanOutService, req: FanOutRequest): Promise<FanOutResult> {
  const guards = getFanOutGuards();
  const workerMode = loadFanoutWorkerPermissionMode();
  const base = {
    idempotencyKey: req.idempotencyKey,
    ownerWorkspaceId: req.verifiedWorkspaceId,
    callerIdentity: 'gui' as const,
    repoPath: req.repoPath,
    titles: req.titles,
    roles: req.roles ?? [],
    approvedBy: 'human' as const,
    workerPermissionMode: workerMode,
  };
  try {
    guards.appendAudit({
      ...base,
      at: Date.now(),
      roleCommands: [],
      promptSha256: req.titles.map((_t, k) =>
        promptDigest([req.prompt.trim(), (req.taskPrompts?.[k] ?? '').trim()].filter((p) => p.length > 0).join('\n\n')),
      ),
    });
  } catch (err) {
    return { ok: false, error: `fan-out audit log could not be written: ${(err as Error).message}`, tasks: [] };
  }
  const result = await service.start({ ...req, workerPermissionMode: workerMode, caller: { kind: 'gui' } });
  try {
    guards.appendAudit({
      ...base,
      at: Date.now(),
      kind: 'launched',
      roleCommands: [],
      promptSha256: [],
      launched: result.tasks.map(launchedAuditTask),
    });
  } catch (err) {
    console.warn(`[fanout] could not append the launch record: ${String(err)}`);
  }
  return result;
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
