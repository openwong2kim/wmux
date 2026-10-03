// ─── Warn when an agent starts in a checkout a fan-out task owns ────────────
//
// wmux cannot gate an agent typed into a shell, so the check runs on
// detection: while a pane's agent is live, its cwd is compared with the open
// fan-out tasks' worktrees (see shared/checkoutOwnership). An agent stamp the
// daemon has reported dead, or a shell back at its prompt, does not count —
// the stamp can outlive the agent until the next reconcile. A pane outside
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
  liveness: {
    agentAlive?: Readonly<Record<string, boolean>>;
    commandRunning?: Readonly<Record<string, boolean>>;
  } = {},
): ForeignCheckoutAgent<T>[] {
  const out: ForeignCheckoutAgent<T>[] = [];
  if (tasks.length === 0) return out;
  for (const ws of workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      for (const surface of leaf.surfaces) {
        const agent = surface.ptyId ? surfaceAgent[surface.ptyId] : undefined;
        if (!agent || !surface.cwd) continue;
        // Process truth says the agent died, or OSC 133 says the shell is back
        // at its prompt: the stamp is a leftover, not a working agent.
        if (liveness.agentAlive?.[surface.ptyId] === false) continue;
        if (liveness.commandRunning?.[surface.ptyId] === false) continue;
        const task = findForeignCheckoutOwner(surface.cwd, ws.id, tasks, caseInsensitive);
        if (task) out.push({ ptyId: surface.ptyId, workspaceId: ws.id, cwd: surface.cwd, agentName: agent.name, task });
      }
    }
  }
  return out;
}

export function useCheckoutOwnershipWarning(): void {
  useEffect(() => {
    // macOS volumes are case-insensitive by default; a case-only mismatch on a
    // case-sensitive volume would at worst raise one extra warning.
    const platform = window.electronAPI?.platform;
    const caseInsensitive = platform === 'win32' || platform === 'darwin';
    // (ptyId, taskId) pairs already warned about this session.
    const warned = new Set<string>();
    let last: { workspaces: unknown; surfaceAgent: unknown; missions: unknown; alive: unknown; running: unknown } | null = null;

    const check = (): void => {
      const state = useStore.getState();
      if (
        last &&
        last.workspaces === state.workspaces &&
        last.surfaceAgent === state.surfaceAgent &&
        last.missions === state.missionByPaneGroup &&
        last.alive === state.agentAliveByPtyId &&
        last.running === state.commandRunningByPtyId
      ) {
        return;
      }
      last = {
        workspaces: state.workspaces,
        surfaceAgent: state.surfaceAgent,
        missions: state.missionByPaneGroup,
        alive: state.agentAliveByPtyId,
        running: state.commandRunningByPtyId,
      };
      const hits = collectForeignCheckoutAgents(
        state.workspaces,
        state.surfaceAgent,
        Object.values(state.missionByPaneGroup),
        caseInsensitive,
        { agentAlive: state.agentAliveByPtyId, commandRunning: state.commandRunningByPtyId },
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
