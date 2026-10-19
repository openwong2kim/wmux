import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return { __handlers: handlers, ipcMain: { removeHandler: (name: string) => handlers.delete(name),
    handle: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn) } };
});
import * as electron from 'electron';
import { registerPlanApprovalHandlers, toPlanApprovalView } from '../planApproval.handler';
import { IPC } from '../../../../shared/constants';
import type { DaemonClient } from '../../../DaemonClient';
import type { ApprovalRequest } from '../../../../daemon/approvals/types';

const handlers = (electron as unknown as { __handlers: Map<string, (...args: any[]) => unknown> }).__handlers;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

const FP = 'a'.repeat(32);
const answerable: ApprovalRequest = {
  id: 'req-1', sessionId: 'pty-a', workspaceId: 'ws-1', agent: 'claude', kind: 'terminal_prompt',
  toolName: 'ExitPlanMode', summary: 'Plan: create hello.txt', question: 'Would you like to proceed?',
  channel: 'fenced-keys', formFingerprint: FP, promptFingerprint: FP, createdAt: 5, state: 'pending',
  form: { v: 1, kind: 'plan', actions: [
    { id: 'approve-manual', label: 'Yes, manually approve edits' },
    { id: 'feedback', label: 'Tell Claude what to change', needsText: true },
  ] },
};
// Not bound to its call (or a bypass row on the dialog): no form, so no actions.
const unbound: ApprovalRequest = {
  id: 'req-2', sessionId: 'pty-b', agent: 'claude', kind: 'terminal_prompt', toolName: 'ExitPlanMode',
  summary: 'Plan: other', createdAt: 6, state: 'pending',
};
const permission: ApprovalRequest = {
  id: 'req-3', sessionId: 'pty-c', agent: 'claude', kind: 'terminal_prompt', toolName: 'Bash', createdAt: 7, state: 'pending',
};

function fixture() {
  const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'daemon.approvals.list') return { pending: [answerable, unbound, permission], recentlyResolved: [] };
    if (method === 'daemon.approvals.detail') {
      return params['id'] === 'req-1'
        ? { id: 'req-1', toolName: 'ExitPlanMode', command: '# Plan: create hello.txt\n\n1. Write it.', truncated: false }
        : null;
    }
    if (method === 'daemon.approvals.answerPlan') return { ok: false, reason: 'prompt-changed', request: answerable };
    return null;
  });
  const client = Object.assign(new EventEmitter(), { isConnected: true, rpc });
  const wc = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: vi.fn() });
  const window = { webContents: wc, isDestroyed: () => false } as unknown as Electron.BrowserWindow;
  cleanup = registerPlanApprovalHandlers(() => window, client as unknown as DaemonClient);
  const event = { sender: wc, senderFrame: wc.mainFrame };
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  return { client, rpc, wc, event, call };
}

describe('Fleet Plan card bridge', () => {
  it('lists pending plan dialogs with the plan and the form actions exactly as the daemon defines them', async () => {
    const { call } = fixture();
    expect(await call(IPC.PLAN_APPROVALS_LIST)).toEqual([
      {
        id: 'req-1', sessionId: 'pty-a', workspaceId: 'ws-1', agent: 'claude',
        summary: 'Plan: create hello.txt', question: 'Would you like to proceed?',
        plan: '# Plan: create hello.txt\n\n1. Write it.', planTruncated: false,
        actions: [
          { id: 'approve-manual', label: 'Yes, manually approve edits', needsText: false },
          { id: 'feedback', label: 'Tell Claude what to change', needsText: true },
        ],
        formFingerprint: FP, answered: false, stopped: false, createdAt: 5,
      },
      // Fail closed: shown, but with nothing to press.
      { id: 'req-2', sessionId: 'pty-b', agent: 'claude', summary: 'Plan: other', actions: [], answered: false, stopped: false, createdAt: 6 },
    ]);
  });

  it('answers through daemon.approvals.answerPlan, and serves only the main window', async () => {
    const { call, rpc, wc } = fixture();
    const result = await call(IPC.PLAN_APPROVALS_ANSWER, { id: 'req-1', formFingerprint: FP, action: 'feedback', text: '  ' });
    expect(result).toEqual({ ok: false, reason: 'prompt-changed' });
    const sent = rpc.mock.calls.find(([m]) => m === 'daemon.approvals.answerPlan')![1] as { id: string; answer: Record<string, unknown> };
    // Whitespace-only feedback is no feedback; the client answer id is main's own.
    expect(sent).toMatchObject({ id: 'req-1', answer: { formFingerprint: FP, action: 'feedback' } });
    expect(sent.answer).not.toHaveProperty('text');
    expect(sent.answer['clientAnswerId']).toMatch(/^[0-9a-f-]{36}$/);

    const other = { sender: wc, senderFrame: {} };
    expect(await handlers.get(IPC.PLAN_APPROVALS_ANSWER)!(other, { id: 'req-1', formFingerprint: FP, action: 'approve-manual' }))
      .toEqual({ ok: false, reason: 'operator-only' });
    expect(await handlers.get(IPC.PLAN_APPROVALS_LIST)!(other)).toEqual([]);
    expect(rpc.mock.calls.filter(([m]) => m === 'daemon.approvals.answerPlan')).toHaveLength(1);
  });

  it('a feedback answer that stopped partway is not shown as sent, and offers no actions', () => {
    const step = { answerId: 'a', index: 1, total: 3, expectedRevision: 4, incarnation: 'i', startedAt: 5 };
    expect(toPlanApprovalView({ ...answerable, step: { ...step, status: 'partial' } }, null))
      .toMatchObject({ answered: false, stopped: true });
    expect(toPlanApprovalView({ ...answerable, step: { ...step, status: 'running' } }, null))
      .toMatchObject({ answered: true, stopped: false });
  });

  it('nudges the renderer on every daemon approval change', () => {
    const { client, wc } = fixture();
    wc.send.mockClear();
    client.emit('approvals:changed');
    expect(wc.send).toHaveBeenCalledWith(IPC.PLAN_APPROVALS_CHANGED);
  });
});
