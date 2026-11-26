// #3276 — the omp extension module, driven through a fake ExtensionAPI and a
// fake spawn. No bridge or wmux pipe is ever reached.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { FLAVOURS } from '../../shared/bin/wmux-hooks-bridge.mjs';
import { EVENTS, createWmuxExtension } from '../extensions/wmux.js';

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Run { command: string; args: string[]; stdin: string; env: NodeJS.ProcessEnv }

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-omp-ext-'));
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function harness(env: NodeJS.ProcessEnv = { WMUX_PTY_ID: 'pty-9' }) {
  const runs: Run[] = [];
  // Reads stdin the moment the bridge would start, as the bridge does: the
  // payload must already be in the descriptor it is handed.
  const spawn = (command: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: [number, string, string] }) => {
    runs.push({ command, args, stdin: fs.readFileSync(opts.stdio[0], 'utf8'), env: opts.env });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    setTimeout(() => child.emit('close', 0), 5);
    return child;
  };
  const handlers = new Map<string, Handler>();
  createWmuxExtension({ env, spawn, bridgePath: '/h/.wmux/hooks/wmux-hooks-bridge.mjs', platform: 'linux', tempDir })({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  });
  const ctx = (kind: 'main' | 'sub' = 'main') => ({
    cwd: '/work/repo',
    agent: { kind },
    sessionManager: { getSessionId: () => 'sess-1' },
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { runs, handlers, ctx, settle };
}

describe('omp wmux extension', () => {
  it('subscribes to exactly the events the bridge maps for omp', () => {
    const { handlers } = harness();
    expect([...handlers.keys()]).toEqual(EVENTS);
    expect(EVENTS.slice().sort()).toEqual(Object.keys(FLAVOURS.omp.events).sort());
  });

  it('runs the shared bridge per event, in order, with metadata only on stdin', async () => {
    const { runs, handlers, ctx, settle } = harness();
    handlers.get('session_start')?.({ type: 'session_start' }, ctx());
    handlers.get('before_agent_start')?.({ type: 'before_agent_start', reason: 'prompt', prompt: 'secret prompt' }, ctx());
    handlers.get('agent_end')?.({ type: 'agent_end', messages: [{ text: 'secret reply' }] }, ctx());
    await settle();
    expect(runs.map((r) => r.args)).toEqual([
      ['/h/.wmux/hooks/wmux-hooks-bridge.mjs', 'omp', 'session_start'],
      ['/h/.wmux/hooks/wmux-hooks-bridge.mjs', 'omp', 'before_agent_start'],
      ['/h/.wmux/hooks/wmux-hooks-bridge.mjs', 'omp', 'agent_end'],
    ]);
    expect(runs[0].command).toBe('node');
    // Pane attribution rides in the inherited env.
    expect(runs[0].env.WMUX_PTY_ID).toBe('pty-9');
    for (const run of runs) expect(JSON.parse(run.stdin)).toEqual({ session_id: 'sess-1', cwd: '/work/repo' });
  });

  // omp may exit as soon as a handler returns (print mode does right after
  // agent_end): an idle run, and session_shutdown always, start inside it.
  it('starts a run inside the handler when none is pending, and session_shutdown always', () => {
    const { runs, handlers, ctx } = harness();
    handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx());
    expect(runs.map((r) => r.args[2])).toEqual(['agent_end']);
    handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, ctx());
    expect(runs.map((r) => r.args[2])).toEqual(['agent_end', 'session_shutdown']);
    expect(JSON.parse(runs[1].stdin)).toEqual({ session_id: 'sess-1', cwd: '/work/repo' });
    // No payload file is left behind on POSIX.
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('starts nothing that was still queued once session_shutdown ran', async () => {
    const { runs, handlers, ctx, settle } = harness();
    handlers.get('before_agent_start')?.({ type: 'before_agent_start', reason: 'prompt' }, ctx());
    handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx());
    handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, ctx());
    await settle();
    expect(runs.map((r) => r.args[2])).toEqual(['before_agent_start', 'session_shutdown']);
  });

  it('ignores subagents, non-terminal settles, revives, and approvals with no UI', async () => {
    const { runs, handlers, ctx, settle } = harness();
    handlers.get('tool_approval_requested')?.({ type: 'tool_approval_requested' }, { ...ctx(), hasUI: false });
    handlers.get('tool_approval_resolved')?.({ type: 'tool_approval_resolved', approved: false }, { ...ctx(), hasUI: false });
    handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx('sub'));
    handlers.get('agent_end')?.({ type: 'agent_end', messages: [], willContinue: true }, ctx());
    handlers.get('before_agent_start')?.({ type: 'before_agent_start', reason: 'revive', prompt: '' }, ctx());
    await settle();
    expect(runs).toEqual([]);
  });

  it('subscribes to nothing outside a wmux pane', () => {
    expect(harness({}).handlers.size).toBe(0);
  });

  it('never throws into omp when the bridge cannot start', () => {
    const handlers = new Map<string, Handler>();
    createWmuxExtension({ env: { WMUX_PTY_ID: 'p' }, spawn: () => { throw new Error('ENOENT'); } })({
      on: (name: string, handler: Handler) => handlers.set(name, handler),
    });
    expect(() => handlers.get('session_start')?.({}, {})).not.toThrow();
  });
});
