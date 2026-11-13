// A mission closed over the pipe (`channel_mission_close` → task.mission.close)
// leaves the task ledger in the same call, so the owner lane refuses the
// closed task's panes at once instead of after the throttled WorkTask mirror.
// Both handlers are dispatched through one real RpcRouter over one real
// TaskLedger; only the daemon and the renderer are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aChannelRpc } from '../a2a.channel.rpc';
import { registerInputRpc } from '../input.rpc';
import { TaskLedger } from '../../../../daemon/ledger/TaskLedger';
import { getTaskLedger, setTaskLedgerForTests } from '../../../deck/taskLedgerHost';
import type { DaemonClient } from '../../../DaemonClient';
import type { PTYManager } from '../../../pty/PTYManager';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const PANE_OWNERS: Record<string, string> = { 'pty-owner': 'ws-owner', 'pty-task': 'ws-task' };

type Answer = { ok: boolean; error?: string; result?: unknown };

let dir: string;
let closeAnswer: { ok: boolean; error?: unknown };
let writes: string[];
let router: RpcRouter;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mission-close-'));
  setTaskLedgerForTests(new TaskLedger({ dir }));
  await getTaskLedger().register({ id: 'wtask-1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'lane' });
  closeAnswer = { ok: true };
  writes = [];
  sendToRendererMock.mockImplementation((_w: unknown, method: string, params: Record<string, unknown>) =>
    Promise.resolve(method === 'input.findOwnerWorkspace' ? { workspaceId: PANE_OWNERS[params['ptyId'] as string] ?? null } : null),
  );
  const dc = {
    isConnected: true,
    rpc: async (method: string) => {
      if (method === 'task.mission.close') return closeAnswer;
      if (method === 'daemon.approvals.list') return { pending: [] };
      return {};
    },
    writeToSession: (_ptyId: string, data: string) => {
      writes.push(data);
      return true;
    },
  };
  router = new RpcRouter();
  registerA2aChannelRpc(router, () => dc as unknown as DaemonClient, () => ({}) as BrowserWindow);
  registerInputRpc(router, { get: () => undefined } as unknown as PTYManager, () => ({}) as BrowserWindow, () => dc as never, undefined, undefined, {
    ownerAnswers: () => 'all',
    paneAgent: async () => 'claude',
    ownerLaneNotice: () => undefined,
    log: () => undefined,
    readScreenText: async () => 'worker output',
    usageLimited: () => false,
  });
});

afterEach(() => {
  setTaskLedgerForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const call = (method: string, params: Record<string, unknown>): Promise<Answer> =>
  router.dispatch({ id: '1', method, params } as never, { externalWire: true }) as Promise<Answer>;

const pressEnter = (): Promise<Answer> => call('input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-task', key: 'enter', callerPtyId: 'pty-owner' });

describe('task.mission.close over the pipe', () => {
  it('cancels the ledger row in the same call, so the owner lane refuses the task at once', async () => {
    expect((await pressEnter()).ok).toBe(true);
    expect(writes).toEqual(['\r']);

    const closed = await call('task.mission.close', { taskId: 'wtask-1', senderPtyId: 'pty-owner' });
    expect(closed).toMatchObject({ ok: true, result: { ok: true } });
    expect(getTaskLedger().get('wtask-1')?.status).toBe('cancelled');

    const after = await pressEnter();
    expect(after.ok).toBe(false);
    expect(after.error).toContain('Cross-workspace terminal access is not allowed');
    expect(writes).toEqual(['\r']);
  });

  it('leaves the row open when the daemon refuses the close', async () => {
    closeAnswer = { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'not the owner' } };

    await call('task.mission.close', { taskId: 'wtask-1', senderPtyId: 'pty-owner' });

    expect(getTaskLedger().get('wtask-1')?.status).toBe('working');
    expect((await pressEnter()).ok).toBe(true);
  });
});
