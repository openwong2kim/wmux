import { describe, expect, it } from 'vitest';
import { parseTranscriptLine } from '../parseEntry';

describe('recorded turn completion', () => {
  it.each([null, 'tool_use', 'max_tokens', 'end_turn'])('only marks explicit end_turn (%s)', (stop_reason) => {
    const events = parseTranscriptLine(JSON.stringify({ type: 'assistant', message: {
      stop_reason, content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'answer' }],
    } }), 0);
    expect(events.find(e => e.kind === 'assistant_text' && !e.thinking)).toHaveProperty('text', 'answer');
    for (const event of events) {
      if (event.kind === 'assistant_text') expect(event.turnComplete).toBe(stop_reason === 'end_turn' && !event.thinking ? true : undefined);
    }
  });
});
