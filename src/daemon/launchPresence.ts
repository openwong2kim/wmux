/**
 * #1919 / #1933 — "did the agent this pane was asked to launch actually
 * start?", answered for the fan-out launch check (`daemon.getLaunchPresence`).
 *
 * A pane with no canonical agent name is NOT proof that no agent runs there:
 * identity detection can lag (no banner yet, no hook yet, an unattributed
 * process), and a wrapper can emit an OSC 133 prompt-end while the agent it
 * started is still alive. So `absent` needs positive evidence of absence —
 * every signal below must agree, and the process table must have been read:
 *
 *   - no canonical agent name;
 *   - the agent process tracker does not hold a live agent for the pane;
 *   - OSC 133 does not report a running foreground command (`false` or
 *     unknown — a launch line that was swallowed never emits command-start);
 *   - a fresh process snapshot shows the pane's root is a plain shell with
 *     no child process at all (apart from verified passive helpers).
 *
 * Anything short of that is `unknown`, never `absent`: a missing session, an
 * exec pane (its root IS the agent), a WSL pane (its Linux processes are not
 * in the Windows table), a shell with children, an unsupported shell, or a
 * snapshot that was not taken or failed. The caller treats `unknown` as no
 * evidence and raises no warning.
 */

export type LaunchPresence = 'running' | 'absent' | 'unknown';

/** Why the verdict was reached — reported alongside it for logs and tests. */
export type LaunchPresenceReason =
  | 'no-session'
  | 'agent-named'
  | 'agent-process-alive'
  | 'exec-pane'
  | 'wsl-pane'
  | 'foreground-command'
  | 'not-probed'
  | 'shell-has-children'
  | 'shell-missing'
  | 'unsupported-shell'
  | 'probe-failed'
  | 'idle-shell';

/** The idle-shell read of the pane's root process (AgentProcessTracker.idleShellState),
 *  or `'error'` when the process table could not be read. */
export type IdleShellRead =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'unsupported-shell' | 'shell-has-children' }
  | 'error';

export interface LaunchPresenceInputs {
  /** False when the daemon has no such session. */
  sessionExists: boolean;
  /** The canonical name readDaemonAgentState reports (null = none). */
  agentName: string | null;
  /** AgentProcessTracker.statusFor: true = a tracked agent process is alive. */
  trackerAlive: boolean | undefined;
  /** PromptEventLog.commandRunningIfKnown. */
  commandRunning: boolean | undefined;
  /** The pane's root is the agent itself (an exec unit). */
  isExec: boolean;
  /** The pane's shell is wsl.exe. */
  isWsl: boolean;
  /** The process-table read; undefined = not taken (cheap mode). */
  idleShell?: IdleShellRead;
}

export interface LaunchPresenceVerdict {
  presence: LaunchPresence;
  reason: LaunchPresenceReason;
}

/** Whether the verdict can still be decided without reading the process table. */
export function launchPresenceNeedsProcessRead(inputs: Omit<LaunchPresenceInputs, 'idleShell'>): boolean {
  return decideLaunchPresence(inputs).reason === 'not-probed';
}

/** The verdict. Pure — exported for unit tests. */
export function decideLaunchPresence(inputs: LaunchPresenceInputs): LaunchPresenceVerdict {
  if (!inputs.sessionExists) return { presence: 'unknown', reason: 'no-session' };
  if (inputs.agentName) return { presence: 'running', reason: 'agent-named' };
  if (inputs.trackerAlive === true) return { presence: 'running', reason: 'agent-process-alive' };
  if (inputs.isExec) return { presence: 'unknown', reason: 'exec-pane' };
  if (inputs.isWsl) return { presence: 'unknown', reason: 'wsl-pane' };
  if (inputs.commandRunning === true) return { presence: 'unknown', reason: 'foreground-command' };
  const idle = inputs.idleShell;
  if (idle === undefined) return { presence: 'unknown', reason: 'not-probed' };
  if (idle === 'error') return { presence: 'unknown', reason: 'probe-failed' };
  if (idle.ok) return { presence: 'absent', reason: 'idle-shell' };
  switch (idle.reason) {
    case 'missing':
      return { presence: 'unknown', reason: 'shell-missing' };
    case 'unsupported-shell':
      return { presence: 'unknown', reason: 'unsupported-shell' };
    default:
      return { presence: 'unknown', reason: 'shell-has-children' };
  }
}
