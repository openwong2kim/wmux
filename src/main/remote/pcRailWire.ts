// PC rail: the payload of PC_RAIL_IPC.FEED_EVENT.
//
// Main owns the 10 s per-host poll (a renderer timer is throttled while the
// window is in the background), so the results need a main → renderer push.
// Type-only, so preload and the renderer can import it.

import { PC_RAIL_IPC, type PcRailTokenKind } from '../../shared/pcRail';
import type { RemoteApprovalSummary } from '../../shared/pcRail/attention';
import type { PcRailWorkspacesResponse } from '../../shared/pcRail/workspaceRow';

/** main → renderer (push): PcRailFeedEvent. */
export const PC_RAIL_FEED_EVENT = PC_RAIL_IPC.FEED_EVENT;

export type PcRailFeedFailure = 'unreachable' | 'auth-rejected' | 'insecure-transport' | 'unavailable';

/** One web-paired host as main lists it. Never carries the token. */
export interface PcRailHostInfo {
  id: string;
  label: string;
  allowInput?: boolean;
  /** How this desktop's credential for the host was issued; absent when unknown. */
  tokenKind?: PcRailTokenKind;
}

export type PcRailFeedEvent =
  /** The full host roster, sent on subscribe and whenever it changes. */
  | { type: 'hosts'; hosts: PcRailHostInfo[] }
  /**
   * One host's poll tick answered. Times are epoch ms on this machine: each
   * list is a snapshot of when its request started. `approvals` and
   * `approvalsRequestedAt` are absent when that read failed, and
   * `approvalsError` says why.
   */
  | {
    type: 'feed';
    hostId: string;
    at: number;
    ok: true;
    response: PcRailWorkspacesResponse;
    listRequestedAt: number;
    approvals?: RemoteApprovalSummary[];
    approvalsRequestedAt?: number;
    approvalsError?: PcRailFeedFailure;
    allowInput?: boolean;
  }
  /** One host's poll tick got no usable answer. */
  | { type: 'feed'; hostId: string; at: number; ok: false; reason: PcRailFeedFailure };
