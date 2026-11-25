import { describe, expect, it } from 'vitest';
import { applyHarnessEvents } from '../../../../shared/chatv2/apply';
import type { HarnessEvent } from '../../../../shared/chatv2/harnessEvents';
import { newChatSession, type ToolPreview } from '../../../../shared/chatv2/session';
import { foldTurns, groupToolRows, rowHolds, sessionRows, transcriptRows, type RowCache, type TranscriptRow } from '../rows';
import { absolutePath, relativeToCwd, toolLabelParts } from '../format';
import { callLabel, looksLikeGlob, shellOutput } from '../Transcript';
import { enteringKeys, newestKey } from '../ChatV2View';

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

let file = 0;
const readNew = () => read(`f${(file += 1)}.ts`);

describe('groupToolRows', () => {
  it('folds any run of two or more calls into one line; a single call stays its own row', () => {
    expect(shape(grouped([...readNew(), ...readNew(), ...readNew()]))).toEqual(['user', 'group:Read 3 files', 'footer']);
    expect(shape(grouped([...readNew(), ...readNew()]))).toEqual(['user', 'group:Read 2 files', 'footer']);
    expect(shape(grouped([...readNew()]))).toEqual(['user', 'tool', 'footer']);
  });

  it('counts the distinct files a run read or edited, and sums the edits\' diff stats', () => {
    expect(shape(grouped([...read('a.ts'), ...read('a.ts'), ...read('b.ts')]))[1]).toBe('group:Read 2 files');
    const rows = grouped([...edit(12, 3), ...edit(1, 0)]);
    expect(shape(rows)).toEqual(['user', 'group:Edited 1 file', 'footer']);
    expect(rows[1]).toMatchObject({ additions: 13, deletions: 3, count: 2 });
  });

  it('says a mixed run as one sentence, in the order its kinds were first used', () => {
    expect(shape(grouped([...readNew(), ...readNew(), ...readNew(), ...edit(1, 1), ...tool('execute'), ...readNew()]))[1])
      .toBe('group:Read 4 files, edited 1 file, ran 1 command');
    // The noun is not repeated when the item before already said it.
    expect(shape(grouped([...readNew(), ...readNew(), ...readNew(), ...tool('edit', { preview: { kind: 'write', path: '/repo/x.ts' } }), ...tool('edit', { preview: { kind: 'write', path: '/repo/y.ts' } })]))[1])
      .toBe('group:Read 3 files, edited 2');
    expect(shape(grouped([...tool('execute'), ...tool('search'), ...tool('search'), ...tool('fetch')]))[1])
      .toBe('group:Ran 1 command, searched 2 times, used 1 tool');
  });

  it('carries a failed call inside the run and counts it', () => {
    const rows = grouped([...readNew(), ...tool('read', { status: 'failed', preview: { kind: 'read', path: '/repo/gone.ts' } }), ...readNew()]);
    expect(shape(rows)).toEqual(['user', 'group:Read 3 files', 'footer']);
    expect(rows[1]).toMatchObject({ failed: 1, state: 'done' });
  });

  it('keeps a call that waits on an approval out of the run; a decided one rides along', () => {
    const pending = grouped([...readNew(), ...readNew(), ...tool('edit', { status: 'running' }), { type: 'approval.requested', requestId: 'r1', title: 'Edit', callId: `t${call}` }]);
    expect(shape(pending)).toEqual(['user', 'group:Read 2 files', 'tool', 'footer']);
    const decided = grouped([...readNew(), ...tool('edit', { status: 'running', preview: { kind: 'write', path: '/repo/d.ts' } }), { type: 'approval.requested', requestId: 'r2', title: 'Edit', callId: `t${call}` }, { type: 'approval.resolved', requestId: 'r2', decision: 'allow' }, { type: 'tool.updated', callId: `t${call}`, status: 'completed' }]);
    expect(shape(decided)).toEqual(['user', 'group:Read 1 file, edited 1', 'footer']);
  });

  it('breaks on assistant text, notices, questions and subagents', () => {
    expect(shape(grouped([...readNew(), ...readNew(), { type: 'message.delta', text: 'hm' }, { type: 'message.completed' }, ...readNew()])))
      .toEqual(['user', 'group:Read 2 files', 'assistant', 'tool', 'footer']);
    expect(shape(grouped([...readNew(), { type: 'session.error', message: 'boom' }, ...readNew()])))
      .toEqual(['user', 'tool', 'notice', 'tool', 'footer']);
    const asked = grouped([...readNew(), ...readNew(), { type: 'question.asked', requestId: 'q1', questions: [{ id: 'q0', prompt: 'Which?', multiSelect: false, allowCustom: true, options: [{ id: 'a', label: 'A' }] }] }]);
    expect(shape(asked)).toEqual(['user', 'group:Read 2 files', 'question', 'footer']);
    const agent = grouped([...readNew(), { type: 'tool.started', callId: 'agent', title: 'Agent', kind: 'agent', agentModel: 'claude-haiku-4-5-20251001', status: 'in_progress' }, ...readNew()]);
    expect(shape(agent)).toEqual(['user', 'tool', 'subagent', 'tool', 'footer']);
  });

  it('carries reasoning between calls inside the run, but leaves trailing reasoning outside', () => {
    const rows = grouped([
      ...readNew(), { type: 'reasoning.delta', text: 'next' }, { type: 'message.completed' },
      ...readNew(), ...readNew(), { type: 'reasoning.delta', text: 'then' },
    ]);
    expect(shape(rows)).toEqual(['user', 'group:Read 3 files', 'reasoning', 'footer']);
    const group = rows[1];
    if (group.kind !== 'toolGroup') throw new Error();
    expect(group.rows.map((row) => row.kind)).toEqual(['tool', 'reasoning', 'tool', 'tool']);
    expect(group.count).toBe(3);
  });

  it('keeps the group key while a run streams, and names the call in flight apart from the sentence', () => {
    const cache = new WeakMap();
    const before = fold([user, ...readNew(), ...readNew(), ...readNew()]);
    const first = groupToolRows(sessionRows(before, cache), cache);
    const again = groupToolRows(sessionRows(before, cache), cache);
    expect(again[1]).toBe(first[1]); // unchanged members: the same object
    const after = applyHarnessEvents(before, [{ seq: 50, at: 99_000, event: { type: 'tool.started', callId: 'live', title: 'npm test', kind: 'execute', status: 'in_progress' } }]);
    const second = groupToolRows(sessionRows(after, cache), cache);
    expect(shape(second)).toEqual(['user', 'group:Read 3 files', 'footer']);
    expect(second[1]).toMatchObject({ key: first[1].key, state: 'running', count: 4 });
    expect(second[1].kind === 'toolGroup' && second[1].current?.tool?.title).toBe('npm test');
    const done = applyHarnessEvents(after, [{ seq: 51, at: 100_000, event: { type: 'tool.updated', callId: 'live', status: 'completed' } }]);
    const third = groupToolRows(sessionRows(done, cache), cache);
    expect(third[1]).toMatchObject({ kind: 'toolGroup', key: first[1].key, label: 'Read 3 files, ran 1 command', state: 'done' });
  });
});

