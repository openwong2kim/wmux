import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import type {
  Automation,
  AutomationDraft,
  AutomationMutationResult,
  AutomationOkResult,
  AutomationPermissionMode,
  AutomationRunNowResult,
  AutomationRun,
} from '../../../shared/automation';
import { AutomationClient } from '../../automation/AutomationClient';
import { setAutomationToastLabels } from '../../automation/AutomationBridge';

const NO_DAEMON = 'daemon unavailable';
const MODES: readonly AutomationPermissionMode[] = ['approval', 'scoped', 'bypass'];

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isDraft(value: unknown): value is AutomationDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return typeof d.name === 'string'
    && !!d.trigger && typeof d.trigger === 'object'
    && !!d.action && typeof d.action === 'object';
}

/**
 * Scheduled runs — renderer ⇄ daemon `automation.*` pass-throughs. Registered
 * in both modes (like web.handler): with no daemon every read resolves empty
 * and every mutation `{ ok:false }`, so the renderer never meets a missing
 * handler across the connect/disconnect handler swap. Validation of what a
 * draft may contain lives daemon-side; this only rejects malformed shapes.
 * `automation.propose` is deliberately absent — that is the MCP path.
 */
export function registerAutomationHandlers(getClient: () => DaemonClient | null): () => void {
  const api = (): AutomationClient | null => {
    const client = getClient();
    return client && client.isConnected ? new AutomationClient(client) : null;
  };
  const refuse = (error = NO_DAEMON): { ok: false; error: string } => ({ ok: false, error });

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, async (_event, ...args: unknown[]) => fn(...(args as A))));
  };

  handle(IPC.AUTOMATION_LIST, async (): Promise<{ automations: Automation[]; available: boolean }> => {
    const a = api();
    if (!a) return { automations: [], available: false };
    try {
      return { automations: (await a.list()).automations, available: true };
    } catch {
      // Older daemon (Unknown method) — the feature is simply not there.
      return { automations: [], available: false };
    }
  });

  handle(IPC.AUTOMATION_RUNS, async (automationId?: unknown): Promise<{ runs: AutomationRun[] }> => {
    const a = api();
    if (!a) return { runs: [] };
    try {
      return { runs: await a.runs(isId(automationId) ? automationId : undefined) };
    } catch {
      return { runs: [] };
    }
  });

  handle(IPC.AUTOMATION_SNAPSHOT, async (runId: unknown): Promise<{ text: string | null }> => {
    const a = api();
    if (!a || !isId(runId)) return { text: null };
    try {
      return { text: await a.snapshot(runId) };
    } catch {
      return { text: null };
    }
  });

  handle(IPC.AUTOMATION_CREATE, async (draft: unknown): Promise<AutomationMutationResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isDraft(draft)) return refuse('invalid draft');
    return a.create({ draft });
  });

  handle(IPC.AUTOMATION_UPDATE, async (id: unknown, draft: unknown): Promise<AutomationMutationResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isId(id) || !isDraft(draft)) return refuse('invalid draft');
    return a.update({ id, draft });
  });

  handle(IPC.AUTOMATION_REMOVE, async (id: unknown): Promise<AutomationOkResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isId(id)) return refuse('invalid id');
    return a.remove({ id });
  });

  handle(IPC.AUTOMATION_SET_ENABLED, async (id: unknown, enabled: unknown): Promise<AutomationMutationResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isId(id) || typeof enabled !== 'boolean') return refuse('invalid request');
    return a.setEnabled({ id, enabled });
  });

  handle(
    IPC.AUTOMATION_GRANT,
    async (id: unknown, mode: unknown, allowedTools: unknown): Promise<AutomationMutationResult> => {
      const a = api();
      if (!a) return refuse();
      if (!isId(id) || !MODES.includes(mode as AutomationPermissionMode)) return refuse('invalid request');
      const tools = Array.isArray(allowedTools) && allowedTools.every((t) => typeof t === 'string')
        ? (allowedTools as string[])
        : undefined;
      return a.grant({ id, mode: mode as AutomationPermissionMode, ...(tools ? { allowedTools: tools } : {}) });
    },
  );

  handle(IPC.AUTOMATION_RUN_NOW, async (id: unknown, kind: unknown): Promise<AutomationRunNowResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isId(id) || (kind !== 'manual' && kind !== 'test')) return refuse('invalid request');
    return a.runNow({ id, kind });
  });

  handle(IPC.AUTOMATION_CANCEL_RUN, async (runId: unknown): Promise<AutomationOkResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isId(runId)) return refuse('invalid id');
    return a.cancelRun({ runId });
  });

  const onLabels = (_event: Electron.IpcMainEvent, input: unknown): void => {
    setAutomationToastLabels(input);
  };
  ipcMain.removeAllListeners(IPC.AUTOMATION_TOAST_LABELS);
  ipcMain.on(IPC.AUTOMATION_TOAST_LABELS, onLabels);

  return () => {
    for (const channel of [
      IPC.AUTOMATION_LIST, IPC.AUTOMATION_RUNS, IPC.AUTOMATION_SNAPSHOT, IPC.AUTOMATION_CREATE,
      IPC.AUTOMATION_UPDATE, IPC.AUTOMATION_REMOVE, IPC.AUTOMATION_SET_ENABLED, IPC.AUTOMATION_GRANT,
      IPC.AUTOMATION_RUN_NOW, IPC.AUTOMATION_CANCEL_RUN,
    ]) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.removeListener(IPC.AUTOMATION_TOAST_LABELS, onLabels);
  };
}
