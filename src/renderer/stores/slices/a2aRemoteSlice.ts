import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { A2aLinkRecordV1, A2aPeerRecordV1, A2aRemoteHostRecordV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../../shared/rpc';
import type { Task } from '../../../shared/types';
import type { A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';

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
  a2aRemote: { links: [], hosts: [], held: [], joined: [], peers: [], loaded: false },
  setA2aRemote: (patch) => set((state: StoreState) => {
    Object.assign(state.a2aRemote, patch);
  }),
});

/** Held for Moa: it goes by itself once Moa can take it, so nobody has to act. */
const MOA_HOLDS = new Set(['brain-delivery-pending', 'brain-unavailable']);

/** Why a task (or its newest held reply) is held. */
export function heldReason(task: Task): string | undefined {
  const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
  if (!marker) return undefined;
  return marker.held ?? marker.inbox?.find((i) => i.held)?.held;
}

/** Held work a person must deliver or send back (not a hold that clears by itself). */
export function heldNeedsPerson(task: Task): boolean {
  return !MOA_HOLDS.has(heldReason(task) ?? '');
}

/**
 * What waits on a person across PCs: link requests to accept or decline, held
 * work to deliver or send back, and PCs whose certificate changed. The rail's
 * Remote badge and the page's Needs you block count the same three.
 */
export function selectRemoteNeedsYou(s: Pick<StoreState, 'a2aRemote'>): number {
  const { links, held, hosts } = s.a2aRemote;
  return links.filter((l) => l.state === 'proposed-in').length
    + held.filter(heldNeedsPerson).length
    + hosts.filter((h) => h.state === 'identity-changed').length;
}
