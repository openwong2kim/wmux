import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * #1778 — per-thread identity under a shared Codex app-server, through the
 * REAL registered handlers of createWmuxServer over an in-memory transport.
 * Mocked boundaries only: the RPC pipe (sendRpc), the parent-process lookup
 * (readParentChain) and the platform predicate (codexOwnerIndexAvailable).
 * Owner records are real v1 files read by the real readCodexThreadOwner.
 */

const { mockSendRpc, parentChain, ownerIndex } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  parentChain: vi.fn(),
  ownerIndex: { value: true },
}));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});
vi.mock('../codexThreadIdentity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codexThreadIdentity')>();
  return { ...actual, readParentChain: parentChain, codexOwnerIndexAvailable: () => ownerIndex.value };
});

vi.mock('../../shared/computer/config', () => ({ readComputerUseEnabled: () => true, readComputerUseAskPerApp: () => false }));

import { createWmuxServer } from '../index';

const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const T1 = '019a0000-0000-7000-8000-000000000001';
const T2 = '019a0000-0000-7000-8000-000000000002';
const T3 = '019a0000-0000-7000-8000-000000000003';

const SHARED_SERVER = ['/Users/u/.codex/packages/app-server-daemon/releases/0.160.0/bin/codex', 'app-server', '--listen', 'unix://', '--managed-daemon'];
const MCP_ENTRY = ['node', '/Users/u/.wmux/mcp/index.js'];

// Live panes: pty-a (ws-1) and pty-b (ws-2). main's server-side walk ends at
// the daemon starter pty-s (ws-s) — the pre-fix identity of every call.
const ENTRIES = [
  { pid: '101', ptyId: 'pty-a', workspaceId: 'ws-1' },
  { pid: '102', ptyId: 'pty-b', workspaceId: 'ws-2' },
  { pid: '103', ptyId: 'pty-s', workspaceId: 'ws-s' },
];

let home: string;

function recordOwner(id: string, ptyId: string, workspaceId: string): void {
  const dir = path.join(home, 'wmux-thread-owners');
  fs.mkdirSync(dir, { recursive: true });
  const env = {
    WMUX_PTY_ID: ptyId, WMUX_WORKSPACE_ID: workspaceId, WMUX_SURFACE_ID: '', WMUX_DATA_SUFFIX: '',
    WMUX_PIPE_NAME: '', WMUX_HOOKS_TO_MAIN: '',
  };
  const nonce = randomUUID();
  fs.writeFileSync(path.join(dir, `thread-${digest(id)}.json`), JSON.stringify({ version: 1, id, env, nonce }));
  fs.writeFileSync(path.join(dir, `pane-${digest(JSON.stringify(['', ptyId]))}.json`), JSON.stringify({ id, nonce }));
}

type Handler = (method: string, params: Record<string, unknown>) => unknown;
let extraRpc: Handler = () => ({});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-server-'));
  vi.stubEnv('CODEX_HOME', home);
  // Owner records name the wmux instance; this suite plays the default one.
  vi.stubEnv('WMUX_DATA_SUFFIX', '');
  // The default-home probe must not read the real ~/.codex.
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  ownerIndex.value = true;
  parentChain.mockReset();
  parentChain.mockResolvedValue([MCP_ENTRY, SHARED_SERVER]);
  extraRpc = () => ({});
  mockSendRpc.mockReset();
  mockSendRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.resolve.identity') {
      return {
        mappings: Object.fromEntries(ENTRIES.map((e) => [e.pid, e.workspaceId])),
        entries: ENTRIES,
        resolved: { workspaceId: 'ws-s', ptyId: 'pty-s' },
      };
    }
    if (method === 'a2a.whoami') return { echo: params };
    if (method === 'mcp.claimWorkspace') return { workspaceId: 'ws-mcp', ptyId: 'pty-mcp', token: 'tok' };
    return extraRpc(method, params);
  });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function connect(opts: { envPtyHint?: string; envWorkspaceHint?: string } = {}): Promise<Client> {
  const server = createWmuxServer({
    envWorkspaceHint: opts.envWorkspaceHint ?? 'ws-s',
    envPtyHint: opts.envPtyHint ?? 'pty-s',
    commanderToken: undefined,
    commanderMode: false,
    coreMode: false,
    callerPid: process.pid,
    callerPpid: 4242,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'codex-mcp-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

interface ToolResult { isError?: boolean; content: Array<{ type: string; text?: string }> }

async function call(client: Client, name: string, args: Record<string, unknown>, threadId?: string): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args, ...(threadId ? { _meta: { threadId } } : {}) })) as ToolResult;
}

