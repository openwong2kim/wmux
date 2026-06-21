// ─── ChannelService ────────────────────────────────────────────────────
// Daemon-side channel state owner. The ONLY writer to ChannelState — every
// mutation funnels through this service so the per-channel mutex, idempotency
// LRU, and `saveImmediate` PERSIST_FAILED surfacing stay in one place.
//
// The service holds:
//   - `state: ChannelState` — in-memory mirror, loaded from the writer at
//     construction and re-saved on every mutation. The writer is the
//     persistence model; this service is the in-memory authoritative copy
//     for the lifetime of the daemon.
//   - `mutexes: Map<channelId, Promise<void>>` — per-channel promise chain.
//     Each mutation for a given channelId waits for the previous one to
//     finish. Channels don't contend with each other (different keys).
//   - `idempotency: Map<channelId, Map<clientMsgId, {seq, lastUsedAt}>>` —
//     LRU cache of recent clientMsgIds, capped at CHANNEL_IDEMPOTENCY_CAP
//     per channel. Lookups in the post path are O(1) amortized; eviction
//     is O(n) only on overflow.
//
// Plan reference: U3 (a2a-channels service layer).

import { randomUUID } from 'node:crypto';
import {
  canonicalizeChannelName,
  CHANNEL_IDEMPOTENCY_CAP,
  isValidChannelName,
  type Channel,
  type ChannelMember,
  type ChannelMessage,
  type ChannelRecipientStatus,
  type ChannelState,
  type ChannelVisibility,
} from '../../shared/channels';
import type { ChannelStateWriter } from './ChannelStateWriter';

/**
 * Event payload emitted by the service after a successful post. The
 * `workspaceId` field is the SENDER's workspace (base scoping per the
 * wmux protocol convention; the recipient list is in `recipients`).
 * The wiring layer (U4) projects this to the main-process EventBus
 * after workspace-scope resolution.
 */
export interface ChannelMessageEvent {
  type: 'channel.message';
  channelId: string;
  seq: number;
  sender: { workspaceId: string; memberId: string; memberName: string };
  recipients: ChannelRecipientStatus[];
  message: ChannelMessage;
  /** Sender's workspaceId. */
  workspaceId: string;
}

/** Shape of the `emit` callback injected by the daemon. */
export type ChannelServiceEmit = (event: ChannelMessageEvent) => void;

/** Typed error codes surfaced from the service to the caller. */
export type ChannelErrorCode =
  | 'INVALID_NAME'
  | 'CHANNEL_NOT_FOUND'
  | 'CHANNEL_ARCHIVED'
  | 'NOT_A_MEMBER'
  | 'DUPLICATE_MEMBER'
  | 'PERSIST_FAILED';

export interface ChannelError {
  code: ChannelErrorCode;
  message: string;
}

export interface ChannelServiceDeps {
  /** The persistence layer. `saveImmediate` returns false on write failure
   *  (U1) and the post path surfaces that as `PERSIST_FAILED`. The full
   *  `ChannelStateWriter` is required because we read `load()` at
   *  construction to seed in-memory state. */
  writer: ChannelStateWriter;
  /** Company this daemon's channels belong to. Channels are company-bounded
   *  by design (see plan KTD10). */
  companyId: string;
  /** Event sink. Called once per successful post. */
  emit: ChannelServiceEmit;
  /** Time source. Defaults to `Date.now`. Override in tests for stable seq. */
  now?: () => number;
}

/** Sender identity carried in post/join payloads. */
export interface SenderRef {
  workspaceId: string;
  memberId: string;
  memberName: string;
}

export interface CreateChannelParams {
  name: string;
  visibility: ChannelVisibility;
  topic?: string;
  createdBy: SenderRef;
}

export interface ArchiveChannelParams {
  channelId: string;
  archivedBy: string;
}

export interface JoinChannelParams {
  channelId: string;
  member: SenderRef;
  /** When false, the new member's `historyFromSeq` is set to the
   *  channel's current `nextSeq` (so they don't see older history). */
  includeHistory?: boolean;
}

export interface LeaveChannelParams {
  channelId: string;
  workspaceId: string;
  memberId: string;
}

