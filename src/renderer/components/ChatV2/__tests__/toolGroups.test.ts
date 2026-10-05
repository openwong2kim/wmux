import { describe, expect, it } from 'vitest';
import { applyHarnessEvents } from '../../../../shared/chatv2/apply';
import type { HarnessEvent } from '../../../../shared/chatv2/harnessEvents';
import { newChatSession, type ToolPreview } from '../../../../shared/chatv2/session';
import { groupToolRows, sessionRows, type TranscriptRow } from '../rows';
import { absolutePath, toolLabelParts } from '../format';
import { enteringKeys } from '../ChatV2View';

function fold(events: HarnessEvent[]) {
  return applyHarnessEvents(
    newChatSession({ id: 's', harness: 'claude', cwd: '/repo', model: 'claude-opus-5-5' }),
    events.map((event, index) => ({ seq: index + 1, at: 10_000 + index * 1_000, event })),
  );
}

let call = 0;
function tool(kind: string, opts: { status?: string; preview?: ToolPreview; title?: string } = {}): HarnessEvent[] {
  const callId = `t${(call += 1)}`;
  const started: HarnessEvent = { type: 'tool.started', callId, title: opts.title ?? kind, kind, status: 'in_progress', ...(opts.preview ? { preview: opts.preview } : {}) };
  return opts.status === 'running' ? [started] : [started, { type: 'tool.updated', callId, status: opts.status ?? 'completed' }];
}

const read = (path = 'a.ts') => tool('read', { preview: { kind: 'read', path: `/repo/${path}` } });
const edit = (additions: number, deletions: number) =>
  tool('edit', { preview: { kind: 'write', path: '/repo/e.ts', additions, deletions, lines: [{ kind: 'add', text: 'x' }] } });
const user: HarnessEvent = { type: 'user.message', text: 'go', clientMessageId: 'c-00000001' };

function grouped(events: HarnessEvent[]): TranscriptRow[] {
  return groupToolRows(sessionRows(fold([user, ...events])));
}
const shape = (rows: TranscriptRow[]) => rows.map((row) => (row.kind === 'toolGroup' ? `group:${row.label}` : row.kind));

describe('groupToolRows', () => {
  it('folds three reads, but not two', () => {
    expect(shape(grouped([...read(), ...read(), ...read()]))).toEqual(['user', 'group:Read 3 files', 'footer']);
    expect(shape(grouped([...read(), ...read()]))).toEqual(['user', 'tool', 'tool', 'footer']);
  });

  it('folds two file edits and sums their diff stats', () => {
    const rows = grouped([...edit(12, 3), ...edit(1, 0)]);
    expect(shape(rows)).toEqual(['user', 'group:Edited 2 files', 'footer']);
    expect(rows[1]).toMatchObject({ additions: 13, deletions: 3, count: 2 });
  });

  it('labels commands and searches', () => {
    expect(shape(grouped([...tool('execute'), ...tool('execute'), ...tool('execute')]))[1]).toBe('group:Ran 3 commands');
    expect(shape(grouped([...tool('search'), ...tool('search'), ...tool('search')]))[1]).toBe('group:Searched 3 times');
  });

  it('folds a mixed run of three into "Ran N tool calls"', () => {
    expect(shape(grouped([...read(), ...tool('execute'), ...edit(1, 1)]))[1]).toBe('group:Ran 3 tool calls');
    expect(shape(grouped([...read(), ...tool('execute')]))).toEqual(['user', 'tool', 'tool', 'footer']);
  });

  it('splits a run into same-kind groups before folding what is left as mixed', () => {
    const rows = grouped([...read(), ...read(), ...read(), ...read(), ...edit(5, 1), ...edit(0, 0), ...tool('execute'), ...tool('execute'), ...tool('execute')]);
    expect(shape(rows)).toEqual(['user', 'group:Read 4 files', 'group:Edited 2 files', 'group:Ran 3 commands', 'footer']);
    expect(rows[2]).toMatchObject({ additions: 5, deletions: 1 });
    // Two calls between two same-kind groups are too few to fold.
    const between = grouped([...read(), ...read(), ...read(), ...tool('execute'), ...edit(1, 0), ...read(), ...read(), ...read()]);
    expect(shape(between)).toEqual(['user', 'group:Read 3 files', 'tool', 'tool', 'group:Read 3 files', 'footer']);
  });

  it('never folds a failed tool: it splits the run', () => {
    const rows = grouped([...read(), ...read(), ...read(), ...tool('read', { status: 'failed' }), ...read(), ...read()]);
    expect(shape(rows)).toEqual(['user', 'group:Read 3 files', 'tool', 'tool', 'tool', 'footer']);
    expect(rows[2]).toMatchObject({ kind: 'tool', state: 'failed' });
  });

  it('never folds a tool with an approval, pending or decided', () => {
    const pending = grouped([...read(), ...read(), ...tool('edit', { status: 'running' }), { type: 'approval.requested', requestId: 'r1', title: 'Edit', callId: `t${call}` }, ...read()]);
    expect(shape(pending)).toEqual(['user', 'tool', 'tool', 'tool', 'tool', 'footer']);
    const decided = grouped([...read(), ...read(), ...read(), ...tool('edit', { status: 'running' }), { type: 'approval.requested', requestId: 'r2', title: 'Edit', callId: `t${call}` }, { type: 'approval.resolved', requestId: 'r2', decision: 'allow' }]);
    expect(shape(decided)).toEqual(['user', 'group:Read 3 files', 'tool', 'footer']);
  });

  it('breaks on assistant text, notices and questions', () => {
    expect(shape(grouped([...read(), ...read(), { type: 'message.delta', text: 'hm' }, { type: 'message.completed' }, ...read()])))
      .toEqual(['user', 'tool', 'tool', 'assistant', 'tool', 'footer']);
    expect(shape(grouped([...read(), ...read(), { type: 'session.error', message: 'boom' }, ...read()])))
      .toEqual(['user', 'tool', 'tool', 'notice', 'tool', 'footer']);
    const asked = grouped([...read(), ...read(), ...read(), { type: 'question.asked', requestId: 'q1', questions: [{ id: 'q0', prompt: 'Which?', multiSelect: false, allowCustom: true, options: [{ id: 'a', label: 'A' }] }] }]);
    expect(shape(asked)).toEqual(['user', 'group:Read 3 files', 'question', 'footer']);
  });

  it('never folds a subagent row', () => {
    const rows = grouped([...read(), ...read(), { type: 'tool.started', callId: 'agent', title: 'Agent', kind: 'agent', agentModel: 'claude-haiku-4-5-20251001', status: 'in_progress' }, ...read()]);
    expect(shape(rows)).toEqual(['user', 'tool', 'tool', 'subagent', 'tool', 'footer']);
  });

  it('carries reasoning between calls inside the group, but leaves trailing reasoning outside', () => {
    const rows = grouped([
      ...read(), { type: 'reasoning.delta', text: 'next' }, { type: 'message.completed' },
      ...read(), ...read(), { type: 'reasoning.delta', text: 'then' },
    ]);
    expect(shape(rows)).toEqual(['user', 'group:Read 3 files', 'reasoning', 'footer']);
    const group = rows[1];
    if (group.kind !== 'toolGroup') throw new Error();
    expect(group.rows.map((row) => row.kind)).toEqual(['tool', 'reasoning', 'tool', 'tool']);
    expect(group.count).toBe(3);
  });

  it('keeps the group key and updates the count in place while a run streams', () => {
    const cache = new WeakMap();
    const events = [user, ...read(), ...read(), ...read()];
    const before = fold(events);
    const first = groupToolRows(sessionRows(before, cache), cache);
    const again = groupToolRows(sessionRows(before, cache), cache);
    expect(again[1]).toBe(first[1]); // unchanged members: the same object
    const after = applyHarnessEvents(before, [{ seq: 50, at: 99_000, event: { type: 'tool.started', callId: 'live', title: 'Read', kind: 'read', status: 'in_progress' } }]);
    const second = groupToolRows(sessionRows(after, cache), cache);
    expect(second[1]).toMatchObject({ kind: 'toolGroup', key: first[1].key, label: 'Read 4 files', state: 'running' });
  });
});

