import { describe, it, expect } from 'vitest';
import { BotToolGuard, botToolNamingRule } from '../botToolGuard';
import type { RawSdkMessage } from '../BrainAdapter';

const ALLOWED = ['mcp__wmux__room_post', 'mcp__wmux__fanout_start'];
const call = (id: string, name: string): RawSdkMessage => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name }] } });
const result = (id: string, isError: boolean): RawSdkMessage =>
  ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });

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

  it('the naming rule lists only the wmux tools', () => {
    expect(botToolNamingRule(['Read', ...ALLOWED])).toContain('mcp__wmux__room_post, mcp__wmux__fanout_start.');
    expect(botToolNamingRule(['Read'])).toBe('');
  });
});
