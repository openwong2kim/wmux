import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

/**
 * tools/list diet (#1302) — the contract the three cuts share:
 *
 *   1. a2a_task_send is a literal alias of send_message;
 *   2. seven browser_repl sub-steps duplicate the bridge as standalone tools;
 *   3. the pre-merge names of browser_session / pane_metadata / pane_stash
 *      {restore} stay callable for one release.
 *
 * "Unlisted" must mean exactly that: ABSENT from tools/list (the budget every
 * session pays) while STILL DISPATCHING via tools/call (so hard-coded callers
 * keep working). Both halves are pinned here against a real McpServer wired
 * with createWmuxServer() over an in-memory transport pair — the only mock is
 * wmux-client's sendRpc, at the RPC boundary the tools actually call through,
 * which also lets the merged/pre-merge spellings be compared for identical
 * results (same RPC method + params ⇒ same echoed payload).
 */
const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});

// Imported AFTER the mock is registered (hoisted by vitest ahead of this
// import regardless of source order, per vi.mock semantics).
import { createWmuxServer } from '../index';
import { UNLISTED_TOOLS, UNLISTED_TOOLS_SET } from '../../shared/unlistedTools';
import { createBrowserBridge } from '../browser-repl/bridge';

interface ConnectedClient {
  client: Client;
  close: () => Promise<void>;
}

async function connectClient(opts?: {
  coreMode?: boolean;
  envWorkspaceHint?: string;
}): Promise<ConnectedClient> {
  const server = createWmuxServer({
    envWorkspaceHint: opts?.envWorkspaceHint ?? 'ws-caller',
    envPtyHint: '',
    commanderToken: undefined,
    commanderMode: false,
    coreMode: opts?.coreMode ?? false,
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
 * sendRpc mock routing: identity/liveness probes fail closed exactly as in
 * paneGetMetadataCrossWorkspace.test.ts (rpc-down ⇒ the env-hint path is
 * trusted), and only the methods under test answer — echoing method + params
 * back so callers can assert exactly what the tool forwarded (and the merged
 * vs pre-merge spellings can be compared for identical output).
 */
const ECHOED_METHODS = new Set([
  'a2a.task.send',
  'browser.session.start',
  'browser.session.stop',
  'browser.session.status',
  'browser.session.list',
  'pane.setMetadata',
  'pane.getMetadata',
  'pane.stash',
  'pane.unstash',
]);

function installSendRpcRouting(): void {
  mockSendRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (ECHOED_METHODS.has(method)) return { method, params };
    throw new Error(`rpc-down: ${method}`);
  });
}

beforeEach(() => {
  mockSendRpc.mockReset();
  installSendRpcRouting();
});

async function listToolNames(client: Client): Promise<string[]> {
  const res = await client.listTools();
  return res.tools.map((t) => t.name);
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args }) as {
    isError?: boolean;
    content: { type: 'text'; text: string }[];
  };
  return { isError: result.isError, text: result.content[0]?.text ?? '' };
}

const BROWSER_SUB_STEPS = UNLISTED_TOOLS.filter((n) =>
  n.startsWith('browser_') && !n.startsWith('browser_session_'),
) as readonly string[];

describe('tools/list diet — listing', () => {
  it('no unlisted name appears in the full profile tools/list', async () => {
    const { client, close } = await connectClient();
    try {
      const names = await listToolNames(client);
      for (const name of UNLISTED_TOOLS) {
        expect(names, `${name} must not be listed`).not.toContain(name);
      }
    } finally {
      await close();
    }
  });

  it('no unlisted name appears in the core profile tools/list', async () => {
    const { client, close } = await connectClient({ coreMode: true });
    try {
      const names = await listToolNames(client);
      for (const name of UNLISTED_TOOLS) {
        expect(names, `${name} must not be listed`).not.toContain(name);
      }
    } finally {
      await close();
    }
  });

  it('the merged tools are listed, and pane_stash carries the restore param', async () => {
    const { client, close } = await connectClient({ coreMode: true });
    try {
      const res = await client.listTools();
      const names = res.tools.map((t) => t.name);
      expect(names).toContain('pane_metadata');
      const paneStash = res.tools.find((t) => t.name === 'pane_stash');
      expect(paneStash, 'pane_stash must stay listed').toBeDefined();
      expect(JSON.stringify(paneStash?.inputSchema)).toContain('restore');
    } finally {
      await close();
    }
  });

  it('the unlisted set stays honest with the manifest names (no stale entry)', () => {
    // A name nobody registers anymore would silently dead-letter here; the
    // probe covers the listing side, this covers the SSOT itself.
    expect(UNLISTED_TOOLS_SET.has('a2a_task_send')).toBe(true);
    expect(BROWSER_SUB_STEPS).toEqual([
      'browser_navigate_back',
      'browser_hover',
      'browser_drag',
      'browser_select',
      'browser_scroll_into_view',
      'browser_highlight',
      'browser_dialog',
    ]);
  });
});

