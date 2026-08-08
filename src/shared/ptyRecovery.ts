import { isAgentSlug, type AgentSlug } from './agentIdentity';
import type { ResumeBinding } from './agentResume';

/**
 * Minimal metadata carried while a renderer surface replaces a known-dead
 * daemon session. Both cwd candidates remain untrusted until main validates
 * them at PTY-create time.
 */
export interface DeadPaneRecovery {
  spawnCwd?: string;
  cwd?: string;
  resumeAgent?: AgentSlug;
  resumeBinding?: ResumeBinding;
}

export interface DeadPaneSessionSnapshot {
  spawnCwd?: string;
  cwd?: string;
  /** Untrusted daemon/RPC value; normalized before entering renderer state. */
  resumeAgent?: string;
  resumeBinding?: ResumeBinding;
}

function nonBlank(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

export function asRecoveryAgentSlug(value: string | undefined): AgentSlug | undefined {
  return value !== undefined && isAgentSlug(value) ? value : undefined;
}

/**
 * Build the renderer hand-off from a daemon tombstone. A descriptor is
 * returned even when both cwd fields are absent: its presence tells the create
 * path this is a dead-session replacement, for which home is the final fallback
 * instead of the workspace profile used by ordinary blank surfaces.
 */
export function createDeadPaneRecovery(session: DeadPaneSessionSnapshot): DeadPaneRecovery {
  const resumeBinding = session.resumeBinding;
  const resumeAgent = asRecoveryAgentSlug(session.resumeAgent)
    ?? asRecoveryAgentSlug(resumeBinding?.agent);
  return {
    ...(nonBlank(session.spawnCwd) ? { spawnCwd: session.spawnCwd } : {}),
    ...(nonBlank(session.cwd) ? { cwd: session.cwd } : {}),
    ...(resumeAgent ? { resumeAgent } : {}),
    ...(resumeBinding ? { resumeBinding } : {}),
  };
}

/** Carry a still-pending resume offer across a second replacement. */
export function mergeDeadPaneRecovery(
  previous: DeadPaneRecovery | undefined,
  incoming: DeadPaneRecovery,
): DeadPaneRecovery {
  if (!previous) return incoming;
  return {
    ...previous,
    ...incoming,
    ...(incoming.resumeAgent ?? previous.resumeAgent
      ? { resumeAgent: incoming.resumeAgent ?? previous.resumeAgent }
      : {}),
    ...(incoming.resumeBinding ?? previous.resumeBinding
      ? { resumeBinding: incoming.resumeBinding ?? previous.resumeBinding }
      : {}),
  };
}