export interface PostMessageParams {
  channelId: string;
  sender: SenderRef;
  text: string;
  /** Idempotency key. Two posts with the same `clientMsgId` on the same
   *  channel return the original message; the second is a no-op. */
  clientMsgId?: string;
  /** Optional structured data (R10). */
  data?: unknown;
}

/** Discriminated success/failure envelope returned by every public method.
 *  Each method has its own `T` describing its success payload (e.g.
 *  `CreateChannelResult` for `create`). The `ok: false` branch always
 *  carries a typed `ChannelError` so callers can branch on `error.code`
 *  without parsing `error.message` strings. */
export type Result<T> =
  | ({ ok: true } & T)
  | { ok: false; error: ChannelError };

/** Result for methods that only return success/failure without a payload.
 *  Uses `void` (not `Record<string, never>`) so the success literal
 *  `{ ok: true }` satisfies the type — `Record<string, never>` would
 *  require every property to be `never`, including `ok`. */
export type EmptyResult = Result<void>;

/** Idempotency cache entry. `lastUsedAt` drives LRU eviction on overflow. */
interface IdempotencyEntry {
  seq: number;
  lastUsedAt: number;
}

export class ChannelService {
  private readonly writer: ChannelStateWriter;
  private state: ChannelState;
  private readonly mutexes = new Map<string, Promise<void>>();
  private readonly idempotency = new Map<string, Map<string, IdempotencyEntry>>();
  private readonly companyId: string;
  private readonly emit: ChannelServiceEmit;
  private readonly now: () => number;

  constructor(deps: ChannelServiceDeps) {
    this.writer = deps.writer;
    // Seed from the writer. The writer's `load()` runs the empty-channel
    // reaper and prototype-pollution guards before we get the data, so
    // the service can trust the shape.
    this.state = this.writer.load();
    this.companyId = deps.companyId;
    this.emit = deps.emit;
    this.now = deps.now ?? (() => Date.now());
  }

  // ── Read-only ─────────────────────────────────────────────────────

  /** Return every channel, regardless of status. */
  list(): Channel[] {
    return this.state.channels;
  }

  /** Return a channel by id, or null if not found. */
  get(channelId: string): Channel | null {
    return this.state.channels.find((c) => c.id === channelId) ?? null;
  }

  /** Return the members of a channel, or [] if not found. */
  getMembers(channelId: string): ChannelMember[] {
    return this.state.members[channelId] ?? [];
  }

  /** Return messages for a channel, optionally filtered to `seq >= sinceSeq`. */
  getMessages(channelId: string, sinceSeq?: number): ChannelMessage[] {
    const all = this.state.messages[channelId] ?? [];
    if (sinceSeq === undefined) return all;
    return all.filter((m) => m.seq >= sinceSeq);
  }

  // ── Mutating (per-channel mutex) ──────────────────────────────────

  async create(params: CreateChannelParams): Promise<Result<{ channel: Channel }>> {
    return this.withChannelLock('__create__', async () => {
      const name = canonicalizeChannelName(params.name);
      if (!isValidChannelName(name)) {
        return { ok: false, error: { code: 'INVALID_NAME', message: `Invalid channel name: ${params.name}` } };
      }
      // Reject duplicate names within the same company.
      if (this.state.channels.some((c) => c.companyId === this.companyId && c.name === name)) {
        return { ok: false, error: { code: 'INVALID_NAME', message: `Channel name already exists: ${name}` } };
      }
      const now = this.now();
      const channel: Channel = {
        id: `ch-${randomUUID()}`,
        companyId: this.companyId,
        name,
        visibility: params.visibility,
        status: 'active',
        createdAt: now,
        createdBy: params.createdBy.workspaceId,
        nextSeq: 1,
        ...(params.topic !== undefined ? { topic: params.topic } : {}),
      };
      this.state.channels.push(channel);
      // Auto-add the creator as a member (plan KTD10).
      this.state.members[channel.id] = [
        {
          workspaceId: params.createdBy.workspaceId,
          memberId: params.createdBy.memberId,
          joinedAt: now,
          historyFromSeq: 0,
        },
      ];
      this.state.messages[channel.id] = [];
      this.state.idempotency[channel.id] = {};
      if (!this.saveOrFail()) {
        // Roll back to keep the in-memory state in sync with disk.
        this.state.channels.pop();
        delete this.state.members[channel.id];
        delete this.state.messages[channel.id];
        delete this.state.idempotency[channel.id];
        return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel create' } };
      }
      return { ok: true, channel };
    });
  }

