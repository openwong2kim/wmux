import { describe, it, expect } from 'vitest';
import { selectApprovalInbox, type ApprovalInboxState } from '../approvalInbox';
import type { ApprovalPromptInfo } from '../../../../main/mcp/ApprovalQueue';
import type { PendingExecuteApproval } from '../../slices/a2aSlice';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function mcpPrompt(promptId: string, declaredCapabilities: string[], overrides: Partial<ApprovalPromptInfo> = {}): ApprovalPromptInfo {
  return { promptId, clientName: `client-${promptId}`, declaredCapabilities, ...overrides };
}

function a2aApproval(taskId: string): PendingExecuteApproval {
  return {
    taskId,
    senderWorkspaceId: 'ws-sender',
    receiverWorkspaceId: 'ws-receiver',
    messagePreview: 'run the build',
    cwd: 'C:\\repo',
    expiresAt: 1_700_000_000_000,
  };
}

function fixture(over: Partial<ApprovalInboxState> = {}): ApprovalInboxState {
  return {
    mcpPrompts: {},
    mcpPromptOrder: [],
    pendingExecuteApproval: null,
    ...over,
  };
}

// `terminal.read` → risk class 'terminal-content' → severity 'critical'.
// `meta.read`     → risk class 'metadata'         → severity 'neutral' (benign).
// (Looked up in src/main/mcp/methodCapabilityMap.ts CAPABILITY_RISK_CLASS +
//  RISK_CLASS_COPY — pinned here so a copy-table change that flips severity
//  fails this test loudly.)

describe('selectApprovalInbox', () => {
  it('returns [] when nothing is pending', () => {
    expect(selectApprovalInbox(fixture())).toEqual([]);
  });

  it('emits a single a2a item from pendingExecuteApproval', () => {
    const items = selectApprovalInbox(fixture({ pendingExecuteApproval: a2aApproval('task-1') }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'a2a',
      key: 'a2a:task-1',
      taskId: 'task-1',
      messagePreview: 'run the build',
      expiresAt: 1_700_000_000_000,
      senderWorkspaceId: 'ws-sender',
      receiverWorkspaceId: 'ws-receiver',
      cwd: 'C:\\repo',
    });
  });

  it('emits two concurrent MCP items keyed by promptId in insertion order', () => {
    const items = selectApprovalInbox(
      fixture({
        mcpPrompts: {
          p1: mcpPrompt('p1', ['meta.read']),
          p2: mcpPrompt('p2', ['pane.read']),
        },
        mcpPromptOrder: ['p1', 'p2'],
      }),
    );
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.key)).toEqual(['mcp:p1', 'mcp:p2']);
    expect(items[0]).toMatchObject({ source: 'mcp', promptId: 'p1', clientName: 'client-p1' });
    expect(items[1]).toMatchObject({ source: 'mcp', promptId: 'p2', clientName: 'client-p2' });
  });

  it('skips a promptId present in the order but missing from the record (defensive)', () => {
    const items = selectApprovalInbox(
      fixture({
        mcpPrompts: { p1: mcpPrompt('p1', ['meta.read']) },
        mcpPromptOrder: ['p1', 'p-gone'],
      }),
    );
    expect(items.map((i) => i.key)).toEqual(['mcp:p1']);
  });

  it('orders A2A first, then MCP', () => {
    const items = selectApprovalInbox(
      fixture({
        pendingExecuteApproval: a2aApproval('task-1'),
        mcpPrompts: { p1: mcpPrompt('p1', ['meta.read']) },
        mcpPromptOrder: ['p1'],
      }),
    );
    expect(items.map((i) => i.source)).toEqual(['a2a', 'mcp']);
    expect(items[0].key).toBe('a2a:task-1');
    expect(items[1].key).toBe('mcp:p1');
  });

  it('flags isCritical=true for a real critical capability (terminal.read)', () => {
    const items = selectApprovalInbox(
      fixture({
        mcpPrompts: { p1: mcpPrompt('p1', ['terminal.read']) },
        mcpPromptOrder: ['p1'],
      }),
    );
    const item = items[0];
    expect(item.source).toBe('mcp');
    if (item.source === 'mcp') expect(item.isCritical).toBe(true);
  });

  it('flags isCritical=false for a benign metadata capability (meta.read)', () => {
    const items = selectApprovalInbox(
      fixture({
        mcpPrompts: { p1: mcpPrompt('p1', ['meta.read']) },
        mcpPromptOrder: ['p1'],
      }),
    );
    const item = items[0];
    expect(item.source).toBe('mcp');
    if (item.source === 'mcp') expect(item.isCritical).toBe(false);
  });
});
