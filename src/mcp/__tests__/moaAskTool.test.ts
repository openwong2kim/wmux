import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// moa_ask / moa_ask_status: absent unless the owner opted in (moa-ask.json),
// full profile only, appended last; the verified pane is sent, never the env
// hint. Only the switch and the pipe are mocked.
const { mockSendRpc, enabled } = vi.hoisted(() => ({ mockSendRpc: vi.fn(), enabled: { value: false } }));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});
vi.mock('../../shared/moaAskSwitch', () => ({ readMoaAskEnabled: () => enabled.value }));

import { createWmuxServer } from '../index';

async function connect(opts: { coreMode?: boolean; commanderMode?: boolean } = {}) {
  const server = createWmuxServer({
    envWorkspaceHint: 'ws-caller',
    envPtyHint: 'pty-env-hint',
    commanderToken: opts.commanderMode ? 'tok' : undefined,
    commanderMode: opts.commanderMode ?? false,
    coreMode: opts.coreMode ?? false,
    callerPid: process.pid,
    callerPpid: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function toolNames(opts: { coreMode?: boolean; commanderMode?: boolean } = {}) {
  const client = await connect(opts);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockImplementation(async () => ({}));
  enabled.value = false;
});

describe('moa_ask MCP tools', () => {
  it('are absent unless the owner turned the ask mode on', async () => {
    const names = await toolNames();
    expect(names).not.toContain('moa_ask');
    expect(names).not.toContain('moa_ask_status');
  });

  it('are appended last in full when on, and never in core or commander', async () => {
    enabled.value = true;
    const full = await toolNames();
    expect(full.slice(-2)).toEqual(['moa_ask', 'moa_ask_status']);
    expect(await toolNames({ coreMode: true })).not.toContain('moa_ask');
    expect(await toolNames({ commanderMode: true })).not.toContain('moa_ask');
  });

  it('sends the walked pane as senderPtyId, never the env hint', async () => {
    enabled.value = true;
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.resolve.identity') return { mappings: {}, resolved: { workspaceId: 'ws-walked', ptyId: 'pty-walked' } };
      if (method === 'moa.ask') return { ok: true, ticket: { ticketId: 't', status: 'pending' } };
      return {};
    });
    const client = await connect();
    await client.callTool({ name: 'moa_ask', arguments: { question: 'Reuse it?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] } });
    await client.close();
    const call = mockSendRpc.mock.calls.find((c) => c[0] === 'moa.ask');
    expect(call?.[1]).toMatchObject({ question: 'Reuse it?', senderPtyId: 'pty-walked' });
    expect(JSON.stringify(call?.[1])).not.toContain('pty-env-hint');
  });
});
