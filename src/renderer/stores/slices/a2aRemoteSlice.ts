import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { A2aLinkOfferRecordV1, A2aLinkRecordV1, A2aPeerRecordV1, A2aRemoteHostRecordV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../../shared/rpc';
import type { Task } from '../../../shared/types';
import { readHeldReason, type A2aRemoteHeldReason, type A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';

// ─── Cross-PC A2A, as the Remote page and the rail read it ────────────────────
//
// The single renderer copy of the other PCs: their links, their connection
// state, the remote work held for a person, and the pairing records behind
// them. `useA2aRemoteBridge` (mounted once in AppLayout) is the only
// subscriber; it re-reads on the daemon's link and host-status nudges. The
// Remote page and the rail's badge both read from here, so the count the rail
// shows is the list the page draws.

export interface A2aRemoteFeed {
  links: A2aLinkRecordV1[];
  /** Share offers: this PC's own and the ones other PCs sent it. */
  offers: A2aLinkOfferRecordV1[];
  /** Every paired PC's connection, either role. */
  hosts: A2aRemoteHostStatus[];
  /** Remote work held for a person (the target pane is gone or taken). */
  held: Task[];
  /** PCs this PC joined (addresses, fingerprint). */
  joined: A2aRemoteHostRecordV1[];
  /** PCs that joined this one, not revoked. */
  peers: A2aPeerRecordV1[];
  /** Set once any read has answered. */
  loaded: boolean;
}

export interface A2aRemoteSlice {
  a2aRemote: A2aRemoteFeed;
  setA2aRemote: (patch: Partial<A2aRemoteFeed>) => void;
}

export const createA2aRemoteSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  A2aRemoteSlice
> = (set) => ({
  a2aRemote: { links: [], offers: [], hosts: [], held: [], joined: [], peers: [], loaded: false },
  setA2aRemote: (patch) => set((state: StoreState) => {
    Object.assign(state.a2aRemote, patch);
  }),
});

/** Why a task (or its newest held reply) is held. A Moa hold an older daemon
 *  still reports reads as `link-not-active` (readHeldReason). */
export function heldReason(task: Task): A2aRemoteHeldReason | undefined {
  const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
  const held = marker?.held ?? marker?.inbox?.find((i) => i.held)?.held;
  return held ? readHeldReason(held) : undefined;
}

/**
 * A pane another PC shared with this one, still waiting for this PC's human:
 * open (an answer that did not settle can be sent again), and not past the
 * expiry this PC worked out on receipt.
 */
export function offerWaitsOnYou(o: A2aLinkOfferRecordV1, now: number = Date.now()): boolean {
  return o.side === 'in' && o.state === 'open' && Date.parse(o.expiresAt) > now;
}

/**
 * What waits on a person across PCs: link requests to accept or decline,
 * panes other PCs shared to link with one here, held work to deliver or send
 * back, and PCs whose certificate changed. The rail's Remote badge and the
 * page's Needs you block count the same four.
 */
export function selectRemoteNeedsYou(s: Pick<StoreState, 'a2aRemote'>): number {
  const { links, offers, held, hosts } = s.a2aRemote;
  return links.filter((l) => l.state === 'proposed-in').length
    + offers.filter((o) => offerWaitsOnYou(o)).length
    + held.length
    + hosts.filter((h) => h.state === 'identity-changed').length;
}
