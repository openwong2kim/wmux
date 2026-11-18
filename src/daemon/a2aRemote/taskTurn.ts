import type { TurnEvent } from '../../shared/transcript/turnEvents';
import { userEntryHash } from '../../shared/promptHash';

/**
 * Which turn of an agent's transcript (Claude Code) a delivered task started,
 * read line by line. The per-line primitives are the ones the headless
 * delivery attributes a turn with (headlessDelivery.ts `stepEpisode`);
 * `stepTaskTurn` is the plain form of its rules for a pane someone else may
 * also be typing into: the turn the task's own prompt opened, until its first
 * end, and the tool calls made in between.
 */

/** Claude Code's system notice when it goes on by itself after a usage limit reset. */
const AUTO_CONTINUE_NOTICE = 'Usage limit reset · Continuing automatically';

/** The entry's `type`, `stop_reason`, content and sidechain flag, from its raw line (null: not JSON). */
export function rawEntry(line: string): { type?: unknown; stopReason?: unknown; content?: unknown; messageId: string | null; sidechain: boolean; typed: boolean; autoContinued: boolean } | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as { type?: unknown; isSidechain?: unknown; origin?: { kind?: unknown }; promptSource?: unknown; turnOrigin?: unknown; content?: unknown; message?: { id?: unknown; stop_reason?: unknown; content?: unknown } };
  const messageId = typeof e.message?.id === 'string' ? e.message.id : null;
  // Typed at the agent's prompt on this PC (a prompt, a slash command, a `!` command), as Claude Code 2.1 marks it.
  const typed = e.type === 'user' && (e.origin?.kind === 'human' || e.promptSource === 'typed');
  // Claude Code going on by itself after its usage limit reset (2.1.322): its notice, then its own prompt.
  const autoContinued = (e.type === 'user' && (e.origin?.kind === 'auto-continuation' || e.turnOrigin === 'auto_continuation'))
    || (e.type === 'system' && typeof e.content === 'string' && e.content.startsWith(AUTO_CONTINUE_NOTICE));
  return { type: e.type, stopReason: e.message?.stop_reason, content: e.message?.content, messageId, sidechain: e.isSidechain === true, typed, autoContinued };
}

export function textOfContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const blocks = content.filter((b): b is { type: 'text'; text: string } =>
    !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string');
  // A tool result (no text block of the user's own) is not a prompt.
  if (blocks.length === 0 || blocks.length !== content.length) return null;
  const text = blocks.map((b) => b.text).join('\n');
  return text.trim() ? text : null;
}

/** Whether a raw transcript line is the user entry of the prompt with this hash (shared/promptHash.ts). */
export function isPromptEntry(line: string, promptHash: string): boolean {
  const raw = rawEntry(line);
  if (!raw || raw.sidechain || raw.type !== 'user') return false;
  const text = textOfContent(raw.content);
  return text !== null && userEntryHash(text) === promptHash;
}

/** At most this many tool calls are kept for one turn; later ones are not recorded. */
export const TASK_TURN_TOOL_USES_MAX = 256;

/** One delivered task's turn, as read so far. */
export interface TaskTurn {
  /** The delivered prompt's hash (shared/promptHash.ts `promptHash`). */
  promptHash: string;
  /** The prompt's own user entry was seen. */
  opened: boolean;
  /**
   * The turn is over, or was never the task's alone: its first turn end
   * (any, background work left running included), an interrupt, or other
   * input to the agent before or inside it.
   */
  closed: boolean;
  /** The tool calls the agent made between the open and the close, in order. */
  toolUseIds: string[];
}

/**
 * The turn after one transcript line (its raw text and the events the
 * projector's parser reads from it). Nothing changes once closed.
 *  - a subagent's entry (sidechain) is ignored;
 *  - the prompt's own user entry opens it;
 *  - any other user input closes it, before the open as well as inside it;
 *  - after the open, each tool call is recorded, and the first turn end
 *    closes it: `turn_complete`, `turn_aborted`, or an assistant entry that
 *    stopped for anything but a tool call.
 */
export function stepTaskTurn(turn: TaskTurn, line: string, events: readonly TurnEvent[]): void {
  if (turn.closed) return;
  const raw = rawEntry(line);
  if (raw?.sidechain) return;
  if (!turn.opened) {
    const text = raw?.type === 'user' ? textOfContent(raw.content) : null;
    if (text !== null && userEntryHash(text) === turn.promptHash) {
      turn.opened = true;
      return;
    }
  }
  for (const event of events) {
    if (event.kind === 'user_text') {
      turn.closed = true;
      return;
    }
    if (!turn.opened) continue;
    if (event.kind === 'tool_use') {
      if (turn.toolUseIds.length < TASK_TURN_TOOL_USES_MAX && !turn.toolUseIds.includes(event.toolUseId)) turn.toolUseIds.push(event.toolUseId);
    } else if (event.kind === 'meta' && (event.subtype === 'turn_complete' || event.subtype === 'turn_aborted')) {
      turn.closed = true;
      return;
    }
  }
  if (turn.opened && raw?.type === 'assistant' && typeof raw.stopReason === 'string' && raw.stopReason !== 'tool_use') turn.closed = true;
}
