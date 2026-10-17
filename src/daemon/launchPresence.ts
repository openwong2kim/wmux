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
 *
 * A WSL pane has one piece of positive evidence instead of the process table:
 * its bash came back to a prompt after the launch line with a failing status
 * (PromptEventLog.exitAfterPrompt) and nothing has started since — the line
 * did not parse (status 2, the PowerShell prompt argument #2231 typed into
 * bash), the launcher was not found (127), or the agent already exited with
 * an error. A slow start never looks like that: while the agent loads, bash
 * is not at a prompt.
 *
 * F26 — and a second one: the launch line never reached bash at all. Its
 * first prompt is drawn, no line was ever read (no command-start, no return
 * to a prompt after one) and nothing has been written since that prompt
 * (shared/promptLineState.ts). A line bash took would have been echoed; an
 * agent running under a bash without PS0 writes its screen.
 */

export type LaunchPresence = 'running' | 'absent' | 'unknown';

/** Why the verdict was reached — reported alongside it for logs and tests. */
export type LaunchPresenceReason =
  | 'no-session'
  | 'agent-named'
  | 'agent-process-alive'
  | 'exec-pane'
  | 'wsl-pane'
  | 'wsl-launch-failed'
  | 'wsl-line-never-read'
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
  /** PromptEventLog.exitAfterPrompt: the status the shell came back to its
   *  prompt with after a command line, nothing running since. */
  exitAfterPrompt?: number;
  /** F26 — promptLineState is 'idle-at-prompt': the shell sits at its first
   *  prompt and never read a line. */
  lineNeverRead?: boolean;
  /** The process-table read; undefined = not taken (cheap mode). */
  idleShell?: IdleShellRead;
}

export interface LaunchPresenceVerdict {
  presence: LaunchPresence;
  reason: LaunchPresenceReason;
}

/**
 * F26 — may a launch line be typed into this pane a second time? Only on a
 * process-table read that saw the pane's shell with no child process
 * (`idle-shell`). Every other `absent` is a verdict about a launch that
 * failed, not proof that nothing runs: `wsl-line-never-read` is read from the
 * prompt markers alone, and a prompt and the line's echo arriving in one
 * chunk leave it no output to see. No probe lists the Linux processes of a
 * WSL pane's shell, so a WSL pane never qualifies.
 */
export function launchPresenceAllowsResend(verdict: Pick<LaunchPresenceVerdict, 'presence' | 'reason'>): boolean {
  return verdict.presence === 'absent' && verdict.reason === 'idle-shell';
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
  if (inputs.isWsl) {
    if (inputs.exitAfterPrompt !== undefined && inputs.exitAfterPrompt !== 0 && inputs.commandRunning !== true) {
      return { presence: 'absent', reason: 'wsl-launch-failed' };
    }
    if (inputs.lineNeverRead === true && inputs.commandRunning !== true) {
      return { presence: 'absent', reason: 'wsl-line-never-read' };
    }
    return { presence: 'unknown', reason: 'wsl-pane' };
  }
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
