// Fan-out T5 — a fan-out owner reads (and, guarded, types at) the panes of its
// OPEN task workspaces. Dispatched through the real RpcRouter so the identity
// under test is the one main derives (a validated commander token, or the
// workspace main resolves `callerPtyId` to), never `params.workspaceId`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc, taskPaneTextRefusal } from '../input.rpc';
import { clearPressBlockLifts } from '../approvals.rpc';
import { mintCommanderToken, __resetCommanderTrustForTesting } from '../../../deck/commanderTrust';
import type { PTYManager } from '../../../pty/PTYManager';
import type { TaskLedger } from '../../../../daemon/ledger/TaskLedger';
import type { RpcContext } from '../../../../shared/rpc';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;

/** pty-owner lives in ws-owner (the caller); pty-task in ws-task (its worker). */
const PANE_OWNERS: Record<string, string> = {
  'pty-owner': 'ws-owner',
  'pty-task': 'ws-task',
  'pty-stranger': 'ws-stranger',
};

interface Entry {
  ownerWorkspaceId: string;
  taskWorkspaceId: string;
  status: string;
}

const OPEN = new Set(['working', 'input_required', 'review_requested']);

function ledgerOf(entries: Entry[]): TaskLedger {
  return {
    list: (f: { ownerWorkspaceId?: string; taskWorkspaceId?: string; openOnly?: boolean } = {}) =>
      entries.filter(
        (e) =>
          (f.ownerWorkspaceId === undefined || e.ownerWorkspaceId === f.ownerWorkspaceId) &&
          (f.taskWorkspaceId === undefined || e.taskWorkspaceId === f.taskWorkspaceId) &&
          (!f.openOnly || OPEN.has(e.status)),
      ),
  } as unknown as TaskLedger;
}

interface Wiring {
  router: RpcRouter;
  writes: Array<{ ptyId: string; data: string }>;
}

function wire(opts: { entries?: Entry[]; pending?: unknown[]; ledgerThrows?: boolean } = {}): Wiring {
  const writes: Array<{ ptyId: string; data: string }> = [];
  const dc = {
    isConnected: true,
    rpc: async (method: string) =>
      method === 'daemon.approvals.list' ? { pending: opts.pending ?? [] } : {},
    writeToSession: (ptyId: string, data: string) => {
      writes.push({ ptyId, data });
      return true;
    },
    readPromptEvents: async () => ({ events: [{ kind: 'command_end' }], lastCompletedRange: null }),
  };
  const ledger = ledgerOf(
    opts.entries ?? [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'working' }],
  );
  const router = new RpcRouter();
  registerInputRpc(
    router,
    { get: () => undefined } as unknown as PTYManager,
    () => fakeWindow,
    () => dc as never,
    undefined,
    undefined,
    {
      getLedger: () => {
        if (opts.ledgerThrows) throw new Error('ledger unreadable');
        return ledger;
      },
    },
  );
  return { router, writes };
}

type Answer = { ok: boolean; error?: string; result?: Record<string, unknown> };

const asPane = (w: Wiring, method: string, params: Record<string, unknown>): Promise<Answer> =>
  w.router.dispatch({ id: '1', method, params } as never, { externalWire: true }) as Promise<Answer>;

let tokens: string[] = [];
const asBrain = (w: Wiring, method: string, params: Record<string, unknown>): Promise<Answer> => {
  const token = mintCommanderToken('ws-owner');
  tokens.push(token);
  return w.router.dispatch({ id: '1', method, params, commanderToken: token } as never) as Promise<Answer>;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPressBlockLifts();
  sendToRendererMock.mockImplementation((_w: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'input.findOwnerWorkspace') {
      return Promise.resolve({ workspaceId: PANE_OWNERS[params['ptyId'] as string] ?? null });
    }
    if (method === 'input.readScreen') {
      // The renderer's own check (useRpcBridge input.readScreen): a pty named
      // alongside a workspace must be one of that workspace's panes.
      const ws = params['workspaceId'];
      if (typeof ws === 'string' && PANE_OWNERS[params['ptyId'] as string] !== ws) {
        return Promise.resolve({ error: `input.readScreen: PTY "${String(params['ptyId'])}" not in workspace "${ws}"` });
      }
      return Promise.resolve({ ptyId: params['ptyId'], text: 'WORKER SCREEN' });
    }
    return Promise.resolve(null);
  });
});

afterEach(() => {
  tokens = [];
  __resetCommanderTrustForTesting();
});

