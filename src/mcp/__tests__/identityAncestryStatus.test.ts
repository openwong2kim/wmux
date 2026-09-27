/**
 * MCP identity when main reports resolvedStatus.
 *
 * An MCP server started under a shared background server carries the env of
 * whichever pane started that server. main's walk of the real process tree is
 * the authority:
 *   - 'miss'        → the env hints are never used (reads and writes refuse);
 *   - 'unavailable' → nothing verified; refuse with a retryable error;
 *   - no status (older main) → the env hints serve reads, writes refuse;
 *   - 'hit'         → normal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});

import { createWmuxServer } from '../index';
import { withCallerPid, setCallerPid } from '../wmux-client';

// A pid that is neither in the pid-map nor alive, so our own walk stops at once.
const NOT_A_PANE = 2_147_480_000;
const ENTRIES = [{ pid: '1000', ptyId: 'pty-a', workspaceId: 'ws-a' }];

function routeIdentity(identity: Record<string, unknown>): void {
  mockSendRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.resolve.identity') return identity;
    if (method === 'workspace.list') return [{ id: 'ws-a' }, { id: 'ws-b' }];
    if (method === 'a2a.task.send' || method === 'a2a.whoami' || method === 'a2a.task.query') return { method, params };
    throw new Error(`rpc-down: ${method}`);
  });
}

async function connect(): Promise<Client> {
  const server = createWmuxServer({
    envWorkspaceHint: 'ws-a',
    envPtyHint: 'pty-a',
    commanderToken: undefined,
    commanderMode: false,
    coreMode: false,
    callerPid: process.pid,
    callerPpid: NOT_A_PANE,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
}

const calledWith = (method: string) => mockSendRpc.mock.calls.some((c) => c[0] === method);

let client: Client;
beforeEach(() => { mockSendRpc.mockReset(); });
afterEach(async () => { await client?.close(); });

describe('MCP identity — resolvedStatus from main', () => {
  it('miss: the pane env is ignored for writes AND reads, with the relaunch hint', async () => {
    routeIdentity({ mappings: { '1000': 'ws-a' }, entries: ENTRIES, resolved: null, resolvedStatus: 'miss' });
    client = await connect();
    const send = await call(client, 'send_message', { to: 'ws-b', message: 'hi' });
    expect(send.isError).toBe(true);
    expect(send.text).toContain('codex --no-daemon');
    const whoami = await call(client, 'a2a_whoami', {});
    expect(whoami.isError).toBe(true);
    expect(calledWith('a2a.task.send')).toBe(false);
    expect(calledWith('a2a.whoami')).toBe(false);
  });

  it('unavailable: nothing verified, so refuse with a retryable error (no env fallback)', async () => {
    routeIdentity({ mappings: { '1000': 'ws-a' }, entries: ENTRIES, resolved: null, resolvedStatus: 'unavailable' });
    client = await connect();
    const send = await call(client, 'send_message', { to: 'ws-b', message: 'hi' });
    expect(send.isError).toBe(true);
    expect(send.text).toContain('retry');
    const query = await call(client, 'a2a_task_query', {});
    expect(query.isError).toBe(true);
    expect(calledWith('a2a.task.send')).toBe(false);
    expect(calledWith('a2a.task.query')).toBe(false);
  });

  it('older main (no resolvedStatus): env serves reads, writes refuse', async () => {
    routeIdentity({ mappings: { '1000': 'ws-a' }, entries: ENTRIES, resolved: null });
    client = await connect();
    const query = await call(client, 'a2a_task_query', {});
    expect(query.isError).toBe(false);
    const send = await call(client, 'send_message', { to: 'ws-b', message: 'hi' });
    expect(send.isError).toBe(true);
    expect(send.text).toContain('writes are refused');
    expect(calledWith('a2a.task.send')).toBe(false);
  });

  it('hit: sends as the verified pane', async () => {
    routeIdentity({ mappings: {}, entries: [], resolved: { workspaceId: 'ws-b', ptyId: 'pty-b' }, resolvedStatus: 'hit' });
    client = await connect();
    const send = await call(client, 'send_message', { to: 'ws-a', message: 'hi' });
    expect(send.isError).toBe(false);
    const params = mockSendRpc.mock.calls.find((c) => c[0] === 'a2a.task.send')?.[1] as Record<string, unknown>;
    expect(params).toMatchObject({ workspaceId: 'ws-b', senderPtyId: 'pty-b' });
  });
});

describe('withCallerPid', () => {
  it('stamps our pid only on requests that claim a pane', () => {
    setCallerPid(4242);
    expect(withCallerPid({ senderPtyId: 'pty-b', text: 'x' })).toEqual({ senderPtyId: 'pty-b', text: 'x', callerPid: 4242 });
    expect(withCallerPid({ callerPtyId: 'pty-b' })).toMatchObject({ callerPid: 4242 });
    expect(withCallerPid({ text: 'x' })).toEqual({ text: 'x' });
    expect(withCallerPid({ senderPtyId: 'pty-b', callerPid: 7 })).toEqual({ senderPtyId: 'pty-b', callerPid: 7 });
  });
});
