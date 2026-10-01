// #1680 — input.send `newTask` and the a2a gated submit's new-task delivery:
// the fresh-context step runs before the text, its result rides the reply, and
// a command that never finishes fails the send with nothing else written.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { PTYManager } from '../../../pty/PTYManager';
import type { DaemonClient } from '../../../DaemonClient';
import type { RoleBinding } from '../../../../shared/orchestratorRole';
import type { SessionStartReceipt } from '../../../../shared/hooks/HookSignalRouter';
import type { GatedSubmitOptions, GatedSubmitResult } from '../../../../shared/ptyMessageDelivery';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;

/**
 * A daemon-backed Claude Code pane. The composer row follows the writes:
 * `/clear` + Enter clears the screen (and fires SessionStart when `hooks`),
 * any other text + Enter moves it into the transcript.
 */
interface PaneOptions {
  binding?: RoleBinding;
  hooks?: boolean;
  clearNeverLands?: boolean;
  local?: boolean;
  /** The daemon's tasks for the pane's workspace; null = unreadable. */
  daemonTasks?: unknown[] | null;
  /** The approval gate's screen read with this 1-based index shows a dialog. */
  dialogOnGateRead?: number;
  lockWaitMs?: number;
  /** The daemon task read waits for this (holds a delivery inside the lock). */
  holdDaemonQuery?: Promise<void>;
  humanTypesDuringCommand?: boolean;
}

