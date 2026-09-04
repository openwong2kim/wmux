import { describe, it, expect, beforeEach } from 'vitest';
import {
  parsePressParams,
  pickPendingForPty,
  registerApprovalsRpc,
} from '../approvals.rpc';

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

interface DaemonCall {
  method: string;
  params: Record<string, unknown>;
}

let handlers: Map<string, Handler>;
let calls: DaemonCall[];

/** A daemon whose approvals list is scripted and whose resolve answers `reply`. */
function wire(options: {
  connected?: boolean;
  pending?: { id: string; sessionId: string; createdAt?: number }[];
  reply?: unknown;
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
  registerApprovalsRpc(router as never, () => dc as never);
}

const press = (p: Record<string, unknown>): Promise<unknown> => handlers.get('approval.press')!(p);

beforeEach(() => wire({}));

describe('parsePressParams', () => {
  it('needs a target and defaults to approve', () => {
    expect(parsePressParams({})).toEqual({ error: 'approval.press requires an approvalId or a ptyId' });
    expect(parsePressParams({ ptyId: 'pty-1' })).toEqual({ ptyId: 'pty-1', decision: 'approve' });
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
    expect(parsePressParams({ ptyId: 'p', choiceKey: 'rm -rf' })).toMatchObject({
      error: expect.stringContaining('choiceKey'),
    });
    expect(parsePressParams({ ptyId: 'p', choiceKey: '2' })).toMatchObject({ choiceKey: '2' });
  });
});

describe('pickPendingForPty', () => {
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

describe('approval.press', () => {
  it('resolves the pane\'s pending record and declares itself AUTOMATED', async () => {
    wire({ pending: [{ id: 'ap-1', sessionId: 'pty-w', createdAt: 5 }] });

    const res = (await press({ ptyId: 'pty-w', workspaceId: 'ws-brain' })) as { ok: boolean; approvalId: string };

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

  it('passes a scope refusal back with a reason the brain can act on', async () => {
    wire({
      pending: [{ id: 'ap-1', sessionId: 'pty-w' }],
      reply: { ok: false, reason: 'press-capability-off' },
    });

    const res = (await press({ ptyId: 'pty-w' })) as { ok: boolean; reason: string; note: string };

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('press-capability-off');
    expect(res.note).toContain('deck_ask_decision');
  });

  it('says plainly that nothing is pending on that pane instead of pressing blind', async () => {
    wire({ pending: [{ id: 'ap-1', sessionId: 'other-pty' }] });

    const res = (await press({ ptyId: 'pty-w' })) as { ok: boolean; reason: string; note: string };

    expect(res).toMatchObject({ ok: false, reason: 'not-found' });
    expect(res.note).toContain('no approval is pending');
    expect(calls.some((c) => c.method === 'daemon.approvals.resolve')).toBe(false);
  });

  it('sends a named approvalId straight through without listing', async () => {
    wire({ pending: [] });

    await press({ approvalId: 'ap-42', decision: 'deny' });

    expect(calls.map((c) => c.method)).toEqual(['daemon.approvals.resolve']);
    expect(calls[0]?.params).toMatchObject({ id: 'ap-42', decision: 'deny', resolver: 'automated' });
  });

  it('refuses when there is no daemon to hold the records', async () => {
    wire({ connected: false });
    await expect(press({ ptyId: 'pty-w' })).rejects.toThrow(/daemon not connected/);
  });
});
