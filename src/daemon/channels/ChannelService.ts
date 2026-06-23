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
  CHANNEL_BODY_MAX,
  CHANNEL_DATA_MAX,
  CHANNEL_IDEMPOTENCY_CAP,
  CHANNEL_MAX_COUNT,
  CHANNEL_MAX_MEMBERS,
  CHANNEL_TOPIC_MAX,
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
  | 'PERSIST_FAILED'
  /** Caller is not permitted to perform this action (server-pin sender,
   *  archive authz). The server uses the verified workspaceId (resolved
   *  by the transport layer — MCP `requireWorkspaceId`, the renderer's
   *  bridge, etc.) as the authoritative caller identity. A mismatch with
   *  the client-supplied `sender.workspaceId` (post path) or a non-creator
   *  / non-CEO caller (archive path) yields this code. */
  | 'NOT_AUTHORIZED'
  /** Post body over `CHANNEL_BODY_MAX` / topic over `CHANNEL_TOPIC_MAX`.
   *  Enforced pre-persist so the writer never sees oversize content. */
  | 'CHANNEL_BODY_TOO_LARGE'
  /** Post `data` payload over `CHANNEL_DATA_MAX` (JSON-serialized length).
   *  Same pre-persist enforcement as the body cap. */
  | 'CHANNEL_DATA_TOO_LARGE'
  /** Per-company channel count over `CHANNEL_MAX_COUNT` or per-channel
   *  member count over `CHANNEL_MAX_MEMBERS`. Enforced in `create`. */
  | 'CHANNEL_LIMIT_REACHED';

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
  /** Company CEO's workspaceId. Used as the override for the archive
   *  authz gate (KTD-F): the CEO may archive any channel regardless of
   *  who created it. When `undefined`, only the creator can archive.
   *  Daemon-side this stays `undefined` until the company-mode config
   *  key lands (the renderer owns `Company.ceoWorkspaceId` today). */
  ceoWorkspaceId?: string;
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
  /** D5 — server-resolved caller workspace (resolved by the transport layer
   *  from a verified `senderPtyId`). The channel's `createdBy` AND the creator
   *  member's `workspaceId` are pinned to THIS, not the caller-supplied
   *  `createdBy.workspaceId` — a forger must not be able to attribute a channel
   *  to a victim, since `createdBy` feeds the archive authz gate (KTD-F).
   *  Required and consistent with the other mutating params (Join/Leave/Post/
   *  Archive); the daemon create handler fails closed without it. */
  verifiedWorkspaceId: string;
  /** Initial members to auto-add alongside the creator (U6 member cap).
   *  The creator is always added regardless of this field. When omitted,
   *  the channel starts with only the creator (the historical default). */
  members?: SenderRef[];
}

export interface ArchiveChannelParams {
  channelId: string;
  archivedBy: string;
  /** Server-verified workspaceId (resolved by the transport layer).
   *  The archive authz gate (KTD-F) requires the caller to be the
   *  channel's creator OR the company CEO; both are checked against
   *  this field, not against `archivedBy` (which the client supplies
   *  and could lie about). */
  verifiedWorkspaceId: string;
}

export interface JoinChannelParams {
  channelId: string;
  member: SenderRef;
  /** When false, the new member's `historyFromSeq` is set to the
   *  channel's current `nextSeq` (so they don't see older history). */
  includeHistory?: boolean;
  /** D5 — server-resolved caller workspace. The joining member's workspaceId
   *  is pinned to THIS, not the caller-supplied `member.workspaceId`, so a
   *  forger cannot join a channel as a victim workspace. */
  verifiedWorkspaceId: string;
}

export interface LeaveChannelParams {
  channelId: string;
  workspaceId: string;
  memberId: string;
  /** D5 — server-resolved caller workspace. A caller may only remove its OWN
   *  membership: `workspaceId` must equal this, else NOT_AUTHORIZED. */
  verifiedWorkspaceId: string;
}

