import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * Browser tools resolve their workspace only from identities main can verify:
 * the PID-map walk (whose claim token is then carried on every envelope), the
 * commander token, or an external claim. The WMUX_WORKSPACE_ID env hint is not
 * one of them. These drive the real tool handlers through createWmuxServer();
 * the only mock is wmux-client's sendRpc, at the RPC boundary.
 */

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});

import { createWmuxServer } from '../index';
import { getWorkspaceToken, setWorkspaceToken } from '../wmux-client';

async function connect(opts: { envWorkspaceHint?: string; commanderToken?: string } = {}): Promise<Client> {
  const server = createWmuxServer({
    envWorkspaceHint: opts.envWorkspaceHint ?? '',
    envPtyHint: '',
    commanderToken: opts.commanderToken,
    commanderMode: false,
    coreMode: false,
    callerPid: process.pid,
    callerPpid: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: 'text'; text: string }[];
  };
  return { isError: result.isError, text: result.content[0]?.text ?? '' };
}

function browserCalls(method: string): Array<Record<string, unknown>> {
  return mockSendRpc.mock.calls
    .filter(([m]) => m === method)
    .map(([, params]) => params as Record<string, unknown>);
}

beforeEach(() => {
  mockSendRpc.mockReset();
  setWorkspaceToken(undefined);
});

describe('browser tools — workspace identity', () => {
  it('does not use the env hint: an unverified caller never reaches browser.close', async () => {
    // Every identity RPC fails; workspace.list failing would make the weak
    // resolver trust the env hint, which is exactly what the browser path skips.
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'browser.close') return { ok: true };
      throw new Error(`rpc-down: ${method}`);
    });
    const client = await connect({ envWorkspaceHint: 'ws-env' });

    const res = await callTool(client, 'browser_close');

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Workspace identity unknown/);
    expect(browserCalls('browser.close')).toHaveLength(0);
  });

  it('adopts the claim main mints for a server-walk hit and scopes to the walked workspace', async () => {
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.resolve.identity') {
        return {
          mappings: { '1': 'ws-walk' },
          entries: [{ pid: '1', ptyId: 'pty-1', workspaceId: 'ws-walk' }],
          resolved: { workspaceId: 'ws-walk', ptyId: 'pty-1' },
          workspaceToken: 'claim-from-walk',
        };
      }
      if (method === 'browser.close') return { ok: true };
      throw new Error(`rpc-down: ${method}`);
    });
    const client = await connect({ envWorkspaceHint: 'ws-env' });

    const res = await callTool(client, 'browser_close');

    expect(res.isError).toBeFalsy();
    expect(browserCalls('browser.close')).toEqual([{ workspaceId: 'ws-walk' }]);
    expect(getWorkspaceToken()).toBe('claim-from-walk');
  });

  it('keeps the commander brain working: its token-bound workspace scopes the call', async () => {
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'deck.resolveCommanderWorkspace') return { workspaceId: 'ws-brain' };
      if (method === 'browser.close') return { ok: true };
      throw new Error(`rpc-down: ${method}`);
    });
    const client = await connect({ commanderToken: 'commander-token' });

    const res = await callTool(client, 'browser_close');

    expect(res.isError).toBeFalsy();
    expect(browserCalls('browser.close')).toEqual([{ workspaceId: 'ws-brain' }]);
  });
});

describe('browser tools — recovering a walk that produced no claim', () => {
  it('re-walks on main\'s side after a refusal for a cached id that carried no claim', async () => {
    let serverWalkReady = false;
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.resolve.identity') {
        // First: only the client-side walk can hit (our parent is an anchor),
        // and nothing is minted. Later: main's own walk hits and returns a claim.
        const entries = [{ pid: String(process.ppid), ptyId: 'pty-1', workspaceId: 'ws-walk' }];
        return serverWalkReady
          ? { mappings: {}, entries, resolved: { workspaceId: 'ws-walk', ptyId: 'pty-1' }, workspaceToken: 'claim-late' }
          : { mappings: { [String(process.ppid)]: 'ws-walk' }, entries, resolved: null };
      }
      if (method === 'browser.close') {
        if (getWorkspaceToken()) return { ok: true };
        throw new Error(
          'browser.close: BROWSER_SCOPE_REFUSED: browser calls act on the workspace wmux verifies for the ' +
            'caller, and this call carries no verified workspace. Do not retry unchanged.',
        );
      }
      throw new Error(`rpc-down: ${method}`);
    });
    const client = await connect();

    const first = await callTool(client, 'browser_close');
    expect(first.isError).toBe(true);

    serverWalkReady = true;
    const second = await callTool(client, 'browser_close');

    expect(second.isError).toBeFalsy();
    expect(getWorkspaceToken()).toBe('claim-late');
    expect(mockSendRpc.mock.calls.filter(([m]) => m === 'a2a.resolve.identity')).toHaveLength(2);
  });
});
