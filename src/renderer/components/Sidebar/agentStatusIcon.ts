import type { AgentStatus } from '../../../shared/types';

// Shared mapping from agent status → visual indicator. Used by WorkspaceItem
// (full sidebar) and MiniSidebar so they stay in lockstep when statuses change.
export const AGENT_STATUS_ICON: Record<AgentStatus, { dot: string; className: string; labelKey: string }> = {
  running:  { dot: '●', className: 'text-[var(--accent-blue)]', labelKey: 'workspace.agentRunning' },
  complete: { dot: '●', className: 'text-[var(--accent-green)]', labelKey: 'workspace.agentComplete' },
  error:    { dot: '●', className: 'text-[var(--accent-red)]', labelKey: 'workspace.agentError' },
  waiting:  { dot: '●', className: 'text-[var(--accent-yellow)]', labelKey: 'workspace.agentWaiting' },
  idle:     { dot: '●', className: 'text-[var(--text-muted)]', labelKey: 'workspace.agentIdle' },
};