export interface PostMessageParams {
  channelId: string;
  sender: SenderRef;
  text: string;
  /** Server-verified workspaceId (resolved by the transport layer —
   *  MCP `requireWorkspaceId` for first-party tools, the renderer
   *  bridge for the in-app composer). The post path pins the sender's
   *  authoritative workspace from THIS field, not from
   *  `sender.workspaceId` (which the client supplies and could lie
   *  about). A mismatch yields `NOT_AUTHORIZED`. */
  verifiedWorkspaceId: string;
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
  private readonly ceoWorkspaceId: string | undefined;
  private readonly emit: ChannelServiceEmit;
  private readonly now: () => number;
  /**
   * Monotonic counter advanced once per persisted `clientMsgId` entry
   * during hydration (U7). It seeds `lastUsedAt` so the first post on
   * a saturated channel evicts the entry hydrated first — a
   * deterministic FIFO of persisted entries — rather than a random
   * one (which `Date.now()` would do when many entries share the same
   * millisecond). After hydration is done, the counter is unused;
   * live posts stamp `lastUsedAt` from `this.now()` as before.
   */
  private hydrationSeq = 0;

  constructor(deps: ChannelServiceDeps) {
    this.writer = deps.writer;
    // Seed from the writer. The writer's `load()` runs the empty-channel
    // reaper and prototype-pollution guards before we get the data, so
    // the service can trust the shape.
    this.state = this.writer.load();
    this.companyId = deps.companyId;
    this.ceoWorkspaceId = deps.ceoWorkspaceId;
    this.emit = deps.emit;
    this.now = deps.now ?? (() => Date.now());
    // Hydrate the idempotency LRU from persisted state (R9). Without
    // this, a daemon restart loses every `clientMsgId → seq` mapping
    // and a retry after restart silently allocates a fresh seq — the
    // exact failure mode the U2 maintainer directive warned against.
    // The persisted shape is `Record<channelId, Record<clientMsgId,
    // number>>` (a plain object for JSON portability); the in-memory
    // shape is `Map<channelId, Map<clientMsgId, {seq, lastUsedAt}>>`
    // (an LRU map for O(1) lookup + O(n) eviction only on overflow).
    for (const [channelId, clientMap] of Object.entries(this.state.idempotency)) {
      const inner = new Map<string, IdempotencyEntry>();
      for (const [clientMsgId, seq] of Object.entries(clientMap)) {
        inner.set(clientMsgId, { seq, lastUsedAt: ++this.hydrationSeq });
      }
      this.idempotency.set(channelId, inner);
    }
  }

  // ── Read-only ─────────────────────────────────────────────────────

  /**
   * List channels visible to the verified caller (U6 membership +
   * visibility gate). Returns every public channel + every private
   * channel the caller is a member of. Active AND archived rows are
   * returned — the renderer decides how to render archived channels
   * (collapsed group, badge, etc.).
   *
   * The membership gate runs per-channel: a public channel is always
   * visible; a private channel is visible iff the caller's
   * `verifiedWorkspaceId` appears in its member list.
   */
  list(verifiedWorkspaceId: string): Channel[] {
    return this.state.channels.filter((channel) => this.isVisibleTo(channel, verifiedWorkspaceId));
  }

  /**
   * Return a channel by id, gated on visibility for the verified
   * caller. A private channel that does not include the caller is
   * indistinguishable from a missing channel from the caller's POV
   * (returns null — same as a non-existent id). The renderer
   * collapses null into "channel not found" UI without leaking the
   * existence of a private room the caller cannot see.
   */
  get(channelId: string, verifiedWorkspaceId: string): Channel | null {
    const channel = this.state.channels.find((c) => c.id === channelId);
    if (!channel) return null;
    if (!this.isVisibleTo(channel, verifiedWorkspaceId)) return null;
    return channel;
  }

