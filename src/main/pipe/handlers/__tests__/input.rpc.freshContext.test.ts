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
import type { GatedSubmitResult } from '../../../../shared/ptyMessageDelivery';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;

/**
 * A daemon-backed Claude Code pane. The composer row follows the writes:
 * `/clear` + Enter clears the screen (and fires SessionStart when `hooks`),
 * any other text + Enter moves it into the transcript.
 */
function scriptedPane(opts: { binding?: RoleBinding; hooks?: boolean; clearNeverLands?: boolean; local?: boolean } = {}) {
  const writes: string[] = [];
  let revision = 1;
  let composer = '';
  let transcript = ['● earlier task, done'];
  let receipt: SessionStartReceipt | undefined = opts.hooks ? { at: 1, agent: 'claude', source: 'startup' } : undefined;
  let clock = 5_000_000;
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
    })),
    writeToSession: (_id: string, data: string) => {
      writes.push(data);
      revision += 1;
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
      readScreenText: async () => screen(),
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

  it('clears before the paste and reports it', async () => {
    const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true });
    const res = ok(await gatedSubmit('pty-a', 'new task', 'Claude Code', { newTask: true }));
    expect(writes).toEqual(['/clear', '\r', '\x1b[200~new task\x1b[201~', '\r']);
    expect(res).toMatchObject({ freshContext: 'applied', freshContextSignal: 'session_start' });
  });

  it('refuses with fresh_context_timeout and pastes nothing when the command never finishes', async () => {
    const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true, clearNeverLands: true });
    const res = await gatedSubmit('pty-a', 'new task', 'Claude Code', { newTask: true });
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

  it('a reply (no newTask) is delivered exactly as before', async () => {
    const { gatedSubmit, writes } = scriptedPane({ binding: FRESH, hooks: true });
    expect(await gatedSubmit('pty-a', 'a reply', 'Claude Code')).toEqual({ ok: true });
    expect(writes).toEqual(['\x1b[200~a reply\x1b[201~', '\r']);
  });
});