describe('tool label parts', () => {
  it('splits a verb, past-tenses a finished edit, and gives a raw command a verb', () => {
    expect(toolLabelParts('Edit src/a.ts', { command: false, running: false })).toEqual({ verb: 'Edited', object: 'src/a.ts' });
    expect(toolLabelParts('Edit src/a.ts', { command: false, running: true })).toEqual({ verb: 'Edit', object: 'src/a.ts' });
    expect(toolLabelParts('Read a.ts', { command: false, running: false })).toEqual({ verb: 'Read', object: 'a.ts' });
    expect(toolLabelParts('npm test', { command: true, running: false })).toEqual({ verb: 'Ran', object: 'npm test' });
  });

  it('resolves a relative preview path against the cwd only', () => {
    expect(absolutePath('src/a.ts', '/repo/')).toBe('/repo/src/a.ts');
    expect(absolutePath('/abs/a.ts', '/repo')).toBe('/abs/a.ts');
    expect(absolutePath('C:\\x\\a.ts', '/repo')).toBe('C:\\x\\a.ts');
  });
});

describe('enteringKeys', () => {
  const row = (key: string): TranscriptRow => ({ kind: 'meta', key, block: { id: key, role: 'system', text: key } });
  const footer: TranscriptRow = { kind: 'footer', key: 'f', turnId: 'u', model: 'm', live: true };

  it('marks nothing on the first load, then only rows appended after the last one shown', () => {
    const entered = new Set<string>();
    let known = enteringKeys([row('a'), row('b'), footer], null, entered);
    expect(entered.size).toBe(0);
    known = enteringKeys([row('a'), row('b'), row('c'), footer], known, entered);
    expect([...entered]).toEqual(['c']);
    // An earlier page prepended above the first row is not new.
    enteringKeys([row('z'), row('a'), row('b'), row('c'), footer], known, entered);
    expect([...entered]).toEqual(['c']);
  });

  it('does not fade a group that absorbed rows already shown', () => {
    const entered = new Set<string>();
    const known = enteringKeys([row('a'), row('b')], null, entered);
    const group: TranscriptRow = { kind: 'toolGroup', key: 'group:a', label: 'Read 3 files', count: 3, state: 'done', additions: 0, deletions: 0, rows: [row('a'), row('b'), row('c')] };
    enteringKeys([group], known, entered);
    expect(entered.size).toBe(0);
  });
});
