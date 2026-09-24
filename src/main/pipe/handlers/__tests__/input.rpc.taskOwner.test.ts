// Fan-out T5 — a fan-out owner reads (and, guarded, types at) the panes of its
// OPEN task workspaces. Dispatched through the real RpcRouter so the identity
// under test is the one main derives (a validated commander token, or the
// workspace main resolves `callerPtyId` to), never `params.workspaceId`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import { clearPressBlockLifts } from '../approvals.rpc';
import { mintCommanderToken, __resetCommanderTrustForTesting } from '../../../deck/commanderTrust';
import type { PTYManager } from '../../../pty/PTYManager';
import type { TaskLedger } from '../../../../daemon/ledger/TaskLedger';

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
