// The production wiring of Moa's goal contract (moaGoalContract.ts) and of the
// level gate (moaLevelGate.ts): the HQ store, the workspace mirror, the
// decision store and git. deck.handler owns the lifetime.

import fs from 'node:fs';
import { MoaGoalService } from './moaGoalContract';
import { setMoaLevelGate } from './moaLevelGate';
import { getHqWorkspaceId, getMoaConfig, hqPresence, isMoaEnabled } from './deckHqStore';
import {
  clearPendingDecisionIfUnchanged,
  clearResolvedDecision,
  loadWorkspaceDecision,
  raiseDecisionIfFree,
  resolveDecision,
} from './deckDecisionStore';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { resolveRepoRoot } from './moaReadGate';
import { resolvePtyOwnerWorkspace } from '../workspace/ptyOwnership';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { isRemoteTaskId } from '../../shared/a2aRemote';

type GetWindow = Parameters<typeof resolvePtyOwnerWorkspace>[0];

export function createMoaGoalService(opts: { notify: () => void; filePath?: string }): MoaGoalService {
  return new MoaGoalService({
    hqWorkspaceId: () => getHqWorkspaceId(),
    hqLevel: () => getMoaConfig().level,
    moaReady: () => {
      const hq = getHqWorkspaceId();
      return isMoaEnabled() && hq !== null && hqPresence(hq) === 'present';
    },
    // The same vetting Moa's read roots use (a git toplevel that is not $HOME
    // or above it), realpath'd so fan-out's own re-derivation compares equal.
    vetRepo: async (p) => {
      const root = await resolveRepoRoot(p);
      if (!root) return null;
      try {
        return fs.realpathSync(root);
      } catch {
        return null;
      }
    },
    workspaceExists: (id) => (getWorkspaceMirror().getEntries() ?? []).some((e) => e.id === id),
    workspaceName: (id) => getWorkspaceMirror().getEntries()?.find((e) => e.id === id)?.name,
    decisions: {
      raiseIfFree: (id, card) => raiseDecisionIfFree(id, card),
      load: (id) => loadWorkspaceDecision(id),
      resolve: (ws, id, res) => resolveDecision(ws, id, res),
      clearResolved: (ws, id) => clearResolvedDecision(ws, id),
      clearPendingIfUnchanged: (ws, d) => clearPendingDecisionIfUnchanged(ws, d),
    },
    notify: opts.notify,
    ...(opts.filePath ? { filePath: opts.filePath } : {}),
  });
}

/** Where the level gate reads a pane's owner and an A2A task's other side. */
export interface MoaLevelGateLookups {
  getWindow?: GetWindow;
  getDaemonClient?: () => { rpc(method: string, params?: unknown): Promise<unknown> } | null;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function partyWs(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  return isRec(v) && typeof v.workspaceId === 'string' && v.workspaceId.length > 0 ? v.workspaceId : null;
}

/** The workspace on the other side of `taskId` from `hq`, read from one task
 *  query reply; null when the task or its parties are not there. Exported for tests. */
export function counterpartyFromQuery(reply: unknown, hq: string, taskId: string): string | null {
  const tasks = isRec(reply) ? reply.tasks : null;
  const list = Array.isArray(tasks) ? tasks : isRec(tasks) && Array.isArray(tasks.tasks) ? tasks.tasks : isRec(tasks) ? [tasks.task ?? tasks] : [];
  const t = list.find((x: unknown) => isRec(x) && x.id === taskId);
  if (!isRec(t)) return null;
  const meta = isRec(t.metadata) ? t.metadata : t;
  const from = partyWs(meta.from);
  const to = partyWs(meta.to);
  if (from === hq) return to;
  if (to === hq) return from;
  return null;
}

/** The member workspace ids in an `a2a.channel.getMembers` reply, or null. Exported for tests. */
export function membersFromReply(reply: unknown): string[] | null {
  if (!isRec(reply) || reply.ok !== true || !Array.isArray(reply.members)) return null;
  const ids = reply.members.map((m: unknown) => (isRec(m) && typeof m.workspaceId === 'string' ? m.workspaceId : null));
  return ids.every((x): x is string => x !== null) ? [...new Set(ids as string[])] : null;
}

/** Install the commander level gate over `goals` (null uninstalls). */
export function installMoaLevelGate(goals: MoaGoalService | null, lookups: MoaLevelGateLookups = {}): void {
  setMoaLevelGate({
    hqWorkspaceId: () => getHqWorkspaceId(),
    level: () => getMoaConfig().level,
    activeGoal: () => {
      const p = goals?.powers();
      return p && p.ok
        ? {
            goalId: p.contract.id,
            humanOnly: p.contract.humanOnly,
            scope: [...p.contract.workspaceIds, ...p.contract.taskWorkspaceIds],
          }
        : null;
    },
    ...(lookups.getWindow
      ? { ptyOwner: (ptyId: string) => resolvePtyOwnerWorkspace(lookups.getWindow as GetWindow, ptyId) }
      : {}),
    paneOwner: async (paneId: string) => {
      const win = lookups.getWindow;
      if (!win) return null;
      for (const e of getWorkspaceMirror().getEntries() ?? []) {
        const panes = await sendToRenderer(win, 'pane.list', { workspaceId: e.id, includeStashed: true }).catch(() => null);
        if (Array.isArray(panes) && panes.some((x: unknown) => isRec(x) && x.id === paneId)) return e.id;
      }
      return null;
    },
    channelMembers: async (hq: string, channelId: string) => {
      const dc = lookups.getDaemonClient?.() ?? null;
      if (!dc) return null;
      const r = await dc.rpc('a2a.channel.getMembers', { channelId, verifiedWorkspaceId: hq }).catch(() => null);
      return membersFromReply(r);
    },
    taskCounterparty: async (hq: string, taskId: string) => {
      if (isRemoteTaskId(taskId)) return null; // another PC: never inside a contract
      const q = { workspaceId: hq, view: 'page', taskId };
      const dc = lookups.getDaemonClient?.() ?? null;
      if (dc) {
        const fromDaemon = counterpartyFromQuery(await dc.rpc('a2a.task.query', q).catch(() => null), hq, taskId);
        if (fromDaemon) return fromDaemon;
      }
      if (!lookups.getWindow) return null;
      const fromRenderer = await sendToRenderer(lookups.getWindow, 'a2a.task.query', q).catch(() => null);
      return counterpartyFromQuery(fromRenderer, hq, taskId);
    },
  });
}
