import { isPhoneWorkspaceId } from '../../shared/phoneWorkspaceRequests';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { getWorkspaceSettleService } from '../workspace/settle/workspaceSettleHost';
import { createSidebarDropLog, isSidebarId, parsePhoneSidebarSnapshot, type PhoneSidebarSnapshot, type SidebarDropReporter } from '../../shared/phoneFleetSidebar';
import {
  FLEET_TICKET_DETAIL_COMMAND,
  PHONE_FLEET_TICKET_DETAILS_KEY,
  parsePhoneFleetTicketDetails,
  withoutTicketTranscript,
} from '../../shared/phoneFleetTickets';
import { getPhoneFleetTicketStore } from './PhoneFleetTicketStore';

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

/**
 * Parse the renderer's sidebar reply and fold its ticket details into main's
 * store. The details ride a key the snapshot parser does not list, so they
 * are read here, kept, and never forwarded; the forwarded tickets get the
 * workspace names main remembers for workspaces that have since closed.
 */
function takeSidebar(raw: unknown, onDrop: SidebarDropReporter): PhoneSidebarSnapshot | null {
  const sidebar = parsePhoneSidebarSnapshot(raw, onDrop);
  if (sidebar?.fleetTickets) {
    const store = getPhoneFleetTicketStore();
    const details = parsePhoneFleetTicketDetails((raw as Record<string, unknown>)[PHONE_FLEET_TICKET_DETAILS_KEY]);
    store.remember(sidebar.fleetTickets, details, Date.now());
    sidebar.fleetTickets = store.withWorkspaceNames(sidebar.fleetTickets);
  }
  return sidebar;
}

/**
 * One ticket's detail from main's store. On a miss the renderer is asked for
 * a fresh snapshot once (the phone may open a ticket before any list poll
 * since this desktop started), then the store is read again. A renderer that
 * does not answer, or cannot compute the tickets, is `unavailable` (the
 * daemon answers 503), never "not found". A real miss is remembered for a few
 * seconds, so repeated lookups of a dead id never reach the renderer.
 */
async function phoneFleetTicketDetail(payload: Record<string, unknown>, getWindow: () => BrowserWindow | null): Promise<unknown> {
  const id = payload.id;
  if (!isSidebarId(id)) return { notFound: true };
  const store = getPhoneFleetTicketStore();
  let detail = store.detail(id, Date.now());
  if (!detail) {
    if (store.recentlyMissed(id, Date.now())) return { notFound: true };
    let raw: unknown;
    try {
      raw = await sendToRenderer(getWindow, 'workspace.phoneSidebar', {}, { timeoutMs: PHONE_SIDEBAR_RENDERER_TIMEOUT_MS });
    } catch {
      return { unavailable: true };
    }
    if (!takeSidebar(raw, () => undefined)?.fleetTickets) return { unavailable: true };
    detail = store.detail(id, Date.now());
    if (!detail) store.noteMiss(id, Date.now());
  }
  return detail ? { ticket: detail } : { notFound: true };
}

/** Named workspace operations only; never forward an arbitrary phone RPC. */
export async function handlePhoneWorkspaces(command: string, payload: Record<string, unknown>, getWindow: () => BrowserWindow | null): Promise<unknown> {
  if (command === FLEET_TICKET_DETAIL_COMMAND) return phoneFleetTicketDetail(payload, getWindow);
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
    const sidebar = takeSidebar(sidebarRaw, drops.report);
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
 * go first (largest first; the phone draws that workspace flat), then Moa's
 * delegated-job list, then the pending hand-off notices (both bounded). Fleet
 * tickets, the newest field, go before all of it: their text, then the list. The pane placement (every pane
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
  // The tickets go before anything older: a phone whose reply fit before they
  // existed keeps all of it. Their text first, then the list whole — a cut
  // list would read as jobs that are not there.
  if (sidebar.fleetTickets !== undefined) {
    onDrop('budget.fleetTicketText');
    const withoutTicketText: PhoneSidebarSnapshot = { ...sidebar, fleetTickets: sidebar.fleetTickets.map(withoutTicketTranscript) };
    if (fits(withoutTicketText)) return withoutTicketText;
    onDrop('budget.fleetTickets');
    const { fleetTickets: _fleetTickets, ...withoutTickets } = sidebar;
    return fitSidebarToBudget(base, withoutTickets, budget, onDrop);
  }
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
  // Moa's delegated jobs next (bounded, and the newest field), whole: a cut
  // list would read as jobs that are not there.
  const { moaDelegations: _moaDelegations, ...withoutDelegations } = withoutLayout;
  if (withoutLayout.moaDelegations !== undefined) {
    onDrop('budget.moaDelegations');
    if (fits(withoutDelegations)) return withoutDelegations;
  }
  const withoutHandoff: PhoneSidebarSnapshot = { ...withoutDelegations, workspaces: withoutDelegations.workspaces.map(({ moaHandoff: _moaHandoff, ...row }) => row) };
  if (withoutDelegations.workspaces.some((row) => row.moaHandoff !== undefined)) {
    onDrop('budget.moaHandoff');
    if (fits(withoutHandoff)) return withoutHandoff;
  }
  onDrop('budget.panePlacement');
  const withoutPlacement: PhoneSidebarSnapshot = {
    ...withoutHandoff,
    workspaces: withoutHandoff.workspaces.map((row) => {
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
