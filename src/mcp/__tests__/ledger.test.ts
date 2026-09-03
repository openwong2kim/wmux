// Tests for the ledger_update (worker, every profile) and ledger_list
// (commander-only) MCP tools: wire mapping, identity attachment, and the
// reserved commander-only names staying unregistered.

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../wmux-client', () => ({
  sendRpc: vi.fn(),
  setClientIdentity: vi.fn(),
  clearClientIdentity: vi.fn(),
}));

import { sendRpc } from '../wmux-client';
import { registerLedgerUpdateTool, registerLedgerListTool } from '../ledger';
import { FIRST_PARTY_METHODS } from '../../main/mcp/firstParty';
import { COMMANDER_ONLY_TOOLS, COMMANDER_RPC_METHODS } from '../../shared/commanderSurface';
import { CORE_TOOL_SURFACE } from '../../shared/coreSurface';

const mockSendRpc = sendRpc as unknown as ReturnType<typeof vi.fn>;

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;

function collect(): { tools: Map<string, ToolHandler>; shapes: Map<string, Record<string, unknown>> } {
  const tools = new Map<string, ToolHandler>();
  const shapes = new Map<string, Record<string, unknown>>();
  const tool = (name: string, _d: string, schema: Record<string, unknown>, handler: ToolHandler) => {
    tools.set(name, handler);
    shapes.set(name, schema);
  };
  registerLedgerUpdateTool({ tool } as never, { getSenderPtyId: () => 'pty-mine', resolveWorkspaceId: async () => 'ws-mine' });
  registerLedgerListTool(tool as never);
  return { tools, shapes };
}

beforeEach(() => mockSendRpc.mockReset());

describe('ledger_update', () => {
  it('maps snake_case args to the wire and attaches the verified senderPtyId', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, entry: { id: 'wtask-1', status: 'review_requested', rev: 2 } });
    const { tools } = collect();
    const res = await tools.get('ledger_update')!({ task_id: 'wtask-1', status: 'review_requested', expected_rev: 1, summary: 'gate green' });
    expect(mockSendRpc).toHaveBeenCalledWith('ledger.update', {
      taskId: 'wtask-1', status: 'review_requested', expectedRev: 1, summary: 'gate green', senderPtyId: 'pty-mine',
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('review_requested');
  });

  it('flags a refused update as an error result and exposes no completed/cancelled status', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, error: { code: 'STALE_REV', message: 'stale' } });
    const { tools, shapes } = collect();
    const res = await tools.get('ledger_update')!({ task_id: 'wtask-1', status: 'failed', expected_rev: 0 });
    expect(res.isError).toBe(true);
    const status = shapes.get('ledger_update')!['status'] as { options: string[] };
    expect(status.options).not.toContain('completed');
    expect(status.options).not.toContain('cancelled');
  });

  it('is on the core surface and its RPC is first-party', () => {
    expect(CORE_TOOL_SURFACE).toContain('ledger_update');
    expect(FIRST_PARTY_METHODS.has('ledger.update' as never)).toBe(true);
  });
});

describe('ledger_list (commander-only)', () => {
  it('forwards the filters and sends no workspace — the commander token is the identity', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, entries: [] });
    const { tools } = collect();
    await tools.get('ledger_list')!({ open_only: true, task_id: 'wtask-1' });
    expect(mockSendRpc).toHaveBeenCalledWith('ledger.list', { taskId: 'wtask-1', openOnly: true });
  });

  it('is listed commander-only, outside core, with its RPC in the commander lane', () => {
    expect(COMMANDER_ONLY_TOOLS).toContain('ledger_list');
    expect(CORE_TOOL_SURFACE).not.toContain('ledger_list');
    expect(COMMANDER_RPC_METHODS.has('ledger.list')).toBe(true);
  });
});
