import { isPhoneWorkspaceId } from '../../shared/phoneWorkspaceRequests';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { createSidebarDropLog, parsePhoneSidebarSnapshot, type PhoneSidebarSnapshot, type SidebarDropReporter } from '../../shared/phoneFleetSidebar';

/** How long the list waits for the optional sidebar projection. */
const PHONE_SIDEBAR_RENDERER_TIMEOUT_MS = 1500;
/**
 * Serialized reply budget. The daemon's desktop bridge refuses a reply over
 * 128 KiB (see DesktopPhoneBridge); this leaves room for the envelope.
 */
export const PHONE_WORKSPACES_REPLY_BUDGET_BYTES = 112 * 1024;

/**
 * The last sidebar warning logged. The list is asked about once a second while
 * a phone polls, so a persistent problem is logged when it starts or changes,
 * not on every call.
 */
let lastSidebarWarning = '';
function warnSidebar(summary: string): void {
  if (summary === lastSidebarWarning) return;
  lastSidebarWarning = summary;
  if (summary) console.warn(`[phone] workspaces.list sidebar: ${summary}`);
}

/** Named workspace operations only; never forward an arbitrary phone RPC. */
export async function handlePhoneWorkspaces(command: string, payload: Record<string, unknown>, getWindow: () => BrowserWindow | null): Promise<unknown> {
  if (command === 'workspaces.list') {
    // The sidebar projection rides along, fetched in parallel and optional: a
    // failure or a slow renderer omits it and the list answers as before.
    const drops = createSidebarDropLog();
    const [rows, sidebarRaw] = await Promise.all([
      sendToRenderer(getWindow, 'workspace.list'),
      sendToRenderer(getWindow, 'workspace.phoneSidebar', {}, { timeoutMs: PHONE_SIDEBAR_RENDERER_TIMEOUT_MS }).catch((error: unknown) => {
        // A reason, never a value: whether the renderer answered at all.
        drops.report(error instanceof Error && error.message.startsWith('RPC timeout') ? 'renderer.timeout' : 'renderer.unavailable');
        return null;
      }),
    ]);
    if (!Array.isArray(rows)) throw new Error('Workspace list unavailable');
    const reply: { workspaces: Array<{ id: string; name: string; sessionId: string | null }>; sidebar?: PhoneSidebarSnapshot } = {
      workspaces: rows.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string').map(row => ({
        id: row.id, name: row.name, sessionId: typeof row.activePtyId === 'string' ? row.activePtyId : null,
      })),
    };
    const sidebar = parsePhoneSidebarSnapshot(sidebarRaw, drops.report);
    if (!sidebar && sidebarRaw !== null) drops.report('renderer.notSnapshot');
    const fitted = sidebar ? fitSidebarToBudget(reply, sidebar, PHONE_WORKSPACES_REPLY_BUDGET_BYTES, drops.report) : null;
    if (fitted) reply.sidebar = fitted;
    warnSidebar(drops.summary());
    return reply;
  }
  if (command !== 'workspaces.create') throw new Error('Unsupported workspace operation');
  if (typeof payload.requestId !== 'string' || !isPhoneWorkspaceId(`ws-phone-${payload.requestId.toLowerCase()}`) ||
      // eslint-disable-next-line no-control-regex
      typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 100 || /[\u0000-\u001f]/.test(payload.name)) throw new Error('Invalid workspace request');
  let cwd: string | undefined;
  if (payload.cwd !== undefined) {
    if (typeof payload.cwd !== 'string' || payload.cwd.length > 4096 || !path.isAbsolute(payload.cwd) || payload.cwd.includes('\0')) throw new Error('Invalid workspace directory');
    cwd = await fs.realpath(payload.cwd);
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Workspace directory is not a folder');
  }
  const result = await sendToRenderer(getWindow, 'workspace.phoneCreate', {
    id: `ws-phone-${payload.requestId.toLowerCase()}`, name: payload.name.trim(), ...(cwd ? { cwd } : {}),
  });
  if (result && typeof result === 'object' && 'error' in result &&
      ['workspace-request-closed','workspace-request-history-full'].includes(String(result.error))) return {error:result.error};
  if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string') throw new Error('Workspace creation unconfirmed');
  return result;
}

/**
 * The daemon drops a reply over its per-request byte cap without answering,
 * which would turn every list call into a timeout, so the sidebar must fit.
 * It degrades in steps, cheapest loss first: tab titles go, then pane names
 * (a pane row without either carries nothing, so the pane list empties), and
 * only then the whole sidebar. The workspace list itself is never cut.
 */
export function fitSidebarToBudget(
  base: { workspaces: unknown[] },
  sidebar: PhoneSidebarSnapshot,
  budget = PHONE_WORKSPACES_REPLY_BUDGET_BYTES,
  onDrop: SidebarDropReporter = () => undefined,
): PhoneSidebarSnapshot | null {
  const fits = (candidate: PhoneSidebarSnapshot) => Buffer.byteLength(JSON.stringify({ ...base, sidebar: candidate })) <= budget;
  if (fits(sidebar)) return sidebar;
  onDrop('budget.surfaceTitles');
  const withoutTitles: PhoneSidebarSnapshot = {
    ...sidebar,
    panes: sidebar.panes.map((pane) => ({
      ptyId: pane.ptyId,
      workspaceId: pane.workspaceId,
      ...(pane.paneName !== undefined ? { paneName: pane.paneName } : {}),
    })),
  };
  if (fits(withoutTitles)) return withoutTitles;
  onDrop('budget.panes');
  const withoutPanes: PhoneSidebarSnapshot = { ...sidebar, panes: [] };
  if (fits(withoutPanes)) return withoutPanes;
  onDrop('budget.sidebar');
  return null;
}
