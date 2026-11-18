// The Remote page's approvals row → main → the daemon's approvals.set, as the
// app's own call: only a host id and one of the three levels pass, and the
// daemon's line names the app (`by=app-settings`), never a word the renderer sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }),
      removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
    },
    BrowserWindow: { getAllWindows: () => [] },
    __handlers: handlers,
  };
});
vi.mock('../../github/PrProvider', () => ({ detectRemote: vi.fn(async () => null) }));

import * as electron from 'electron';
import { IPC } from '../../../shared/constants';
import { A2A_APPROVALS_RPC, A2A_APPROVALS_SET_BY_APP } from '../../../shared/a2aRemote';
import { registerA2aRemoteHandlers } from '../handlers/a2aRemote.handler';
import { DaemonClient } from '../../DaemonClient';
import { ApprovalSwitchStore, setApprovals } from '../../../daemon/a2aRemote/approvalSwitchStore';

const handlers = (electron as unknown as { __handlers: Map<string, (...args: unknown[]) => Promise<unknown>> }).__handlers;
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

const PC = '11111111-1111-4111-8111-111111111111';
let dir: string;
let lines: string[];
let rpc: ReturnType<typeof vi.fn>;
let cleanup: () => void;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-ipc-'));
  lines = [];
  const store = new ApprovalSwitchStore({ dir, pairing: () => 'peer:1', log: () => undefined, scheduleHarden: () => undefined });
  // The daemon end of the control pipe: approvals.set exactly as the daemon registers it.
  rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === A2A_APPROVALS_RPC.set) return setApprovals(store, params, { log: (_l, m) => lines.push(m) });
    if (method === A2A_APPROVALS_RPC.get) return store.get();
    throw new Error(`unexpected ${method}`);
  });
  const client = {
    on: vi.fn(),
    off: vi.fn(),
    rpc,
    a2aRemoteApprovalsSet: DaemonClient.prototype.a2aRemoteApprovalsSet,
    a2aRemoteApprovalsGet: DaemonClient.prototype.a2aRemoteApprovalsGet,
  } as unknown as DaemonClient;
  cleanup = registerA2aRemoteHandlers(client);
});
afterEach(() => {
  cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the Remote page\'s approvals row → the daemon', () => {
  it('a set reaches approvals.set as the app, and the daemon logs by=app-settings', async () => {
    expect(await invoke(IPC.A2A_REMOTE_APPROVALS_SET, PC, 'command')).toMatchObject({ ok: true, hosts: { [PC]: 'command' } });
    expect(rpc).toHaveBeenCalledWith(A2A_APPROVALS_RPC.set, { hostId: PC, exposure: 'command', senderPtyId: A2A_APPROVALS_SET_BY_APP });
    expect(lines).toEqual([`[a2a-remote] approvals set by=app-settings host=${PC} off->command`]);
    expect(await invoke(IPC.A2A_REMOTE_APPROVALS_GET)).toMatchObject({ hosts: { [PC]: 'command' }, damaged: false });
  });

  it('a renderer argument past the host id and level is never passed on; a bad host or level never reaches the daemon', async () => {
    await invoke(IPC.A2A_REMOTE_APPROVALS_SET, PC, 'off', { senderPtyId: 'pty-spoof' });
    expect(rpc).toHaveBeenLastCalledWith(A2A_APPROVALS_RPC.set, { hostId: PC, exposure: 'off', senderPtyId: A2A_APPROVALS_SET_BY_APP });
    rpc.mockClear();
    expect(await invoke(IPC.A2A_REMOTE_APPROVALS_SET, 'not-a-host', 'command')).toEqual({ ok: false, error: 'bad-request' });
    expect(await invoke(IPC.A2A_REMOTE_APPROVALS_SET, PC, 'everything')).toEqual({ ok: false, error: 'bad-request' });
    expect(rpc).not.toHaveBeenCalled();
  });
});
