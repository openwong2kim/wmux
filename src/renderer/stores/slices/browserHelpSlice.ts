import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { BrowserHelpRequestInfo } from '../../../shared/browserHelp';

// ─── browser_request_help — the renderer's copy of the open asks ─────────────
//
// Help requests arrive one at a time over `browserHelp.onOpen` and leave over
// `browserHelp.onClosed`; this slice is the single renderer-side record of which
// ones are outstanding. Exactly the shape approvalInboxSlice uses for MCP
// permission prompts, and for the same reason: the bridge hook
// (useBrowserHelpBridge) owns the subscription and dispatches add/remove here,
// so no component holds its own copy and two renditions of one request cannot
// disagree.
//
// There is deliberately NO deadline bookkeeping here. Main owns the timeout
// (HelpRequests) and pushes the close when it fires; a renderer-side timer would
// be a second authority that disagrees the moment the window is throttled. The
// `deadlineAt` on the record is read-only, for rendering a countdown.

export interface BrowserHelpSlice {
  /** requestId -> the open request. Authoritative record for each ask. */
  browserHelpRequests: Record<string, BrowserHelpRequestInfo>;
  /** Insertion order of requestIds; drives the inbox render order. */
  browserHelpOrder: string[];

  /** Idempotent on requestId: overwrites the record, appends to order once. */
  addBrowserHelpRequest: (info: BrowserHelpRequestInfo) => void;
  /** Idempotent: removes from both maps; no-op when the id is unknown. */
  removeBrowserHelpRequest: (requestId: string) => void;
}

export const createBrowserHelpSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  BrowserHelpSlice
> = (set) => ({
  browserHelpRequests: {},
  browserHelpOrder: [],

  addBrowserHelpRequest: (info) => set((state: StoreState) => {
    const isNew = !(info.requestId in state.browserHelpRequests);
    state.browserHelpRequests[info.requestId] = info;
    if (isNew) state.browserHelpOrder.push(info.requestId);
  }),

  removeBrowserHelpRequest: (requestId) => set((state: StoreState) => {
    // The order list is filtered even on the unknown-id path: the common no-op
    // is a BROWSER_HELP_CLOSED push landing after an optimistic local removal,
    // and a torn intermediate state must never leave a dangling id behind.
    delete state.browserHelpRequests[requestId];
    const idx = state.browserHelpOrder.indexOf(requestId);
    if (idx !== -1) state.browserHelpOrder.splice(idx, 1);
  }),
});

/**
 * The open help request for one browser surface, or undefined.
 *
 * Returns the STORED record, not a derived object, so a component subscribing
 * with a bare `useStore(...)` re-renders only when the record itself changes —
 * no shallow comparison needed.
 *
 * One request per surface is enforced in main (HelpRequests), so the first match
 * is the only match; scanning the order list keeps the newest-wins behaviour
 * honest if that invariant is ever widened.
 */
export function selectHelpRequestForSurface(
  state: Pick<StoreState, 'browserHelpRequests' | 'browserHelpOrder'>,
  surfaceId: string,
): BrowserHelpRequestInfo | undefined {
  for (const id of state.browserHelpOrder) {
    const record = state.browserHelpRequests[id];
    if (record?.surfaceId === surfaceId) return record;
  }
  return undefined;
}
