import { parseTranscriptLineDetailed, type ParsedTranscriptLine } from './parseEntry';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Project the CLI's own rollout. Event messages are the display transcript;
 * response_item messages also contain injected context and duplicate display
 * messages, so those are deliberately not treated as user conversation.
 * Tool response items have no display duplicate here and retain their call IDs.
 * No model/server process is created by this adapter. */
export function parseCodexLineDetailed(line: string, offset: number): ParsedTranscriptLine {
  const empty = (): ParsedTranscriptLine => ({ events: [], bodies: new Map() });
  let entry: Record<string, unknown>;
  try { entry = object(JSON.parse(line)); } catch { return empty(); }
  const payload = object(entry.payload);
  const id = `codex:${offset}`;
  const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
  const convert = (role: 'user' | 'assistant', content: unknown): ParsedTranscriptLine => {
    const result = parseTranscriptLineDetailed(JSON.stringify({ type: role, uuid: id, timestamp: entry.timestamp, message: { role, content } }), offset);
    for (const event of result.events) event.turnId = turnId;
    return result;
  };
  if (entry.type === 'event_msg') {
    if (['task_started', 'task_complete', 'turn_aborted'].includes(String(payload.type))) {
      const subtype = payload.type === 'task_started' ? 'turn_started' : payload.type === 'task_complete' ? 'turn_complete' : 'turn_aborted';
      return { events: [{ id, kind: 'meta', subtype, label: subtype === 'turn_started' ? 'Working' : subtype === 'turn_complete' ? 'Completed' : 'Interrupted', turnId, ...(Number.isFinite(ts) ? { ts } : {}) }], bodies: new Map() };
    }
    // Older CLI versions publish display text directly. Recent versions publish
    // item_completed instead; neither path reads response_item message copies.
    if (payload.type === 'user_message' && typeof payload.message === 'string') return convert('user', payload.message);
    if (payload.type === 'agent_message' && typeof payload.message === 'string') return convert('assistant', [{ type: 'text', text: payload.message }]);
    if (payload.type !== 'item_completed') return empty();
    const item = object(payload.item);
    if (!['UserMessage', 'AgentMessage', 'Reasoning'].includes(String(item.type))) return empty();
    const content = Array.isArray(item.content) ? item.content.flatMap(part => {
      const p = object(part);
      return ['text', 'Text'].includes(String(p.type)) && typeof p.text === 'string' ? [{ type: 'text', text: p.text }] : [];
    }) : [];
    if (item.type === 'Reasoning') return empty(); // Never expose encrypted/private reasoning.
    return convert(item.type === 'UserMessage' ? 'user' : 'assistant', content);
  }
  if (entry.type !== 'response_item' || typeof payload.call_id !== 'string') return empty();
  if (['function_call', 'custom_tool_call'].includes(String(payload.type)) && typeof payload.name === 'string') {
    const raw = payload.arguments ?? payload.input;
    let input: unknown = raw;
    if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { /* Plain-text custom tool input. */ } }
    return convert('assistant', [{ type: 'tool_use', id: payload.call_id, name: payload.name, input }]);
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(String(payload.type))) {
    const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
    return convert('user', [{ type: 'tool_result', tool_use_id: payload.call_id, content: output }]);
  }
  return empty();
}
