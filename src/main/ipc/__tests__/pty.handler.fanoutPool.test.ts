// A fan-out worker's pane create in daemon mode, through the real handler,
// for a launch the account pool booked (worktask/fanoutAccountPool.ts): the
// spawn env names the account's folder from the launch record, carries no
// vault value, is not rotated away from a default-login pick, and the
// daemon's transcript binding then reads that folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = new Map<string, (...a: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/tmp', on: () => undefined },
  ipcMain: {
    handle: (c: string, f: (...a: unknown[]) => unknown) => captured.set(c, f),
    removeHandler: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
  },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {},
  clipboard: {},
}));

import { registerPTYHandlers } from '../handlers/pty.handler';
import { IPC } from '../../../shared/constants';
import { WORKER_SLOTS_FILENAME, WorkerSlots, setWorkerSlotsForTests } from '../../factory/workerSlots';
import { FanOutGuards, setFanOutGuardsForTests } from '../../worktask/fanoutGuards';
import { __resetAccountStoreForTests, getAccountsPath } from '../../account/accountStore';
import { setAccountVault } from '../../account/accountVault';
import { __resetAccountRotationServiceForTests, getAccountRotationService } from '../../account/AccountRotationService';
import { POOL_DEFAULT_ACCOUNT } from '../../../shared/fanoutAccountPool';
import { commandLineBinding } from '../../../daemon/transcript/agentCommandLineBinding';
import { trackedTempDir } from '../../../test-utils/trackedTempDir';

const ID = '0f9d8c7b-6a5e-4d3c-8b2a-1f0e9d8c7b6a';
let home: string;
let accountDir: string;
let slots: WorkerSlots;

beforeEach(() => {
  home = trackedTempDir('wmux-pool-home-');
  accountDir = trackedTempDir('wmux-pool-acct-');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  // The account the pool picked, with a vault value it must not get.
  const accounts = { version: 1, accounts: [{ id: 'acc-a', name: 'A', vendor: 'claude', configDir: accountDir, createdAt: 1 }], bindings: {} };
  fs.mkdirSync(path.dirname(getAccountsPath()), { recursive: true });
  fs.writeFileSync(getAccountsPath(), JSON.stringify(accounts));
  __resetAccountStoreForTests();
  setAccountVault({
    list: () => [{ accountId: 'acc-a', name: 'CLAUDE_CODE_OAUTH_TOKEN', inject: true, usable: true, length: 5, createdAt: 1, updatedAt: 1, fingerprint: 'x' }],
    envFor: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'vault-value' }),
  } as never);
  slots = new WorkerSlots(path.join(home, 'factory', WORKER_SLOTS_FILENAME), () => []);
  slots.load();
  setWorkerSlotsForTests(slots);
  setFanOutGuardsForTests(new FanOutGuards({ dir: home, ledgerTaskOwner: () => null, ledgerBotTask: () => null }));
});

afterEach(() => {
  slots.settlePendingWriteForTests();
  setWorkerSlotsForTests(null);
  setFanOutGuardsForTests(null);
  setAccountVault(null);
  __resetAccountStoreForTests();
  __resetAccountRotationServiceForTests();
  vi.restoreAllMocks();
});

async function createTaskPane(accountId: string, extra: Record<string, unknown> = {}): Promise<{ params?: { env?: Record<string, string>; secretEnv?: unknown }; error?: unknown }> {
  const rpc = vi.fn(async () => ({}));
  const daemonClient = {
    isConnected: true, writeToSession: vi.fn(), on: () => undefined, off: () => undefined, removeListener: () => undefined,
    rpc, connectSessionPipe: vi.fn(), disconnectSessionPipe: vi.fn(async () => undefined),
  };
  const { gen } = slots.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws-owner', accountId });
  registerPTYHandlers({} as never, { setupDataForwarding: () => undefined } as never, daemonClient as never, () => null);
  const create = captured.get(IPC.PTY_CREATE);
  let error: unknown;
  await Promise.resolve(create?.({}, {
    cwd: process.cwd(), workspaceId: 'ws-task', fanoutTaskOf: 'ws-owner', fanoutLaunch: { taskId: 't1', gen },
    initialCommand: 'claude', ...extra,
  })).catch((err: unknown) => { error = err; });
  const call = rpc.mock.calls.find((c) => (c as unknown[])[0] === 'daemon.createSession') as unknown[] | undefined;
  return { params: call?.[1] as { env?: Record<string, string>; secretEnv?: unknown } | undefined, error };
}

describe('a pool worker pane create (daemon mode)', () => {
  it('spawns on the recorded account folder with no vault value, and binds its transcript there', async () => {
    const { params, error } = await createTaskPane('acc-a');
    expect(error).toBeUndefined();
    expect(params?.env?.CLAUDE_CONFIG_DIR).toBe(accountDir);
    expect(params?.secretEnv).toBeUndefined();
    // The daemon keeps that env as the session's meta.env; its transcript
    // binding reads the account's folder, not a decoy under HOME/.claude.
    for (const root of [path.join(home, '.claude'), accountDir]) {
      fs.mkdirSync(path.join(root, 'projects', '-work'), { recursive: true });
      fs.writeFileSync(path.join(root, 'projects', '-work', `${ID}.jsonl`), '{}\n');
    }
    const binding = commandLineBinding('claude', `claude --resume ${ID}`, '/work', params?.env, { now: 1 });
    expect(binding?.transcriptPath).toBe(path.join(accountDir, 'projects', '-work', `${ID}.jsonl`));
  });

  it('a default-login pick is not rotated away and gets no account folder', async () => {
    const prepare = vi.spyOn(getAccountRotationService(), 'prepareLaunch').mockResolvedValue({ kind: 'switch', accountId: 'acc-a', env: { CLAUDE_CONFIG_DIR: accountDir } });
    const { params, error } = await createTaskPane(POOL_DEFAULT_ACCOUNT);
    expect(error).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    expect(params?.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(params?.secretEnv).toBeUndefined();
  });

  it('refuses a renderer account that differs from the record, before any session', async () => {
    const { params, error } = await createTaskPane(POOL_DEFAULT_ACCOUNT, { accountId: 'acc-a' });
    expect(String(error)).toMatch(/account its launch recorded/);
    expect(params).toBeUndefined();
  });

  it('refuses a picked account whose folder is gone', async () => {
    fs.rmSync(accountDir, { recursive: true, force: true });
    const { params, error } = await createTaskPane('acc-a');
    expect(String(error)).toMatch(/account folder is missing/);
    expect(params).toBeUndefined();
  });

  it('a task switched to codex drops the record\'s account and spawns without it', async () => {
    const { params } = await createTaskPane('acc-a', { initialCommand: 'codex' });
    expect(params?.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(slots.launchOf('t1')).not.toHaveProperty('accountId');
  });
});
