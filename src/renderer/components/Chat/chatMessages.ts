import { fromThreadMessageLike, type ThreadMessage } from '@assistant-ui/react';
import type { ToolResultEvent, TurnEvent } from '../../../shared/transcript/turnEvents';

export interface ChatRow { event: TurnEvent; result?: ToolResultEvent; }

export function transcriptMessages(events: readonly TurnEvent[]): ThreadMessage[] {
  const calls = new Set(events.filter((e) => e.kind === 'tool_use').map((e) => e.toolUseId));
  const results = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.toolUseId, e]));
  return events.filter((e) => e.kind !== 'tool_result' || !calls.has(e.toolUseId)).map((event) => {
    const row: ChatRow = { event, ...(event.kind === 'tool_use' ? { result: results.get(event.toolUseId) } : {}) };
    const text = event.kind === 'meta' ? event.label : event.kind === 'tool_use' ? `${event.name}: ${event.argSummary}`
      : event.kind === 'tool_result' ? (event.output?.inline ?? event.toolUseId) : event.text;
    return fromThreadMessageLike({ id: event.id, role: event.kind === 'user_text' ? 'user' : 'assistant',
      content: [{ type: 'text', text }], ...(event.ts ? { createdAt: new Date(event.ts) } : {}),
      metadata: { custom: { row } },
    }, event.id, { type: 'complete', reason: 'stop' });
  });
}
