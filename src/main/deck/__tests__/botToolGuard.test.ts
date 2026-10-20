import { describe, it, expect } from 'vitest';
import { BotToolGuard, botToolNamingRule, REPEAT_LIMIT } from '../botToolGuard';
import type { RawSdkMessage } from '../BrainAdapter';

const ALLOWED = ['mcp__wmux__room_post', 'mcp__wmux__fanout_start'];
const call = (id: string, name: string, input?: unknown): RawSdkMessage =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, isError: boolean, content?: unknown): RawSdkMessage =>
  ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } }) as unknown as RawSdkMessage;

/** Feeds one call and its result; returns what the guard said on the result. */
let seq = 0;
const step = (g: BotToolGuard, name: string, input: unknown, isError: boolean, content: unknown): string | null => {
  const id = `t${seq++}`;
  expect(g.observe(call(id, name, input))).toBeNull();
  return g.observe(result(id, isError, content));
};

describe('BotToolGuard', () => {
  it('without an init frame, a bare wmux name still counts', () => {
    const g = new BotToolGuard(ALLOWED);
    g.observe(call('a', 'room_post'));
    g.observe(result('a', true));
    expect(g.verdict()).toMatch(/called room_post/);
  });

  it('other tools it does not hold are not a wmux-name slip', () => {
    const g = new BotToolGuard(ALLOWED);
    g.observe({ type: 'system', subtype: 'init', tools: ['Read', ...ALLOWED], mcp_servers: [{ name: 'wmux', status: 'connected' }] });
    g.observe(call('a', 'WebSearch'));
    g.observe(result('a', true));
    expect(g.verdict()).toBeNull();
  });

  it('a wmux server still connecting is not an error yet', () => {
    const g = new BotToolGuard(ALLOWED);
    expect(g.observe({ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'wmux', status: 'pending' }] })).toBeNull();
    expect(new BotToolGuard(ALLOWED).observe({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] })).toMatch(/missing/);
  });

  it('a failed real wmux call is not a missing tool', () => {
    const g = new BotToolGuard(ALLOWED);
    g.observe(call('a', 'mcp__wmux__fanout_start'));
    g.observe(result('a', true));
    expect(g.verdict()).toBeNull();
  });

  it('stops on the third identical failing call', () => {
    const g = new BotToolGuard(ALLOWED);
    const input = { room: 'r1', text: 'hi' };
    expect(step(g, 'mcp__wmux__room_post', input, true, 'room not found')).toBeNull();
    expect(step(g, 'mcp__wmux__room_post', input, true, 'room not found')).toBeNull();
    expect(step(g, 'mcp__wmux__room_post', input, true, 'room not found'))
      .toBe('Stopped: room_post was called 3 times in a row with the same input and the same result.');
  });

  it('stops a wmux refusal repeated without is_error', () => {
    const g = new BotToolGuard(ALLOWED);
    const input = { thread_id: 'not-a-thread', text: 'hi' };
    // The MCP server's envelope: the RPC reply, pretty-printed, as one text block.
    const refusal = [{ type: 'text', text: JSON.stringify({ ok: false, code: 'invalid', message: 'no such thread' }, null, 2) }];
    expect(step(g, 'mcp__wmux__room_post', input, false, refusal)).toBeNull();
    expect(step(g, 'mcp__wmux__room_post', input, false, refusal)).toBeNull();
    expect(step(g, 'mcp__wmux__room_post', input, false, refusal)).toMatch(/^Stopped: room_post was called 3 times/);
  });

  it('a refused real wmux call after a bare-name slip is not a naming failure', () => {
    const g = new BotToolGuard(ALLOWED);
    step(g, 'room_post', {}, true, 'No such tool available: room_post');
    step(g, 'mcp__wmux__room_post', { thread_id: 'x' }, false, [{ type: 'text', text: '{"ok":false,"code":"invalid"}' }]);
    expect(g.verdict()).toBeNull();
  });

  it('input key order does not make a call different', () => {
    const g = new BotToolGuard(ALLOWED);
    step(g, 'Read', { file_path: '/a', limit: 5 }, true, [{ type: 'text', text: 'ENOENT' }]);
    step(g, 'Read', { limit: 5, file_path: '/a' }, true, [{ type: 'text', text: 'ENOENT' }]);
    expect(step(g, 'Read', { file_path: '/a', limit: 5 }, true, [{ type: 'text', text: 'ENOENT' }])).toMatch(/^Stopped: Read was called 3 times/);
  });

  it('the same input with a different result each time is progress', () => {
    const g = new BotToolGuard(ALLOWED);
    for (const out of ['busy 1', 'busy 2', 'busy 3', 'busy 4']) expect(step(g, 'Bash', { command: 'make' }, true, out)).toBeNull();
  });

  it('a different call resets the streak', () => {
    const g = new BotToolGuard(ALLOWED);
    step(g, 'Bash', { command: 'make' }, true, 'fail');
    step(g, 'Bash', { command: 'make' }, true, 'fail');
    expect(step(g, 'Bash', { command: 'make -j1' }, true, 'fail')).toBeNull();
    expect(step(g, 'Bash', { command: 'make' }, true, 'fail')).toBeNull();
    expect(step(g, 'Bash', { command: 'make' }, true, 'fail')).toBeNull();
    expect(step(g, 'Bash', { command: 'make' }, true, 'fail')).toMatch(/^Stopped: Bash/);
  });

  it('identical successful calls do not stop the turn (a bot polling while it waits)', () => {
    const g = new BotToolGuard(ALLOWED);
    for (let i = 0; i < 2 * REPEAT_LIMIT; i++) {
      expect(step(g, 'mcp__wmux__a2a_task_query', { task_id: 't' }, false, 'working')).toBeNull();
      expect(step(g, 'Bash', { command: 'sleep 30' }, false, '')).toBeNull();
    }
  });

  it('stops two failing calls taking turns', () => {
    const g = new BotToolGuard(ALLOWED);
    const verdicts: Array<string | null> = [];
    for (let i = 0; i < REPEAT_LIMIT; i++) {
      verdicts.push(step(g, 'Read', { file_path: '/a' }, false, 'old text'));
      verdicts.push(step(g, 'Edit', { file_path: '/a', old_string: 'x' }, true, 'String not found'));
    }
    expect(verdicts.slice(0, -1).every((v) => v === null)).toBe(true);
    expect(verdicts[verdicts.length - 1]).toBe('Stopped: Read and Edit were called in turn 3 times each with the same inputs and the same results.');
  });

  it('the naming rule lists only the wmux tools', () => {
    expect(botToolNamingRule(['Read', ...ALLOWED])).toContain('mcp__wmux__room_post, mcp__wmux__fanout_start.');
    expect(botToolNamingRule(['Read'])).toBe('');
  });
});
