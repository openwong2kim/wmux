// The transcript's pending tool call — what a terminal_prompt binds to.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandOfToolInput, latestPendingToolUse, readPendingToolUse } from '../pendingToolUse';

const useEntry = (id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', ...extra, message: { content: [{ type: 'tool_use', id, name, input }] },
});
const resultEntry = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

describe('latestPendingToolUse', () => {
  it('is the latest tool_use with no result yet', () => {
    expect(latestPendingToolUse([
      useEntry('t1', 'Bash', { command: 'ls' }),
      resultEntry('t1'),
      useEntry('t2', 'Bash', { command: 'rm -rf build' }),
    ])).toEqual({ id: 't2', name: 'Bash', input: { command: 'rm -rf build' } });
  });

  it('is null once the latest call has its result, or when there is none', () => {
    expect(latestPendingToolUse([useEntry('t1', 'Bash', { command: 'ls' }), resultEntry('t1')])).toBeNull();
    expect(latestPendingToolUse([])).toBeNull();
    expect(latestPendingToolUse(['junk', null, { type: 'user' }])).toBeNull();
  });

  it('ignores subagent (sidechain) calls', () => {
    expect(latestPendingToolUse([
      useEntry('t1', 'Bash', { command: 'ls' }),
      useEntry('s1', 'Bash', { command: 'rm -rf x' }, { isSidechain: true }),
    ])?.id).toBe('t1');
  });
});

describe('readPendingToolUse', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('reads the tail of the file, skipping a cut first line and a half-written last one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pending-tool-'));
    dirs.push(dir);
    const file = path.join(dir, 'conv.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'x'.repeat(400) } }),
      JSON.stringify(useEntry('t9', 'Bash', { command: 'npm test' })),
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n{"type":"assist`);
    expect(readPendingToolUse(file, 200)?.id).toBe('t9');
    expect(readPendingToolUse(path.join(dir, 'missing.jsonl'))).toBeNull();
  });
});

describe('commandOfToolInput', () => {
  it('is Bash\'s command, else the path the call acts on', () => {
    expect(commandOfToolInput('Bash', { command: 'ls -la', description: 'List' })).toBe('ls -la');
    expect(commandOfToolInput('Write', { file_path: '/tmp/a.txt', content: 'x' })).toBe('/tmp/a.txt');
    expect(commandOfToolInput('Bash', { file_path: '/tmp/a.txt' })).toBeUndefined();
  });
});
