import { fromThreadMessageLike, type ThreadMessage } from '@assistant-ui/react';
import type { ToolResultEvent, TurnEvent } from '../../../shared/transcript/turnEvents';

export interface ChatRow { event: TurnEvent; result?: ToolResultEvent; activity?: ChatRow[]; }

export function transcriptMessages(events: readonly TurnEvent[], groupActivity = false): ThreadMessage[] {
  const calls = new Set(events.filter((e) => e.kind === 'tool_use').map((e) => e.toolUseId));
  const results = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.toolUseId, e]));
  const rows: ChatRow[] = [];
  for (const event of events.filter((e) => e.kind !== 'tool_result' || e.files?.length || !calls.has(e.toolUseId))) {
    const row: ChatRow = { event, ...(event.kind === 'tool_use' ? { result: results.get(event.toolUseId) } : {}) };
    const activity = event.kind === 'tool_use' || event.kind === 'tool_result' && !event.files?.length || event.kind === 'assistant_text' && event.thinking;
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