describe('calls a turn ended early, denials and search wording', () => {
  it('reads a call the turn\'s end cut short as stopped, not done', () => {
    const rows = sessionRows(fold([user, ...tool('execute', { status: 'running', title: 'npm test' }), { type: 'turn.ended', outcome: 'interrupted' }]));
    expect(rows.find((row) => row.kind === 'tool')).toMatchObject({ state: 'stopped' });
    const done = sessionRows(fold([user, ...tool('execute', { status: 'running', title: 'npm test' }), { type: 'turn.ended', outcome: 'completed' }]));
    expect(done.find((row) => row.kind === 'tool')).toMatchObject({ state: 'done' });
  });

  it('does not count a call the owner denied as failed', () => {
    const rows = grouped([...readNew(), ...tool('execute', { status: 'running', title: 'rm -rf x' }), { type: 'approval.requested', requestId: 'r-deny', title: 'Bash', callId: `t${call}` }, { type: 'approval.resolved', requestId: 'r-deny', decision: 'deny' }, { type: 'tool.updated', callId: `t${call}`, status: 'failed' }]);
    expect(rows[1]).toMatchObject({ kind: 'toolGroup', failed: 0 });
  });

  it('leaves a denied call out of the sentence and counts it apart; a stop during its approval is stopped, not failed', () => {
    const denied = grouped([...readNew(), ...tool('execute', { status: 'running', title: 'rm -rf x' }), { type: 'approval.requested', requestId: 'r-den2', title: 'Bash', callId: `t${call}` }, { type: 'approval.resolved', requestId: 'r-den2', decision: 'deny' }, { type: 'tool.updated', callId: `t${call}`, status: 'completed' }]);
    expect(denied[1]).toMatchObject({ kind: 'toolGroup', label: 'Read 1 file', denied: 1, failed: 0 });
    const cancelled = grouped([...readNew(), ...tool('execute', { status: 'running', title: 'npm test' }), { type: 'approval.requested', requestId: 'r-can', title: 'Bash', callId: `t${call}` }, { type: 'approval.resolved', requestId: 'r-can', decision: 'cancelled' }, { type: 'tool.updated', callId: `t${call}`, status: 'cancelled' }]);
    expect(cancelled[1]).toMatchObject({ kind: 'toolGroup', label: 'Read 1 file', stopped: 1, failed: 0 });
  });

  it('reads a call whose approval was settled without an answer but that then completed as done', () => {
    const rows = sessionRows(fold([user, ...tool('execute', { status: 'running', title: 'ls' }), { type: 'approval.requested', requestId: 'r-exp', title: 'Bash', callId: `t${call}` }, { type: 'approval.resolved', requestId: 'r-exp', decision: 'cancelled' }, { type: 'tool.updated', callId: `t${call}`, status: 'completed' }]));
    expect(rows.find((row) => row.kind === 'tool')).toMatchObject({ state: 'done' });
  });

  it('labels a lone denied call as denied, not as run', () => {
    const rows = sessionRows(fold([user, ...tool('execute', { status: 'running', title: 'rm -rf x' }), { type: 'approval.requested', requestId: 'r-lone', title: 'Bash', callId: `t${call}` }, { type: 'approval.resolved', requestId: 'r-lone', decision: 'deny' }, { type: 'tool.updated', callId: `t${call}`, status: 'failed' }]));
    const row = rows.find((candidate) => candidate.kind === 'tool');
    if (row?.kind !== 'tool') throw new Error();
    expect(callLabel(row.block, row.state, '/repo').verb).toBe('Denied');
  });

  it('counts edits with no path apiece, not as one file under a bare tool title', () => {
    expect(shape(grouped([...tool('edit', { title: 'Edit' }), ...tool('edit', { title: 'Edit' })]))[1]).toBe('group:Edited 2 files');
    // A title that names the file still counts the same file once.
    expect(shape(grouped([...tool('read', { title: 'Read a.ts' }), ...tool('read', { title: 'Read a.ts' })]))[1]).toBe('group:Read 1 file');
  });

  it('reads a glob as found files and a regex grep as a search', () => {
    expect(looksLikeGlob('src/**/*.ts')).toBe(true);
    expect(looksLikeGlob('src/daemon')).toBe(true);
    expect(looksLikeGlob('foo.*bar')).toBe(false);
    expect(looksLikeGlob('this\\.head')).toBe(false);
    expect(looksLikeGlob('evicts the oldest')).toBe(false);
  });
});

