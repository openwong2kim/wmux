import { BrowserWindow, dialog, ipcMain } from 'electron';
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
import { getAutomationUiLocale, setAutomationUiLocale } from '../../automation/AutomationBridge';
import { bypassConfirmCopy } from '../../automation/toastText';

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
/**
 * Native confirmation for a Bypass grant, owned by main so no renderer path
 * (editor, "Grant again", a direct IPC call) can raise a schedule to Bypass
 * without the human seeing it. Resolves true only on an explicit confirm.
 */
export type BypassConfirmFn = (win: BrowserWindow | null, automationName: string) => Promise<boolean>;

export const confirmBypassNatively: BypassConfirmFn = async (win, automationName) => {
  const copy = bypassConfirmCopy(getAutomationUiLocale(), automationName);
  const opts = {
    type: 'question' as const,
    buttons: [copy.cancel, copy.confirm],
    defaultId: 0,
    cancelId: 0,
    message: copy.message,
    detail: copy.detail,
    noLink: true,
  };
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
};

export function registerAutomationHandlers(
  getClient: () => DaemonClient | null,
  confirmBypass: BypassConfirmFn = confirmBypassNatively,
): () => void {
  const api = (): AutomationClient | null => {
    const client = getClient();
    return client && client.isConnected ? new AutomationClient(client) : null;
  };
  const refuse = (error = NO_DAEMON): { ok: false; error: string } => ({ ok: false, error });

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, async (_event, ...args: unknown[]) => fn(...(args as A))));
  };

  handle(IPC.AUTOMATION_LIST, async (): Promise<{ automations: Automation[]; available: boolean; error?: string }> => {
    const a = api();
    if (!a) return { automations: [], available: false };
    try {
      return { automations: (await a.list()).automations, available: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only an older daemon (Unknown method) means the feature is not there;
      // a timeout or a blip must not make the sidebar row vanish.
      if (message.includes('Unknown method')) return { automations: [], available: false };
      return { automations: [], available: true, error: message };
    }
  });

  handle(IPC.AUTOMATION_RUNS, async (automationId?: unknown): Promise<{ runs: AutomationRun[] }> => {
    const a = api();
    if (!a) return { runs: [] };
    try {
      // Absent = every run; present but malformed must not widen to "all".
      if (automationId !== undefined && !isId(automationId)) return { runs: [] };
      return { runs: await a.runs(automationId) };
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

  // Registered by hand: the Bypass prompt is parented to the invoking window.
  ipcMain.removeHandler(IPC.AUTOMATION_GRANT);
  ipcMain.handle(IPC.AUTOMATION_GRANT, wrapHandler(
    IPC.AUTOMATION_GRANT,
    async (
      event: Electron.IpcMainInvokeEvent,
      id: unknown,
      mode: unknown,
      allowedTools: unknown,
    ): Promise<AutomationMutationResult> => {
      const a = api();
      if (!a) return refuse();
      if (!isId(id) || !MODES.includes(mode as AutomationPermissionMode)) return refuse('invalid request');
      if (mode === 'bypass') {
        const win = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
        let name = '';
        try {
          name = (await a.list()).automations.find((x) => x.id === id)?.name ?? '';
        } catch { /* the name only labels the prompt */ }
        if (!(await confirmBypass(win, name))) return refuse('cancelled');
      }
      const tools = Array.isArray(allowedTools) && allowedTools.every((t) => typeof t === 'string')
        ? (allowedTools as string[])
        : undefined;
      return a.grant({ id, mode: mode as AutomationPermissionMode, ...(tools ? { allowedTools: tools } : {}) });
    },
  ));

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
    setAutomationUiLocale(input);
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
