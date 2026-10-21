// New agent sessions, counted for the sidebar's "Star on GitHub" row
// (shared/starPrompt.ts). Local only: a count goes to this app's own window
// and into its session file, nowhere else.
//
// The choke point is the agent's own SessionStart hook (Claude Code, Codex and
// every agent with a hook bridge), replayed to main by DaemonNotificationRouter
// and, while the daemon is unreachable, by hooks.rpc's local twin. It fires
// once per agent session however the session was started (typed in a shell, a
// quick launch, a fan-out task), and its `source` tells a new session apart
// from the ones that must not count:
//   - `resume`: a restored pane after a crash or reboot is relaunched with
//     `--resume`; a pane the daemon kept across an app restart fires nothing.
//   - `clear` / `compact`: the same session going on.
// Bot workers (a factory bot's fan-out tasks) and the orchestrator's own
// brain pane are left out: no person started them.
import type { AgentSignal } from '../../shared/hooks/signal-types';
import { isBrainPtyId } from '../../shared/constants';
import { isBotWorkerSession } from '../agents/botWorkerMergeGuard';

/** Session-start receipts remembered for de-duplication (a bridge may deliver one twice). */
const SEEN_CAP = 512;

export interface StarPromptSessionDeps {
  isBotWorker: (ptyId: string) => boolean;
  isBrain: (ptyId: string) => boolean;
}

const defaultDeps: StarPromptSessionDeps = {
  isBotWorker: (ptyId) => isBotWorkerSession(ptyId),
  isBrain: isBrainPtyId,
};

/** Does this session-start hook on `ptyId` count as a new session a person started? */
export function isCountableAgentStart(
  ptyId: string,
  signal: AgentSignal | undefined,
  deps: StarPromptSessionDeps = defaultDeps,
): boolean {
  if (!signal || signal.kind !== 'agent.session_start') return false;
  // Exact pane only, the same rule as HookSignalRouter.noteSessionStart: a
  // hook that merely resolves to this pane is not evidence about it.
  if (!ptyId || signal.ptyId !== ptyId) return false;
  if (signal.payload?.['source'] !== 'startup') return false;
  if (deps.isBrain(ptyId)) return false;
  return !deps.isBotWorker(ptyId);
}

export class StarPromptSessionCounter {
  private seen = new Set<string>();
  private sinks = new Set<() => void>();

  constructor(private deps: StarPromptSessionDeps = defaultDeps) {}

  /** Subscribe to counted sessions; returns the unsubscribe. */
  onSession(sink: () => void): () => void {
    this.sinks.add(sink);
    return () => { this.sinks.delete(sink); };
  }

  /** Feed one session-start hook. True when it was counted. */
  note(ptyId: string, signal: AgentSignal | undefined): boolean {
    try {
      if (!isCountableAgentStart(ptyId, signal, this.deps)) return false;
    } catch {
      return false;
    }
    const key = `${ptyId}\u0000${signal?.agentSessionId ?? signal?.ts ?? ''}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    for (const sink of this.sinks) {
      try { sink(); } catch { /* a broken sink must not break the hook path */ }
    }
    return true;
  }
}

/** Process-wide: both hook paths feed the one counter. */
export const starPromptSessions = new StarPromptSessionCounter();
