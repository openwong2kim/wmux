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
import { resolveRepoRoot } from './moaReadGate';
import type { AgentStatus } from '../../shared/types';
import { HUMAN_WORKSPACE_ID } from '../../shared/channels';

type Invoke = (method: string, params: Record<string, unknown>) => Promise<unknown>;

interface PaneRow {
  id?: unknown;
  agents?: Array<{ ptyId?: unknown; surfaceId?: unknown; agentName?: unknown; agentStatus?: unknown }>;
}

/** The panes of a pane.list answer. Operator dispatch wraps it as
 *  { ok, result }; pane.rpc answers { asOfSeq, bootId, panes }. Exported for
 *  the unit test, which feeds the real envelope. */
export function paneRows(res: unknown): PaneRow[] {
  const r = res as { ok?: boolean; result?: unknown } | null;
  const body = r && typeof r === 'object' && 'result' in r ? r.result : res;
  if (Array.isArray(body)) return body as PaneRow[];
  const panes = body && typeof body === 'object' ? (body as { panes?: unknown }).panes : undefined;
  return Array.isArray(panes) ? (panes as PaneRow[]) : [];
}

/** Exported for the unit test. */
export async function resolveTarget(
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
    // Undefined when the mirror cannot tell (no fresh snapshot, pane not in
    // it): an unknown is never read as "the turn ended".
    agentBusy: (workspaceId, ptyId) => {
      const snap = getWorkspaceMirror().getFleetSnapshot(workspaceId);
      if (!snap || Date.now() - snap.ts > DEFAULT_MAX_SNAPSHOT_AGE_MS) return undefined;
      const pane = snap.panes.find((p) => p.ptyId === ptyId);
      // A permission prompt is mid-turn: the agent is still busy with it.
      return pane ? pane.agentStatus === 'running' || pane.agentStatus === 'awaiting_input' : undefined;
    },
    agentSample: (workspaceId, ptyId) => {
      const snap = getWorkspaceMirror().getFleetSnapshot(workspaceId);
      if (!snap || Date.now() - snap.ts > DEFAULT_MAX_SNAPSHOT_AGE_MS) return undefined;
      const pane = snap.panes.find((p) => p.ptyId === ptyId);
      if (!pane) return undefined;
      return {
        busy: pane.agentStatus === 'running',
        ...(pane.agentStatus === 'awaiting_input' ? { blocked: true } : {}),
        at: snap.ts,
      };
    },
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
    // A pane's cwd is what it reported (OSC 7): only a successful git
    // toplevel that is not $HOME or above it becomes a read root.
    repoRootOf: async (workspaceId, ptyId) => {
      const snap = getWorkspaceMirror().getFleetSnapshot(workspaceId);
      const cwd = snap?.panes.find((p) => p.ptyId === ptyId)?.cwd;
      return resolveRepoRoot(cwd);
    },
    taskState: async (taskId) => {
      const res = (await opts.invoke('a2a.task.query', { workspaceId: HUMAN_WORKSPACE_ID }).catch(() => null)) as
        | { ok?: boolean; result?: { tasks?: unknown } }
        | null;
      const tasks = res && res.ok !== false && Array.isArray(res.result?.tasks) ? (res.result!.tasks as Array<Record<string, unknown>>) : null;
      if (!tasks) return undefined;
      const t = tasks.find((x) => x.id === taskId);
      if (!t) return null;
      const st = (t.status as { state?: unknown } | undefined)?.state ?? t.state;
      return typeof st === 'string' ? st : undefined;
    },
    registerCheck: (key, check) => registerDeliveryCheck(key, check),
    notify: opts.notify,
  });
}
