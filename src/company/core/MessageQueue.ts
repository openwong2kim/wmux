// ─── MessageQueue ─────────────────────────────────────────────────────────────
// Queues outgoing messages to PTY members and delivers them only when the
// target member is in 'idle' status, preventing text corruption that occurs
// when keystroke injection lands while an agent is mid-output.

import { generateId } from '../../shared/types';
import type { MemberStatus } from '../types';
import { formatMessage, formatBroadcast, type MessagePriority } from './messageTemplates';
import { formatBracketedPastePayload, isMultilinePtyPayload } from '../../shared/ptyMessageDelivery';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueuedMessage {
  id: string;
  targetMemberId: string;
  targetPtyId: string;
  targetName: string;
  message: string;
  from: string;
  priority: MessagePriority;
  timestamp: number;
  delivered: boolean;
  isBroadcast: boolean;
}

export type DeliverFn = (ptyId: string, text: string) => void;

// ─── MessageQueue class ───────────────────────────────────────────────────────

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private deliverFn: DeliverFn;
  private readonly maxSize: number;

  constructor(deliverFn: DeliverFn, maxSize = 500) {
    this.deliverFn = deliverFn;
    this.maxSize = maxSize;
  }

  // ── Enqueue ──────────────────────────────────────────────────────────────────

  enqueue(
    opts: Omit<QueuedMessage, 'id' | 'timestamp' | 'delivered'>,
  ): string {
    // Enforce queue size limit to prevent unbounded memory growth
    if (this.queue.length >= this.maxSize) {
      // Prefer evicting delivered messages first
      const deliveredIdx = this.queue.findIndex((m) => m.delivered);
      if (deliveredIdx !== -1) {
        this.queue.splice(deliveredIdx, 1);
      } else {
        // Drop oldest undelivered
        this.queue.shift();
      }
    }
    const msg: QueuedMessage = {
      ...opts,
      id: generateId('mq'),
      timestamp: Date.now(),
      delivered: false,
    };
    this.queue.push(msg);
    return msg.id;
  }

  /**
   * Convenience: enqueue a point-to-point message and immediately attempt
   * delivery if the member is currently idle.
   */
  enqueueAndTryDeliver(
    opts: Omit<QueuedMessage, 'id' | 'timestamp' | 'delivered'>,
    currentStatus: MemberStatus,
  ): string {
    const id = this.enqueue(opts);
    if (currentStatus === 'idle') {
      this.tryDeliver(opts.targetMemberId, currentStatus);
    }
    return id;
  }

  // ── Delivery ─────────────────────────────────────────────────────────────────

  /**
   * Attempt to deliver all pending messages for a given member.
   * Only executes delivery when status is 'idle'.
   */
  tryDeliver(memberId: string, status: MemberStatus): void {
    if (status !== 'idle') return;

    const pending = this.queue.filter(
      (m) => m.targetMemberId === memberId && !m.delivered,
    );

    for (const msg of pending) {
      const formatted = msg.isBroadcast
        ? formatBroadcast(msg.from, msg.message, msg.priority)
        : formatMessage(msg.from, msg.targetName, msg.message, msg.priority);

      this.deliverFn(msg.targetPtyId, formatBracketedPastePayload(formatted));
      setTimeout(() => {
        this.deliverFn(msg.targetPtyId, isMultilinePtyPayload(formatted) ? '\r\r' : '\r');
      }, 100);
      msg.delivered = true;
    }
  }

  /**
   * Attempt delivery for all pending messages across all members.
   * Callers must supply a status lookup function.
   */
  deliverAll(getStatus: (memberId: string) => MemberStatus | undefined): void {
    const pendingMemberIds = [
      ...new Set(
        this.queue
          .filter((m) => !m.delivered)
          .map((m) => m.targetMemberId),
      ),
    ];

    for (const memberId of pendingMemberIds) {
      const status = getStatus(memberId);
      if (status) {
        this.tryDeliver(memberId, status);
      }
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────────────

  getPending(memberId?: string): QueuedMessage[] {
    const undelivered = this.queue.filter((m) => !m.delivered);
    if (memberId === undefined) return undelivered;
    return undelivered.filter((m) => m.targetMemberId === memberId);
  }

  getPendingCount(memberId: string): number {
    return this.getPending(memberId).length;
  }

  // ── Removal ───────────────────────────────────────────────────────────────────

  remove(msgId: string): void {
    const idx = this.queue.findIndex((m) => m.id === msgId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }
  }

  /** Purge all delivered messages to keep memory bounded. */
  clearDelivered(): void {
    this.queue = this.queue.filter((m) => !m.delivered);
  }

  /** Remove all entries for a member (e.g. when they are removed from the company). */
  clearMember(memberId: string): void {
    this.queue = this.queue.filter((m) => m.targetMemberId !== memberId);
  }

  /** Snapshot of the full queue (for store serialization). */
  snapshot(): QueuedMessage[] {
    return [...this.queue];
  }

  /** Replace queue contents from a snapshot (hydration). */
  hydrate(messages: QueuedMessage[]): void {
    this.queue = messages.map((m) => ({ ...m }));
  }
}
