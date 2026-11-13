// Who sent a new A2A task whose delivery the renderer is making right now.
//
// The daemon writes a new task's row only after the renderer has delivered
// it (a2a.rpc.ts sendTask), so at the delivery gate there is no row to read
// the sender from. Main keeps its own record instead: the send's verified
// caller workspace, under a key main mints, for as long as the send runs.
// The renderer hands the key back with the delivery (GatedSubmitOptions
// senderSendKey); an unknown or ended key names no one.

import { randomUUID } from 'node:crypto';

const inFlight = new Map<string, string>();

/** Record a send by `senderWorkspaceId`; `end` drops the record. */
export function beginDeliverySend(senderWorkspaceId: string): { key: string; end: () => void } {
  const key = `send-${randomUUID()}`;
  inFlight.set(key, senderWorkspaceId);
  return { key, end: () => void inFlight.delete(key) };
}

/** The sender of a send still running, or null. */
export function deliverySendSender(key: string): string | null {
  return inFlight.get(key) ?? null;
}