describe('foldTurns', () => {
  const ended: HarnessEvent = { type: 'turn.ended', outcome: 'completed' };
  const say = (text: string): HarnessEvent[] => [{ type: 'message.delta', text }, { type: 'message.completed' }];
  const folded = (events: HarnessEvent[], cache: RowCache = new WeakMap()) => transcriptRows(fold([user, ...events]), cache);
  const shapeOf = (rows: TranscriptRow[]) => rows.map((row) => (row.kind === 'turnFold' ? `fold:${row.rows.length}` : row.kind === 'toolGroup' ? `group:${row.label}` : row.kind));

  it('folds a settled turn\'s work under its prompt and leaves only the answer open', () => {
    const rows = folded([...say('Looking.'), ...readNew(), ...readNew(), { type: 'reasoning.delta', text: 'ok' }, { type: 'message.completed' }, ...say('Done: it works.'), ended]);
    expect(shapeOf(rows)).toEqual(['user', 'fold:3', 'assistant']);
    const fold0 = rows[1];
    if (fold0.kind !== 'turnFold') throw new Error();
    expect(fold0.rows.map((row) => row.kind)).toEqual(['assistant', 'toolGroup', 'reasoning']);
    expect(fold0).toMatchObject({ outcome: 'completed', answer: 'Done: it works.', failed: 0 });
    expect(fold0.durationMs).toBeGreaterThan(0);
  });

  it('leaves the open turn as it is, with its live footer', () => {
    expect(shapeOf(folded([...say('Looking.'), ...readNew()]))).toEqual(['user', 'assistant', 'tool', 'footer']);
  });

  it('keeps a plain receipt for a turn with no work, and the notice of a turn with no answer', () => {
    expect(shapeOf(folded([...say('Hi.'), ended]))).toEqual(['user', 'fold:0', 'assistant']);
    const failed = folded([...say('Reading.'), ...tool('read', { status: 'failed' }), { type: 'session.error', message: 'API Error: 529' }, { type: 'turn.ended', outcome: 'failed' }]);
    expect(shapeOf(failed)).toEqual(['user', 'fold:2', 'notice']);
    expect(failed[1]).toMatchObject({ outcome: 'failed', failed: 1, answer: '' });
  });

  it('keeps the answer open when the turn ends on a notice after it', () => {
    const rows = folded([...readNew(), ...say('The answer.'), { type: 'session.error', message: 'late' }, ended]);
    expect(shapeOf(rows)).toEqual(['user', 'fold:1', 'assistant', 'notice']);
    expect(rows[1]).toMatchObject({ answer: 'The answer.' });
  });

  it('offers no Copy answer when the answer was capped (only its first part is held)', () => {
    const user: TranscriptRow = { kind: 'user', key: 'u', block: { id: 'u', role: 'user', text: 'go' } };
    const capped: TranscriptRow = { kind: 'assistant', key: 'a', block: { id: 'a', role: 'assistant', text: 'The first part', overflow: { text: true } } };
    const next: TranscriptRow = { kind: 'user', key: 'u2', block: { id: 'u2', role: 'user', text: 'again' } };
    expect(foldTurns([user, capped, next])[1]).toMatchObject({ kind: 'turnFold', answer: '' });
  });

  it('keeps the answer and a status line after it open (answer, status, footer)', () => {
    const rows = folded([...readNew(), ...readNew(), ...say('The answer.'), { type: 'status', text: 'Continued in the terminal.' }, ended]);
    expect(shapeOf(rows)).toEqual(['user', 'fold:1', 'assistant', 'meta']);
    expect(rows[1]).toMatchObject({ answer: 'The answer.' });
  });

  it('folds a status line from the middle of the work, and keeps one that ends a turn with no answer', () => {
    expect(shapeOf(folded([...readNew(), { type: 'status', text: 'Compacting' }, ...tool('execute'), ...say('Done.'), ended]))).toEqual(['user', 'fold:3', 'assistant']);
    expect(shapeOf(folded([...readNew(), ...readNew(), { type: 'status', text: 'Continued in the terminal.' }, ended]))).toEqual(['user', 'fold:1', 'meta']);
  });

  it('stands an empty settled turn for its prompt, so settling is not news', () => {
    const rows = folded([ended]);
    expect(shapeOf(rows)).toEqual(['user', 'fold:0']);
    expect(newestKey(rows)).toBe(rows[0].key);
  });

  it('reads the newest row through the fold, so a tool-only turn that settles is not news', () => {
    const work = [...readNew(), ...readNew()];
    const live = folded(work);
    const settled = folded([...work, ended]);
    expect(shapeOf(settled)).toEqual(['user', 'fold:1']);
    expect(newestKey(live)).toBeDefined();
    expect(newestKey(settled)).toBe(newestKey(live));
  });

  it('folds every earlier turn, and finds a block through a fold and a run', () => {
    const rows = folded([...readNew(), ...readNew(), ...say('One.'), ended, { type: 'user.message', text: 'again', clientMessageId: 'c-00000002' }, ...say('Two.')]);
    expect(shapeOf(rows)).toEqual(['user', 'fold:1', 'assistant', 'user', 'assistant', 'footer']);
    const run = rows[1].kind === 'turnFold' ? rows[1].rows[0] : null;
    const inner = run?.kind === 'toolGroup' ? run.rows[0] : null;
    expect(inner && 'block' in inner && rowHolds(rows[1], inner.block.id)).toBe(true);
    expect(rowHolds(rows[2], 'nope')).toBe(false);
  });

  it('returns the same fold object while the turn is unchanged', () => {
    const cache: RowCache = new WeakMap();
    const session = fold([user, ...readNew(), ...say('A.'), ended]);
    expect(transcriptRows(session, cache)[1]).toBe(transcriptRows(session, cache)[1]);
  });
});

