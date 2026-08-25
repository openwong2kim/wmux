import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * #1018 — pane_get_metadata was hard-scoped to the caller's own workspace
 * (always forced `requireWorkspaceId()`), so another agent could not read a
 * DIFFERENT workspace's pane metadata even read-only, and had no way to tell
 * panes apart before addressing one. pane.rpc's resolveTarget already accepts
 * any workspaceId (it only checks paneId belongs to it) — the MCP tool
 * wrapper was the only thing forcing it to the caller's own id. This locks
 * the fix as read-only and additive: pane_set_metadata gets no such override.
 *
 * Review (2026-08-25, maintainer CHANGES_REQUESTED) found the first cut of
 * this file only pinned the SOURCE TEXT of the fix — including, at one
 * point, a source pattern that was itself the bug
 * (`targetWorkspaceId || (await requireWorkspaceId())` — the identity gate
 * never runs when an override is present). A regex that matches source can
 * assert a vulnerability just as easily as a fix. The tests below exercise
 * the REAL tool handler instead, through a real McpServer wired with
 * createWmuxServer() and talking over an in-memory MCP transport pair — the
 * only mock is wmux-client's sendRpc, at the RPC boundary the tool actually
 * calls through. Everything above that boundary (schema validation, the
 * identity gate, the paneId-required guard) runs unmocked.
 */

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});

// Imported AFTER the mock is registered (hoisted by vitest ahead of this
// import regardless of source order, per vi.mock semantics).
import { createWmuxServer } from '../index';

interface ConnectedClient {
  client: Client;
  close: () => Promise<void>;
}

async function connectClient(envWorkspaceHint: string): Promise<ConnectedClient> {
  const server = createWmuxServer({
    envWorkspaceHint,
    envPtyHint: '',
    commanderToken: undefined,
    commanderMode: false,
    callerPid: process.pid,
    callerPpid: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, close: async () => client.close() };
}

/**
 * sendRpc mock routing:
 *  - 'a2a.resolve.identity' and 'deck.resolveCommanderWorkspace' fail closed
 *    (rpc-down / no token), so resolveWorkspaceId() falls straight through to
 *    the env-hint path — no real PID-map walk or daemon pipe needed.
 *  - 'workspace.list' throws too, so the env hint's liveness check comes back
 *    'unknown' (not 'absent') and the hint is trusted, exactly as it is
 *    against a real daemon that is merely slow to answer during boot.
 *  - 'pane.getMetadata' is the call under test: echo the params back as the
 *    RPC result so each test can assert exactly what workspaceId/paneId the
 *    tool forwarded.
 */
function installSendRpcRouting(): void {
  mockSendRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'pane.getMetadata') {
      return { paneId: params.paneId, workspaceId: params.workspaceId, metadata: {}, version: 0 };
    }
    throw new Error(`rpc-down: ${method}`);
  });
}

beforeEach(() => {
  mockSendRpc.mockReset();
  installSendRpcRouting();
});

async function callPaneGetMetadata(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string }> {
  const result = await client.callTool({ name: 'pane_get_metadata', arguments: args }) as {
    isError?: boolean;
    content: { type: 'text'; text: string }[];
  };
  return { isError: result.isError, text: result.content[0]?.text ?? '' };
}

describe('pane_get_metadata — cross-workspace read (#1018), behavioral', () => {
  it('an identity-less caller is rejected even when it passes a foreign workspaceId (security gate)', async () => {
    // No env hint, no PID-map hit, no commander token: resolveWorkspaceId()
    // has nothing to resolve to. The #1020 bug was exactly this case:
    // `targetWorkspaceId || (await requireWorkspaceId())` never called
    // requireWorkspaceId() at all when targetWorkspaceId was present, so an
    // identity-less caller sailed straight through to the RPC.
    const { client, close } = await connectClient('');
    try {
      const res = await callPaneGetMetadata(client, {
        workspaceId: 'ws-victim',
        paneId: 'pane-1',
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Workspace identity unknown/);
      // And the RPC must never have been reached — the gate has to run
      // BEFORE the call, not merely alongside it.
      expect(mockSendRpc).not.toHaveBeenCalledWith('pane.getMetadata', expect.anything(), expect.anything());
    } finally {
      await close();
    }
  });

  it('workspaceId without paneId is rejected (no silent active-pane fallback on a cross-workspace read)', async () => {
    const { client, close } = await connectClient('ws-caller');
    try {
      const res = await callPaneGetMetadata(client, { workspaceId: 'ws-other' });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/paneId is required when workspaceId is set/);
      expect(mockSendRpc).not.toHaveBeenCalledWith('pane.getMetadata', expect.anything(), expect.anything());
    } finally {
      await close();
    }
  });

  it('an empty-string workspaceId is rejected by the schema, not silently treated as "own workspace"', async () => {
    const { client, close } = await connectClient('ws-caller');
    try {
      const res = await callPaneGetMetadata(client, { workspaceId: '', paneId: 'pane-1' });
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('an identified caller with a valid override reads the OTHER workspace, not its own', async () => {
    const { client, close } = await connectClient('ws-caller');
    try {
      const res = await callPaneGetMetadata(client, {
        workspaceId: 'ws-other',
        paneId: 'pane-in-other-ws',
      });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.text);
      expect(parsed.workspaceId).toBe('ws-other');
      expect(parsed.paneId).toBe('pane-in-other-ws');
    } finally {
      await close();
    }
  });

  it('omitting workspaceId still reads the calling workspace, unchanged from before #1018', async () => {
    const { client, close } = await connectClient('ws-caller');
    try {
      const res = await callPaneGetMetadata(client, { paneId: 'pane-mine' });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.text);
      expect(parsed.workspaceId).toBe('ws-caller');
    } finally {
      await close();
    }
  });
});

describe('pane_set_metadata — no cross-workspace override (write path stays own-workspace-only)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  it('keeps forcing the caller\'s own workspace, with no workspaceId parameter at all', () => {
    const block = src.match(/'pane_set_metadata',[\s\S]*?callRpc\('pane\.setMetadata', params\);/)?.[0];
    if (!block) throw new Error('pane_set_metadata registration not found in mcp/index.ts');
    expect(block).toMatch(/const workspaceId = await requireWorkspaceId\(\);/);
    expect(block).not.toMatch(/targetWorkspaceId/);
  });
});
