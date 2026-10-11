// Production wiring for the fan-out worker watch (fanoutWorkerWatch.ts): the
// daemon client, the pane → workspace lookup, the running dot, the launch
// probe and the worker turn ends. Kept out of deck.handler so its install
// stays one line.

import type { BrowserWindow } from 'electron';
import type { AgentLifecycleEvent } from '../../shared/events';
import { eventBus } from '../events/EventBus';
import { resolvePtyOwnerWorkspace } from '../workspace/ptyOwnership';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { getLastBroadcastAgentStatus, hasOutstandingRunningClaim } from '../ipc/handlers/metadata.handler';
import { createDaemonLaunchProbe, type LaunchProbeDaemon } from '../worktask/fanoutLaunchProbe';
import { installFanoutWorkerWatch, type FanoutWorkerWatch, type WorkerWatchDaemon } from './fanoutWorkerWatch';

export function startFanoutWorkerWatch(
  getWindow: () => BrowserWindow | null,
  getDaemonClient: () => unknown,
  hasBrain: (ownerWorkspaceId: string) => boolean,
  /** Another always-on consumer of worker turn ends (fanoutCallerStopNotify.ts). */
  onLifecycle?: (ev: AgentLifecycleEvent) => void,
): FanoutWorkerWatch {
  const probe = createDaemonLaunchProbe(() => (getDaemonClient() as LaunchProbeDaemon | null) ?? null);
  const watch = installFanoutWorkerWatch({
    getDaemonClient: () => (getDaemonClient() as WorkerWatchDaemon | null) ?? null,
    resolveWorkspace: (ptyId) => resolvePtyOwnerWorkspace(getWindow, ptyId),
    // Pane membership is structural, which the renderer pushes at once, so
    // the mirror's age (status churn) does not bound it.
    workspacePtyIds: (workspaceId) =>
      getWorkspaceMirror().getEntries()?.find((e) => e.id === workspaceId)?.ptyIds ?? null,
    isRunning: (ptyId) => getLastBroadcastAgentStatus(ptyId) === 'running' || hasOutstandingRunningClaim(ptyId),
    agentRunning: (ptyId) => probe.agentRunning(ptyId),
    hasBrain,
  });
  // Its own subscription, not the deck's: that one only runs while Moa is on.
  const offBus = eventBus.subscribe((ev) => {
    if (ev.type !== 'agent.lifecycle') return;
    watch.noteLifecycle(ev);
    onLifecycle?.(ev);
  });
  return {
    ...watch,
    dispose: () => {
      offBus();
      watch.dispose();
    },
  };
}
