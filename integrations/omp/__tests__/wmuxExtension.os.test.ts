// #3276 — the omp extension module, driven through a fake ExtensionAPI and a
// fake spawn. No bridge or wmux pipe is ever reached.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FLAVOURS } from '../../shared/bin/wmux-hooks-bridge.mjs';
import { EVENTS, createWmuxExtension } from '../extensions/wmux.js';

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Run { command: string; args: string[]; stdin: string; env: NodeJS.ProcessEnv }

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-omp-ext-'));
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function harness(env: NodeJS.ProcessEnv = { WMUX_PTY_ID: 'pty-9' }, { hangFirst = false } = {}) {
  const runs: Run[] = [];
  // Reads stdin the moment the bridge would start, as the bridge does: the
  // payload must already be in the descriptor it is handed.
  const spawn = (command: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: [number, string, string] }) => {
    runs.push({ command, args, stdin: fs.readFileSync(opts.stdio[0], 'utf8'), env: opts.env });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    // A bridge that never exits holds the queue until the run's own bound.
    if (!(hangFirst && runs.length === 1)) setTimeout(() => child.emit('close', 0), 5);
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
  const runsReach = (count: number) => vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(count), { timeout: 2000, interval: 5 });
  return { runs, handlers, ctx, runsReach };
}

describe('omp wmux extension', () => {
  it('subscribes to exactly the events the bridge maps for omp', () => {
    const { handlers } = harness();
    expect([...handlers.keys()]).toEqual(EVENTS);
    expect(EVENTS.slice().sort()).toEqual(Object.keys(FLAVOURS.omp.events).sort());
  });

  it('runs the shared bridge per event, in order, with metadata only on stdin', async () => {
    const { runs, handlers, ctx, runsReach } = harness();
    handlers.get('session_start')?.({ type: 'session_start' }, ctx());
    handlers.get('before_agent_start')?.({ type: 'before_agent_start', reason: 'prompt', prompt: 'secret prompt' }, ctx());
    handlers.get('agent_end')?.({ type: 'agent_end', messages: [{ text: 'secret reply' }] }, ctx());
    await runsReach(3);
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
  // agent_end): an idle run starts inside it, and session_shutdown's handler,
  // which omp awaits, has started session_end by the time it resolves.
  it('starts a run inside the handler when none is pending; session_shutdown before it resolves', async () => {
    const { runs, handlers, ctx } = harness();
    handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx());
    expect(runs.map((r) => r.args[2])).toEqual(['agent_end']);
    await handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, ctx());
    expect(runs.map((r) => r.args[2])).toEqual(['agent_end', 'session_shutdown']);
    expect(JSON.parse(runs[1].stdin)).toEqual({ session_id: 'sess-1', cwd: '/work/repo' });
    // No payload file is left behind on POSIX.
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('drains the runs already accepted before session_end', async () => {
    const { runs, handlers, ctx } = harness();
    handlers.get('before_agent_start')?.({ type: 'before_agent_start', reason: 'prompt' }, ctx());
    handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx());
    await handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, ctx());
    expect(runs.map((r) => r.args[2])).toEqual(['before_agent_start', 'agent_end', 'session_shutdown']);
  });

  it('bounds the drain, and starts nothing still queued once session_end ran', async () => {
    vi.useFakeTimers();
    try {
      const { runs, handlers, ctx } = harness(undefined, { hangFirst: true });
      handlers.get('before_agent_start')?.({ type: 'before_agent_start', reason: 'prompt' }, ctx());
      handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx());
      const shutdown = handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, ctx());
      // Within omp's 2s wait for the handler.
      await vi.advanceTimersByTimeAsync(1600);
      await shutdown;
      expect(runs.map((r) => r.args[2])).toEqual(['before_agent_start', 'session_shutdown']);
      // The hung run's bound passes; the agent_end queued behind it never starts.
      await vi.advanceTimersByTimeAsync(5000);
      expect(runs.map((r) => r.args[2])).toEqual(['before_agent_start', 'session_shutdown']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores subagents, non-terminal settles, revives, and approvals with no UI', async () => {
    const { runs, handlers, ctx } = harness();
    handlers.get('tool_approval_requested')?.({ type: 'tool_approval_requested' }, { ...ctx(), hasUI: false });
    handlers.get('tool_approval_resolved')?.({ type: 'tool_approval_resolved', approved: false }, { ...ctx(), hasUI: false });
    handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx('sub'));
    handlers.get('agent_end')?.({ type: 'agent_end', messages: [], willContinue: true }, ctx());
    handlers.get('before_agent_start')?.({ type: 'before_agent_start', reason: 'revive', prompt: '' }, ctx());
    // A forwarded event starts its first run inside the handler, so none is coming.
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
