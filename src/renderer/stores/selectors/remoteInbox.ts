import type { StoreState } from '../index';
import type { RemoteInboxItem } from '../../../shared/lanlink';

// ─── LanLink PR-2 Remote Inbox — render list ──────────────────────────────────
//
// Pure derivation (mirrors selectors/approvalInbox.ts): fold the recordId order
// array into a render list, skipping any id missing from the record map. The
// order array and record map are written together (addRemoteItem), but a torn
// intermediate state must never crash a surface — so the skip-missing guard is
// required. PR-5 builds the visual "remote peer" card on top of this list;
// PR-2 stops at state + selector.

/** Minimal store surface the selector reads — keeps the subscription narrow. */
export type RemoteInboxState = Pick<StoreState, 'remoteItems' | 'remoteItemOrder'>;

export function selectRemoteInbox(state: RemoteInboxState): RemoteInboxItem[] {
  const out: RemoteInboxItem[] = [];
  for (const id of state.remoteItemOrder) {
    const item = state.remoteItems[id];
    if (!item) continue; // torn-state guard — never crash on a missing record
    out.push(item);
  }
  return out;
}
