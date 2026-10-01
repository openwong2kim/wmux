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
