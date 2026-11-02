/** One agent process's own start time, as read off the process table. */
export interface AgentProcessStart {
  pid: number;
  /** Epoch ms. */
  startedAt: number;
}

/**
 * When the pane's current agent started: the later of the shell's last command
 * start (OSC 133 C) and a recorded process start of the pid the pane's agent
 * runs as now. Either alone is enough, so a shell that reports no command start
 * (no wmux integration, bash before 4.4) still has one; a record of another pid
 * is a previous agent's and counts for nothing.
 */
export function agentLaunchAt(
  commandAt: number | undefined,
  starts: ReadonlyArray<AgentProcessStart | undefined>,
  currentPid: number | undefined,
): number | undefined {
  const known = [
    commandAt,
    ...starts.map((start) => start && start.pid === currentPid && start.startedAt > 0 ? start.startedAt : undefined),
  ].filter((v): v is number => v !== undefined);
  return known.length > 0 ? Math.max(...known) : undefined;
}
