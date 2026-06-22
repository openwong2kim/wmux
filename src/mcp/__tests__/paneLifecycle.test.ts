// Behavioral tests for the pane/surface lifecycle MCP tools (issue #285).
//
// registerPaneLifecycleTools takes injectable deps (callRpc +
// resolveCallerWorkspaceId), so we capture each registered handler with a
// minimal McpServer stand-in and assert the exact (method, params) it forwards
// — without booting the PID-map walk or a live pipe. Mirrors the harness in
// index.channel.test.ts. The first-party allowlist coverage lives in
// src/main/mcp/__tests__/firstParty.test.ts (source-scan lockstep) and the
// index.ts wiring guard lives in workspaceRouting.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerPaneLifecycleTools, type PaneLifecycleDeps } from '../paneLifecycle';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
}>;

// Mutated per-test (read lazily by the resolver stub).
let callerWs = 'ws-caller';

const mockCallRpc = vi.fn(async () => ({
  content: [{ type: 'text' as const, text: 'ok' }],
}));
const mockResolveWs = vi.fn(async () => callerWs);

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  const deps: PaneLifecycleDeps = {
    callRpc: mockCallRpc,
    resolveCallerWorkspaceId: mockResolveWs,
  };
  registerPaneLifecycleTools(server as never, deps);
  return tools;
}

const tools = collectTools();
const paneSplit = tools.get('pane_split');
const paneClose = tools.get('pane_close');
const paneFocus = tools.get('pane_focus');
const surfaceNew = tools.get('surface_new');
const surfaceClose = tools.get('surface_close');

if (!paneSplit || !paneClose || !paneFocus || !surfaceNew || !surfaceClose) {
  throw new Error('pane lifecycle tools failed to register');
}

beforeEach(() => {
  mockCallRpc.mockClear();
  mockResolveWs.mockClear();
  callerWs = 'ws-caller';
});

describe('paneLifecycle tools: registration', () => {
  it('registers all five lifecycle tools', () => {
    for (const name of ['pane_split', 'pane_close', 'pane_focus', 'surface_new', 'surface_close']) {
      expect(tools.get(name), `${name} should be registered`).toBeDefined();
    }
  });
});

describe('pane_split (CREATE family)', () => {
  it('forwards an explicit workspaceId and defaults direction to horizontal', async () => {
    await paneSplit({ workspaceId: 'ws-explicit' });
    expect(mockCallRpc).toHaveBeenCalledWith('pane.split', {
      direction: 'horizontal',
      workspaceId: 'ws-explicit',
    });
    // Explicit ws is honored verbatim — the caller resolver is not consulted.
    expect(mockResolveWs).not.toHaveBeenCalled();
  });

  it('forwards an explicit direction', async () => {
    await paneSplit({ workspaceId: 'ws-explicit', direction: 'vertical' });
    expect(mockCallRpc).toHaveBeenCalledWith('pane.split', {
      direction: 'vertical',
      workspaceId: 'ws-explicit',
    });
  });

  it('resolves the caller workspace when workspaceId is omitted (DR-1)', async () => {
    callerWs = 'ws-caller';
    await paneSplit({});
    expect(mockResolveWs).toHaveBeenCalledTimes(1);
    expect(mockCallRpc).toHaveBeenCalledWith('pane.split', {
      direction: 'horizontal',
      workspaceId: 'ws-caller',
    });
  });

  it('omits workspaceId on a true identity miss (renderer active-ws fallback)', async () => {
    callerWs = '';
    await paneSplit({});
    expect(mockCallRpc).toHaveBeenCalledWith('pane.split', { direction: 'horizontal' });
  });

  it('returns the callRpc result verbatim (ptyWarning passthrough)', async () => {
    mockCallRpc.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"paneId":"p9","ptyWarning":"bg spawn skipped"}' }],
    });
    const res = await paneSplit({ workspaceId: 'w' });
    expect(res).toEqual({
      content: [{ type: 'text', text: '{"ok":true,"paneId":"p9","ptyWarning":"bg spawn skipped"}' }],
    });
  });
});

describe('pane_close / pane_focus (ADDRESS family) map the pane id → { id }', () => {
  it('pane_close maps paneId → pane.close { id }', async () => {
    await paneClose({ paneId: 'p1' });
    expect(mockCallRpc).toHaveBeenCalledWith('pane.close', { id: 'p1' });
  });

  it('pane_focus maps paneId → pane.focus { id }', async () => {
    await paneFocus({ paneId: 'p2' });
    expect(mockCallRpc).toHaveBeenCalledWith('pane.focus', { id: 'p2' });
  });

  it('the address family never resolves a workspace (id-addressed, all-ws)', async () => {
    await paneClose({ paneId: 'p1' });
    await paneFocus({ paneId: 'p2' });
    await surfaceClose({ surfaceId: 's1' });
    expect(mockResolveWs).not.toHaveBeenCalled();
  });
});

describe('surface_new (CREATE family)', () => {
  it('forwards an explicit workspaceId, no shell/cwd', async () => {
    await surfaceNew({ workspaceId: 'ws-explicit' });
    expect(mockCallRpc).toHaveBeenCalledWith('surface.new', { workspaceId: 'ws-explicit' });
    expect(mockResolveWs).not.toHaveBeenCalled();
  });

  it('resolves the caller workspace when omitted (DR-1)', async () => {
    callerWs = 'ws-caller';
    await surfaceNew({});
    expect(mockResolveWs).toHaveBeenCalledTimes(1);
    expect(mockCallRpc).toHaveBeenCalledWith('surface.new', { workspaceId: 'ws-caller' });
  });

  it('omits workspaceId on a true identity miss', async () => {
    callerWs = '';
    await surfaceNew({});
    expect(mockCallRpc).toHaveBeenCalledWith('surface.new', {});
  });

  it('passes shell and cwd through', async () => {
    await surfaceNew({ workspaceId: 'ws-x', shell: 'pwsh', cwd: 'C:/tmp' });
    expect(mockCallRpc).toHaveBeenCalledWith('surface.new', {
      workspaceId: 'ws-x',
      shell: 'pwsh',
      cwd: 'C:/tmp',
    });
  });
});

describe('surface_close (ADDRESS family)', () => {
  it('maps surfaceId → surface.close { id }', async () => {
    await surfaceClose({ surfaceId: 's1' });
    expect(mockCallRpc).toHaveBeenCalledWith('surface.close', { id: 's1' });
  });
});