const DIALOG = [' Bash command', '', '   touch probe.txt', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');

function scriptedPane(opts: PaneOptions = {}) {
  const writes: string[] = [];
  let revision = 1;
  let composer = '';
  let transcript = ['● earlier task, done'];
  let receipt: SessionStartReceipt | undefined = opts.hooks ? { at: 1, agent: 'claude', source: 'startup' } : undefined;
  let clock = 5_000_000;
  let gateReads = 0;
  const screen = (): string => [...transcript, '', '──────────', `> ${composer}`].join('\n');
  const dc = {
    isConnected: true,
    rpc: async () => ({ pending: [] }),
    getSendTarget: vi.fn(async () => ({ agent: 'Claude Code', bracketedPaste: true })),
    getAgentState: vi.fn(async () => ({
      agentName: 'Claude Code',
      agentVerified: true,
      agentStatus: 'idle',
      inputQuiet: true,
      inputRevision: revision,
      incarnationId: 'inc-1',
      keyInputRevision: revision,
      keyInputQuiet: true,
    })),
    writeToSession: (_id: string, data: string) => {
      writes.push(data);
      revision += 1;
      // A human key lands while the command is typed.
      if (opts.humanTypesDuringCommand && data === '/clear') revision += 1;
      if (data === '\r') {
        if (composer === '/clear') {
          if (!opts.clearNeverLands) {
            transcript = [];
            if (opts.hooks) receipt = { at: clock, agent: 'claude', source: 'clear' };
          }
          if (opts.clearNeverLands) return true;
        } else if (composer) {
          // The submitted prompt scrolls up out of the composer area.
          transcript = [...transcript, `> ${composer}`, '', '● working', '  step 1', '  step 2', '  step 3', ''];
        }
        composer = '';
      } else if (data.startsWith('\x7f')) {
        composer = composer.slice(0, composer.length - data.length);
      } else {
        // eslint-disable-next-line no-control-regex -- the bracketed-paste markers
        composer += data.replace(/\x1b\[20[01]~/g, '');
      }
      return true;
    },
  };
  sendToRendererMock.mockImplementation((_w: unknown, method: string, params?: { tail_lines?: number }) => {
    if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-self' });
    if (method === 'input.readScreen' && params?.tail_lines !== undefined) {
      return Promise.resolve({ ptyId: 'pty-a', text: screen() });
    }
    return Promise.resolve(null);
  });
  const router = new RpcRouter();
  const pty = {
    get: vi.fn(() => (opts.local ? { id: 'local' } : undefined)),
    write: (_id: string, data: string) => dc.writeToSession(_id, data),
  } as unknown as PTYManager;
  const input = registerInputRpc(
    router,
    pty,
    () => fakeWindow,
    () => dc as unknown as DaemonClient,
    async () => opts.binding,
    undefined,
    {
      readSessionStart: () => receipt,
      sleep: async () => undefined,
      answerPolicy: async () => ({ allowed: false, reason: 'autonomy-off' }),
      readScreenText: async () => (++gateReads === opts.dialogOnGateRead ? DIALOG : screen()),
      queryDaemonTasks: async () => {
        await opts.holdDaemonQuery;
        return opts.daemonTasks === undefined ? [] : opts.daemonTasks;
      },
      ...(opts.lockWaitMs !== undefined ? { freshContextLockWaitMs: opts.lockWaitMs } : {}),
      freshContextOptions: {
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    },
  );
  return { router, writes, gatedSubmit: input.gatedSubmit };
}

const FRESH: RoleBinding = { agent: 'claude', freshContext: true };

const send = (router: RpcRouter, params: Record<string, unknown>) =>
  router.dispatch({ id: 'n', method: 'input.send', params: { ptyId: 'pty-a', workspaceId: 'ws-self', ...params } });

describe('input.send newTask (#1680)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('needs submit and refuses raw', async () => {
    const { router, writes } = scriptedPane({ binding: FRESH });
    for (const params of [{ text: 'go', newTask: true }, { text: 'go', newTask: true, submit: true, raw: true }]) {
      const res = await send(router, params);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/newTask/);
    }
    expect(writes).toEqual([]);
  });

  it('types the command, waits for the SessionStart, then sends the task — in that order', async () => {
    const { router, writes } = scriptedPane({ binding: FRESH, hooks: true });
    const res = await send(router, { text: 'build the parser', submit: true, newTask: true });
    if (!res.ok) throw new Error(res.error);
    expect(writes).toEqual(['/clear', '\r', 'build the parser', '\r']);
    expect(res.result).toMatchObject({
      accepted: true,
      freshContext: 'applied',
      freshContextCommand: '/clear',
      freshContextSignal: 'session_start',
    });
    // The step reads a wide window ending at the cursor (a full-screen Codex
    // draws its banner far above the composer); the submit receipt keeps 20.
    const tails = sendToRendererMock.mock.calls
      .filter(([, method]) => method === 'input.readScreen')
      .map(([, , params]) => (params as { tail_lines?: number; endAtCursor?: boolean }));
    expect(tails).toContainEqual(expect.objectContaining({ tail_lines: 200, endAtCursor: true }));
    expect(tails).toContainEqual(expect.objectContaining({ tail_lines: 20, endAtCursor: true }));
  });

  it('a human key landing while the command is typed fails the send with nothing more written', async () => {
    const { router, writes } = scriptedPane({ binding: FRESH, hooks: true, humanTypesDuringCommand: true });
    const res = await send(router, { text: 'build the parser', submit: true, newTask: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/nothing further was written/);
      expect(res.error).toMatch(/NOT sent/);
    }
    expect(writes).toEqual(['/clear']);
  });

  it('a command that never finishes fails the send and writes nothing after its Enter', async () => {
    const { router, writes } = scriptedPane({ binding: FRESH, hooks: true, clearNeverLands: true });
    const res = await send(router, { text: 'build the parser', submit: true, newTask: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/fresh context did not finish/);
      expect(res.error).toMatch(/NOT sent/);
    }
    expect(writes).toEqual(['/clear', '\r']);
  });

  it('an unbound pane gets the text as usual and says not_bound', async () => {
    const { router, writes } = scriptedPane({ binding: undefined });
    const res = await send(router, { text: 'build the parser', submit: true, newTask: true });
    if (!res.ok) throw new Error(res.error);
    expect(writes).toEqual(['build the parser', '\r']);
    expect(res.result).toMatchObject({ freshContext: 'not_bound' });
  });

  it('a pane without daemon state gets the text without a clear (skipped_unobservable)', async () => {
    const { router, writes } = scriptedPane({ binding: FRESH, local: true });
    const res = await send(router, { text: 'build the parser', submit: true, newTask: true });
    if (!res.ok) throw new Error(res.error);
    expect(writes[0]).toBe('build the parser');
    expect(writes).not.toContain('/clear');
    expect(res.result).toMatchObject({ freshContext: 'skipped_unobservable' });
  });

  // Review P2-B: the gate ran before this send waited for the pane's lock; it
  // runs again right before the command is typed.
  it('re-checks the approval gate before typing the command', async () => {
    // Read 1 is the handler's own gate; read 2 is the one inside the lock.
    const { router, writes } = scriptedPane({ binding: FRESH, hooks: true, dialogOnGateRead: 2 });
    const res = await send(router, { text: 'build the parser', submit: true, newTask: true });
    expect(res.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('re-checks the gate before the text and says the pane was already cleared', async () => {
    const { router, writes } = scriptedPane({ binding: FRESH, hooks: true, dialogOnGateRead: 3 });
    const res = await send(router, { text: 'build the parser', submit: true, newTask: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already cleared/);
    expect(writes).toEqual(['/clear', '\r']);
  });

  it('a second new-task send that cannot get the pane fails with nothing written', async () => {
    const { router, writes } = scriptedPane({ binding: FRESH, hooks: true, lockWaitMs: 0 });
    const [first, second] = await Promise.all([
      send(router, { text: 'first task', submit: true, newTask: true }),
      send(router, { text: 'second task', submit: true, newTask: true }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/nothing was written/);
    expect(writes.join('')).not.toContain('second task');
  });

  it('an ordinary send never carries freshContext fields and never clears', async () => {
    const { router, writes } = scriptedPane({ binding: FRESH, hooks: true });
    const res = await send(router, { text: 'and also the lexer', submit: true });
    if (!res.ok) throw new Error(res.error);
    expect(writes).toEqual(['and also the lexer', '\r']);
    expect(res.result).not.toHaveProperty('freshContext');
  });
});

describe('gated submit, new-task delivery (#1680)', () => {
  beforeEach(() => vi.clearAllMocks());

  const ok = (r: GatedSubmitResult) => {
    expect(r.ok).toBe(true);
    return r as Extract<GatedSubmitResult, { ok: true }>;
  };

  const PANE = { workspaceId: 'ws-self', paneId: 'pane-a', surfaceId: 'surf-a' };
  const NEW = { newTask: true, taskId: 'task-new', pane: PANE } as const;
  const openTask = (id: string, side: 'to' | 'from', state = 'working') => ({
    id,
    status: { state },
    metadata: {
      to: side === 'to' ? { workspaceId: 'ws-self', paneId: 'pane-a' } : { workspaceId: 'ws-peer' },
      from: side === 'from' ? { workspaceId: 'ws-self', surfaceId: 'surf-a' } : { workspaceId: 'ws-peer' },
    },
  });

  it('clears before the paste and reports it', async () => {
    const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true });
    const res = ok(await gatedSubmit('pty-a', 'new task', 'Claude Code', NEW));
    expect(writes).toEqual(['/clear', '\r', '\x1b[200~new task\x1b[201~', '\r']);
    expect(res).toMatchObject({ freshContext: 'applied', freshContextSignal: 'session_start' });
  });

  it('refuses with fresh_context_timeout and pastes nothing when the command never finishes', async () => {
    const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true, clearNeverLands: true });
    const res = await gatedSubmit('pty-a', 'new task', 'Claude Code', NEW);
    expect(res).toMatchObject({ ok: false, reason: 'fresh_context_timeout' });
    expect(res).not.toHaveProperty('pasted');
    expect(writes).toEqual(['/clear', '\r']);
  });

  it('keeps the conversation of a pane with other open tasks (skipped_busy, open_a2a_task)', async () => {
    const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true });
    const res = ok(await gatedSubmit('pty-a', 'new task', 'Claude Code', { newTask: true, keepContext: 'open_a2a_task' }));
    expect(writes).toEqual(['\x1b[200~new task\x1b[201~', '\r']);
    expect(res).toMatchObject({ freshContext: 'skipped_busy', freshContextReason: expect.stringMatching(/^open_a2a_task/) });
  });

  // Review P2-C: the renderer's task list is not reloaded after a restart, so
  // main also asks the daemon's store, and never clears when it cannot.
  it('keeps the conversation when the daemon store has another open task on the pane', async () => {
    for (const task of [openTask('t-old', 'to'), openTask('t-sent', 'from', 'submitted')]) {
      const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true, daemonTasks: [task] });
      const res = ok(await gatedSubmit('pty-a', 'new task', 'Claude Code', NEW));
      expect(writes).toEqual(['\x1b[200~new task\x1b[201~', '\r']);
      expect(res).toMatchObject({ freshContext: 'skipped_busy', freshContextReason: expect.stringMatching(/^open_a2a_task/) });
    }
  });

  it('ignores ended tasks, other panes and the task being delivered', async () => {
    const daemonTasks = [
      openTask('t-done', 'to', 'completed'),
      openTask('task-new', 'to'),
      { id: 't-elsewhere', status: { state: 'working' }, metadata: { to: { workspaceId: 'ws-self', paneId: 'pane-b' }, from: { workspaceId: 'ws-peer' } } },
    ];
    const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true, daemonTasks });
    const res = ok(await gatedSubmit('pty-a', 'new task', 'Claude Code', NEW));
    expect(writes[0]).toBe('/clear');
    expect(res).toMatchObject({ freshContext: 'applied' });
  });

  it('never clears when the open tasks cannot be known', async () => {
    const cases: Array<[unknown[] | null, GatedSubmitOptions]> = [
      [null, NEW],
      [[], { newTask: true, taskId: 'task-new' }],
    ];
    for (const [daemonTasks, options] of cases) {
      const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true, daemonTasks });
      const res = ok(await gatedSubmit('pty-a', 'new task', 'Claude Code', options));
      expect(writes).not.toContain('/clear');
      expect(res).toMatchObject({ freshContext: 'skipped_busy', freshContextReason: expect.stringMatching(/^a2a_tasks_unknown/) });
    }
  });

  it('an unbound pane costs no daemon task lookup', async () => {
    const { gatedSubmit } = scriptedPane({ binding: undefined, daemonTasks: null });
    const res = ok(await gatedSubmit('pty-a', 'new task', 'Claude Code', NEW));
    expect(res).toMatchObject({ freshContext: 'not_bound' });
  });

  // Review P2-D: a second new task waits a bounded time, then gives up with
  // nothing written.
  it('refuses with fresh_context_busy when the pane stays held', async () => {
    let release: () => void = () => undefined;
    const holdDaemonQuery = new Promise<void>((resolve) => { release = resolve; });
    const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true, lockWaitMs: 20, holdDaemonQuery });
    const firstP = gatedSubmit('pty-a', 'first task', 'Claude Code', NEW);
    const second = await gatedSubmit('pty-a', 'second task', 'Claude Code', NEW);
    release();
    const first = await firstP;
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: 'fresh_context_busy', detail: expect.stringMatching(/nothing was written/) });
    expect(writes.join('')).not.toContain('second task');
  });

  it('a reply (no newTask) is delivered exactly as before', async () => {
    const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true });
    expect(await gatedSubmit('pty-a', 'a reply', 'Claude Code')).toEqual({ ok: true });
    expect(writes).toEqual(['\x1b[200~a reply\x1b[201~', '\r']);
  });
});
