// The production wiring of Moa's hand-offs (moaHandoff.ts): the HQ and
// autonomy stores, the workspace mirror, the decision store, the work links,
// the operator RPC lane and main's delivery checks. deck.handler owns the
// lifetime.

import type { BrowserWindow } from 'electron';
import { MoaHandoffService, type HandoffRecord, type ResolvedTarget } from './moaHandoff';
import { getHqWorkspaceId, getMoaConfig, hqPresence, isMoaEnabled } from './deckHqStore';
import { loadWorkspaceMode } from './deckAutonomyStore';
import { loadLiveDeckWork } from './deckWorkStore';
import {
  clearPendingDecisionIfUnchanged,
  clearResolvedDecision,
  loadWorkspaceDecision,
  raiseDecisionIfFree,
  resolveDecision,
} from './deckDecisionStore';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { resolvePtyOwnerWorkspace } from '../workspace/ptyOwnership';
import { getWorkLinkStore } from '../workLink/workLinkStore';
import { deliverOperatorTask, releaseUndelivered } from '../git/handoff';
import { registerDeliveryCheck } from '../pipe/deliveryGuards';
import { DEFAULT_MAX_SNAPSHOT_AGE_MS } from './stopGate';
import type { AgentStatus } from '../../shared/types';

type Invoke = (method: string, params: Record<string, unknown>) => Promise<unknown>;

interface PaneRow {
  id?: unknown;
  agents?: Array<{ ptyId?: unknown; surfaceId?: unknown; agentName?: unknown; agentStatus?: unknown }>;
}

/** A pane.list answer (operator dispatch: { ok, result }, or the bare list). */
function paneRows(res: unknown): PaneRow[] {
  const r = res as { ok?: boolean; result?: unknown } | null;
  const list = r && typeof r === 'object' && 'result' in r ? r.result : res;
  return Array.isArray(list) ? (list as PaneRow[]) : [];
}

async function resolveTarget(
  invoke: Invoke,
  getWindow: () => BrowserWindow | null,
  sel: { ptyId?: string; paneId?: string },
): Promise<ResolvedTarget | null> {
  const entries = getWorkspaceMirror().getEntries() ?? [];
  const candidates = sel.ptyId
    ? [await resolvePtyOwnerWorkspace(getWindow, sel.ptyId).catch(() => null)].filter((w): w is string => !!w)
    : entries.map((e) => e.id);
  for (const workspaceId of candidates) {
    const rows = paneRows(await invoke('pane.list', { workspaceId }).catch(() => null));
    for (const row of rows) {
      if (typeof row.id !== 'string') continue;
      const agents = (row.agents ?? []).filter((a) => typeof a.ptyId === 'string');
      const hit = sel.ptyId
        ? agents.find((a) => a.ptyId === sel.ptyId)
        : row.id === sel.paneId
          ? agents.length === 1 ? agents[0] : undefined
          : undefined;
      if (!hit) continue;
      return {
        workspaceId,
        paneId: row.id,
        ptyId: hit.ptyId as string,
        ...(typeof hit.surfaceId === 'string' ? { surfaceId: hit.surfaceId } : {}),
        agentName: typeof hit.agentName === 'string' && hit.agentName ? hit.agentName : null,
        agentStatus: typeof hit.agentStatus === 'string' ? (hit.agentStatus as AgentStatus) : null,
      };
    }
  }
  return null;
}

export function createMoaHandoffService(opts: {
  invoke: Invoke;
  getWindow: () => BrowserWindow | null;
  notify: () => void;
  /** The HQ's latest turn was started by the operator (not a wake). */
  operatorTurn?: (hqWorkspaceId: string) => boolean;
  onOperatorCancel?: (r: HandoffRecord) => void;
}): MoaHandoffService {
  const links = getWorkLinkStore();
  const linkDeps = {
    invoke: opts.invoke,
    links: {
      list: (f: Parameters<typeof links.list>[0]) => links.list(f),
      upsert: (i: Parameters<typeof links.upsert>[0]) => links.upsert(i),
      setState: (id: string, st: Parameters<typeof links.setState>[1], why?: Parameters<typeof links.setState>[2]) => links.setState(id, st, why),
    },
    startFanOut: () => Promise.reject(new Error('not used')),
  };
  return new MoaHandoffService({
    hqWorkspaceId: () => getHqWorkspaceId(),
    moaReady: () => {
      const hq = getHqWorkspaceId();
      return isMoaEnabled() && hq !== null && hqPresence(hq) === 'present';
    },
    modeOf: (id) => loadWorkspaceMode(id),
    autoHandoffEnabled: () => getMoaConfig().autoHandoff !== false,
    hqServesOperatorRequest: () => {
      const hq = getHqWorkspaceId();
      return hq !== null && loadLiveDeckWork(hq) !== null && opts.operatorTurn?.(hq) === true;
    },
    workspaceExists: (id) => (getWorkspaceMirror().getEntries() ?? []).some((e) => e.id === id),
    workspaceName: (id) => getWorkspaceMirror().getEntries()?.find((e) => e.id === id)?.name,
    resolveTarget: (sel) => resolveTarget(opts.invoke, opts.getWindow, sel),
    paneState: (workspaceId, ptyId) => {
      const snap = getWorkspaceMirror().getFleetSnapshot(workspaceId);
      if (!snap || Date.now() - snap.ts > DEFAULT_MAX_SNAPSHOT_AGE_MS) return 'unknown';
      const pane = snap.panes.find((p) => p.ptyId === ptyId);
      if (!pane) return 'gone';
      return pane.isAgent === false ? 'shell' : 'agent';
    },
    agentBusy: (workspaceId, ptyId) =>
      getWorkspaceMirror().getFleetSnapshot(workspaceId)?.panes.find((p) => p.ptyId === ptyId)?.agentStatus === 'running',
    ...(opts.onOperatorCancel ? { onOperatorCancel: opts.onOperatorCancel } : {}),
    decisions: {
      raiseIfFree: (id, card) => raiseDecisionIfFree(id, card),
      load: (id) => loadWorkspaceDecision(id),
      resolve: (ws, id, res) => resolveDecision(ws, id, res),
      clearResolved: (ws, id) => clearResolvedDecision(ws, id),
      clearPendingIfUnchanged: (ws, d) => clearPendingDecisionIfUnchanged(ws, d),
    },
    links: {
      upsert: (i) => links.upsert(i),
      setState: (id, st, why) => links.setState(id, st, why),
      setLastQuestion: async (id, q) => {
        await links.upsert({ id, lastQuestion: q });
      },
    },
    invoke: opts.invoke,
    deliver: (args) => deliverOperatorTask(opts.invoke, args),
    release: (linkId, taskId) => releaseUndelivered(linkDeps, linkId, taskId),
    registerCheck: (key, check) => registerDeliveryCheck(key, check),
    notify: opts.notify,
  });
}
