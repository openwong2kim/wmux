// Banner-independent agent attribution for interactive panes.
//
// A pane's agent is named by one of three signals: a hook, an attributed
// process, or the detector reading the agent's banner. The process tracker
// only probed when a hook or a banner said so, so an agent with no
// session-start hook (Codex notifies on turn end only) was named by its
// banner alone. When that read missed — a resumed Codex after an app update,
// for one — the pane had no identity, and no sidebar row, until the agent's
// first turn ended.
//
// OSC 133 already says when the shell handed the terminal to a foreground
// command. A command still running `settleMs` after its command-start (C) is
// worth a process probe: a TUI agent is up by then, while `ls` or `git status`
// has long returned and costs nothing. One later retry catches a slow starter
// (a cold `npx` download, a wrapper that execs late); after that the window
// closes. The probe itself only commits a pick that resolves to an agent slug,
// and backs off on a miss (AgentProcessTracker.armIfAgent).

/** How long a foreground command must outlive its command-start marker. */
export const COMMAND_SETTLE_MS = 1_500;

/** Gap before the one retry. Longer than AGENT_MISS_BACKOFF_MS, so a first
 *  attempt that found nothing does not block the retry. */
export const COMMAND_RETRY_MS = 5_000;

export interface CommandStartAgentProbeDeps {
  /** OSC 133 says a foreground command still owns the pane's PTY. */
  stillRunning: (sessionId: string) => boolean;
  /** The pane already has a live, named agent — the retry has nothing to do. */
  named: (sessionId: string) => boolean;
  /** Probe the pane's process tree for a named agent. */
  probe: (sessionId: string) => void;
  /** Delays between attempts; the first is measured from the command-start. */
  delaysMs?: readonly number[];
}

export class CommandStartAgentProbe {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: CommandStartAgentProbeDeps) {}

  /** Feed every parsed OSC 133 marker. Any marker after a command-start ends
   *  that command's window; a new command-start opens a fresh one. */
  onPromptEvent(sessionId: string, type: string): void {
    const pending = this.timers.get(sessionId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.timers.delete(sessionId);
    }
    if (type === 'command_start') this.schedule(sessionId, 0);
  }

  private schedule(sessionId: string, attempt: number): void {
    const delays = this.deps.delaysMs ?? [COMMAND_SETTLE_MS, COMMAND_RETRY_MS];
    if (attempt >= delays.length) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      if (!this.deps.stillRunning(sessionId)) return;
      // The first attempt probes even for a pane that reads as named: a new
      // command-start means the tracked agent may be one that just exited.
      if (attempt > 0 && this.deps.named(sessionId)) return;
      this.deps.probe(sessionId);
      this.schedule(sessionId, attempt + 1);
    }, delays[attempt]);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }
}
