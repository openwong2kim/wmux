import type { AgentStatus } from '../../shared/types';
import type { ChatInterruptResult } from '../../shared/transcript/turnEvents';
import { screenBlocksChatSend, screenShowsRunningTurn, screenShowsTurnEnding, titleShowsFinishedTurn, titleShowsRunningTurn } from './chatScreenGate';

/** One ESC per pane within this window, whatever wrote the last one. */
export const INTERRUPT_COOLDOWN_MS = 2000;

/**
 * Daemon-side verdict. The desktop keeps its `ChatInterruptResult` enum; the
 * extra values are the phone route's (see `nativeChatBridge` for the mapping).
 * - `turn_mismatch`: the caller named a turn that is not the running one.
 * - `already_interrupted`: a lone ESC already reached the pane in this turn.
 * - `cooldown`: a lone ESC reached the pane less than the cooldown ago.
 * - `unauthorized`: the caller's re-authorization failed before the write.
 * - `write_refused`: `beforeWrite` declined (nothing written).
 */
export type ChatInterruptVerdict = ChatInterruptResult | 'turn_mismatch' | 'already_interrupted' | 'cooldown' | 'unauthorized' | 'write_refused';

export interface ChatInterruptDeps {
  getTranscriptSessionId: () => string | undefined;
  hasOpenApproval: () => boolean;
  /** The pane's visible grid, parsed; null when it cannot be read. */
  readScreen: () => Promise<readonly string[] | null>;
  /** `turn` is the pane's running episode, when the pane tracks one. */
  getAgentState: () => { slug: string; status: AgentStatus; turn?: { id: string; state: 'running' | 'idle'; startedAt?: number } } | null;
  write: (data: string) => boolean;
  /** When a lone ESC last reached the pane from any source (0 = never). */
  lastEscAt?: () => number;
  now?: () => number;
  /** The turn the caller means; any other running turn is refused. */
  expectedTurnId?: string;
  /** Called after the screen read, before the write; false writes nothing. */
  authorized?: () => Promise<boolean>;
  /** The pane's latest window title and when it was set; read synchronously right before the write. */
  readTitle?: () => { title: string; at: number } | null;
  /** Synchronous last step before the ESC (e.g. a durable receipt), given the turn aimed at; false writes nothing. */
  beforeWrite?: (turn: { id: string; startedAt: number }) => boolean;
  /**
   * The agent's own interrupt, tried after `beforeWrite` and before the ESC
   * (Codex `turn/interrupt`). `interrupted`: the agent's own stream proved
   * the turn stopped, so no ESC follows. `not-written`: nothing reached the
   * agent. `uncertain`: it may have. Anything but `interrupted` runs every
   * gate again before the ESC.
   */
  native?: () => Promise<'interrupted' | 'not-written' | 'uncertain'>;
}

/**
 * Chat Stop: the key the agent's own TUI interrupts a turn with.
 *
 * ESC is only safe while the turn runs. At rest it clears Claude's input line
 * (and a second one opens rewind), and in a dialog it answers the dialog, so an
 * idle agent, an open approval or any keyboard-owning screen refuses instead.
 * The agent must also show it is working right now: its own running row on
 * the screen read, or a fresh running spinner as its latest window title (the
 * only sign left while answer text streams), and nothing saying the turn just
 * ended (an idle title set during this turn, Claude's Stop-hook row). One ESC
 * per turn and per cooldown is all a pane gets. Every check repeats after the
 * last await (the screen read), right before the write.
 */
export async function interruptChatTurn(agentSessionId: string, deps: ChatInterruptDeps): Promise<ChatInterruptVerdict> {
  const now = deps.now ?? Date.now;
  let slug = '';
  let target: { id: string; startedAt: number } | undefined;
  const check = (): ChatInterruptVerdict | null => {
    if (deps.getTranscriptSessionId() !== agentSessionId) return 'session_changed';
    if (deps.hasOpenApproval()) return 'blocked';
    const state = deps.getAgentState();
    if (!state || !['claude', 'codex'].includes(state.slug)) return 'unavailable';
    slug = state.slug;
    if (state.status === 'awaiting_input') return 'blocked';
    if (state.status !== 'running') return 'not_running';
    const { turn } = state;
    if (deps.expectedTurnId !== undefined && turn?.id !== deps.expectedTurnId) return 'turn_mismatch';
    // No episode, or one without a start, cannot hold the once-per-turn latch.
    if (!turn || turn.state !== 'running' || turn.startedAt === undefined) return 'not_running';
    const escAt = deps.lastEscAt?.() ?? 0;
    if (escAt > 0 && escAt >= turn.startedAt) return 'already_interrupted';
    if (escAt > 0 && now() - escAt < INTERRUPT_COOLDOWN_MS) return 'cooldown';
    target = { id: turn.id, startedAt: turn.startedAt };
    return null;
  };
  if (!agentSessionId) return 'error';
  const first = check();
  if (first) return first;
  /**
   * Authorization, then the screen read (the last await before a write),
   * then every check again. Null: the turn `expected` (when given) is still
   * running and may be interrupted now.
   */
  const lastGate = async (expected?: string): Promise<ChatInterruptVerdict | null> => {
    if (deps.authorized) {
      let ok = false;
      try { ok = await deps.authorized(); } catch { /* a failed check is a refusal */ }
      if (!ok) return 'unauthorized';
    }
    let rows: readonly string[] | null = null;
    try { rows = await deps.readScreen(); } catch { /* unreadable = refuse */ }
    if (screenBlocksChatSend(rows)) return 'blocked';
    const again = check();
    if (again || !target) return again ?? 'not_running';
    if (expected !== undefined && target.id !== expected) return 'not_running';
    // The hook's `running` can outlive the turn; the agent's own row and title
    // cannot. The title is read synchronously, with nothing between it and the write.
    let title: { title: string; at: number } | null = null;
    try { title = deps.readTitle?.() ?? null; } catch { /* no title = no title evidence */ }
    if (titleShowsFinishedTurn(title, slug, target.startedAt) || screenShowsTurnEnding(rows, slug)) return 'not_running';
    if (!screenShowsRunningTurn(rows, slug) && !titleShowsRunningTurn(title, slug, now())) return 'not_running';
    return null;
  };
  const second = await lastGate();
  if (second || !target) return second ?? 'not_running';
  const aimed = target;
  if (deps.beforeWrite && !deps.beforeWrite(aimed)) return 'write_refused';
  if (deps.native) {
    let native: 'interrupted' | 'not-written' | 'uncertain';
    try { native = await deps.native(); } catch { native = 'uncertain'; }
    if (native === 'interrupted') return 'sent';
    // Up to the native bound passed: every gate again, for the same turn,
    // before the ESC. A refusal after a native request that may have landed
    // is still a written interrupt (`sent`), which the caller observes.
    const third = await lastGate(aimed.id);
    if (third) return native === 'uncertain' ? 'sent' : third;
    try { return deps.write('\x1b') ? 'sent' : native === 'uncertain' ? 'sent' : 'unavailable'; } catch { return 'error'; }
  }
  try { return deps.write('\x1b') ? 'sent' : 'unavailable'; } catch { return 'error'; }
}
