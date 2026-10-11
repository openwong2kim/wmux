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
import { getWorkspaceToken, noteBrowserOutcome, setWorkspaceToken } from '../wmux-client';
import { __resetPaneResolverForTesting } from '../paneResolver';

async function connect(
  opts: { envWorkspaceHint?: string; envPtyHint?: string; commanderToken?: string } = {},
): Promise<Client> {
  const server = createWmuxServer({
    envWorkspaceHint: opts.envWorkspaceHint ?? '',
    envPtyHint: opts.envPtyHint ?? '',
    commanderToken: opts.commanderToken,
    commanderMode: false,
    coreMode: false,
    callerPid: process.pid,
    callerPpid: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // A known non-Codex client: on Windows an unknown name makes the first browser
  // call inspect this process's real parent, which these tests are not about.
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} });
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
  __resetPaneResolverForTesting();
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
    // On Windows the client-side walk spawns PowerShell per hop, twice here.
  }, 30_000);
});

describe('browser tools — a claim that is gone after a wmux restart', () => {
  const GONE =
    'browser.close: BROWSER_SCOPE_REFUSED: the workspace you claimed is gone; the wmux MCP server claims ' +
    'again on its next call, otherwise call mcp.claimWorkspace again to get a new one. Do not retry unchanged.';

  function walkMinting(tokens: string[]) {
    let walks = 0;
    return () => ({
      mappings: {},
      entries: [],
      resolved: { workspaceId: 'ws-walk', ptyId: 'pty-1' },
      workspaceToken: tokens[Math.min(walks++, tokens.length - 1)],
    });
  }

  it('runs the call once more with a fresh claim, so the agent never sees the refusal', async () => {
    const walk = walkMinting(['claim-before-restart', 'claim-after-restart']);
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.resolve.identity') return walk();
      if (method === 'browser.close') {
        // What the real sendRpc does with main's refusal of a dead claim.
        if (getWorkspaceToken() === 'claim-before-restart') {
          noteBrowserOutcome(method, GONE, true);
          throw new Error(GONE);
        }
        noteBrowserOutcome(method, { ok: true }, false);
        return { ok: true };
      }
      throw new Error(`rpc-down: ${method}`);
    });
    const client = await connect();

    const res = await callTool(client, 'browser_close');

    expect(res.isError).toBeFalsy();
    expect(browserCalls('browser.close')).toHaveLength(2);
    expect(getWorkspaceToken()).toBe('claim-after-restart');
  });

  it('runs it at most once more: a second refusal reaches the agent', async () => {
    const walk = walkMinting(['claim-dead']);
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.resolve.identity') return walk();
      if (method === 'browser.close') {
        noteBrowserOutcome(method, GONE, true);
        throw new Error(GONE);
      }
      throw new Error(`rpc-down: ${method}`);
    });
    const client = await connect();

    const res = await callTool(client, 'browser_close');

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/the workspace you claimed is gone/);
    expect(browserCalls('browser.close')).toHaveLength(2);
  });

  it('never re-runs a call main answered, even when the answer quotes a refusal', async () => {
    const walk = walkMinting(['claim-live']);
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.resolve.identity') return walk();
      if (method === 'browser.close') {
        const reply = { ok: true, note: 'the workspace you claimed is gone' };
        noteBrowserOutcome(method, reply, false);
        return reply;
      }
      throw new Error(`rpc-down: ${method}`);
    });
    const client = await connect();

    const res = await callTool(client, 'browser_close');

    expect(res.isError).toBeFalsy();
    expect(browserCalls('browser.close')).toHaveLength(1);
  });
});

describe('browser tools — a caller outside every pane (scheduled run)', () => {
  it('claims a dedicated workspace and acts there, carrying the claim', async () => {
    let claims = 0;
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.resolve.identity') {
        // main is up and its walk found no pane above us. An empty pid map, so
        // no client-side walk runs (on Windows it spawns PowerShell per hop).
        return { mappings: {}, entries: [], resolved: null };
      }
      if (method === 'mcp.claimWorkspace') {
        claims++;
        return { workspaceId: 'ws-claimed', ptyId: 'pty-claimed', workspaceToken: 'claim-run' };
      }
      if (method === 'browser.close') return { ok: true };
      throw new Error(`rpc-down: ${method}`);
    });
    const client = await connect();

    const first = await callTool(client, 'browser_close');
    const second = await callTool(client, 'browser_close');

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(browserCalls('browser.close')).toEqual([{ workspaceId: 'ws-claimed' }, { workspaceId: 'ws-claimed' }]);
    expect(getWorkspaceToken()).toBe('claim-run');
    expect(claims).toBe(1);
  });
});

describe('browser tools — the pane the env names', () => {
  function routing(hintedPane: unknown, extra: (method: string) => unknown = () => undefined) {
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.resolve.identity') return { mappings: {}, entries: [], resolved: null, hintedPane };
      if (method === 'mcp.claimWorkspace') return { workspaceId: 'ws-claimed', ptyId: 'pty-claimed', workspaceToken: 'claim' };
      if (method === 'browser.close') return { ok: true };
      const out = extra(method);
      if (out !== undefined) return out;
      throw new Error(`rpc-down: ${method}`);
    });
  }

  it('a scheduled run (its auto- session is no live pane) claims a dedicated workspace', async () => {
    routing({ live: false });
    const client = await connect({ envPtyHint: 'auto-run-1' });

    const res = await callTool(client, 'browser_close');

    expect(res.isError).toBeFalsy();
    expect(browserCalls('browser.close')).toEqual([{ workspaceId: 'ws-claimed' }]);
    const identity = mockSendRpc.mock.calls.find(([m]) => m === 'a2a.resolve.identity');
    expect(identity?.[1]).toMatchObject({ hintedPtyId: 'auto-run-1' });
  });

  it('a WSL pane the daemon attests acts in its own workspace with main\'s claim', async () => {
    routing({ live: true, workspaceId: 'ws-wsl', workspaceToken: 'claim-wsl' });
    const client = await connect({ envPtyHint: 'pty-wsl', envWorkspaceHint: 'ws-wsl' });

    const res = await callTool(client, 'browser_close');

    expect(res.isError).toBeFalsy();
    expect(browserCalls('browser.close')).toEqual([{ workspaceId: 'ws-wsl' }]);
    expect(getWorkspaceToken()).toBe('claim-wsl');
    expect(mockSendRpc.mock.calls.some(([m]) => m === 'mcp.claimWorkspace')).toBe(false);
  });

  it('a live pane main cannot attest is refused with the reason, never claimed elsewhere', async () => {
    routing({ live: true });
    const client = await connect({ envPtyHint: 'pty-wsl', envWorkspaceHint: 'ws-wsl' });

    const res = await callTool(client, 'browser_close');

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/could not verify/);
    expect(mockSendRpc.mock.calls.some(([m]) => m === 'mcp.claimWorkspace')).toBe(false);
    expect(browserCalls('browser.close')).toHaveLength(0);
  });

  it('the status probe never creates a workspace for a caller outside every pane', async () => {
    routing({ live: false }, (method) => (method === 'browser.session.status' ? { backend: 'builtin' } : undefined));
    const client = await connect();

    const res = await callTool(client, 'browser_session', { action: 'status' });

    expect(res.isError).toBeFalsy();
    expect(mockSendRpc.mock.calls.some(([m]) => m === 'mcp.claimWorkspace')).toBe(false);
  });
});
