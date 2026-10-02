import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// The opt-in switch and the pipe are the only boundaries mocked: the tool is
// exercised through a real McpServer from createWmuxServer.
const { mockSendRpc, enabled } = vi.hoisted(() => ({ mockSendRpc: vi.fn(), enabled: { value: false } }));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});
vi.mock('../../shared/computer/config', () => ({ readComputerUseEnabled: () => enabled.value }));

import { createWmuxServer } from '../index';
import { encodeComputerErrorMessage } from '../../shared/computer/errors';
import type { AppInfo, HelperMethod, WindowInfo } from '../../shared/computer/protocol';
import type { RpcContext } from '../../shared/rpc';
import type { RpcRouter } from '../../main/pipe/RpcRouter';
import { registerComputerRpc } from '../../main/pipe/handlers/computer.rpc';
import { ComputerService, type HelperLike } from '../../main/computer/ComputerService';

async function connect(opts: { coreMode?: boolean } = {}) {
  const server = createWmuxServer({
    envWorkspaceHint: 'ws-caller',
    envPtyHint: '',
    commanderToken: undefined,
    commanderMode: false,
    coreMode: opts.coreMode ?? false,
    callerPid: process.pid,
    callerPpid: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function toolNames(opts: { coreMode?: boolean } = {}) {
  const client = await connect(opts);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

// Connecting sends mcp.identify; only computer.* calls are the tool's.
let reply: (method: string) => unknown = () => ({});
const computerCalls = () => mockSendRpc.mock.calls.filter((c) => String(c[0]).startsWith('computer.'));

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockImplementation(async (method: string) => (method.startsWith('computer.') ? reply(method) : {}));
  enabled.value = false;
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('computer MCP tool', () => {
  it('is absent unless the user opted in', async () => {
    expect(await toolNames()).not.toContain('computer');
  });

  it('is listed in the full profile when opted in, and never in core', async () => {
    enabled.value = true;
    const full = await toolNames();
    expect(full).toContain('computer');
    // Appended last so the default ordering the probe pins is untouched.
    expect(full[full.length - 1]).toBe('computer');
    expect(await toolNames({ coreMode: true })).not.toContain('computer');
  });

  it('returns app state as metadata text first, then the image', async () => {
    enabled.value = true;
    reply = () => ({
      snapshotId: 's7',
      app: { id: 'np', name: 'Notepad', pid: 1, path: 'np.exe' },
      window: { id: 'w1', appId: 'np', pid: 1, title: 'notes', bounds: { x: 0, y: 0, width: 1, height: 1 } },
      tree: '0 window notes\n\t1 edit Text, Value: hi',
      screenshot: { mime: 'image/jpeg', data: 'QUJD', width: 640, height: 360, scale: 0.5 },
      screenshotStatus: { status: 'captured' },
    });
    const client = await connect();
    const res = await client.callTool({ name: 'computer', arguments: { action: 'getAppState', app: 'Notepad' } });
    await client.close();
    const content = res.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(content[0].text).toContain('"snapshotId":"s7"');
    expect(content[0].text).toContain('1 edit Text, Value: hi');
    expect(content[1]).toMatchObject({ data: 'QUJD', mimeType: 'image/jpeg' });
    // Outside any pane the server identifies itself by its instance id, never the env pty hint.
    expect(computerCalls()).toEqual([['computer.getAppState', { app: 'Notepad', window: undefined, mode: undefined, callerInstance: expect.stringMatching(UUID_RE) }, expect.any(Number)]]);
  });

  it('identifies an in-pane caller by its walked pane, never by the env pty hint', async () => {
    enabled.value = true;
    reply = () => ({ method: 'synthetic', verification: 'unverified' });
    // main's server-side walk answers with this process's pane.
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.resolve.identity') return { mappings: {}, resolved: { workspaceId: 'ws-walked', ptyId: 'pty-walked' } };
      return method.startsWith('computer.') ? reply(method) : {};
    });
    const server = createWmuxServer({
      envWorkspaceHint: 'ws-env',
      envPtyHint: 'pty-env-inherited',
      commanderToken: undefined,
      commanderMode: false,
      coreMode: false,
      callerPid: process.pid,
      callerPpid: null,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: 'computer', arguments: { action: 'click', snapshotId: 's7', index: 3 } });
    await client.close();
    expect(computerCalls()).toEqual([['computer.act', { action: 'click', snapshotId: 's7', index: 3, senderPtyId: 'pty-walked' }, expect.any(Number)]]);
  });

  it('shows a consented app\'s window titles over MCP and blanks the rest', async () => {
    enabled.value = true;
    // The real main side behind the pipe: computer.rpc.ts and ComputerService
    // over a scripted helper, so the identity the MCP server attaches is what
    // main keys consent and titles on.
    const apps: AppInfo[] = [
      { id: 'com.apple.TextEdit', name: 'TextEdit', pid: 500, path: '/System/Applications/TextEdit.app', bundleId: 'com.apple.TextEdit' },
      { id: 'com.apple.Notes', name: 'Notes', pid: 501, path: '/System/Applications/Notes.app', bundleId: 'com.apple.Notes' },
    ];
    const windows: WindowInfo[] = apps.map((a) => ({ id: `w${a.pid}`, appId: a.id, pid: a.pid, title: `${a.name} secret`, bounds: { x: 0, y: 0, width: 10, height: 10 } }));
    const helper: HelperLike = {
      request: (async (method: HelperMethod, params: Record<string, unknown>) => {
        const i = apps.findIndex((a) => a.name === params.app || a.id === params.app);
        if (method === 'listApps') return { apps };
        if (method === 'listWindows') return { windows };
        if (method === 'resolveTarget') return { app: apps[i], window: windows[i] };
        if (method === 'getAppState') return { snapshotId: 's1', app: apps[i], window: windows[i], screenshotStatus: { status: 'skipped' } };
        throw new Error(`unexpected ${method}`);
      }) as HelperLike['request'],
      abort: () => undefined,
      dispose: () => undefined,
    };
    const service = new ComputerService({
      isEnabled: () => true,
      createHelper: () => helper,
      requestConsent: async () => 'approved',
      stopKey: { arm: () => true, release: () => undefined },
      blockContext: () => ({}),
    });
    const handlers = new Map<string, (p: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>>();
    registerComputerRpc({ register: (m: string, h: never) => handlers.set(m, h) } as unknown as RpcRouter, () => service, async () => null);
    mockSendRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (!method.startsWith('computer.')) return {};
      return handlers.get(method)?.(params, { clientName: 'test-client' } as RpcContext);
    });
    const client = await connect();
    const titles = async () => {
      const result = await client.callTool({ name: 'computer', arguments: { action: 'listWindows' } });
      const { windows: listed } = JSON.parse((result.content as Array<{ text: string }>)[0].text) as { windows: WindowInfo[] };
      return Object.fromEntries(listed.map((w) => [w.appId, w.title]));
    };
    expect(await titles()).toEqual({ 'com.apple.TextEdit': '', 'com.apple.Notes': '' });
    await client.callTool({ name: 'computer', arguments: { action: 'getAppState', app: 'TextEdit', mode: 'ax' } });
    expect(await titles()).toEqual({ 'com.apple.TextEdit': 'TextEdit secret', 'com.apple.Notes': '' });
    await client.close();
    const listCall = computerCalls().find((c) => c[0] === 'computer.listWindows');
    expect(listCall?.[1]).toEqual({ callerInstance: expect.stringMatching(UUID_RE) });
  });

  it('keeps one identity for concurrent first calls (they share a single pane walk)', async () => {
    enabled.value = true;
    reply = () => ({ method: 'synthetic', verification: 'unverified' });
    let walks = 0;
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.resolve.identity') {
        walks++;
        await new Promise((r) => setTimeout(r, 30)); // a slow walk: the second call arrives meanwhile
        return { mappings: {}, resolved: { workspaceId: 'ws-walked', ptyId: 'pty-walked' } };
      }
      return method.startsWith('computer.') ? reply(method) : {};
    });
    const server = createWmuxServer({
      envWorkspaceHint: 'ws-env',
      envPtyHint: 'pty-env-inherited',
      commanderToken: undefined,
      commanderMode: false,
      coreMode: false,
      callerPid: process.pid,
      callerPpid: null,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await Promise.all([
      client.callTool({ name: 'computer', arguments: { action: 'getAppState', app: 'Notepad' } }),
      client.callTool({ name: 'computer', arguments: { action: 'click', snapshotId: 's7', index: 3 } }),
    ]);
    await client.close();
    const ids = computerCalls().map((c) => (c[1] as { senderPtyId?: string; callerInstance?: string }));
    expect(ids).toHaveLength(2);
    expect(ids.every((p) => p.senderPtyId === 'pty-walked' && p.callerInstance === undefined)).toBe(true);
    expect(walks).toBe(1);
  });

  it('a caller cannot name a pane itself: senderPtyId is not a tool argument', async () => {
    enabled.value = true;
    const client = await connect();
    const res = await client.callTool({ name: 'computer', arguments: { action: 'click', snapshotId: 's7', index: 3, senderPtyId: 'pty-other' } });
    await client.close();
    expect(res.isError).toBe(true);
    expect(computerCalls()).toEqual([]);
  });

  it('sends input actions to computer.act without observation-only fields', async () => {
    enabled.value = true;
    reply = () => ({ method: 'synthetic', verification: 'unverified' });
    const client = await connect();
    const res = await client.callTool({
      name: 'computer',
      arguments: { action: 'click', snapshotId: 's7', index: 3, app: 'Notepad' },
    });
    await client.close();
    expect(computerCalls()).toEqual([['computer.act', { action: 'click', snapshotId: 's7', index: 3, callerInstance: expect.stringMatching(UUID_RE) }, expect.any(Number)]]);
    expect((res.content as Array<{ text: string }>)[0].text).toContain('Unverified: call getAppState');
  });

  it('turns a coded error into guidance for the agent', async () => {
    enabled.value = true;
    reply = () => {
      throw new Error(encodeComputerErrorMessage({ code: 'app_blocked', message: 'KeePassXC' }));
    };
    const client = await connect();
    const res = await client.callTool({ name: 'computer', arguments: { action: 'getAppState', app: 'KeePassXC' } });
    await client.close();
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('[app_blocked]');
    expect(text).toContain('Do not retry');
  });

  it('rejects unknown options instead of silently dropping them', async () => {
    enabled.value = true;
    const client = await connect();
    const res = await client.callTool({ name: 'computer', arguments: { action: 'listApps', bogus: 1 } });
    await client.close();
    expect(res.isError).toBe(true);
    expect(computerCalls()).toEqual([]);
  });
});