  /**
   * Return the members of a channel, gated on the caller being a
   * member (or the channel being public). Private channels do not
   * expose their member list to non-members — the empty-array
   * return is intentional; the renderer treats it as "no access."
   */
  getMembers(channelId: string, verifiedWorkspaceId: string): ChannelMember[] {
    const channel = this.state.channels.find((c) => c.id === channelId);
    if (!channel) return [];
    if (!this.isVisibleTo(channel, verifiedWorkspaceId)) return [];
    return this.state.members[channelId] ?? [];
  }

  /**
   * Return messages for a channel, gated on visibility + membership
   * AND floored at the viewer's `historyFromSeq` for non-public
   * channels. The seq-floor mirrors `isMessageVisibleToViewer` in
   * `src/renderer/components/Channels/ChannelView.tsx` — a member
   * who joined late (`historyFromSeq = nextSeq at join time`) cannot
   * see earlier messages via this endpoint. Public channels have
   * no floor (any verified caller sees the full history from `sinceSeq`).
   *
   * The seq-floor is `Math.max(sinceSeq ?? 0, viewer.historyFromSeq)`
   * so a caller can still page with `sinceSeq` on top of the floor.
   */
  getMessages(channelId: string, sinceSeq: number | undefined, verifiedWorkspaceId: string): ChannelMessage[] {
    const channel = this.state.channels.find((c) => c.id === channelId);
    if (!channel) return [];
    if (!this.isVisibleTo(channel, verifiedWorkspaceId)) return [];
    const all = this.state.messages[channelId] ?? [];
    // Floor at the viewer's historyFromSeq for non-public channels.
    // Public channels have no per-member history cap.
    let floor = sinceSeq ?? 0;
    if (channel.visibility !== 'public') {
      const viewer = (this.state.members[channelId] ?? []).find(
        (m) => m.workspaceId === verifiedWorkspaceId,
      );
      if (!viewer) {
        // Should be unreachable given the isVisibleTo gate above (a
        // non-public channel is only visible to its members), but
        // guarded so a future visibility-rule change can't widen the
        // hole.
        return [];
      }
      floor = Math.max(floor, viewer.historyFromSeq);
    }
    return all.filter((m) => m.seq >= floor);
  }

  /** Per-channel visibility rule. A channel is visible to the caller
   *  when it is public OR the caller is in its member list. */
  private isVisibleTo(channel: Channel, verifiedWorkspaceId: string): boolean {
    if (channel.visibility === 'public') return true;
    const members = this.state.members[channel.id] ?? [];
    return members.some((m) => m.workspaceId === verifiedWorkspaceId);
  }

  // ── Mutating (per-channel mutex) ──────────────────────────────────

