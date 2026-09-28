import type { AgentStatus } from '../../shared/types';
import type { TranscriptPage, TranscriptStatus } from '../../shared/transcript/turnEvents';

/** The bridge surface the settle reads and writes (DaemonPTYBridge). */
export interface OpenCodeIdleBridge {
  getAgentStatus(): AgentStatus;
  getLastTurnStartedAt(): number;
  noteAgentStatus(status: 'complete'): void;
}

/** A plugin-less settle: status only, no toast (main treats `internal` as a trace). */
export const OPENCODE_IDLE_SETTLE_EVENT = {
  agent: 'OpenCode',
  status: 'complete',
  message: 'Turn ended',
  source: 'detector',
  decision: 'internal',
} as const;

/**
 * #1621 — an OpenCode pane's byte silence, checked against the terminal chat
 * plugin's own phase. Without the lifecycle plugin no `agent.stop` arrives, the
 * silence is an unmarked idle, and the desktop keeps the pane `running` for its
 * whole activity window. When the plugin reports the selected session
 * `complete`, the turn has ended: settle the bridge and let `emit` fan the
 * status out. Returns true when it settled.
 *
 * `lastSettled` remembers, per pane, the transcript tail that already settled,
 * so a TUI boot (empty transcript) or a repeat idle over the same history
 * emits nothing.
 */
export async function settleOpenCodeOnIdle(
  id: string,
  /** The pane's canonical agent slug (process, hook, then screen tier). */
  agentSlug: string | undefined,
  bridge: OpenCodeIdleBridge,
  read: () => Promise<{ status: TranscriptStatus; page: TranscriptPage } | null>,
  emit: (data: typeof OPENCODE_IDLE_SETTLE_EVENT) => void,
  lastSettled: Map<string, string>,
): Promise<boolean> {
  if (agentSlug !== 'opencode' || bridge.getAgentStatus() !== 'idle') return false;
  const turnStartedAt = bridge.getLastTurnStartedAt();
  const result = await read();
  if (!result?.status.available || result.status.agentStatus !== 'complete') return false;
  const tail = result.page.events.at(-1)?.id;
  if (!tail || lastSettled.get(id) === tail) return false;
  // A new turn, or a settle from elsewhere (the lifecycle plugin's stop), during the read.
  if (bridge.getLastTurnStartedAt() !== turnStartedAt || bridge.getAgentStatus() !== 'idle') return false;
  lastSettled.set(id, tail);
  bridge.noteAgentStatus('complete');
  emit(OPENCODE_IDLE_SETTLE_EVENT);
  return true;
}
