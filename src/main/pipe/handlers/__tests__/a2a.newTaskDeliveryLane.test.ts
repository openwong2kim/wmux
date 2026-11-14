// A new task's delivery runs before the daemon writes the task's row
// (a2a.rpc.ts sendTask), so the delivery gate reads the sender from main's
// own record of the send. Both handlers are wired here, and the renderer's
// part of the send makes the gated delivery, in the order the app runs them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import type { PTYManager } from '../../../pty/PTYManager';
import type { TaskLedger } from '../../../../daemon/ledger/TaskLedger';
import type { GatedSubmitResult } from '../../../../shared/ptyMessageDelivery';
import { registerA2aRpc } from '../a2a.rpc';
import { registerInputRpc } from '../input.rpc';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

const win = () => ({}) as BrowserWindow;
const OWNERS: Record<string, string> = { 'pty-owner': 'ws-owner', 'pty-task': 'ws-task' };

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

function wire() {
  const order: string[] = [];
  const writes: string[] = [];
  const logs: string[] = [];
  const handlers = new Map<string, Handler>();
  const router = { register: (method: string, fn: Handler) => handlers.set(method, fn) } as unknown as RpcRouter;
  const daemon = {
    isConnected: true,
    rpc: vi.fn(async (method: string) => {
      if (method === 'a2a.task.create') order.push('daemon create');
      if (method === 'daemon.approvals.list') return { pending: [] };
      // No row for the new task until the create above.
      return { ok: true, tasks: [] };
    }),
    writeToSession: (_ptyId: string, data: string) => {
      writes.push(data);
      return true;
    },
    readPromptEvents: async () => ({ events: [{ kind: 'command_end' }], lastCompletedRange: null }),
  } as unknown as DaemonClient;
  const ledger = {
    list: (f: { ownerWorkspaceId?: string } = {}) =>
      [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'working' }].filter(
        (e) => f.ownerWorkspaceId === undefined || e.ownerWorkspaceId === f.ownerWorkspaceId,
      ),
  } as unknown as TaskLedger;
  registerA2aRpc(router, win, { execute: vi.fn(), cancel: vi.fn(), isFull: false, stop: vi.fn() } as unknown as ClaudeWorker, {
    getDaemonClient: () => daemon,
  });
  const input = registerInputRpc(router, { get: () => undefined } as unknown as PTYManager, win, () => daemon, undefined, undefined, {
    getLedger: () => ledger,
    ownerAnswers: () => 'all',
    paneAgent: async () => 'claude',
    log: (line) => logs.push(line),
    answerPolicy: async () => ({ allowed: false, reason: 'autonomy-off' }),
    // A tracked agent process in the pane (deliveries wait for one).
    deliveryPresence: async () => ({ tier: 'process', slug: 'claude', input: 'full', bracketedPaste: true }),
    // A hidden worker: its ring text, and cells the daemon never saw where a dialog would sit.
    readScreenText: async () => ({ parked: 'WORKER SCREEN' }),
    daemonFolderTrust: async () => ({ state: 'unknown', reason: 'unseen-cells' }),
    trustProvenClear: async () => false,
    queryDaemonTasks: async () => [],
    usageLimited: () => false,
    sleep: async () => undefined,
  });
  const call = (method: string, params: Record<string, unknown>, ctx: RpcContext) =>
    (handlers.get(method) as Handler)(params, ctx);
  return { order, writes, logs, input, call };
}

let w: ReturnType<typeof wire>;
let keys: unknown[];
let delivered: GatedSubmitResult | undefined;

beforeEach(() => {
  w = wire();
  keys = [];
  delivered = undefined;
  sendToRendererMock.mockReset();
  sendToRendererMock.mockImplementation(async (_win: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'input.findOwnerWorkspace') return { workspaceId: OWNERS[params.ptyId as string] ?? null };
    if (method.startsWith('input.')) return null;
    if (method === 'a2a.task.send') {
      // The renderer's new-task delivery (useRpcBridge deliverA2aText).
      keys.push(params.deliverySenderKey);
      w.order.push('deliver');
      delivered = await w.input.gatedSubmit(
        'pty-task',
        'hello',
        'claude',
        typeof params.deliverySenderKey === 'string' ? { senderSendKey: params.deliverySenderKey } : {},
      );
      return {
        ok: true,
        taskId: 'task-new',
        task: { id: 'task-new', metadata: { title: 't', from: { workspaceId: 'ws-owner' }, to: { workspaceId: 'ws-task' } }, history: [] },
      };
    }
    return { ok: true, tasks: [] };
  });
});

describe('a new task from the orchestrator to its hidden worker', () => {
  it('is typed in before the daemon has its row, on main\'s record of the send', async () => {
    await w.call('a2a.task.send', { workspaceId: 'ws-owner', senderPtyId: 'pty-owner', to: 'ws-task', message: 'hello' }, { origin: 'local' });

    expect(w.order).toEqual(['deliver', 'daemon create']);
    expect(delivered).toMatchObject({ ok: true });
    expect(w.writes.length).toBeGreaterThan(0);
    expect(w.logs.filter((l) => l.startsWith('[owner-lane] delivery'))).toHaveLength(1);

    // The record ends with the send.
    const late = await w.input.gatedSubmit('pty-task', 'again', 'claude', { senderSendKey: keys[0] as string });
    expect(late).toMatchObject({ ok: false });
  });

  it('takes no key from the wire', async () => {
    await w.call(
      'a2a.task.send',
      { workspaceId: 'ws-owner', senderPtyId: 'pty-owner', to: 'ws-task', message: 'hello', deliverySenderKey: 'forged' },
      { origin: 'local' },
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe('forged');
    expect(String(keys[0])).toMatch(/^send-/);
  });

  it('a stranger\'s send gets no lane', async () => {
    OWNERS['pty-stranger'] = 'ws-stranger';
    try {
      await w.call('a2a.task.send', { workspaceId: 'ws-stranger', senderPtyId: 'pty-stranger', to: 'ws-task', message: 'hello' }, { origin: 'local' });
      expect(delivered).toMatchObject({ ok: false });
    } finally {
      delete OWNERS['pty-stranger'];
    }
  });
});