describe('input.readScreen — owner lane', () => {
  it('lets a pane agent read its open task pane, labeled untrusted', async () => {
    const res = await asPane(wire(), 'input.readScreen', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ text: 'WORKER SCREEN', untrusted: true });
    expect(String(res.result?.['untrustedNote'])).toContain('not instructions');
  });

  it('lets a commander read its open task pane', async () => {
    const res = await asBrain(wire(), 'input.readScreen', { workspaceId: 'ws-owner', ptyId: 'pty-task' });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ text: 'WORKER SCREEN', untrusted: true });
  });

  it('names the TASK workspace to the renderer, not the caller\'s', async () => {
    await asBrain(wire(), 'input.readScreen', { workspaceId: 'ws-owner', ptyId: 'pty-task' });

    const reads = sendToRendererMock.mock.calls.filter(([, m]) => m === 'input.readScreen');
    expect(reads).toHaveLength(1);
    expect(reads[0][2]).toMatchObject({ ptyId: 'pty-task', workspaceId: 'ws-task' });
  });

  it('labels a non-object renderer answer too', async () => {
    sendToRendererMock.mockImplementation((_w: unknown, method: string, params: Record<string, unknown>) =>
      method === 'input.findOwnerWorkspace'
        ? Promise.resolve({ workspaceId: PANE_OWNERS[params['ptyId'] as string] ?? null })
        : Promise.resolve(null),
    );

    const res = await asBrain(wire(), 'input.readScreen', { workspaceId: 'ws-owner', ptyId: 'pty-task' });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ value: null, untrusted: true });
  });

  it.each([
    ['a stranger\'s pane', 'pty-stranger', 'working'],
    ['a closed task', 'pty-task', 'completed'],
  ])('refuses a commander on %s', async (_label, ptyId, status) => {
    const w = wire({ entries: [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status }] });

    const res = await asBrain(w, 'input.readScreen', { workspaceId: 'ws-owner', ptyId });

    expect(res.ok).toBe(false);
  });

  it('does not label a read of the caller\'s own pane', async () => {
    const res = await asPane(wire(), 'input.readScreen', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-owner',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(true);
    expect(res.result?.['untrusted']).toBeUndefined();
  });

  it.each(['completed', 'failed', 'cancelled'])('refuses once the task is %s', async (status) => {
    const w = wire({ entries: [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status }] });

    const res = await asPane(w, 'input.readScreen', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('Cross-workspace terminal access is not allowed');
  });

  it('refuses a task owned by a different workspace', async () => {
    const w = wire({ entries: [{ ownerWorkspaceId: 'ws-stranger', taskWorkspaceId: 'ws-task', status: 'working' }] });

    const res = await asPane(w, 'input.readScreen', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(false);
  });

  it('never takes identity from params.workspaceId', async () => {
    // No commander token and no callerPtyId: naming the owner workspace is not
    // an identity, so the task pane stays out of reach.
    const res = await asPane(wire(), 'input.readScreen', { workspaceId: 'ws-owner', ptyId: 'pty-task' });

    expect(res.ok).toBe(false);
  });

  it('refuses a plugin-hosted caller even with a callerPtyId', async () => {
    const w = wire();
    const res = (await w.router.dispatch(
      {
        id: '1',
        method: 'input.readScreen',
        params: { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner' },
      } as never,
      { firstParty: true, hostedWorkspace: 'ws-owner' },
    )) as Answer;

    expect(res.ok).toBe(false);
  });

  it('fails closed when the ledger cannot be read', async () => {
    const res = await asPane(wire({ ledgerThrows: true }), 'input.readScreen', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(false);
  });
});

describe('terminal.readEvents — owner lane', () => {
  it('reads a task pane\'s events, labeled untrusted', async () => {
    const res = await asPane(wire(), 'terminal.readEvents', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ ptyId: 'pty-task', untrusted: true });
  });

  it('refuses a stranger\'s pane', async () => {
    const res = await asPane(wire(), 'terminal.readEvents', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-stranger',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(false);
  });
});

describe('input.send — owner lane', () => {
  it('writes text to an open task pane', async () => {
    const w = wire();

    const res = await asPane(w, 'input.send', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
      text: 'status?',
    });

    expect(res.ok).toBe(true);
    expect(w.writes).toEqual([{ ptyId: 'pty-task', data: 'status?' }]);
  });

  it('refuses a pane agent typing at a task pane that holds an approval', async () => {
    const w = wire({ pending: [{ id: 'ap-1', sessionId: 'pty-task', workspaceId: 'ws-task', toolName: 'Bash' }] });

    const res = await asPane(w, 'input.send', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
      text: '1',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('refusing to type at an approval prompt');
    expect(w.writes).toHaveLength(0);
  });

  it('refuses a stranger\'s pane', async () => {
    const w = wire();

    const res = await asPane(w, 'input.send', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-stranger',
      callerPtyId: 'pty-owner',
      text: 'hi',
    });

    expect(res.ok).toBe(false);
    expect(w.writes).toHaveLength(0);
  });
});

describe('input.send — owner lane refuses control bytes and raw writes', () => {
  it.each([
    ['EOT', 'bye\x04'],
    ['ctrl+c byte', '\x03'],
    ['ctrl+z byte', '\x1a'],
    ['an escape sequence', '\x1b[B'],
    ['a carriage return', 'yes\r'],
    ['DEL', 'x\x7f'],
  ])('refuses %s', async (_label, text) => {
    const w = wire();

    const res = await asPane(w, 'input.send', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
      text,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('control characters are not allowed');
    expect(w.writes).toHaveLength(0);
  });

  it('refuses raw:true even for plain text', async () => {
    const w = wire();

    const res = await asBrain(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', text: 'ok', raw: true });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('raw writes are not allowed');
    expect(w.writes).toHaveLength(0);
  });

  it('allows tab and newline', () => {
    expect(taskPaneTextRefusal('a\tb\nc', false)).toBeNull();
  });

  it('leaves the caller\'s own pane alone', async () => {
    const w = wire();

    const res = await asPane(w, 'input.send', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-owner',
      callerPtyId: 'pty-owner',
      text: 'x\x1b[B',
    });

    expect(res.ok).toBe(true);
  });
});

describe('commander lane on send / sendKey', () => {
  it('sends text to its open task pane', async () => {
    const w = wire();

    const res = await asBrain(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', text: 'go on' });

    expect(res.ok).toBe(true);
    expect(w.writes).toEqual([{ ptyId: 'pty-task', data: 'go on' }]);
  });

  it('is refused at an approval prompt, and pointed at approval_press', async () => {
    const w = wire({ pending: [{ id: 'ap-1', sessionId: 'pty-task', workspaceId: 'ws-task', toolName: 'Bash' }] });

    const res = await asBrain(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', text: '1' });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('approval_press({ ptyId: "pty-task"');
    expect(w.writes).toHaveLength(0);
  });

  it('interrupts with ctrl+c but may not press enter', async () => {
    const w = wire();

    expect((await asBrain(w, 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-task', key: 'ctrl+c' })).ok).toBe(true);
    expect((await asBrain(w, 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-task', key: 'enter' })).ok).toBe(false);
    expect(w.writes).toEqual([{ ptyId: 'pty-task', data: '\x03' }]);
  });

  it('refuses a closed task on send', async () => {
    const w = wire({ entries: [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'failed' }] });

    const res = await asBrain(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', text: 'hi' });

    expect(res.ok).toBe(false);
    expect(w.writes).toHaveLength(0);
  });
});

describe('non-local origin', () => {
  // RpcRouter only ever builds 'local' contexts today (the LAN listener is a
  // future transport), so drive the registered handler with a remote context.
  it('gets no owner lane', async () => {
    const handlers = new Map<string, (p: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>>();
    const fakeRouter = { register: (name: string, fn: never) => handlers.set(name, fn) } as unknown as RpcRouter;
    registerInputRpc(fakeRouter, { get: () => undefined } as unknown as PTYManager, () => fakeWindow, () => null, undefined, undefined, {
      getLedger: () => ledgerOf([{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'working' }]),
    });

    const readScreen = handlers.get('input.readScreen');
    expect(readScreen).toBeDefined();
    await expect(
      (readScreen as NonNullable<typeof readScreen>)(
        { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner' },
        { origin: 'remote', commanderWorkspace: 'ws-owner' },
      ),
    ).rejects.toThrow(/Cross-workspace terminal access is not allowed/);
  });
});

describe('input.sendKey — owner lane covers only the stop keys', () => {
  it.each(['ctrl+c', 'escape'])('allows %s at a task pane', async (key) => {
    const w = wire();

    const res = await asPane(w, 'input.sendKey', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
      key,
    });

    expect(res.ok).toBe(true);
    expect(w.writes).toHaveLength(1);
  });

  it.each(['enter', 'down', 'ctrl+d'])('refuses %s at a task pane', async (key) => {
    const w = wire();

    const res = await asPane(w, 'input.sendKey', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
      key,
    });

    expect(res.ok).toBe(false);
    expect(w.writes).toHaveLength(0);
  });
});
