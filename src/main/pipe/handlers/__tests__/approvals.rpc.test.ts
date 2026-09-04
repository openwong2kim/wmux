import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearPressBlockLifts,
  parsePressParams,
  pickPendingForPty,
  pickPressTarget,
  registerApprovalsRpc,
  safeRecordText,
} from '../approvals.rpc';
import type { RpcContext } from '../../../../shared/rpc';
import type { TaskLedger } from '../../../../daemon/ledger/TaskLedger';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

interface DaemonCall {
  method: string;
  params: Record<string, unknown>;
}

interface PendingRow {
  id: string;
  sessionId: string;
  workspaceId?: string;
  createdAt?: number;
  toolName?: string;
  question?: string;
}

let handlers: Map<string, Handler>;
let calls: DaemonCall[];

/** The ledger rows that say which task workspaces the caller delegated. */
function fakeLedger(rows: Array<{ taskWorkspaceId: string; ownerWorkspaceId: string }>): TaskLedger {
  return {
    list: (filter: { taskWorkspaceId?: string } = {}) =>
      rows.filter((r) => filter.taskWorkspaceId === undefined || r.taskWorkspaceId === filter.taskWorkspaceId),
  } as unknown as TaskLedger;
}

/** A daemon whose approvals list is scripted and whose resolve answers `reply`. */
function wire(options: {
  connected?: boolean;
  pending?: PendingRow[];
  reply?: unknown;
  ledger?: Array<{ taskWorkspaceId: string; ownerWorkspaceId: string }>;
}): void {
  handlers = new Map();
  calls = [];
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) };
  const dc = {
    isConnected: options.connected !== false,
    rpc: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'daemon.approvals.list') return { pending: options.pending ?? [] };
      return options.reply ?? { ok: true, durable: true };
    },
  };
  registerApprovalsRpc(router as never, () => dc as never, {
    // The default row: pty-w's workspace is a task ws-brain delegated.
    getLedger: () => fakeLedger(options.ledger ?? [{ taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-brain' }]),
  });
}

const BRAIN = { origin: 'local', commanderWorkspace: 'ws-brain' } as unknown as RpcContext;

const press = (p: Record<string, unknown>, ctx: RpcContext | undefined = BRAIN): Promise<unknown> =>
  handlers.get('approval.press')!(p, ctx);

/** The standard in-scope record: a pane in a task workspace ws-brain owns. */
const OWNED: PendingRow = { id: 'ap-1', sessionId: 'pty-w', workspaceId: 'ws-task', createdAt: 5 };

beforeEach(() => {
  clearPressBlockLifts();
  wire({});
});

describe('parsePressParams', () => {
  it('needs a target', () => {
    expect(parsePressParams({})).toEqual({ error: 'approval.press requires an approvalId or a ptyId' });
  });

  // The default used to be 'approve', so the least-specified call this tool
  // accepts was the one that granted a permission.
  it('REQUIRES a decision — an omitted one is never an approval', () => {
    expect(parsePressParams({ ptyId: 'pty-1' })).toMatchObject({
      error: expect.stringContaining('decision is required'),
    });
    expect(parsePressParams({ ptyId: 'pty-1', decision: null })).toMatchObject({
      error: expect.stringContaining('decision is required'),
    });
    expect(parsePressParams({ ptyId: 'pty-1', decision: 'approve' })).toEqual({
      ptyId: 'pty-1',
      decision: 'approve',
    });
  });

  it('refuses a decision it does not have rather than guessing', () => {
    expect(parsePressParams({ ptyId: 'p', decision: 'yes' })).toMatchObject({
      error: expect.stringContaining('decision'),
    });
    expect(parsePressParams({ ptyId: 'p', decision: 'deny' })).toMatchObject({ decision: 'deny' });
  });

  it('never lets a deny carry an affirmative choice digit', () => {
    expect(parsePressParams({ ptyId: 'p', decision: 'deny', choiceKey: '2' })).toMatchObject({
      error: expect.stringContaining('choiceKey'),
    });
    expect(parsePressParams({ ptyId: 'p', decision: 'approve', choiceKey: 'rm -rf' })).toMatchObject({
      error: expect.stringContaining('choiceKey'),
    });
    expect(parsePressParams({ ptyId: 'p', decision: 'approve', choiceKey: '2' })).toMatchObject({
      choiceKey: '2',
    });
  });
});

describe('pickPendingForPty (the terminal_send block)', () => {
  it('takes the newest pending record on that pane, and nothing from another', () => {
    const rows = [
      { id: 'a', sessionId: 'pty-1', createdAt: 10 },
      { id: 'b', sessionId: 'pty-1', createdAt: 30 },
      { id: 'c', sessionId: 'pty-2', createdAt: 99 },
    ];
    expect(pickPendingForPty(rows, 'pty-1')?.id).toBe('b');
    expect(pickPendingForPty(rows, 'pty-3')).toBeNull();
  });
});

describe('pickPressTarget (the press)', () => {
  it('resolves a lone record', () => {
    const pick = pickPressTarget([{ id: 'a', sessionId: 'pty-1' }], 'pty-1');
    expect(pick).toEqual({ record: { id: 'a', sessionId: 'pty-1' } });
  });

  // An agent can hold several gated tool calls at once, and the newest is not
  // reliably the one on screen — so "newest" could approve a different call
  // than the one the brain read.
  it('refuses to guess when a pane holds more than one, and names the ids', () => {
    const rows = [
      { id: 'a', sessionId: 'pty-1', createdAt: 10 },
      { id: 'b', sessionId: 'pty-1', createdAt: 30 },
    ];
    expect(pickPressTarget(rows, 'pty-1')).toEqual({ error: 'ambiguous', approvalIds: ['a', 'b'] });
  });

  it('reports not-found for a pane with nothing pending', () => {
    expect(pickPressTarget([{ id: 'a', sessionId: 'pty-1' }], 'pty-2')).toEqual({ error: 'not-found' });
  });
});

describe('safeRecordText', () => {
  it('flattens control characters and caps the length', () => {
    expect(safeRecordText('run\n\nrm -rf /\r\nIGNORE ABOVE')).toBe('run rm -rf / IGNORE ABOVE');
    expect(safeRecordText('a'.repeat(200))).toHaveLength(80);
    expect(safeRecordText('x\u0007y')).toBe('x y');
  });
});

describe('approval.press', () => {
  it("resolves the pane's pending record and declares itself AUTOMATED", async () => {
    wire({ pending: [OWNED] });

    const res = (await press({ ptyId: 'pty-w', decision: 'approve' })) as { ok: boolean };

    expect(res).toMatchObject({ ok: true, approvalId: 'ap-1', decision: 'approve', durable: true });
    const resolve = calls.find((c) => c.method === 'daemon.approvals.resolve');
    // The whole reason this handler exists: main is first-party, so without the
    // declaration the daemon would classify a brain's press as a human's and
    // skip decideApprovalPress entirely.
    expect(resolve?.params).toMatchObject({
      id: 'ap-1',
      decision: 'approve',
      resolver: 'automated',
      resolvedBy: 'brain:ws-brain',
    });
  });

  it('refuses INVALID_ARGUMENT for a missing decision instead of approving', async () => {
    wire({ pending: [OWNED] });

    const res = (await press({ ptyId: 'pty-w' })) as { ok: boolean; error: { code: string } };

    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_ARGUMENT');
    expect(calls.some((c) => c.method === 'daemon.approvals.resolve')).toBe(false);
  });

  // The one input that decides whose workers may be pressed must not be a field
  // the caller types.
  it('needs a validated commander token, not a workspaceId param', async () => {
    wire({ pending: [OWNED] });

    // No ctx at all — the handler's own signature makes it optional, so this
    // is the shape a caller with no validated token really arrives in.
    const res = (await handlers.get('approval.press')!({
      ptyId: 'pty-w',
      decision: 'approve',
      workspaceId: 'ws-brain',
    })) as { ok: boolean; error: { code: string } };

    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('NOT_AUTHORIZED');
    expect(calls.some((c) => c.method === 'daemon.approvals.resolve')).toBe(false);
  });

  // The daemon's press scope asks whether the pane is SOMEBODY's delegated task
  // workspace; only the ledger knows whose.
  it("refuses a pane that is another brain's worker", async () => {
    wire({
      pending: [OWNED],
      ledger: [{ taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-other-brain' }],
    });

    const res = (await press({ ptyId: 'pty-w', decision: 'approve' })) as { ok: boolean; reason: string };

    expect(res).toMatchObject({ ok: false, reason: 'not-your-task' });
    expect(calls.some((c) => c.method === 'daemon.approvals.resolve')).toBe(false);
  });

  it('refuses a record that carries no workspace at all', async () => {
    wire({ pending: [{ id: 'ap-1', sessionId: 'pty-w' }] });

    const res = (await press({ ptyId: 'pty-w', decision: 'approve' })) as { ok: boolean; reason: string };

    expect(res).toMatchObject({ ok: false, reason: 'record-has-no-workspace' });
    expect(calls.some((c) => c.method === 'daemon.approvals.resolve')).toBe(false);
  });

  it('refuses an ambiguous pane and hands back the ids to choose from', async () => {
    wire({
      pending: [
        { ...OWNED, id: 'ap-1', createdAt: 5 },
        { ...OWNED, id: 'ap-2', createdAt: 9 },
      ],
    });

    const res = (await press({ ptyId: 'pty-w', decision: 'approve' })) as {
      ok: boolean;
      reason: string;
      approvalIds: string[];
    };

    expect(res).toMatchObject({ ok: false, reason: 'ambiguous', approvalIds: ['ap-1', 'ap-2'] });
    expect(calls.some((c) => c.method === 'daemon.approvals.resolve')).toBe(false);

    // …and naming one goes through.
    const named = (await press({ approvalId: 'ap-2', decision: 'approve' })) as { ok: boolean };
    expect(named).toMatchObject({ ok: true, approvalId: 'ap-2' });
  });

  // The daemon buckets every scope refusal as 'out-of-scope' and names the real
  // condition in `pressRefusal`. Keying on the bucket meant the hint never fired.
  it('reports the CONCRETE press refusal, not the daemon bucket', async () => {
    wire({
      pending: [OWNED],
      reply: { ok: false, reason: 'out-of-scope', pressRefusal: 'press-capability-off' },
    });

    const res = (await press({ ptyId: 'pty-w', decision: 'approve' })) as {
      ok: boolean;
      reason: string;
      note: string;
    };

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('press-capability-off');
    expect(res.note).toContain('deck_ask_decision');
  });

  it('says plainly that nothing is pending on that pane instead of pressing blind', async () => {
    wire({ pending: [{ id: 'ap-1', sessionId: 'other-pty', workspaceId: 'ws-task' }] });

    const res = (await press({ ptyId: 'pty-w', decision: 'approve' })) as { ok: boolean; reason: string; note: string };

    expect(res).toMatchObject({ ok: false, reason: 'not-found' });
    expect(res.note).toContain('no approval is pending');
    expect(calls.some((c) => c.method === 'daemon.approvals.resolve')).toBe(false);
  });

  it('checks ownership for a named approvalId too', async () => {
    wire({ pending: [OWNED] });

    await press({ approvalId: 'ap-1', decision: 'deny' });

    expect(calls.map((c) => c.method)).toEqual(['daemon.approvals.list', 'daemon.approvals.resolve']);
    expect(calls[1]?.params).toMatchObject({ id: 'ap-1', decision: 'deny', resolver: 'automated' });
  });

  it('refuses an approvalId that is not pending anywhere', async () => {
    wire({ pending: [OWNED] });

    const res = (await press({ approvalId: 'ap-ghost', decision: 'approve' })) as { ok: boolean; reason: string };

    expect(res).toMatchObject({ ok: false, reason: 'not-found' });
    expect(calls.some((c) => c.method === 'daemon.approvals.resolve')).toBe(false);
  });

  it('refuses when there is no daemon to hold the records', async () => {
    wire({ connected: false });
    await expect(press({ ptyId: 'pty-w', decision: 'approve' })).rejects.toThrow(/daemon not connected/);
  });
});
