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
// worth one process probe: a TUI agent is up by then, while `ls` or `git
// status` has long returned and costs nothing. The probe itself only commits
// a pick that resolves to an agent slug (AgentProcessTracker.armIfAgent).

/** How long a foreground command must outlive its command-start marker. */
export const COMMAND_SETTLE_MS = 1_500;

export interface CommandStartAgentProbeDeps {
  /** OSC 133 says a foreground command still owns the pane's PTY. */
  stillRunning: (sessionId: string) => boolean;
  /** Probe the pane's process tree for a named agent. */
  probe: (sessionId: string) => void;
  settleMs?: number;
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
    if (type !== 'command_start') return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      if (this.deps.stillRunning(sessionId)) this.deps.probe(sessionId);
    }, this.deps.settleMs ?? COMMAND_SETTLE_MS);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }
}
