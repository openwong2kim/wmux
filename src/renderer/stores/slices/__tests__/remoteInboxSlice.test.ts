import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createRemoteInboxSlice, type RemoteInboxSlice } from '../remoteInboxSlice';
import { selectRemoteInbox } from '../../selectors/remoteInbox';
import type { RemoteInboxItem } from '../../../../shared/lanlink';

type TestState = RemoteInboxSlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createRemoteInboxSlice(...args),
    })),
  );
}

function makeItem(recordId: string, overrides: Partial<RemoteInboxItem> = {}): RemoteInboxItem {
  return {
    recordId,
    origin: 'remote',
    peerName: 'Peer',
    text: 'hello',
    seq: 1,
    receivedAt: 1,
    ...overrides,
  };
}

describe('remoteInboxSlice', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
  });

  it('starts empty', () => {
    expect(store.getState().remoteItems).toEqual({});
    expect(store.getState().remoteItemOrder).toEqual([]);
  });

  it('R1: addRemoteItem records + appends to order; idempotent on recordId (dup-0, latest-wins)', () => {
    store.getState().addRemoteItem(makeItem('r1', { text: 'first' }));
    store.getState().addRemoteItem(makeItem('r2'));
    expect(store.getState().remoteItemOrder).toEqual(['r1', 'r2']);

    // Re-pull the SAME recordId with newer text → no duplicate row, latest wins.
    store.getState().addRemoteItem(makeItem('r1', { text: 'second' }));
    expect(store.getState().remoteItemOrder).toEqual(['r1', 'r2']);
    expect(store.getState().remoteItems['r1'].text).toBe('second');
  });

  it('R2: selectRemoteInbox folds order→items and skips a missing record (torn state)', () => {
    store.getState().addRemoteItem(makeItem('r1'));
    store.getState().addRemoteItem(makeItem('r2'));
    expect(selectRemoteInbox(store.getState()).map((i) => i.recordId)).toEqual(['r1', 'r2']);

    // Torn state: an order id with no record — the selector skips, never throws.
    const torn = {
      remoteItems: store.getState().remoteItems,
      remoteItemOrder: ['r1', 'ghost', 'r2'],
    };
    expect(() => selectRemoteInbox(torn)).not.toThrow();
    expect(selectRemoteInbox(torn).map((i) => i.recordId)).toEqual(['r1', 'r2']);
  });
});