describe('tools/list diet — unlisted names stay callable', () => {
  it('a2a_task_send still dispatches via tools/call and matches send_message exactly', async () => {
    const { client, close } = await connectClient();
    try {
      const args = { to: '2', message: 'ping' };
      const alias = await callTool(client, 'a2a_task_send', args);
      expect(alias.isError).toBeFalsy();
      const canonical = await callTool(client, 'send_message', args);
      expect(canonical.isError).toBeFalsy();
      // Identical handler + shape ⇒ identical RPC method and params.
      expect(alias.text).toBe(canonical.text);
      const parsed = JSON.parse(alias.text);
      expect(parsed.method).toBe('a2a.task.send');
      expect(parsed.params.workspaceId).toBe('ws-caller');
    } finally {
      await close();
    }
  });

  it('each unlisted browser sub-step still dispatches via tools/call', async () => {
    const { client, close } = await connectClient();
    try {
      for (const name of BROWSER_SUB_STEPS) {
        // The point is dispatch, not browser behavior: an UNREGISTERED name
        // makes callTool itself reject, so a resolved result (even an error
        // one) proves the handler is still reachable.
        const res = await callTool(client, name, name === 'browser_dialog' ? { accept: true } : { ref: '1' });
        expect(res.text.length + (res.isError ? 1 : 0)).toBeGreaterThan(0);
      }
    } finally {
      await close();
    }
  });

  it('the pre-merge browser_session_* names still dispatch', async () => {
    const { client, close } = await connectClient();
    try {
      for (const name of ['browser_session_start', 'browser_session_stop', 'browser_session_status', 'browser_session_list']) {
        const res = await callTool(client, name, {});
        expect(res.isError, `${name} should still run`).toBeFalsy();
        expect(JSON.parse(res.text).method).toBe(`browser.session.${name.split('_').pop()}`);
      }
    } finally {
      await close();
    }
  });

  it('the pre-merge pane_set_metadata / pane_get_metadata names still dispatch', async () => {
    const { client, close } = await connectClient();
    try {
      const set = await callTool(client, 'pane_set_metadata', { label: 'x' });
      expect(set.isError).toBeFalsy();
      expect(JSON.parse(set.text).method).toBe('pane.setMetadata');
      const get = await callTool(client, 'pane_get_metadata', { paneId: 'p-1' });
      expect(get.isError).toBeFalsy();
      expect(JSON.parse(get.text).method).toBe('pane.getMetadata');
    } finally {
      await close();
    }
  });

  it('pane_unstash still dispatches', async () => {
    const { client, close } = await connectClient();
    try {
      const res = await callTool(client, 'pane_unstash', { paneId: 'p-1' });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.text).method).toBe('pane.unstash');
    } finally {
      await close();
    }
  });
});

