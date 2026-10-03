import { isPhoneWorkspaceId } from '../../shared/phoneWorkspaceRequests';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { getWorkspaceSettleService } from '../workspace/settle/workspaceSettleHost';
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
    // Settle state is main's own (no renderer round-trip); fields are additive.
    const settle = getWorkspaceSettleService()?.snapshot().states ?? {};
    const reply: { workspaces: Array<{ id: string; name: string; sessionId: string | null; settled?: true; snoozedUntil?: number }>; sidebar?: PhoneSidebarSnapshot } = {
      workspaces: rows.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string').map(row => ({
        id: row.id, name: row.name, sessionId: typeof row.activePtyId === 'string' ? row.activePtyId : null,
        ...(settle[row.id]?.settled ? { settled: true as const } : {}),
        ...(settle[row.id]?.snoozedUntil !== undefined ? { snoozedUntil: settle[row.id].snoozedUntil } : {}),
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
 * It degrades in steps, cheapest loss first. The per-workspace layout trees
 * go first (largest first; the phone draws that workspace flat). The pane placement (every pane
 * id and every task's pane group) goes before anything the reply carried
 * before it existed, so a sidebar that fit without it still arrives whole;
 * then tab titles, then the pane rows, and only then the whole sidebar. With
 * the placement gone a nested task keeps only its workspace-level `nested`.
 * The workspace list itself is never cut.
 */
export function fitSidebarToBudget(
  base: { workspaces: unknown[] },
  sidebar: PhoneSidebarSnapshot,
  budget = PHONE_WORKSPACES_REPLY_BUDGET_BYTES,
  onDrop: SidebarDropReporter = () => undefined,
): PhoneSidebarSnapshot | null {
  const fits = (candidate: PhoneSidebarSnapshot) => Buffer.byteLength(JSON.stringify({ ...base, sidebar: candidate })) <= budget;
  if (fits(sidebar)) return sidebar;
  // The layout trees go first, largest first and one workspace at a time, so
  // the rest keep theirs. Every later step starts from a snapshot with no tree
  // at all: a tree never rides with pane rows or titles cut under it.
  const withoutLayout: PhoneSidebarSnapshot = { ...sidebar, workspaces: sidebar.workspaces.map(({ layout: _layout, ...row }) => row) };
  const layouts = sidebar.workspaces
    .filter((row) => row.layout !== undefined)
    .map((row) => ({ id: row.id, bytes: Buffer.byteLength(`,"layout":${JSON.stringify(row.layout)}`) }))
    .sort((a, b) => b.bytes - a.bytes);
  if (layouts.length > 0) {
    onDrop('budget.layout');
    const excess = Buffer.byteLength(JSON.stringify({ ...base, sidebar })) - budget;
    const dropped = new Set<string>();
    let freed = 0;
    for (const { id, bytes } of layouts.slice(0, -1)) {
      dropped.add(id);
      freed += bytes;
      if (freed < excess) continue;
      const partial: PhoneSidebarSnapshot = {
        ...sidebar,
        workspaces: sidebar.workspaces.map((row, i) => (dropped.has(row.id) ? withoutLayout.workspaces[i] : row)),
      };
      if (fits(partial)) return partial;
    }
    if (fits(withoutLayout)) return withoutLayout;
  }
  onDrop('budget.panePlacement');
  const withoutPlacement: PhoneSidebarSnapshot = {
    ...withoutLayout,
    workspaces: withoutLayout.workspaces.map((row) => {
      if (row.task?.paneGroup === undefined && row.task?.requesterPaneId === undefined) return row;
      const { paneGroup: _paneGroup, requesterPaneId: _requesterPaneId, ...task } = row.task;
      return { ...row, task };
    }),
    panes: sidebar.panes.map(({ paneId: _paneId, ...pane }) => pane),
  };
  if (fits(withoutPlacement)) return withoutPlacement;
  onDrop('budget.surfaceTitles');
  const withoutTitles: PhoneSidebarSnapshot = {
    ...withoutPlacement,
    panes: withoutPlacement.panes.map((pane) => ({
      ptyId: pane.ptyId,
      workspaceId: pane.workspaceId,
      ...(pane.paneName !== undefined ? { paneName: pane.paneName } : {}),
    })),
  };
  if (fits(withoutTitles)) return withoutTitles;
  onDrop('budget.panes');
  const withoutPanes: PhoneSidebarSnapshot = { ...withoutPlacement, panes: [] };
  if (fits(withoutPanes)) return withoutPanes;
  onDrop('budget.sidebar');
  return null;
}
