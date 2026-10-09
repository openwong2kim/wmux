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

/** Install the commander level gate over `goals` (null uninstalls). */
export function installMoaLevelGate(goals: MoaGoalService | null): void {
  setMoaLevelGate({
    hqWorkspaceId: () => getHqWorkspaceId(),
    level: () => getMoaConfig().level,
    activeGoal: () => {
      const p = goals?.powers();
      return p && p.ok ? { goalId: p.contract.id, humanOnly: p.contract.humanOnly } : null;
    },
  });
}
