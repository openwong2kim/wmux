import type { AgentStatus } from '../../shared/types';
import type { ClaudeRewindResult } from '../../shared/transcript/turnEvents';
import { screenBlocksChatSend, screenShowsRunningTurn, titleShowsRunningTurn } from './chatScreenGate';
import { claudeComposerEmpty, claudeComposerVisible, type ChatScreenRows } from './deliverChatPrompt';

/** Gap between the two ESCs: well inside Claude's double-tap window, and two separate chunks. */
export const REWIND_ESC_GAP_MS = 120;

export interface ClaudeRewindDeps {
  hasOpenApproval: () => boolean;
  /** Null when the pane runs no verified agent. */
  getAgentState: () => { slug: string; status: AgentStatus } | null;
  /** The pane's visible grid, parsed; null when it cannot be read. */
  readScreen: () => Promise<ChatScreenRows | null>;
  /** The pane's latest window title and when it was set. */
  readTitle?: () => { title: string; at: number } | null;
  write: (data: string) => boolean;
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
 * composer on screen and no pending approval gets the keys, and the state
 * checks repeat right before each write.
 */
export async function openClaudeRewind(deps: ClaudeRewindDeps): Promise<ClaudeRewindResult> {
  const now = deps.now ?? Date.now;
  const check = (): ClaudeRewindResult | null => {
    if (deps.hasOpenApproval()) return 'blocked';
    const state = deps.getAgentState();
    if (!state || state.slug !== 'claude') return 'unavailable';
    if (state.status === 'running') return 'busy';
    if (state.status === 'awaiting_input' || state.status === 'waiting') return 'blocked';
    return null;
  };
  const first = check();
  if (first) return first;
  let rows: ChatScreenRows | null = null;
  try { rows = await deps.readScreen(); } catch { /* unreadable = refuse */ }
  if (screenBlocksChatSend(rows)) return 'blocked';
  // A hook's idle can lag the turn; Claude's own running row and title cannot.
  let title: { title: string; at: number } | null = null;
  try { title = deps.readTitle?.() ?? null; } catch { /* no title = no title evidence */ }
  if (screenShowsRunningTurn(rows, 'claude') || titleShowsRunningTurn(title, 'claude', now())) return 'busy';
  if (!claudeComposerEmpty(rows)) return claudeComposerVisible(rows) ? 'draft' : 'blocked';
  const again = check();
  if (again) return again;
  try {
    if (!deps.write('\x1b')) return 'unavailable';
    await (deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(REWIND_ESC_GAP_MS);
    // A lone ESC on an empty composer does nothing, so stopping here is safe.
    const last = check();
    if (last) return last;
    return deps.write('\x1b') ? 'opened' : 'unavailable';
  } catch {
    return 'error';
  }
}
