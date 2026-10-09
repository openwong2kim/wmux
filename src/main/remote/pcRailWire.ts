// PC rail: the one push PR1's PC_RAIL_IPC does not name yet.
//
// Main owns the 10 s per-host poll (a renderer timer is throttled while the
// window is in the background), so the results need a main → renderer push.
// Kept free of runtime imports so preload and the renderer can import it.
// Proposed for PC_RAIL_IPC as FEED_EVENT.

import type { RemoteApprovalSummary } from '../../shared/pcRail/attention';
import type { PcRailWorkspacesResponse } from '../../shared/pcRail/workspaceRow';

/** main → renderer (push): PcRailFeedEvent. */
export const PC_RAIL_FEED_EVENT = 'pcRail:feed-event';

export type PcRailFeedFailure = 'unreachable' | 'auth-rejected' | 'insecure-transport' | 'unavailable';

/** One web-paired host as main lists it. Never carries the token. */
export interface PcRailHostInfo {
  id: string;
  label: string;
  allowInput?: boolean;
}

export type PcRailFeedEvent =
  /** The full host roster, sent on subscribe and whenever it changes. */
  | { type: 'hosts'; hosts: PcRailHostInfo[] }
  /** One host's poll tick answered. `approvals` is absent when that read failed. */
  | {
    type: 'feed';
    hostId: string;
    at: number;
    ok: true;
    response: PcRailWorkspacesResponse;
    approvals?: RemoteApprovalSummary[];
    allowInput?: boolean;
  }
  /** One host's poll tick got no usable answer. */
  | { type: 'feed'; hostId: string; at: number; ok: false; reason: PcRailFeedFailure };
