import type { AgentStatus } from '../../shared/types';
import type { ClaudeRewindResult } from '../../shared/transcript/turnEvents';
import { agentRow } from '../../shared/agentIdentity';
import { screenBlocksChatSend, screenShowsRunningTurn, titleShowsRunningTurn } from './chatScreenGate';
import { claudeComposerEmpty, claudeComposerVisible, type ChatScreenRows } from './deliverChatPrompt';

/** Gap between the two ESCs: well inside Claude's double-tap window, and two separate chunks. */
export const REWIND_ESC_GAP_MS = 120;
/**
 * The most the two ESCs may be apart, screen read included. Past it Claude
 * may read them as two lone presses (the daemon's own detector allows a
 * human's 500 ms double-tap), so the second one is not sent.
 */
export const REWIND_MAX_GAP_MS = 400;
/** Escape as kitty CSI-u, for a pane whose app pushed the kitty keyboard protocol. */
export const ESCAPE_CSI_U = '\x1b[27u';

export interface ClaudeRewindDeps {
  hasOpenApproval: () => boolean;
  /** Null when the pane runs no verified agent. `inputRevision` moves on every key written to the pane. */
  getAgentState: () => { slug: string; status: AgentStatus; inputRevision: number } | null;
  /** The pane's visible grid, parsed; null when it cannot be read. */
  readScreen: () => Promise<ChatScreenRows | null>;
  /** The pane's latest window title and when it was set. */
  readTitle?: () => { title: string; at: number } | null;
  write: (data: string) => boolean;
  /** The pane's app negotiated kitty keys: a bare ESC would wait for a CSI that never comes. */
  kitty?: boolean;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Open Claude Code's own Rewind picker in a terminal pane: the double ESC its
 * TUI takes at rest (live-checked on Claude Code 2.1.302 — the picker opens
 * with "(current)" selected, so nothing is restored until the user picks a
 * point and confirms).
 *
 * ESC means something else in every other state, so each one refuses: during
 * a turn it interrupts, in a dialog it answers, and with a draft in the
 * composer the first ESC clears it. Only an idle Claude with an empty
 * composer on screen and no pending approval gets the keys. The screen, the
 * title and the state are read again before each ESC, and any key written to
 * the pane in between (the terminal, the phone) aborts.
 */
export async function openClaudeRewind(deps: ClaudeRewindDeps): Promise<ClaudeRewindResult> {
  const now = deps.now ?? Date.now;
  const esc = deps.kitty ? ESCAPE_CSI_U : '\x1b';
  const check = (revision?: number): ClaudeRewindResult | null => {
    if (deps.hasOpenApproval()) return 'blocked';
    const state = deps.getAgentState();
    if (!state || !agentRow(state.slug)?.rewindPicker) return 'unavailable';
    if (state.status === 'running') return 'busy';
    // `waiting` is a turn that ended and is ready for input; only a mid-turn prompt blocks.
    if (state.status === 'awaiting_input') return 'blocked';
    // Someone else typed since the screen was read: the screen no longer says what ESC would do.
    if (revision !== undefined && state.inputRevision !== revision) return 'busy';
    return null;
  };
  const revision = (): number => deps.getAgentState()?.inputRevision ?? -1;
  /** The screen read (the last await before a write), then every check again. */
  const atRest = async (expected: number): Promise<ClaudeRewindResult | null> => {
    let rows: ChatScreenRows | null = null;
    try { rows = await deps.readScreen(); } catch { /* unreadable = refuse */ }
    if (screenBlocksChatSend(rows)) return 'blocked';
    // A hook's idle can lag the turn; Claude's own running row and title cannot.
    let title: { title: string; at: number } | null = null;
    try { title = deps.readTitle?.() ?? null; } catch { /* no title = no title evidence */ }
    if (screenShowsRunningTurn(rows, 'claude') || titleShowsRunningTurn(title, 'claude', now())) return 'busy';
    if (!claudeComposerEmpty(rows)) return claudeComposerVisible(rows) ? 'draft' : 'blocked';
    return check(expected);
  };
  const first = check();
  if (first) return first;
  try {
    const before = await atRest(revision());
    if (before) return before;
    if (!deps.write(esc)) return 'unavailable';
    const firstAt = now();
    // Our own ESC moved the revision; anything past it is someone else's key.
    const afterFirst = revision();
    await (deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(REWIND_ESC_GAP_MS);
    // A lone ESC on an empty composer does nothing, so stopping here is safe.
    const between = await atRest(afterFirst);
    if (between) return between;
    // A slow screen read stretched the gap past a double-tap: not a rewind any more.
    if (now() - firstAt > REWIND_MAX_GAP_MS) return 'retry';
    return deps.write(esc) ? 'opened' : 'unavailable';
  } catch {
    return 'error';
  }
}
