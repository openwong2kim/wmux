import { execFileSync } from 'node:child_process';
import { buildExecArgs } from '../../execWrapper';
import { describe, expect, it } from 'vitest';
import { buildAgentLaunch, claudeOptionsFromHelp, codexOptionsFromCache } from '../agentLaunch';
const help = "Claude Code\n --model <model> alias 'sonnet'\n --effort <level> Effort level (low, medium, high, xhigh, max)";
describe('advertised agent launch flags', () => {
  it('discovers effort flags from the installed CLI help', () => {
    expect(claudeOptionsFromHelp(help)).toEqual({ agent: 'claude', models: ['sonnet','opus','haiku'], efforts: ['low','medium','high','xhigh','max'] });
    expect(claudeOptionsFromHelp("Claude Code --model <model> 'fable'")?.models).toContain('fable');
    expect(claudeOptionsFromHelp('other CLI --model')).toBeNull();
    expect(claudeOptionsFromHelp('Claude Code --model')?.efforts).toEqual([]);
  });
  it('builds only the selected supported flags without inventing a prompt', () => {
    const options = [claudeOptionsFromHelp(help)!];
    expect(buildAgentLaunch({agent:'claude',model:'opus',effort:'high'},options)).toBe('claude --model opus --effort high');
    expect(buildAgentLaunch({agent:'claude'},options)).toBe('claude');
  });
  it.each([
    {agent:'shell'}, {agent:'claude',model:'opus; touch /tmp/unwanted'},
    {agent:'claude',model:'opus\nwhoami'}, {agent:'claude',effort:'ultra'},
    {agent:'claude',model:'--dangerously-skip-permissions'},
  ])('refuses unadvertised or executable values %j', value => {
    expect(() => buildAgentLaunch(value,[claudeOptionsFromHelp(help)!])).toThrow();
  });
  it('does not guess effort support on an older CLI', () => {
    expect(() => buildAgentLaunch({agent:'claude',effort:'high'},[claudeOptionsFromHelp('Claude Code --model')!])).toThrow('Unsupported effort');
    expect(() => buildAgentLaunch({agent:'claude'},[])).toThrow('unavailable');
  });
});

describe('Codex model and effort catalog', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  const cache = { fetched_at: new Date(now).toISOString(), identity: { secret: 'never expose' }, models: [
    { slug:'model-a', visibility:'list', supported_reasoning_levels:[{effort:'low'},{effort:'high'}], description:'private instructions' },
    { slug:'model-b', visibility:'list', supported_reasoning_levels:[{effort:'medium'}] },
    { slug:'hidden', visibility:'hide', supported_reasoning_levels:[{effort:'high'}] },
    { slug:'bad;command', visibility:'list', supported_reasoning_levels:[{effort:'high'}] },
  ] };
  it('projects only visible safe model IDs and per-model effort values', () => {
    expect(codexOptionsFromCache(cache,now)).toEqual({agent:'codex',models:['model-a','model-b'],efforts:[],modelEfforts:{'model-a':['low','high'],'model-b':['medium']},catalogState:'cached'});
  });
  it('does not invent models from missing, stale or malformed cache', () => {
    for (const value of [null,{}, {...cache,fetched_at:'invalid'}, {...cache,fetched_at:new Date(now-86400001).toISOString()}]) {
      expect(codexOptionsFromCache(value,now).models).toEqual([]);
      expect(codexOptionsFromCache(value,now).catalogState).toBe('unavailable');
    }
  });
  it('enforces the selected model effort contract when building real CLI flags', () => {
    const options = [codexOptionsFromCache(cache,now)];
    expect(buildAgentLaunch({agent:'codex',model:'model-a',effort:'high'},options)).toBe('codex --model model-a -c model_reasoning_effort=high');
    expect(() => buildAgentLaunch({agent:'codex',model:'model-b',effort:'high'},options)).toThrow('Unsupported effort');
    expect(() => buildAgentLaunch({agent:'codex',effort:'high'},options)).toThrow('Unsupported effort');
    expect(buildAgentLaunch({agent:'codex'},options)).toBe('codex');
  });
});

it.skipIf(process.platform === 'win32')('passes model and effort as separate argv through the actual POSIX exec wrapper', () => {
  const options = [{agent:'codex' as const,models:['model-a'],efforts:[],modelEfforts:{'model-a':['high']}}];
  const command = buildAgentLaunch({agent:'codex',model:'model-a',effort:'high'},options);
  const fixture = 'codex() { printf "%s\\n" "$@"; }; ' + command;
  const output = execFileSync('/bin/sh',buildExecArgs('/bin/sh',fixture)!,{encoding:'utf8'});
  expect(output.trim().split('\n')).toEqual(['--model','model-a','-c','model_reasoning_effort=high']);
});
