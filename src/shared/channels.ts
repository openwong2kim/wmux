// === A2A Channels ===
// Persistent, named multi-party rooms at the company level. Slack-style
// channels: scoped membership, durable history, public-or-private visibility
// (immutable post-creation), and a human-observable sidebar in the renderer.
//
// Companion to MessageQueue (which still owns the 1-to-1 + broadcast A2A
// primitives). Channels layer on top: posts fan out via the same idle-targeted
// delivery path, but the channel owns its own state, history, and membership.

/**
 * Channel visibility. Immutable post-creation (see plan KTD7).
 * `public` channels are discoverable and joinable; `private` channels
 * are invite-only.
 */
export type ChannelVisibility = 'public' | 'private';

/**
 * Channel lifecycle state. `active` channels accept posts; `archived`
 * channels are read-only and subject to the empty-channel reaper. See
 * plan R4 for the state machine.
 */
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
   *
   * When this field is missing on a zero-member channel at load time,
   * the reaper falls back to `createdAt` as the effective empty-start.
   * This catches the "lost emptySince" recovery case — a channel whose
   * `emptySince` was never persisted (crash between leave and write) or
   * was lost through a future migration — and applies the 7-day bound
   * from creation in that case.
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
  /**
   * Per-recipient delivery snapshot, populated when the message is
   * posted under the per-channel mutex. Required by plan KTD3: the
   * recipient set is frozen at critical-section entry so later joins
   * don't retroactively change who was targeted. Optional because
   * older persisted messages (pre-U2) won't have it.
   */
  recipientSnapshot?: ChannelRecipientStatus[];
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

/** Channel name length bounds. `CHANNEL_NAME_MIN` is the empty-length
 *  floor; the regex below requires at least 1 character. */
export const CHANNEL_NAME_MIN = 1;
/** Channel name upper length bound. Matches `{CHANNEL_NAME_MAX - 1}` in
 *  the `CHANNEL_NAME_RE` regex below. */
export const CHANNEL_NAME_MAX = 64;
/** Allowed characters: lowercase letters, digits, hyphens. The trailing
 *  `{0,63}` is `CHANNEL_NAME_MAX - 1` since the leading char is fixed. */
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Canonicalize a user-supplied channel name. Strips characters outside
 * `[a-z0-9-]`, lowercases, drops a leading hyphen (so the result starts
 * with a letter or digit), and clamps to `CHANNEL_NAME_MAX` characters.
 *
 * The result may still be invalid for adversarial inputs — an empty
 * string canonicalizes to `""`, and any input whose non-hyphen chars
 * are all stripped (e.g. all-punctuation) canonicalizes to `""`. Both
 * fail `isValidChannelName`. The caller is responsible for validating
 * the result with `isValidChannelName` and rejecting invalid input at
 * the boundary; the canonicalizer's job is to normalize, not to
 * guarantee validity.
 */
export function canonicalizeChannelName(raw: string): string {
  const replaced = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  // Strip a leading hyphen so the result starts with a letter or digit.
  // (CHANNEL_NAME_RE requires this — without the strip, "-foo" would
  // pass canonicalize but fail isValidChannelName.)
  const stripped = replaced.replace(/^-+/, '');
  // Clamp to CHANNEL_NAME_MAX. JS's String.prototype.slice handles
  // surrogate pairs as code units, which is fine here — channel names
  // are ASCII by construction (the regex above restricts to ASCII).
  return stripped.slice(0, CHANNEL_NAME_MAX);
}

/** Returns true iff `name` matches the channel name pattern: 1-64
 *  characters, lowercase letter/digit start, `[a-z0-9-]` body. */
export function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME_RE.test(name);
}

/** Topic bounds. */
export const CHANNEL_TOPIC_MAX = 256;

/** Per-channel idempotency cap. See `ChannelState.idempotency`. */
export const CHANNEL_IDEMPOTENCY_CAP = 1000;

/** Empty-channel retention. Plan KTD8. */
export const CHANNEL_EMPTY_TTL_HOURS_DEFAULT = 7 * 24;
