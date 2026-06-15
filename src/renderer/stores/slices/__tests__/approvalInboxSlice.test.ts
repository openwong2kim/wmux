import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createApprovalInboxSlice, type ApprovalInboxSlice } from '../approvalInboxSlice';
import type { ApprovalPromptInfo } from '../../../../main/mcp/ApprovalQueue';

type TestState = ApprovalInboxSlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createApprovalInboxSlice(...args),
    }))
  );
}

function makePrompt(promptId: string, overrides: Partial<ApprovalPromptInfo> = {}): ApprovalPromptInfo {
  return {
    promptId,
    clientName: 'test-plugin',
    declaredCapabilities: ['meta.read'],
    ...overrides,
  };
}

describe('approvalInboxSlice', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('starts empty', () => {
    expect(store.getState().mcpPrompts).toEqual({});
    expect(store.getState().mcpPromptOrder).toEqual([]);
  });

  it('addMcpPrompt records the prompt and appends to order', () => {
    store.getState().addMcpPrompt(makePrompt('p1'));
    expect(store.getState().mcpPrompts['p1']).toEqual(makePrompt('p1'));
    expect(store.getState().mcpPromptOrder).toEqual(['p1']);

    store.getState().addMcpPrompt(makePrompt('p2', { clientName: 'other' }));
    expect(store.getState().mcpPromptOrder).toEqual(['p1', 'p2']);
    expect(store.getState().mcpPrompts['p2'].clientName).toBe('other');
  });

  it('addMcpPrompt is idempotent on promptId — one order entry, info overwritten', () => {
    store.getState().addMcpPrompt(makePrompt('p1', { clientName: 'first' }));
    store.getState().addMcpPrompt(
      makePrompt('p1', { clientName: 'second', declaredCapabilities: ['terminal.read'] }),
    );
    // Order has exactly one entry — no duplicate.
    expect(store.getState().mcpPromptOrder).toEqual(['p1']);
    // The latest info wins (a coalesced re-open may carry a wider snapshot).
    expect(store.getState().mcpPrompts['p1'].clientName).toBe('second');
    expect(store.getState().mcpPrompts['p1'].declaredCapabilities).toEqual(['terminal.read']);
  });

  it('removeMcpPrompt deletes from both the record and the order', () => {
    store.getState().addMcpPrompt(makePrompt('p1'));
    store.getState().addMcpPrompt(makePrompt('p2'));
    store.getState().removeMcpPrompt('p1');
    expect(store.getState().mcpPrompts['p1']).toBeUndefined();
    expect(store.getState().mcpPromptOrder).toEqual(['p2']);
  });

  it('removeMcpPrompt is idempotent — unknown id does not throw and does not mutate', () => {
    store.getState().addMcpPrompt(makePrompt('p1'));
    const beforeOrder = store.getState().mcpPromptOrder;
    expect(() => store.getState().removeMcpPrompt('does-not-exist')).not.toThrow();
    expect(store.getState().mcpPrompts['p1']).toEqual(makePrompt('p1'));
    expect(store.getState().mcpPromptOrder).toEqual(['p1']);
    // Removing the same id twice is also a no-op the second time.
    store.getState().removeMcpPrompt('p1');
    expect(() => store.getState().removeMcpPrompt('p1')).not.toThrow();
    expect(store.getState().mcpPromptOrder).toEqual([]);
    expect(beforeOrder).toEqual(['p1']); // sanity: original ref unchanged after first remove
  });
});