  async archive(params: ArchiveChannelParams): Promise<EmptyResult> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      const now = this.now();
      channel.status = 'archived';
      channel.archivedAt = now;
      channel.archivedBy = params.archivedBy;
      if (!this.saveOrFail()) {
        // Roll back.
        channel.status = 'active';
        delete channel.archivedAt;
        delete channel.archivedBy;
        return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel archive' } };
      }
      return { ok: true };
    });
  }

  async join(params: JoinChannelParams): Promise<EmptyResult> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      const members = this.state.members[channel.id] ?? [];
      // Reject duplicate membership.
      if (members.some((m) => m.workspaceId === params.member.workspaceId && m.memberId === params.member.memberId)) {
        return { ok: false, error: { code: 'DUPLICATE_MEMBER', message: 'Already a member' } };
      }
      // If the channel was empty (emptySince set), clear the empty marker —
      // the channel is alive again.
      if (channel.emptySince !== undefined) {
        delete channel.emptySince;
      }
      const now = this.now();
      const historyFromSeq = params.includeHistory === false ? channel.nextSeq : 0;
      members.push({
        workspaceId: params.member.workspaceId,
        memberId: params.member.memberId,
        joinedAt: now,
        historyFromSeq,
      });
      this.state.members[channel.id] = members;
      if (!this.saveOrFail()) {
        // Roll back the push.
        members.pop();
        return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel join' } };
      }
      return { ok: true };
    });
  }

  async leave(params: LeaveChannelParams): Promise<EmptyResult> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      const members = this.state.members[channel.id] ?? [];
      const idx = members.findIndex(
        (m) => m.workspaceId === params.workspaceId && m.memberId === params.memberId,
      );
      if (idx < 0) {
        return { ok: false, error: { code: 'NOT_A_MEMBER', message: 'Not a member' } };
      }
      // Snapshot the removed member so we can put them back on rollback.
      const removed = members[idx];
      members.splice(idx, 1);
      // If the channel is now empty, stamp `emptySince` (plan KTD8).
      if (members.length === 0 && channel.emptySince === undefined) {
        channel.emptySince = this.now();
      }
      this.state.members[channel.id] = members;
      if (!this.saveOrFail()) {
        // Roll back: re-insert at the original index.
        members.splice(idx, 0, removed);
        // Clear the emptySince stamp we just set.
        if (members.length === 1) delete channel.emptySince;
        return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel leave' } };
      }
      return { ok: true };
    });
  }

  async post(params: PostMessageParams): Promise<Result<{
    message: ChannelMessage;
    idempotent?: boolean;
  }>> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      if (channel.status === 'archived') {
        return { ok: false, error: { code: 'CHANNEL_ARCHIVED', message: 'Channel is archived' } };
      }
      // Idempotency check — under the per-channel mutex, so concurrent posts
      // on the same channel see consistent state.
      if (params.clientMsgId) {
        const channelIdMap = this.idempotency.get(channel.id) ?? new Map();
        const existing = channelIdMap.get(params.clientMsgId);
        if (existing) {
          // Refresh LRU timestamp on hit.
          existing.lastUsedAt = this.now();
          // Find the original message by seq.
          const original = (this.state.messages[channel.id] ?? []).find(
            (m) => m.seq === existing.seq,
          );
          if (original) {
            return { ok: true, message: original, idempotent: true };
          }
          // Cache points at a seq that no longer exists (e.g. message was
          // pruned by empty-channel reaper). Fall through to a fresh post.
        }
      }
      // Membership check.
      const members = this.state.members[channel.id] ?? [];
      const isMember = members.some(
        (m) => m.workspaceId === params.sender.workspaceId && m.memberId === params.sender.memberId,
      );
      if (!isMember) {
        return { ok: false, error: { code: 'NOT_A_MEMBER', message: 'Not a channel member' } };
      }
      // Freeze the recipient snapshot at critical-section entry (plan KTD3).
      // We deliberately do NOT re-read members after this point; a concurrent
      // `join` that lands later will not retroactively change the snapshot
      // of this in-flight post.
      const snapshot: ChannelRecipientStatus[] = members.map((m) => ({
        memberId: m.memberId,
        workspaceId: m.workspaceId,
        status: 'pending' as const,
      }));
      const seq = channel.nextSeq++;
      const now = this.now();
      const message: ChannelMessage = {
        channelId: channel.id,
        seq,
        workspaceId: params.sender.workspaceId,
        memberId: params.sender.memberId,
        memberName: params.sender.memberName,
        text: params.text,
        postedAt: now,
        deliveryStatus: 'pending',
        recipientSnapshot: snapshot,
        ...(params.clientMsgId !== undefined ? { clientMsgId: params.clientMsgId } : {}),
        ...(params.data !== undefined ? { data: params.data } : {}),
      };
      (this.state.messages[channel.id] ??= []).push(message);
      // Update idempotency cache.
      if (params.clientMsgId) {
        const channelIdMap = this.idempotency.get(channel.id) ?? new Map();
        channelIdMap.set(params.clientMsgId, { seq, lastUsedAt: now });
        // LRU eviction down to CHANNEL_IDEMPOTENCY_CAP.
        if (channelIdMap.size > CHANNEL_IDEMPOTENCY_CAP) {
          this.evictOldest(channelIdMap, channelIdMap.size - CHANNEL_IDEMPOTENCY_CAP);
        }
        this.idempotency.set(channel.id, channelIdMap);
        // Also persist the seq map so a daemon restart preserves idempotency.
        this.state.idempotency[channel.id] = Object.fromEntries(
          Array.from(channelIdMap.entries()).map(([k, v]) => [k, v.seq]),
        );
      }
      if (!this.saveOrFail()) {
        // Roll back: un-bump nextSeq, pop the message, drop idempotency entry.
        channel.nextSeq--;
        const msgs = this.state.messages[channel.id];
        if (msgs) msgs.pop();
        if (params.clientMsgId) {
          const channelIdMap = this.idempotency.get(channel.id);
          if (channelIdMap) channelIdMap.delete(params.clientMsgId);
        }
        return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist post' } };
      }
      // Emit AFTER successful persist — the post is durable on disk by the
      // time consumers see it. A failed emit does not block the post
      // (the plan's contract is: persist-first, then notify).
      try {
        this.emit({
          type: 'channel.message',
          channelId: channel.id,
          seq,
          sender: {
            workspaceId: params.sender.workspaceId,
            memberId: params.sender.memberId,
            memberName: params.sender.memberName,
          },
          recipients: snapshot,
          message,
          workspaceId: params.sender.workspaceId,
        });
      } catch (err) {
        // Best-effort: a throwing emit must not roll back a successful
        // post. The next tryDeliver cycle (U3.5 wiring) re-fans-out from
        // the persisted recipientSnapshot.
        console.error('[ChannelService] emit failed:', err);
      }
      return { ok: true, message };
    });
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Per-channel promise chain. Each call appends a new tail to the chain
   * for `channelId`; the caller awaits the previous tail, runs its body,
   * then releases its own slot. The map entry is deleted if our tail is
   * still the current head of the chain (i.e. no later caller overwrote
   * it), so an idle channel doesn't leak a resolved-promise entry forever.
   *
   * Channels don't contend — different keys run in parallel. Two posts on
   * the SAME channel are serialized; two posts on DIFFERENT channels race.
   */
  private async withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(channelId) ?? Promise.resolve();
    let release!: () => void;
    const ourTail = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const newTail = prev.then(() => ourTail);
    this.mutexes.set(channelId, newTail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      // Only delete if our entry is still the current tail. A later caller
      // (in a later tick) will have replaced it; they'll clean up their own.
      if (this.mutexes.get(channelId) === newTail) {
        this.mutexes.delete(channelId);
      }
    }
  }

  /** Evict the `count` oldest entries from a clientMsgId→entry map. */
  private evictOldest(map: Map<string, IdempotencyEntry>, count: number): void {
    const entries = Array.from(map.entries()).sort(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
    );
    for (let i = 0; i < count && i < entries.length; i++) {
      map.delete(entries[i][0]);
    }
  }

  /** Save the current state via the writer. Returns true on success. */
  private saveOrFail(): boolean {
    return this.writer.saveImmediate(this.state);
  }
}
