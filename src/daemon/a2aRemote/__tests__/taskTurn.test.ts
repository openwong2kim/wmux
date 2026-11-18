// stepTaskTurn: the turn a delivered task's prompt opened in a Claude Code
// transcript, until its first end, and the tool calls made inside it.
import { describe, expect, it } from 'vitest';
import { promptHash } from '../../../shared/promptHash';
import { parseTranscriptLine } from '../../transcript/parseEntry';
import { isPromptEntry, stepTaskTurn, type TaskTurn } from '../taskTurn';

const PROMPT = '[wmux] task rt-00000000000000000000000000000001 from Mac/ws/#1:\n> Reply with PONG';

let seq = 0;
const stamp = (): string => new Date(Date.UTC(2026, 10, 13, 0, 0, seq++)).toISOString();
const userLine = (text: string): string => JSON.stringify({ type: 'user', uuid: `u${seq}`, timestamp: stamp(), message: { role: 'user', content: text } });
const assistantLine = (text: string, stop: string | null = 'end_turn'): string => JSON.stringify({
  type: 'assistant', uuid: `a${seq}`, timestamp: stamp(),
  message: { role: 'assistant', content: [{ type: 'text', text }], ...(stop ? { stop_reason: stop } : {}) },
});
const callLine = (id: string, input: object = { command: 'uname -s' }): string => JSON.stringify({ type: 'assistant', uuid: `c${seq}`, timestamp: stamp(),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }], stop_reason: 'tool_use' } });
const resultLine = (id: string): string => JSON.stringify({ type: 'user', uuid: `r${seq}`, timestamp: stamp(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Linux' }] } });
const side = (line: string): string => JSON.stringify({ ...JSON.parse(line) as object, isSidechain: true });

function turn(): TaskTurn {
  return { promptHash: promptHash(PROMPT), opened: false, closed: false, toolUseIds: [] };
}

function run(lines: string[]): TaskTurn {
  const t = turn();
  let offset = 0;
  for (const line of lines) {
    stepTaskTurn(t, line, parseTranscriptLine(line, offset));
    offset += line.length + 1;
  }
  return t;
}

describe('stepTaskTurn', () => {
  it('opens on the delivered prompt, collects its tool calls, and closes on the first turn end', () => {
    const t = run([
      userLine(PROMPT),
      callLine('toolu_1'),
      resultLine('toolu_1'),
      callLine('toolu_2'),
      resultLine('toolu_2'),
      assistantLine('PONG'),
      // The next turn: not the task's.
      userLine('something else'),
      callLine('toolu_3'),
    ]);
    expect(t).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_1', 'toolu_2'] });
  });

  it('stays open (not closed) while the turn runs', () => {
    const t = run([userLine(PROMPT), callLine('toolu_1')]);
    expect(t).toMatchObject({ opened: true, closed: false, toolUseIds: ['toolu_1'] });
  });

  it('a prompt stored as a paste (markers, line breaks) still opens it', () => {
    expect(run([userLine(`<pasted_content id="1">\n${PROMPT}\n</pasted_content id="1">`)]).opened).toBe(true);
  });

  it('other input inside the turn closes it', () => {
    const t = run([userLine(PROMPT), callLine('toolu_1'), resultLine('toolu_1'), userLine('stop, do this instead'), callLine('toolu_2')]);
    expect(t).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_1'] });
  });

  it('other input before the prompt closes it, and the prompt then does not open it', () => {
    const t = run([userLine('typed by the person first'), userLine(PROMPT), callLine('toolu_1')]);
    expect(t).toMatchObject({ opened: false, closed: true, toolUseIds: [] });
  });

  it('ignores a subagent (sidechain) entry: its prompt, its tool calls and its turn end', () => {
    const t = run([
      side(userLine(PROMPT)),
      userLine(PROMPT),
      side(userLine('subagent prompt')),
      side(callLine('toolu_side')),
      side(assistantLine('subagent done')),
      callLine('toolu_1'),
    ]);
    expect(t).toMatchObject({ opened: true, closed: false, toolUseIds: ['toolu_1'] });
  });

  it('a turn end that leaves background work running closes it (later turns are not the task\'s)', () => {
    const t = run([
      userLine(PROMPT),
      callLine('toolu_bg', { command: 'sleep 20 && echo DONE', run_in_background: true }),
      resultLine('toolu_bg'),
      assistantLine('Started it in the background.'),
      callLine('toolu_after'),
    ]);
    expect(t).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_bg'] });
  });

  it('an interrupt closes it', () => {
    const interrupt = JSON.stringify({ type: 'user', uuid: `i${seq}`, timestamp: stamp(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    const t = run([userLine(PROMPT), callLine('toolu_1'), interrupt, callLine('toolu_2')]);
    expect(t).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_1'] });
  });

  it('a prompt typed at the agent closes it, marked as typed or not', () => {
    const typed = JSON.stringify({ type: 'user', uuid: `y${seq}`, timestamp: stamp(), origin: { kind: 'human' }, promptSource: 'typed',
      message: { role: 'user', content: [{ type: 'text', text: 'and also this' }] } });
    expect(run([userLine(PROMPT), callLine('toolu_1'), typed, callLine('toolu_2')])).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_1'] });
  });

  it('Claude Code going on by itself after a usage limit closes it (notice or its own prompt)', () => {
    const notice = JSON.stringify({ type: 'system', subtype: 'informational', isSidechain: false, timestamp: stamp(), content: 'Usage limit reset · Continuing automatically' });
    const resume = JSON.stringify({ type: 'user', isSidechain: false, timestamp: stamp(), isMeta: true, origin: { kind: 'auto-continuation' }, turnOrigin: 'auto_continuation',
      message: { role: 'user', content: 'Your usage limit has reset. Continue.' } });
    expect(run([userLine(PROMPT), callLine('toolu_1'), notice, callLine('toolu_2')])).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_1'] });
    expect(run([userLine(PROMPT), callLine('toolu_1'), resume, callLine('toolu_2')])).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_1'] });
  });

  it('a queued command closes it, and one carrying the task\'s own prompt never opens it', () => {
    const queued = (prompt: string): string => JSON.stringify({ type: 'attachment', isSidechain: false, timestamp: stamp(), attachment: { type: 'queued_command', prompt } });
    expect(run([userLine(PROMPT), callLine('toolu_1'), queued('next'), callLine('toolu_2')])).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_1'] });
    expect(run([queued(PROMPT), callLine('toolu_1')])).toMatchObject({ opened: false, closed: true, toolUseIds: [] });
  });

  it('a meta user entry (a wake, a notification) closes it; tool results do not', () => {
    const wake = JSON.stringify({ type: 'user', timestamp: stamp(), isMeta: true, turnOrigin: 'scheduled', promptSource: 'system', message: { role: 'user', content: 'scheduled wake' } });
    expect(run([userLine(PROMPT), callLine('toolu_1'), resultLine('toolu_1'), wake, callLine('toolu_2')])).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_1'] });
  });

  it('the same prompt a second time closes it', () => {
    expect(run([userLine(PROMPT), callLine('toolu_1'), userLine(PROMPT), callLine('toolu_2')])).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_1'] });
  });

  it('isPromptEntry matches the prompt\'s own user entry only', () => {
    const hash = promptHash(PROMPT);
    expect(isPromptEntry(userLine(PROMPT), hash)).toBe(true);
    expect(isPromptEntry(userLine('other'), hash)).toBe(false);
    expect(isPromptEntry(side(userLine(PROMPT)), hash)).toBe(false);
    expect(isPromptEntry(assistantLine(PROMPT), hash)).toBe(false);
    expect(isPromptEntry('not json', hash)).toBe(false);
  });
});
