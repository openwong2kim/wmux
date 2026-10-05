import { fromThreadMessageLike, type ThreadMessage } from '@assistant-ui/react';
import type { AssistantTextEvent, ToolResultEvent, TurnEvent } from '../../../shared/transcript/turnEvents';

/**
 * What the transcript recorded about a finished turn: when it opened (the
 * prompt or the agent's own turn start) and closed, and the reply prose for
 * Copy. Either time is absent when its entry carried no timestamp.
 */
export interface TurnReceipt { start?: number; end?: number; replies: AssistantTextEvent[] }
export interface ChatRow { event: TurnEvent; result?: ToolResultEvent; activity?: ChatRow[]; images?: string[]; receipt?: TurnReceipt }

export function transcriptMessages(events: readonly TurnEvent[], groupActivity = false): ThreadMessage[] {
  const calls = new Set(events.filter((e) => e.kind === 'tool_use').map((e) => e.toolUseId));
  const results = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.toolUseId, e]));
  const rows: ChatRow[] = [];
  // A receipt closes a turn only on a recorded end (Claude's end_turn, Codex's
  // task_complete), never on silence.
  let turn: { start?: number; replies: AssistantTextEvent[] } | null = null;
  for (const event of events.filter((e) => e.kind !== 'tool_result' || e.files?.length || !calls.has(e.toolUseId))) {
    // The prompt opens a turn; an agent's own turn start opens one only when
    // no prompt already did (an autonomous turn).
    if (event.kind === 'user_text' || event.kind === 'meta' && event.subtype === 'turn_started' && !(turn && !turn.replies.length)) {
      turn = { start: event.ts, replies: [] };
    }
    if (event.kind === 'assistant_text' && !event.thinking && !event.folded) (turn ??= { replies: [] }).replies.push(event);
    const ends = event.kind === 'assistant_text' && !event.thinking && event.turnComplete || event.kind === 'meta' && event.subtype === 'turn_complete';
    // An image's source note belongs to the prompt that carried the image.
    const previous = rows.at(-1);
    if (event.kind === 'meta' && event.images?.length && previous?.event.kind === 'user_text' && previous.event.hasImage) {
      previous.images = [...(previous.images ?? []), ...event.images];
      continue;
    }
    const row: ChatRow = { event, ...(event.kind === 'tool_use' ? { result: results.get(event.toolUseId) } : {}) };
    if (ends && turn) { row.receipt = { start: turn.start, end: event.ts, replies: turn.replies }; turn = null; }
    // A failed call stays out of the fold (someone has to see it), unless the
    // transcript's owner marked it `folded` (Moa's internal calls).
    const failed = event.kind === 'tool_use' ? results.get(event.toolUseId)?.ok === false : event.kind === 'tool_result' && !event.ok;
    const activity = event.folded || !failed && (event.kind === 'tool_use' || event.kind === 'tool_result' && !event.files?.length || event.kind === 'assistant_text' && event.thinking);
    if (groupActivity && activity) {
      const previous = rows.at(-1);
      if (previous?.activity) previous.activity.push(row);
      else rows.push({ event: { id: `activity:${event.id}`, kind: 'meta', subtype: 'unknown', label: 'Agent activity' }, activity: [row] });
    } else rows.push(row);
  }
  return rows.map((row) => {
    const { event } = row;
    const text = event.kind === 'meta' ? event.label : event.kind === 'tool_use' ? `${event.name}: ${event.argSummary}`
      : event.kind === 'tool_result' ? (event.output?.inline ?? event.toolUseId) : event.text;
    return fromThreadMessageLike({ id: event.id, role: event.kind === 'user_text' ? 'user' : 'assistant',
      content: [{ type: 'text', text }], ...(event.ts ? { createdAt: new Date(event.ts) } : {}),
      metadata: { custom: { row } },
    }, event.id, { type: 'complete', reason: 'stop' });
  });
}

export type ActivityLabel = { key: 'chat.groupRead' | 'chat.groupEdited' | 'chat.groupRan' | 'chat.groupSearched'; count: number };

const FAMILY: [RegExp, ActivityLabel['key'], number][] = [
  [/^(multi)?edit$|^write$|^notebookedit$/i, 'chat.groupEdited', 2],
  [/^read$/i, 'chat.groupRead', 3],
  [/^bash$/i, 'chat.groupRan', 3],
  [/^(grep|glob)$/i, 'chat.groupSearched', 3],
];

/** "Read 3 files" when every call in a fold is one kind and there are enough of them; else null. */
export function activityLabel(activity: readonly ChatRow[]): ActivityLabel | null {
  const names = activity.flatMap((row) => (row.event.kind === 'tool_use' ? [row.event.name] : []));
  for (const [pattern, key, min] of FAMILY) {
    if (names.length >= min && names.every((name) => pattern.test(name))) return { key, count: names.length };
  }
  return null;
}
