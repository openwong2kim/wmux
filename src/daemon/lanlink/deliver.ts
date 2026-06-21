// === LanLink deliver() seam — DEFINE-ONLY (PR-4, roadmap §11) ===
//
// The shared delivery interface where the channels track (topology: who is in a
// room) and the LanLink track (transport: how far a message reaches) converge
// WITHOUT a code merge. channels U2 fanout calls deliver(msg, recipient); a local
// recipient routes through the in-process pipe, a remote recipient routes through
// the LanLink AEAD transport to the peer daemon's durable inbox. PR-4 DEFINES the
// contract only — no implementation, no wiring — so #269 (channels) can target a
// stable shape. The remote member identity is the LanLink per-peer UUID.
//
// Imports a shared type only; execute-wall clean.

import type { TaskState } from '../../shared/types';

/** Where a fanned-out message should land. */
export type DeliveryRecipient =
  | { transport: 'local'; workspaceId: string; paneId?: string }
  | { transport: 'lanlink'; peerUuid: string };

/** The text-only restricted message a room post fans out (mirrors the wire subset). */
export interface DeliverableMessage {
  kind: 'msg.text' | 'state.update';
  peerName: string;
  text: string;
  state?: TaskState;
}

export interface DeliveryResult {
  ok: boolean;
  /** For a durable remote landing, the inbox seq (the durable ACK); absent on local. */
  seq?: number;
  error?: string;
}

/**
 * The convergence seam. channels U2 fanout implements its room/membership logic
 * and calls this for each recipient; a LanLink-backed Deliverer routes a
 * `transport:'lanlink'` recipient over the AEAD channel and a `transport:'local'`
 * recipient over the in-process pipe. DEFINE-ONLY in PR-4.
 */
export interface Deliverer {
  deliver(msg: DeliverableMessage, recipient: DeliveryRecipient): Promise<DeliveryResult>;
}
