import { CHAT_ID_CLOCK_SKEW_MS, CHAT_LAUNCH_RETENTION_MS, chatIdTime, type ChatEffect, type ChatOwner } from '../chat/chatBridge';

/**
 * Memory-only launch receipts for `POST /api/sessions/:id/chat/launch`
 * (contract §6.4, N8).
 *
 * Launch has no durable receipt on the desktop, and this one deliberately
 * stays in memory: its only job is to let a phone that lost the response tell
 * "typed" from "never arrived" without typing the launcher a second time. A
 * daemon restart forgets it and the GET answers `unknown`; the client then
 * reads `/turns`, where a started agent shows up as a binding anyway.
 *
 * Keyed by owner AND id, and bound to the pane: one device can neither read
 * nor collide with another device's launch, and an id reused on a different
 * pane reads as a different fingerprint rather than a replay.
 */
export type LaunchReceiptState = 'pending' | 'submitted' | 'refused' | 'uncertain' | 'unknown';

interface Entry {
  paneId: string;
  fingerprint: string;
  /** From the id's own time prefix: kept while the route still accepts the id. */
  expiresAt: number;
  state: Exclude<LaunchReceiptState, 'unknown'>;
  /** The final HTTP answer, replayed verbatim (plus `replayed:true`). */
  final?: { status: number; body: Record<string, unknown> };
}

export type LaunchBegin =
  | { kind: 'new' }
  | { kind: 'pending' }
  | { kind: 'replay'; status: number; body: Record<string, unknown> }
  | { kind: 'conflict' }
  | { kind: 'full' };

/** Launches are one per pane at a time, so 256 is far above any honest load. */
const MAX_LAUNCH_RECEIPTS = 256;

export function launchStateFor(effect: ChatEffect): Exclude<LaunchReceiptState, 'pending' | 'unknown'> {
  return effect === 'submitted' ? 'submitted' : effect === 'none' ? 'refused' : 'uncertain';
}

export class ChatLaunchReceiptStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs = CHAT_LAUNCH_RETENTION_MS, private readonly cap = MAX_LAUNCH_RECEIPTS) {}

  /**
   * Insert-if-absent, synchronously: no `await` sits between the lookup and
   * the insert, so two concurrent POSTs with one id can never both dispatch.
   */
  begin(owner: ChatOwner, clientLaunchId: string, paneId: string, fingerprint: string, now: number): LaunchBegin {
    this.prune(now);
    const key = keyOf(owner, clientLaunchId);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.paneId !== paneId || existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      if (existing.state === 'pending' || !existing.final) return { kind: 'pending' };
      return { kind: 'replay', status: existing.final.status, body: existing.final.body };
    }
    // Never evict a receipt inside its window: a retry of that id would find
    // nothing and type the launcher a second time.
    if (this.entries.size >= this.cap) return { kind: 'full' };
    this.entries.set(key, { paneId, fingerprint, expiresAt: chatIdTime(clientLaunchId) + this.ttlMs + CHAT_ID_CLOCK_SKEW_MS, state: 'pending' });
    return { kind: 'new' };
  }

  finish(owner: ChatOwner, clientLaunchId: string, effect: ChatEffect, status: number, body: Record<string, unknown>): void {
    const entry = this.entries.get(keyOf(owner, clientLaunchId));
    if (!entry) return;
    entry.state = launchStateFor(effect);
    entry.final = { status, body };
  }

  state(owner: ChatOwner, paneId: string, clientLaunchId: string, now: number): LaunchReceiptState {
    this.prune(now);
    const entry = this.entries.get(keyOf(owner, clientLaunchId));
    return entry && entry.paneId === paneId ? entry.state : 'unknown';
  }

  private prune(now: number): void {
    // A pending entry is never aged out: dropping it while its launch is still
    // running would let a retry with the same id dispatch a second time.
    for (const [key, entry] of this.entries) {
      if (entry.state !== 'pending' && now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}

function keyOf(owner: ChatOwner, clientLaunchId: string): string {
  return `${owner}\u0000${clientLaunchId}`;
}