describe('tools/list diet — merged tools produce identical results', () => {
  it('browser_session {action} matches the pre-merge tool for every action', async () => {
    const { client, close } = await connectClient();
    try {
      const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
        ['browser_session_start', { action: 'start' }, {}],
        ['browser_session_start', { action: 'start', profile: 'live' }, { profile: 'live' }],
        ['browser_session_stop', { action: 'stop' }, {}],
        ['browser_session_status', { action: 'status' }, {}],
        ['browser_session_list', { action: 'list' }, {}],
      ];
      for (const [oldName, mergedArgs, oldArgs] of cases) {
        const merged = await callTool(client, 'browser_session', mergedArgs);
        const old = await callTool(client, oldName, oldArgs);
        expect(merged.isError, `browser_session ${mergedArgs.action} errored`).toBeFalsy();
        expect(old.isError, `${oldName} errored`).toBeFalsy();
        expect(merged.text, `browser_session ${mergedArgs.action} vs ${oldName}`).toBe(old.text);
      }
    } finally {
      await close();
    }
  });

  it('pane_metadata {action} matches pane_set_metadata and pane_get_metadata', async () => {
    const { client, close } = await connectClient();
    try {
      const setArgs = { paneId: 'p-1', label: 'Backend', custom: { 'orchestrator.taskId': 't-9' } };
      const mergedSet = await callTool(client, 'pane_metadata', { action: 'set', ...setArgs });
      const oldSet = await callTool(client, 'pane_set_metadata', setArgs);
      expect(mergedSet.isError).toBeFalsy();
      expect(oldSet.isError).toBeFalsy();
      expect(mergedSet.text).toBe(oldSet.text);

      const getArgs = { paneId: 'p-1', workspaceId: 'ws-other' };
      const mergedGet = await callTool(client, 'pane_metadata', { action: 'get', ...getArgs });
      const oldGet = await callTool(client, 'pane_get_metadata', getArgs);
      expect(mergedGet.isError).toBeFalsy();
      expect(oldGet.isError).toBeFalsy();
      expect(mergedGet.text).toBe(oldGet.text);
    } finally {
      await close();
    }
  });

  it('pane_metadata rejects workspaceId on set — the write side takes no override', async () => {
    const { client, close } = await connectClient();
    try {
      // pane_set_metadata never took a workspaceId; silently ignoring one on
      // the merged tool would let a cross-workspace write report success
      // while hitting the caller's own pane. It must fail loudly, and the
      // get action keeps its cross-workspace reach.
      const res = await callTool(client, 'pane_metadata', {
        action: 'set',
        workspaceId: 'ws-other',
        paneId: 'p-1',
        label: 'x',
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('workspaceId is only valid with action:"get"');
      // No RPC went out for the refused call.
      const calls = mockSendRpc.mock.calls.filter(
        (c) => (c[0] as string) === 'pane.setMetadata',
      );
      expect(calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('pane_stash {restore:true} matches pane_unstash, and restore omitted stays a stash', async () => {
    const { client, close } = await connectClient();
    try {
      const restore = await callTool(client, 'pane_stash', { paneId: 'p-1', restore: true });
      const unstash = await callTool(client, 'pane_unstash', { paneId: 'p-1' });
      expect(restore.isError).toBeFalsy();
      expect(unstash.isError).toBeFalsy();
      expect(restore.text).toBe(unstash.text);
      expect(JSON.parse(restore.text).method).toBe('pane.unstash');

      const stash = await callTool(client, 'pane_stash', { paneId: 'p-1' });
      expect(stash.isError).toBeFalsy();
      expect(JSON.parse(stash.text).method).toBe('pane.stash');
    } finally {
      await close();
    }
  });
});

describe('tools/list diet — browser_repl mitigations', () => {
  it('the browser_repl description carries the sub-step argument cheat sheet', async () => {
    const { client, close } = await connectClient();
    try {
      const res = await client.listTools();
      const repl = res.tools.find((t) => t.name === 'browser_repl');
      expect(repl, 'browser_repl must stay listed').toBeDefined();
      const desc = repl?.description ?? '';
      expect(desc).toMatch(/navigate_back\(\)/);
      expect(desc).toMatch(/hover\(ref\)/);
      expect(desc).toMatch(/drag\(sourceRef,targetRef\|path\)/);
      expect(desc).toMatch(/select\(ref,values\)/);
      expect(desc).toMatch(/scroll_into_view\(ref\)/);
      expect(desc).toMatch(/highlight\(ref\)/);
      expect(desc).toMatch(/dialog\(accept,text\)/);
    } finally {
      await close();
    }
  });

  it('a wrong-argument call inside a snippet reports the valid argument names', async () => {
    const tools = new Map([
      ['browser_hover', {
        name: 'browser_hover',
        shape: { ref: z.string(), surfaceId: z.string().optional() },
        handler: async () => ({ content: [{ type: 'text' as const, text: 'unreached' }] }),
      }],
    ]);
    const bridge = createBrowserBridge(tools, {});
    const outcome = await bridge('hover', { wrongArg: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('invalid arguments');
      expect(outcome.error).toContain('valid: ref, surfaceId');
    }
  });
});