const whoamiParams = () =>
  mockSendRpc.mock.calls.filter((c) => c[0] === 'a2a.whoami').map((c) => c[1] as Record<string, unknown>);

describe('shared Codex app-server, owner index available (pane relay, non-Windows)', () => {
  it('gives two concurrent threads their own pane and workspace', async () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    recordOwner(T2, 'pty-b', 'ws-2');
    const client = await connect();
    await Promise.all([
      call(client, 'a2a_whoami', {}, T1),
      call(client, 'a2a_whoami', {}, T2),
      call(client, 'a2a_whoami', {}, T1),
    ]);
    await client.close();
    const seen = whoamiParams().map((p) => `${p.workspaceId}/${p.senderPtyId}`).sort();
    expect(seen).toEqual(['ws-1/pty-a', 'ws-1/pty-a', 'ws-2/pty-b']);
    // A thread-only call never asks main for the server-side walk.
    const identityCalls = mockSendRpc.mock.calls.filter((c) => c[0] === 'a2a.resolve.identity');
    expect(identityCalls.every((c) => !('callerPid' in (c[1] as object)))).toBe(true);
  });

  it('refuses a call without a threadId once the parent is a shared server', async () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    const client = await connect();
    expect((await call(client, 'a2a_whoami', {}, T1)).isError).toBeFalsy();
    const res = await call(client, 'a2a_whoami', {});
    await client.close();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no valid Codex thread id/);
    // Never the daemon starter's identity.
    expect(whoamiParams()).toHaveLength(1);
  });

  it('treats an unreadable parent chain as a retryable error and asks again next call', async () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    parentChain.mockResolvedValueOnce([]);
    const client = await connect();
    const first = await call(client, 'a2a_whoami', {}, T1);
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toMatch(/could not be inspected.*Retry/s);
    expect(first.content[0].text).not.toMatch(/setup-hooks/);
    // 'unknown' was not remembered: the next call inspects again and resolves.
    const second = await call(client, 'a2a_whoami', {}, T1);
    await client.close();
    expect(second.isError).toBeFalsy();
    expect(parentChain).toHaveBeenCalledTimes(2);
    expect(whoamiParams()).toEqual([{ workspaceId: 'ws-1', senderPtyId: 'pty-a' }]);
  });

  it('lets a threadless call through when the parent is unknown (a client without threadIds)', async () => {
    parentChain.mockResolvedValue([]);
    const client = await connect();
    const res = await call(client, 'a2a_whoami', {});
    await client.close();
    expect(res.isError).toBeFalsy();
    expect(whoamiParams()).toEqual([{ workspaceId: 'ws-s', senderPtyId: 'pty-s' }]);
  });

  it('keeps the pre-#1778 identity for a non-Codex parent', async () => {
    parentChain.mockResolvedValue([MCP_ENTRY, ['zsh', '-l']]);
    const client = await connect();
    await call(client, 'a2a_whoami', {}, T1);
    await call(client, 'a2a_whoami', {}, T2);
    await client.close();
    expect(whoamiParams()).toEqual([
      { workspaceId: 'ws-s', senderPtyId: 'pty-s' },
      { workspaceId: 'ws-s', senderPtyId: 'pty-s' },
    ]);
    // 'other' is remembered: one inspection for the connection.
    expect(parentChain).toHaveBeenCalledTimes(1);
  });

  it('gives an unresolved thread no identity and no shared fallback', async () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    const client = await connect();
    // Warm the process caches through a resolved thread first.
    expect((await call(client, 'a2a_whoami', {}, T1)).isError).toBeFalsy();

    const whoami = await call(client, 'a2a_whoami', {}, T3);
    expect(whoami.isError).toBe(true);
    expect(whoami.content[0].text).toMatch(/no wmux pane owns Codex thread .*setup-hooks/s);

    const read = await call(client, 'terminal_read', {}, T3);
    expect(read.isError).toBe(true);
    expect(read.content[0].text).toMatch(/Workspace identity unknown/);
    await client.close();
    // No external claim (the shared "MCP" workspace), no terminal RPC.
    expect(mockSendRpc).not.toHaveBeenCalledWith('mcp.claimWorkspace', expect.anything(), expect.anything());
    expect(mockSendRpc).not.toHaveBeenCalledWith('mcp.claimWorkspace', expect.anything());
    expect(mockSendRpc.mock.calls.some((c) => String(c[0]).startsWith('input.') || c[0] === 'terminal.read')).toBe(false);
  });

  it('gives computer use the thread\'s pane, and an unresolved thread no shared instance id', async () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    extraRpc = (method) => (method.startsWith('computer.') ? { method: 'synthetic', verification: 'unverified' } : {});
    const client = await connect();
    const unresolved = await call(client, 'computer', { action: 'click', snapshotId: 's1', index: 1 }, T3);
    expect(unresolved.isError).toBe(true);
    await call(client, 'computer', { action: 'click', snapshotId: 's1', index: 1 }, T1);
    await client.close();
    const acts = mockSendRpc.mock.calls.filter((c) => String(c[0]).startsWith('computer.')).map((c) => c[1]);
    expect(acts).toEqual([{ action: 'click', snapshotId: 's1', index: 1, senderPtyId: 'pty-a' }]);
  });

  it('routes a resolved thread\'s terminal call to its own workspace', async () => {
    recordOwner(T2, 'pty-b', 'ws-2');
    const seen: Array<Record<string, unknown>> = [];
    extraRpc = (method, params) => {
      if (method !== 'workspace.list') seen.push({ method, ...params });
      return { text: '' };
    };
    const client = await connect();
    await call(client, 'terminal_read', {}, T2);
    await client.close();
    const terminal = seen.find((s) => s.method === 'input.readScreen');
    expect(terminal?.workspaceId).toBe('ws-2');
  });

  it.each([
    ['pane_list', 'pane.list'],
    ['surface_list', 'surface.list'],
    ['pane_split', 'pane.split'],
    ['surface_new', 'surface.new'],
  ])('fails %s closed for an unresolved thread instead of using the focused workspace', async (tool, method) => {
    const client = await connect();
    const noOwner = await call(client, tool, {}, T3);
    expect(noOwner.isError).toBe(true);
    expect(noOwner.content[0].text).toMatch(/no wmux pane owns Codex thread/);
    // An uninspectable parent is a retryable error for these tools too.
    parentChain.mockResolvedValueOnce([]);
    const fresh = await connect();
    const unknown = await call(fresh, tool, {}, T3);
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toMatch(/could not be inspected.*Retry/s);
    await client.close();
    await fresh.close();
    expect(mockSendRpc.mock.calls.some((c) => c[0] === method)).toBe(false);
  });

  it('scopes pane_list to a resolved thread\'s own workspace', async () => {
    recordOwner(T2, 'pty-b', 'ws-2');
    const client = await connect();
    await call(client, 'pane_list', {}, T2);
    await client.close();
    expect(mockSendRpc.mock.calls.find((c) => c[0] === 'pane.list')?.[1]).toEqual({ workspaceId: 'ws-2' });
  });

  it('reports an unreachable wmux as retryable, without the setup-hooks hint', async () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    const client = await connect();
    mockSendRpc.mockImplementation(async () => { throw new Error('connect ENOENT'); });
    const res = await call(client, 'a2a_whoami', {}, T1);
    await client.close();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not reachable.*Retry/s);
    expect(res.content[0].text).not.toMatch(/setup-hooks/);
  });
});