describe('shellOutput', () => {
  it('uses the preview output, else the result detail', () => {
    expect(shellOutput('out', 'Bash: ls', 'ls')).toBe('out');
    expect(shellOutput(undefined, 'a.ts\nb.ts', 'ls')).toBe('a.ts\nb.ts');
  });

  it('never shows the request detail as output, running or finished silent', () => {
    expect(shellOutput(undefined, 'Bash: git add .', 'git add .')).toBe('');
    // The request summary caps the command; a prefix still matches.
    expect(shellOutput(undefined, 'Bash: echo aaaa', 'echo aaaaaaaa')).toBe('');
    expect(shellOutput(undefined, undefined, 'true')).toBe('');
  });
});

describe('tool label parts', () => {
  it('splits a verb, past-tenses a finished edit, and gives a raw command a verb', () => {
    expect(toolLabelParts('Edit src/a.ts', { command: false, running: false })).toEqual({ verb: 'Edited', object: 'src/a.ts' });
    expect(toolLabelParts('Edit src/a.ts', { command: false, running: true })).toEqual({ verb: 'Editing', object: 'src/a.ts' });
    expect(toolLabelParts('Read a.ts', { command: false, running: true })).toEqual({ verb: 'Reading', object: 'a.ts' });
    expect(toolLabelParts('npm test', { command: true, running: true })).toEqual({ verb: 'Running', object: 'npm test' });
    expect(toolLabelParts('Read a.ts', { command: false, running: false })).toEqual({ verb: 'Read', object: 'a.ts' });
    expect(toolLabelParts('npm test', { command: true, running: false })).toEqual({ verb: 'Ran', object: 'npm test' });
  });

  it('shows paths under the chat\'s directory relative to it, only where a path starts', () => {
    expect(relativeToCwd('Read /repo/src/a.ts', '/repo')).toBe('Read src/a.ts');
    expect(relativeToCwd('cat "/repo/a b"', '/repo/')).toBe('cat "a b"');
    expect(relativeToCwd('/var/tmp/x', '/tmp')).toBe('/var/tmp/x');
    expect(relativeToCwd('/repox/a', '/repo')).toBe('/repox/a');
  });

  it('shortens Windows paths with either separator and either drive case, never under a drive root', () => {
    expect(relativeToCwd('Read C:\\work\\app\\src\\a.ts', 'C:\\work\\app')).toBe('Read src\\a.ts');
    expect(relativeToCwd('Read c:/work/app/src/a.ts', 'C:\\work\\app\\')).toBe('Read src/a.ts');
    expect(relativeToCwd('Read C:\\x\\y', 'C:\\')).toBe('Read C:\\x\\y');
  });

  it('shortens paths under a UNC share, keeping its two leading separators', () => {
    expect(relativeToCwd('Read \\\\srv\\share\\repo\\src\\a.ts', '\\\\srv\\share\\repo')).toBe('Read src\\a.ts');
    expect(relativeToCwd('Read //srv/share/repo/a.ts', '\\\\srv\\share\\repo\\')).toBe('Read a.ts');
    // One leading separator is another path, not the share.
    expect(relativeToCwd('Read \\srv\\share\\repo\\a.ts', '\\\\srv\\share\\repo')).toBe('Read \\srv\\share\\repo\\a.ts');
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
    const group: TranscriptRow = { kind: 'toolGroup', key: 'group:a', label: 'Read 3 files', count: 3, failed: 0, stopped: 0, denied: 0, state: 'done', additions: 0, deletions: 0, rows: [row('a'), row('b'), row('c')] };
    enteringKeys([group], known, entered);
    expect(entered.size).toBe(0);
  });
});

describe('enteringKeys with folded turns', () => {
  it('does not fade a turn fold that took in rows already shown', () => {
    const row = (key: string): TranscriptRow => ({ kind: 'meta', key, block: { id: key, role: 'system', text: key } });
    const entered = new Set<string>();
    const known = enteringKeys([row('u'), row('a'), row('b')], null, entered);
    const fold0: TranscriptRow = { kind: 'turnFold', key: 'u:fold', turnId: 'u', model: 'm', failed: 0, answer: 'b', rows: [row('a')] };
    enteringKeys([row('u'), fold0, row('b')], known, entered);
    expect(entered.size).toBe(0);
  });
});