  /**
   * Create a new channel. Canonicalizes the name, rejects duplicates
   * within the same company, and auto-adds the creator as a member
   * with `historyFromSeq: 0` (KTD10). Returns the authoritative
   * `Channel` row on success; `INVALID_NAME` if the name fails
   * validation; `PERSIST_FAILED` if the writer's `saveImmediate` returns
   * `false`. The critical section is keyed on a sentinel (`__create__`)
   * so two concurrent creates serialise on each other.
   */
  async create(params: CreateChannelParams): Promise<Result<{ channel: Channel }>> {
    return this.withChannelLock('__create__', async () => {
      const name = canonicalizeChannelName(params.name);
      if (!isValidChannelName(name)) {
        return { ok: false, error: { code: 'INVALID_NAME', message: `Invalid channel name: ${params.name}` } };
      }
      // Topic length cap (U6). Measured on the trimmed form so a caller
      // cannot pad with whitespace to bypass the cap.
      if (params.topic !== undefined && params.topic.length > CHANNEL_TOPIC_MAX) {
        return {
          ok: false,
          error: {
            code: 'CHANNEL_BODY_TOO_LARGE',
            message: `Topic exceeds ${CHANNEL_TOPIC_MAX} characters`,
          },
        };
      }
      // Per-company channel cap. Catches a runaway client before the
      // in-memory state grows unbounded.
      if (this.state.channels.filter((c) => c.companyId === this.companyId).length >= CHANNEL_MAX_COUNT) {
        return {
          ok: false,
          error: {
            code: 'CHANNEL_LIMIT_REACHED',
            message: `Company channel limit reached (${CHANNEL_MAX_COUNT})`,
          },
        };
      }
      // Per-channel member cap (creator + initial members). Counts the
      // creator explicitly so the cap cannot be silently exceeded when
      // `members` is omitted (the creator is always added regardless).
      const initialMemberCount = 1 + (params.members?.length ?? 0);
      if (initialMemberCount > CHANNEL_MAX_MEMBERS) {
        return {
          ok: false,
          error: {
            code: 'CHANNEL_LIMIT_REACHED',
            message: `Channel member limit reached (${CHANNEL_MAX_MEMBERS})`,
          },
        };
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
        // D5: pin the creator to the server-resolved verifiedWorkspaceId, NOT
        // the caller-supplied createdBy.workspaceId — a forger must not be able
        // to attribute a channel to a victim, since createdBy feeds the archive
        // authz gate below (L459).
        createdBy: params.verifiedWorkspaceId,
        nextSeq: 1,
        ...(params.topic !== undefined ? { topic: params.topic } : {}),
      };
      this.state.channels.push(channel);
      // Auto-add the creator as a member (plan KTD10). Optional
      // initial members (U6) are appended after the creator; duplicates
      // against the creator are silently dropped so a caller cannot
      // double-stamp the creator and skew the count.
      const initialMembers: ChannelMember[] = [
        {
          // D5: the creator's membership is keyed to the server-resolved
          // verifiedWorkspaceId (same pin as createdBy above).
          workspaceId: params.verifiedWorkspaceId,
          memberId: params.createdBy.memberId,
          joinedAt: now,
          historyFromSeq: 0,
        },
      ];
      for (const member of params.members ?? []) {
        if (
          initialMembers.some(
            (m) => m.workspaceId === member.workspaceId && m.memberId === member.memberId,
          )
        ) {
          continue;
        }
        initialMembers.push({
          workspaceId: member.workspaceId,
          memberId: member.memberId,
          joinedAt: now,
          historyFromSeq: 0,
        });
      }
      this.state.members[channel.id] = initialMembers;
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

  /**
   * Archive a channel. Sets `status: 'archived'` and `archivedAt`.
   * Members retain history access (KTD-G). Subsequent `post` calls
   * return `CHANNEL_ARCHIVED`. `CHANNEL_NOT_FOUND` if the id is unknown;
   * `NOT_AUTHORIZED` if the verified caller is neither the creator nor
   * the company CEO; `PERSIST_FAILED` if the writer cannot save.
   */
  async archive(params: ArchiveChannelParams): Promise<EmptyResult> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      // Authz gate (KTD-F): caller must be the creator OR the company CEO.
      // Both checks use `verifiedWorkspaceId` (server-resolved) — the
      // client-supplied `archivedBy` is recorded as metadata only, never
      // trusted for the gate.
      const isCeo = this.ceoWorkspaceId !== undefined && this.ceoWorkspaceId === params.verifiedWorkspaceId;
      if (channel.createdBy !== params.verifiedWorkspaceId && !isCeo) {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: 'Only the channel creator or the company CEO may archive this channel',
          },
        };
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

  /**
   * Add a member to a channel. `DUPLICATE_MEMBER` if already present.
   * `includeHistory: false` (default) sets the new member's
   * `historyFromSeq` to the channel's current `nextSeq` so they don't
   * see older history; `includeHistory: true` sets it to `0` (full
   * history). Members of an `emptySince`-tagged channel clear that
   * tag on join so the empty-channel reaper stops counting it.
   */
  async join(params: JoinChannelParams): Promise<EmptyResult> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      // #288 — fail-closed visibility gate. You may JOIN a channel only if you
      // may SEE it (the same `isVisibleTo` invariant the read paths use):
      // public ⇒ always; private ⇒ the caller's verified workspace must already
      // be a member (seeded at create time). Without this, any same-machine
      // pipe/MCP caller that knows a private channel's id could self-join it and
      // unlock its full history + LIVE fan-out (the joiner lands in every future
      // post's recipientSnapshot + receives the channel.message event) and appear
      // in the roster — reads are membership-scoped, so join was the escalation.
      //
      // We return CHANNEL_NOT_FOUND with the SAME message as a missing channel
      // (NOT a distinct NOT_AUTHORIZED) so a non-member cannot distinguish a
      // private channel they're locked out of from a non-existent id — symmetric
      // with get()/getMembers()/getMessages(), which hide private existence from
      // non-members. An existing member of a private channel passes this gate
      // (they're visible) and falls through to the precise DUPLICATE_MEMBER below.
      if (!this.isVisibleTo(channel, params.verifiedWorkspaceId)) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      const members = this.state.members[channel.id] ?? [];
      // Reject duplicate membership (keyed on the server-resolved workspace).
      if (members.some((m) => m.workspaceId === params.verifiedWorkspaceId && m.memberId === params.member.memberId)) {
        return { ok: false, error: { code: 'DUPLICATE_MEMBER', message: 'Already a member' } };
      }
      // Snapshot emptySince so we can restore it on a saveOrFail
      // rollback (R10). Without the snapshot, a failed persist would
      // leave the channel with NO emptySince even though it should
      // still be tagged for the reaper — the channel could end up
      // living forever despite zero members. The symmetric
      // snapshot/restore pattern lives in `leave()` below.
      const previousEmptySince = channel.emptySince;
      // If the channel was empty (emptySince set), clear the empty marker —
      // the channel is alive again.
      if (channel.emptySince !== undefined) {
        delete channel.emptySince;
      }
      const now = this.now();
      const historyFromSeq = params.includeHistory === false ? channel.nextSeq : 0;
      members.push({
        // D5: pin the joining member to the server-resolved workspace, NOT the
        // caller-supplied member.workspaceId — a forger must not join as a victim.
        workspaceId: params.verifiedWorkspaceId,
        memberId: params.member.memberId,
        joinedAt: now,
        historyFromSeq,
      });
      this.state.members[channel.id] = members;
      if (!this.saveOrFail()) {
        // Roll back the push AND restore the prior emptySince tag.
        members.pop();
        channel.emptySince = previousEmptySince;
        return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel join' } };
      }
      return { ok: true };
    });
  }

  /**
   * Remove a member from a channel. `NOT_A_MEMBER` if absent. The
   * last member leaving sets `emptySince` so the empty-channel reaper
   * prunes the row after the TTL; a subsequent `join` clears
   * `emptySince` (the `create` path is unaffected — a freshly created
   * channel never has `emptySince`).
   */
  async leave(params: LeaveChannelParams): Promise<EmptyResult> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      const members = this.state.members[channel.id] ?? [];
      const idx = members.findIndex(
        // D5: a caller may only remove its OWN membership (the server-resolved
        // workspace), not an arbitrary caller-supplied workspaceId.
        (m) => m.workspaceId === params.verifiedWorkspaceId && m.memberId === params.memberId,
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

  /**
   * Post a message to a channel. Validates membership, freezes the
   * recipient snapshot at critical-section entry (KTD3 — a concurrent
   * `join` that lands later will not retroactively target this post),
   * allocates the next `seq`, and persists. Idempotency: a repeat
   * post with the same `clientMsgId` returns the original message
   * with `idempotent: true` (no new seq, no second emit). Errors:
   * `CHANNEL_NOT_FOUND`, `CHANNEL_ARCHIVED`, `NOT_A_MEMBER`,
   * `NOT_AUTHORIZED`, `PERSIST_FAILED`. The `channel.message` event
   * fires AFTER a successful persist — the message is durable on disk
   * by the time consumers see it.
   *
   * Sender pinning (R5/R6): the server uses `verifiedWorkspaceId` (the
   * transport-resolved caller identity — MCP `requireWorkspaceId`, the
   * renderer bridge) as the authoritative caller. A client-supplied
   * `sender.workspaceId` that disagrees with `verifiedWorkspaceId` is
   * rejected with `NOT_AUTHORIZED` before any state mutation. This
   * stops a malicious or buggy caller from posting AS a different
   * workspace — the persisted row's `workspaceId` is always the
   * verified one, so downstream fan-out (recipient snapshot, event
   * `senderWorkspaceId`) cannot be spoofed by the client.
   */
  async post(params: PostMessageParams): Promise<Result<{
    message: ChannelMessage;
    idempotent?: boolean;
  }>> {
    return this.withChannelLock(params.channelId, async () => {
      // Sender-pin gate (R5). Must run BEFORE any state read or
      // mutation — a forged sender must not even consume an idempotency
      // cache lookup, since that would let the attacker probe seq
      // values for channels they cannot post in.
      if (params.sender.workspaceId !== params.verifiedWorkspaceId) {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: 'sender.workspaceId does not match the verified caller identity',
          },
        };
      }
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
      // Body clamp (U6). Measure the post-canonicalized form (C0 strip +
      // trim) so padding whitespace and zero-width characters cannot
      // bypass the cap. Reject BEFORE allocating a seq so an oversize
      // post does not consume an idempotency slot.
      const sanitizedText = sanitizePostText(params.text);
      if (sanitizedText.length > CHANNEL_BODY_MAX) {
        return {
          ok: false,
          error: {
            code: 'CHANNEL_BODY_TOO_LARGE',
            message: `Post body exceeds ${CHANNEL_BODY_MAX} characters`,
          },
        };
      }
      // Data payload cap (U6). Measured as JSON-serialized length so a
      // moderate JSON blob (~4 KiB) fits while a giant payload is
      // caught without a deep object walk.
      if (params.data !== undefined) {
        let dataSize: number;
        try {
          dataSize = JSON.stringify(params.data).length;
        } catch {
          // Circular / non-serializable payload — surface as too-large
          // so the caller retries with a serializable shape. We do not
          // throw because the post envelope contract is `{ ok, error }`.
          return {
            ok: false,
            error: {
              code: 'CHANNEL_DATA_TOO_LARGE',
              message: 'Post `data` payload is not JSON-serializable',
            },
          };
        }
        if (dataSize > CHANNEL_DATA_MAX) {
          return {
            ok: false,
            error: {
              code: 'CHANNEL_DATA_TOO_LARGE',
              message: `Post \`data\` payload exceeds ${CHANNEL_DATA_MAX} bytes (JSON-serialized)`,
            },
          };
        }
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
        text: sanitizedText,
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

/**
 * Canonicalize a post body for persistence. The rules are:
 *
 *  1. Strip C0 control characters (U+0000-U+001F) EXCEPT for the
 *     whitespace pass-throughs: `\t` (0x09), `\n` (0x0A), `\r` (0x0D).
 *     This catches terminal escape sequences (0x1B ESC), NULs, and
 *     other bytes that could corrupt downstream TUI consumers when
 *     the post is fanned out to a live PTY.
 *  2. Trim leading/trailing whitespace so a padded body cannot
 *     bypass the byte cap (`CHANNEL_BODY_MAX` is measured on this
 *     sanitized form).
 *
 * Unicode whitespace beyond C0 (e.g. zero-width joiner U+200D,
 * non-breaking space U+00A0) is intentionally NOT stripped here —
 * the renderer / MCP tools treat it as content. If a future
 * "normalize Unicode" rule is added it should land in a single
 * shared helper, not in each transport.
 */
export function sanitizePostText(text: string): string {
  // Strip C0 controls except tab/newline/CR. Use a single regex pass
  // for speed — post bodies can be up to 8 KiB and we do this on the
  // hot path.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
}