describe('shared Codex app-server, no owner index (Windows today)', () => {
  beforeEach(() => { ownerIndex.value = false; });

  it('keeps the single-pane identity when the thread has no owner record', async () => {
    const client = await connect();
    const res = await call(client, 'a2a_whoami', {}, T1);
    await client.close();
    expect(res.isError).toBeFalsy();
    expect(whoamiParams()).toEqual([{ workspaceId: 'ws-s', senderPtyId: 'pty-s' }]);
  });

  it('inspects the parent once, and never for a threadless call', async () => {
    const client = await connect();
    await call(client, 'a2a_whoami', {});
    expect(parentChain).not.toHaveBeenCalled();
    await call(client, 'a2a_whoami', {}, T1);
    await call(client, 'a2a_whoami', {}, T2);
    await client.close();
    expect(parentChain).toHaveBeenCalledTimes(1);
  });

  it('remembers an uninspectable parent for a minute instead of paying the lookup on every call', async () => {
    // A lookup that keeps timing out costs 5 s each time, and here 'unknown'
    // decides the same thing as 'other': the starter pane.
    parentChain.mockResolvedValue([]);
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const client = await connect();
      for (const thread of [T1, T2, T1]) {
        const res = await call(client, 'a2a_whoami', {}, thread);
        expect(res.isError).toBeFalsy();
      }
      expect(parentChain).toHaveBeenCalledTimes(1);
      now += 60_001;
      await call(client, 'a2a_whoami', {}, T1);
      await client.close();
      expect(parentChain).toHaveBeenCalledTimes(2);
      expect(whoamiParams().every((p) => p.workspaceId === 'ws-s' && p.senderPtyId === 'pty-s')).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('finds an owner under the CODEX_HOME derived from the shared server\'s path', async () => {
    // Codex passes no CODEX_HOME to the MCP server: only the daemon path names it.
    const customHome = path.join(home, 'custom codex home');
    vi.stubEnv('CODEX_HOME', '');
    parentChain.mockResolvedValue([MCP_ENTRY, [
      path.join(customHome, 'packages', 'app-server-daemon', 'releases', '0.160.0', 'bin', 'codex'),
      'app-server', '--listen', 'unix://', '--managed-daemon',
    ]]);
    const saved = home;
    home = customHome;
    recordOwner(T1, 'pty-a', 'ws-1');
    home = saved;
    const client = await connect();
    await call(client, 'a2a_whoami', {}, T1);
    await client.close();
    expect(whoamiParams()).toEqual([{ workspaceId: 'ws-1', senderPtyId: 'pty-a' }]);
  });

  it('keeps today\'s terminal routing for an ownerless thread', async () => {
    const seen: Array<Record<string, unknown>> = [];
    extraRpc = (method, params) => {
      if (method !== 'workspace.list') seen.push({ method, ...params });
      return { text: '' };
    };
    const client = await connect();
    const res = await call(client, 'terminal_read', {}, T1);
    await client.close();
    expect(res.isError).toBeFalsy();
    expect(seen.find((s) => s.method === 'input.readScreen')?.workspaceId).toBe('ws-s');
  });

  it('still uses a thread owner when one exists, and falls back when its pane is gone', async () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    recordOwner(T2, 'pty-gone', 'ws-9');
    const client = await connect();
    await call(client, 'a2a_whoami', {}, T1);
    const res = await call(client, 'a2a_whoami', {}, T2);
    await client.close();
    expect(res.isError).toBeFalsy();
    expect(whoamiParams()).toEqual([
      { workspaceId: 'ws-1', senderPtyId: 'pty-a' },
      { workspaceId: 'ws-s', senderPtyId: 'pty-s' },
    ]);
  });
});
