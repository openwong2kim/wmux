import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResumeBinding } from '../../../shared/agentResume';
import { TranscriptActivityWatcher, codexToolSummary } from '../TranscriptActivityWatcher';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-activity-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ts = '2026-10-05T12:00:00.000Z';
const claudeTool = (id: string, name: string, input: unknown) => JSON.stringify({
  type: 'assistant', uuid: `u-${id}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const claudeResult = (id: string) => JSON.stringify({
  type: 'user', uuid: `r-${id}`, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const claudeText = (text: string) => JSON.stringify({
  type: 'assistant', uuid: `t-${text.length}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const codexExec = (callId: string, script: string) => JSON.stringify({
  timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', call_id: callId, name: 'exec', input: script },
});
const codexTurnComplete = () => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } });

function append(file: string, ...lines: string[]): void {
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
}

function harness(agent: 'claude' | 'codex', opts: { alive?: boolean | undefined } = {}) {
  const file = path.join(dir, `${agent}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'summary', summary: 'old session' })}\n`);
  let now = 10_000;
  const state: { alive: boolean | undefined; sessions: string[] } = { alive: 'alive' in opts ? opts.alive : true, sessions: ['pty-1'] };
  const sent: Array<[string, string]> = [];
  const binding: ResumeBinding = { agent, sessionId: 's', cwd: dir, transcriptPath: file, ts: 0 };
  const watcher = new TranscriptActivityWatcher({
    listSessionIds: () => state.sessions,
    getBinding: () => binding,
    isAgentAlive: () => state.alive,
    emit: (id, activity) => sent.push([id, activity]),
    now: () => now,
    minGapMs: 0,
  });
  return { file, watcher, sent, state, advance: (ms: number) => { now += ms; } };
}

describe('TranscriptActivityWatcher — tail parsing', () => {
  it('reports the newest Claude tool from appended bytes only', () => {
    const h = harness('claude');
    append(h.file, claudeTool('old', 'Read', { file_path: '/repo/history.ts' }));
    h.watcher.tick(); // starts at the current end: history is not replayed
    expect(h.sent).toEqual([]);
    append(h.file, claudeTool('a', 'Read', { file_path: '/repo/a.ts' }), claudeResult('a'), claudeTool('b', 'Edit', { file_path: '/repo/src/foo.ts' }));
    h.watcher.tick();
    expect(h.sent).toEqual([['pty-1', '✎ foo.ts']]);
  });

  it('reads a Codex rollout, naming the command inside an exec script', () => {
    const h = harness('codex');
    h.watcher.tick();
    append(h.file, codexExec('c1', 'const r = await tools.exec_command({cmd:"npm test -- auth","workdir":"/repo"}); text(r)'));
    h.watcher.tick();
    expect(h.sent).toEqual([['pty-1', '$ npm test -- auth']]);
    // The agent's own turn-end record clears the line.
    append(h.file, codexTurnComplete());
    h.watcher.tick();
    expect(h.sent.at(-1)).toEqual(['pty-1', '']);
  });

  it('never revives a finished pane: a tail ending on the reply sends nothing', () => {
    const h = harness('claude');
    h.watcher.tick();
    append(h.file, claudeTool('a', 'Bash', { command: 'npm run build' }), claudeResult('a'), claudeText('All done.'));
    h.watcher.tick();
    expect(h.sent).toEqual([]);
  });
});

describe('TranscriptActivityWatcher — lifecycle', () => {
  it('watches only a live agent and drops the watch when the agent exits or the pane closes', () => {
    const h = harness('claude', { alive: false });
    h.watcher.tick();
    expect(h.watcher.watchedSessions()).toEqual([]);
    h.state.alive = true;
    h.watcher.tick();
    expect(h.watcher.watchedSessions()).toEqual(['pty-1']);
    h.state.alive = false;
    h.watcher.tick();
    expect(h.watcher.watchedSessions()).toEqual([]);
    h.state.alive = true;
    h.watcher.tick();
    h.state.sessions = [];
    h.watcher.tick();
    expect(h.watcher.watchedSessions()).toEqual([]);
    h.watcher.dispose();
  });

  it('a new agent in the same pane is watched again after the old one died', () => {
    const h = harness('claude');
    h.watcher.tick();
    h.state.alive = false; // /exit: the tracker records the death and stays false
    h.advance(10);
    h.watcher.tick();
    expect(h.watcher.watchedSessions()).toEqual([]);
    h.advance(10);
    h.watcher.noteHookSignal('pty-1', 'agent.session_start'); // a new `claude` starts
    h.watcher.tick();
    expect(h.watcher.watchedSessions()).toEqual(['pty-1']);
    append(h.file, claudeTool('n', 'Edit', { file_path: '/repo/new.ts' }));
    h.watcher.tick();
    expect(h.sent).toEqual([['pty-1', '✎ new.ts']]);
  });

  it('an agent the tracker never attributed is watched while the binding exists', () => {
    const h = harness('claude', { alive: undefined });
    h.watcher.tick();
    expect(h.watcher.watchedSessions()).toEqual(['pty-1']);
  });

  it('a hook-fed session stands down until its next session start', () => {
    const h = harness('claude');
    h.watcher.tick();
    h.watcher.noteHookSignal('pty-1', 'agent.activity');
    append(h.file, claudeTool('a', 'Edit', { file_path: '/repo/x.ts' }));
    h.watcher.tick();
    expect(h.sent).toEqual([]);
    expect(h.watcher.watchedSessions()).toEqual([]);
    h.watcher.noteHookSignal('pty-1', 'agent.session_start');
    h.watcher.tick();
    append(h.file, claudeTool('b', 'Edit', { file_path: '/repo/y.ts' }));
    h.watcher.tick();
    expect(h.sent).toEqual([['pty-1', '✎ y.ts']]);
  });

  it('skips ahead when far behind instead of reading the whole backlog', () => {
    const h = harness('claude');
    h.watcher.tick();
    const filler = claudeText('x'.repeat(1000));
    append(h.file, ...Array.from({ length: 400 }, () => filler), claudeTool('z', 'Grep', { pattern: 'needle' }));
    h.watcher.tick();
    expect(h.sent).toEqual([['pty-1', '⌕ needle']]);
  });
});

describe('codexToolSummary', () => {
  it('maps Codex tools onto the shared glyphs', () => {
    expect(codexToolSummary('shell', { command: ['bash', '-lc', 'ls src'] })).toBe('$ ls src');
    expect(codexToolSummary('exec_command', '{"cmd":"git status"}')).toBe('$ git status');
    expect(codexToolSummary('apply_patch', '*** Begin Patch\n*** Update File: src/app.ts\n@@')).toBe('✎ app.ts');
    expect(codexToolSummary('exec', 'await tools.apply_patch("*** Begin Patch\\n*** Update File: lib/x.ts\\n")')).toBe('✎ x.ts');
  });
});
