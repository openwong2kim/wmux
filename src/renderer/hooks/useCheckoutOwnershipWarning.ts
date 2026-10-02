// ─── Warn when an agent starts in a checkout a fan-out task owns ────────────
//
// wmux cannot gate an agent typed into a shell, so the check runs on
// detection: the moment a pane reports an agent, its cwd is compared with the
// open fan-out tasks' worktrees (see shared/checkoutOwnership). A pane outside
// the owning task's workspace and its orchestrator gets one persistent warning
// per (pane, task) — "Continue here" acknowledges it, clicking the toast jumps
// to the workspace that owns the checkout.

import { useEffect } from 'react';
import { useStore } from '../stores';
import { t } from '../i18n';
import { getWorkspaceLeafPanes, type WorkspacePaneOwner } from '../../shared/paneUtils';
import { findForeignCheckoutOwner, type CheckoutOwnerTask } from '../../shared/checkoutOwnership';

export interface ForeignCheckoutAgent<T extends CheckoutOwnerTask = CheckoutOwnerTask> {
  ptyId: string;
  workspaceId: string;
  cwd: string;
  agentName: string;
  task: T;
}

/** Every agent pane currently working inside a checkout another task owns. */
export function collectForeignCheckoutAgents<T extends CheckoutOwnerTask>(
  workspaces: ReadonlyArray<WorkspacePaneOwner & { id: string }>,
  surfaceAgent: Readonly<Record<string, { name: string } | undefined>>,
  tasks: readonly T[],
  caseInsensitive: boolean,
): ForeignCheckoutAgent<T>[] {
  const out: ForeignCheckoutAgent<T>[] = [];
  if (tasks.length === 0) return out;
  for (const ws of workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      for (const surface of leaf.surfaces) {
        const agent = surface.ptyId ? surfaceAgent[surface.ptyId] : undefined;
        if (!agent || !surface.cwd) continue;
        const task = findForeignCheckoutOwner(surface.cwd, ws.id, tasks, caseInsensitive);
        if (task) out.push({ ptyId: surface.ptyId, workspaceId: ws.id, cwd: surface.cwd, agentName: agent.name, task });
      }
    }
  }
  return out;
}

export function useCheckoutOwnershipWarning(): void {
  useEffect(() => {
    const caseInsensitive = window.electronAPI?.platform === 'win32';
    // (ptyId, taskId) pairs already warned about this session.
    const warned = new Set<string>();
    let last: { workspaces: unknown; surfaceAgent: unknown; missions: unknown } | null = null;

    const check = (): void => {
      const state = useStore.getState();
      if (
        last &&
        last.workspaces === state.workspaces &&
        last.surfaceAgent === state.surfaceAgent &&
        last.missions === state.missionByPaneGroup
      ) {
        return;
      }
      last = { workspaces: state.workspaces, surfaceAgent: state.surfaceAgent, missions: state.missionByPaneGroup };
      const hits = collectForeignCheckoutAgents(
        state.workspaces,
        state.surfaceAgent,
        Object.values(state.missionByPaneGroup),
        caseInsensitive,
      );
      for (const hit of hits) {
        const key = `${hit.ptyId}|${hit.task.id}`;
        if (warned.has(key)) continue;
        warned.add(key);
        state.pushToast({
          level: 'warn',
          persist: true,
          message: t('checkout.foreignAgentToast', { agent: hit.agentName, task: hit.task.title }),
          action: { label: t('checkout.continueHere'), onClick: () => undefined },
          target: { workspaceId: hit.task.paneGroupId ?? null },
        });
      }
    };

    check();
    return useStore.subscribe(check);
  }, []);
}
