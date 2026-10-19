// The Fleet approvals tab's Plan card (shared/planApproval.ts): Claude's
// ExitPlanMode dialogs the daemon holds as `terminal_prompt` records with a
// `plan` form, and the answer the operator gives from the card.
//
// Only the main window's own top frame is served. The answer goes through
// `daemon.approvals.answerPlan`, which the daemon serves to the first-party
// client alone and which runs the same checks as the phone's decision-v2
// answer (the form's fingerprint, the answer age, the screen re-read and the
// fences). Nothing here decides whether an answer may land: a record the
// daemon could not bind carries no form, so its card has no actions.
import { randomUUID } from 'node:crypto';
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../../shared/constants';
import type {
  PlanApprovalAnswerRequest,
  PlanApprovalAnswerResult,
  PlanApprovalView,
} from '../../../shared/planApproval';
import type { ApprovalRequest, TerminalPromptDetail } from '../../../daemon/approvals/types';
import type { DaemonClient } from '../../DaemonClient';
import { isMainWindowSender } from '../mainWindowSender';
import { wrapHandler } from '../wrapHandler';

/** A pending Claude plan dialog. */
export function isPlanRecord(r: ApprovalRequest): boolean {
  return r.state === 'pending' && r.kind === 'terminal_prompt' && r.toolName === 'ExitPlanMode' && !r.native;
}

/** The card's view of one plan record and, when the daemon serves it, the whole plan. */
export function toPlanApprovalView(record: ApprovalRequest, detail: TerminalPromptDetail | null): PlanApprovalView {
  const form = record.form?.kind === 'plan' && record.formFingerprint ? record.form : undefined;
  return {
    id: record.id,
    sessionId: record.sessionId,
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    agent: record.agent,
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.question ? { question: record.question } : {}),
    ...(detail ? { plan: detail.command, planTruncated: detail.truncated } : {}),
    actions: form ? form.actions.map((a) => ({ id: a.id, label: a.label, needsText: a.needsText === true })) : [],
    ...(form ? { formFingerprint: record.formFingerprint } : {}),
    answered: record.pressedAt !== undefined || (record.step !== undefined && record.step.status !== 'partial'),
    stopped: record.step?.status === 'partial',
    createdAt: record.createdAt,
  };
}

/** The renderer's answer, validated. Null = refuse without asking the daemon. */
export function parsePlanAnswerIpc(raw: unknown): PlanApprovalAnswerRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const { id, formFingerprint, action, text } = o;
  if (typeof id !== 'string' || !id || typeof formFingerprint !== 'string' || typeof action !== 'string' || !action) return null;
  if (text !== undefined && typeof text !== 'string') return null;
  return { id, formFingerprint, action, ...(typeof text === 'string' && text.trim() !== '' ? { text } : {}) };
}

/** The daemon's resolve result, narrowed to what the card shows. */
export function toAnswerResult(result: unknown): PlanApprovalAnswerResult {
  const r = (result && typeof result === 'object' ? result : {}) as { ok?: unknown; reason?: unknown; textRefusal?: unknown };
  if (r.ok === true) return { ok: true };
  return {
    ok: false,
    reason: typeof r.reason === 'string' ? r.reason : 'not-found',
    ...(typeof r.textRefusal === 'string' ? { textRefusal: r.textRefusal } : {}),
  };
}

export function registerPlanApprovalHandlers(
  getWindow: () => BrowserWindow | null,
  daemonClient: DaemonClient,
): () => void {
  ipcMain.removeHandler(IPC.PLAN_APPROVALS_LIST);
  ipcMain.handle(IPC.PLAN_APPROVALS_LIST, wrapHandler(IPC.PLAN_APPROVALS_LIST,
    async (e: IpcMainInvokeEvent): Promise<PlanApprovalView[]> => {
      if (!isMainWindowSender(e, getWindow()) || !daemonClient.isConnected) return [];
      const listed = (await daemonClient.rpc('daemon.approvals.list', {})) as { pending?: ApprovalRequest[] } | undefined;
      const plans = (listed?.pending ?? []).filter(isPlanRecord);
      return Promise.all(plans.map(async (record) => {
        const detail = record.form?.kind === 'plan'
          ? ((await daemonClient.rpc('daemon.approvals.detail', { id: record.id }).catch(() => null)) as TerminalPromptDetail | null)
          : null;
        return toPlanApprovalView(record, detail);
      }));
    }));

  ipcMain.removeHandler(IPC.PLAN_APPROVALS_ANSWER);
  ipcMain.handle(IPC.PLAN_APPROVALS_ANSWER, wrapHandler(IPC.PLAN_APPROVALS_ANSWER,
    async (e: IpcMainInvokeEvent, raw: unknown): Promise<PlanApprovalAnswerResult> => {
      if (!isMainWindowSender(e, getWindow())) return { ok: false, reason: 'operator-only' };
      const request = parsePlanAnswerIpc(raw);
      if (!request) return { ok: false, reason: 'invalid-choice' };
      if (!daemonClient.isConnected) return { ok: false, reason: 'daemon-unavailable' };
      const result = await daemonClient.rpc('daemon.approvals.answerPlan', {
        id: request.id,
        answer: {
          formFingerprint: request.formFingerprint,
          clientAnswerId: randomUUID(),
          action: request.action,
          ...(request.text !== undefined ? { text: request.text } : {}),
        },
      });
      return toAnswerResult(result);
    }));

  // A re-list nudge only: the card reads the list again.
  const nudge = (): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.PLAN_APPROVALS_CHANGED);
  };
  daemonClient.on('approvals:changed', nudge);
  // A (re)connected daemon may hold a different list than the card shows.
  nudge();

  return () => {
    daemonClient.off('approvals:changed', nudge);
    ipcMain.removeHandler(IPC.PLAN_APPROVALS_LIST);
    ipcMain.removeHandler(IPC.PLAN_APPROVALS_ANSWER);
  };
}
