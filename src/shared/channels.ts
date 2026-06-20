// === A2A Channels ===
// Persistent, named multi-party rooms at the company level. Slack-style
// channels: scoped membership, durable history, public-or-private visibility
// (immutable post-creation), and a human-observable sidebar in the renderer.
//
// Companion to MessageQueue (which still owns the 1-to-1 + broadcast A2A
// primitives). Channels layer on top: posts fan out via the same idle-targeted
// delivery path, but the channel owns its own state, history, and membership.

export type ChannelVisibility = 'public' | 'private';

export type ChannelStatus = 'active' | 'archived';

/**
 * A channel's persisted shape. Lives in `channels.json` (separate from
 * `sessions.json` so channel loss can't cascade into session failure —
 * see plan KTD1).
 */
export interface Channel {
  /** Stable, unique channel id. Format: `ch-<uuid>` (matches codebase convention). */
  id: string;
  /** Company this channel belongs to. Channels are company-bounded by design. */
  companyId: string;
  /** Canonical name (lowercase, hyphens, length-bounded). Unique within company. */
  name: string;
  /** Optional human-readable topic. */
  topic?: string;
  /** Immutable post-creation. See plan KTD7. */
  visibility: ChannelVisibility;
  /** State machine: `active` ↔ `archived`. See plan R4. */
  status: ChannelStatus;
  /** Epoch ms. */
  createdAt: number;
  /** workspaceId of creator. Always auto-added as a member (plan KTD10). */
  createdBy: string;
  /** Epoch ms, set on `a2a_channel_archive`. */
  archivedAt?: number;
  /** workspaceId of archiver. */
  archivedBy?: string;
  /**
   * Monotonic per-channel counter for posts + membership events. Assigned
   * under the per-channel mutex (plan KTD2). Initialized to 1.
   */
  nextSeq: number;
  /**
   * Epoch ms when the channel became empty (zero members). Set by
   * the last member's `leave` or `archive`+purge flow. Drives the
   * 7-day empty-channel purge (plan KTD8).
   */
  emptySince?: number;
}

/**
 * Channel membership. One row per (channel, workspace). A workspace
 * may have multiple `Member`s (e.g. one per team member), so we
 * key on `memberId` for fine-grained addressing.
 */
export interface ChannelMember {
  workspaceId: string;
  memberId: string;
  /** Epoch ms. */
  joinedAt: number;
  /**
   * First channel `seq` this member can see. Defaults to 0 (= full
   * history from channel creation, plan KTD9). A member who joins
   * with `include_history: false` gets the nextSeq-at-join value
   * here.
   */
  historyFromSeq: number;
}

/**
 * A single posted message. Persisted in `messages[channelId]`. `seq`
 * is the canonical ordering — timestamps are not used for ordering
 * because multiple posts within a single mutex window can share
 * millisecond timestamps.
 */
export interface ChannelMessage {
  /** channelId. Duplicated from the map key for load-path convenience. */
  channelId: string;
  /** Monotonic per-channel sequence. See plan KTD2. */
  seq: number;
  workspaceId: string;
  memberId: string;
  /** Display name at post time. Snapshot to avoid stale-name drift. */
  memberName: string;
  text: string;
  /** Optional structured data, R10. */
  data?: unknown;
  /** Optional idempotency key, R13. */
  clientMsgId?: string;
  /** Epoch ms. */
  postedAt: number;
  /**
   * Delivery outcome. `pending` = enqueued, `delivered` = at least
   * one `tryDeliver` cycle has fired, `target_gone` = dead PTY at
   * deliver time. Per-recipient status lives on the
   * `recipientSnapshot` entries (see R14, plan KTD3).
   */
  deliveryStatus: 'pending' | 'delivered' | 'target_gone';
}

/**
 * Per-recipient delivery outcome. Stored alongside the message in
 * the `recipientSnapshot` field. Required by plan KTD3: the
 * recipient set is frozen at critical-section entry.
 */
export interface ChannelRecipientStatus {
  memberId: string;
  workspaceId: string;
  ptyId?: string;
  /** `'pending'` | `'delivered'` | `'target_gone'`. */
  status: 'pending' | 'delivered' | 'target_gone';
  /** Epoch ms of last attempt, if any. */
  lastAttemptAt?: number;
}

/**
 * Top-level persisted state. Mirrors the StateWriter's `{version, ...}`
 * shape. Versioned for future migration; ships at v1 (no schema migrations
 * registered yet — see `CHANNEL_STATE_REGISTRY`).
 */
export interface ChannelState {
  version: number;
  channels: Channel[];
  /** channelId → membership list. */
  members: Record<string, ChannelMember[]>;
  /** channelId → message list (ordered by seq). */
  messages: Record<string, ChannelMessage[]>;
  /**
   * Idempotency: channelId → clientMsgId → seq. R13. Looked up under
   * the per-channel mutex; eviction policy: LRU-capped at 1000 per
   * channel (memory bound; the per-channel mutex keeps the cap
   * check O(1) amortized).
   */
  idempotency: Record<string, Record<string, number>>;
}

/** Default empty state. Returned by `load()` on first-run / no-file. */
export const EMPTY_CHANNEL_STATE: ChannelState = {
  version: 1,
  channels: [],
  members: {},
  messages: {},
  idempotency: {},
};

/** Channel name canonicalization. Lowercase, hyphens, length-bounded. */
export const CHANNEL_NAME_MIN = 1;
export const CHANNEL_NAME_MAX = 64;
/** Allowed characters: lowercase letters, digits, hyphens. */
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function canonicalizeChannelName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

export function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME_RE.test(name);
}

/** Topic bounds. */
export const CHANNEL_TOPIC_MAX = 256;

/** Per-channel idempotency cap. See `ChannelState.idempotency`. */
export const CHANNEL_IDEMPOTENCY_CAP = 1000;

/** Empty-channel retention. Plan KTD8. */
export const CHANNEL_EMPTY_TTL_HOURS_DEFAULT = 7 * 24;
