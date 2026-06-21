import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { RemoteInboxItem } from '../../../shared/lanlink';

// ─── LanLink PR-2 Remote Inbox — renderer-aggregated remote peer messages ─────
//
// Off-machine peer messages arrive over the dedicated `lanlink.onRemote` IPC
// channel (RemoteInboxBridge → preload), one materialized read-only item at a
// time. This slice is the single renderer-side copy of "which remote messages
// have arrived"; the bridge hook (useRemoteInboxBridge) owns the subscription
// and dispatches addRemoteItem here. The selector (selectRemoteInbox) derives
// the render list.
//
// Mirrors approvalInboxSlice: a parallel-pair (record map keyed by stable id +
// an insertion-order array) with an `isNew` guard so a re-pull — reconnect or a
// nudge-storm — never produces a duplicate row. `origin:'remote'` items are
// UNTRUSTED: they are rendered as text, never pasted into a terminal (PR-5
// builds the visual card; PR-2 stops at state).

export interface RemoteInboxSlice {
  /** recordId -> item. The authoritative record for each remote message. */
  remoteItems: Record<string, RemoteInboxItem>;
  /** Insertion order of recordIds; drives the list render order. */
  remoteItemOrder: string[];

  /** Idempotent on recordId: overwrites the item, appends to order only once. */
  addRemoteItem: (item: RemoteInboxItem) => void;
}

export const createRemoteInboxSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  RemoteInboxSlice
> = (set) => ({
  remoteItems: {},
  remoteItemOrder: [],

  addRemoteItem: (item) => set((state: StoreState) => {
    const isNew = !(item.recordId in state.remoteItems);
    // Overwrite either way — an append-only record re-pulled on reconnect is
    // byte-identical, so this is a harmless no-op; the order push is guarded so
    // a duplicate id never produces a second row (dup-0).
    state.remoteItems[item.recordId] = item;
    if (isNew) {
      state.remoteItemOrder.push(item.recordId);
    }
  }),
});
