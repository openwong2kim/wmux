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
  /**
   * @-mentions parsed from the composer at post time. Each entry pins the
   * mentioned member's `workspaceId` — the key used both to highlight "you were
   * mentioned" in the dock and (Phase 2) to route an agent ping to that
   * workspace's a2a inbox — plus a `name` snapshot so the @token renders even
   * after a name change or workspace removal. Optional: pre-mention messages
   * won't have it.
   */
  mentions?: ChannelMention[];
}

/**
 * A single @-mention carried on a {@link ChannelMessage}. The mentioned member
 * is identified by `workspaceId` (the stable, forgery-resistant key the daemon
 * already pins membership on); `memberId` narrows it to a specific member when
 * one was targeted, else the mention is workspace-level. `name` is the display
 * snapshot at post time.
 *
 * Agent-pane redesign: `paneId` + `ptyId` capture the STABLE pane identity of a
 * specific live agent at mention time (the composer snapshots them from
 * `a2a_discover`). The daemon treats them as opaque pass-through (it owns the
 * workspace/subscription gate, not the live pane tree); the RECEIVING renderer
 * resolves `paneId` in its own leaves and re-checks `ptyId` is still live
 * (fail-closed) before pinning an a2a task to that exact pane. Both absent for a
 * workspace-level mention (targets any live agent in the ws — the legacy path).
 */
export interface ChannelMention {
  workspaceId: string;
  memberId?: string;
  paneId?: string;
  ptyId?: string;
  name: string;
}

/**
 * A requested @mention that could NOT be routed because its target workspace is
 * not a member of the channel. `ChannelService.post` returns these to the sender
 * so a mis-targeted mention is visible feedback, not a silent drop (the dominant
 * A2A failure mode). `reason` is an enum so future drop causes (e.g. archived,
 * rate-limited) extend it without breaking callers.
 */
export interface ChannelDroppedMention {
  workspaceId: string;
  name?: string;
  reason: 'not_a_member';
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

/**
 * The single company every channel belongs to until in-app Company mode
 * provides a real company id. The daemon's ChannelService is constructed
 * with this id (it stamps every channel's `companyId`), so the renderer
 * MUST use the same value when it synthesizes an optimistic row or resolves
 * a "self" company context without an in-app Company — otherwise the
 * optimistic row's companyId would disagree with the daemon's authoritative
 * row. Channels are intentionally decoupled from in-app Company mode: they
 * are always available, scoped to this default company, and the daemon is
 * the authoritative catalog. When multi-company lands, this becomes a
 * fallback rather than the only value.
 */
export const DEFAULT_COMPANY_ID = 'co-default';

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

/** Per-message body cap (post path). 8 KiB is enough for ~2000 words
 *  with formatting; longer posts should split. The cap is enforced
 *  post-canonicalization in `ChannelService.post` and surfaces as
 *  `CHANNEL_BODY_TOO_LARGE`. */
export const CHANNEL_BODY_MAX = 8192;

/** Per-message `data` payload cap (R10). 4 KiB holds a moderate JSON
 *  blob (e.g. an MCP tool result, a structured card). Enforced in
 *  `ChannelService.post` and surfaces as `CHANNEL_DATA_TOO_LARGE`.
 *  The size is measured as the JSON-serialized string length, not
 *  the in-memory object size — a cheap O(n) proxy that catches
 *  obvious oversize payloads without deep object walks. */
export const CHANNEL_DATA_MAX = 4096;

/** Max @mentions per post. Bounds the O(mentions x members) validation done
 *  inside the per-channel lock AND the size of the `droppedMentions` feedback
 *  echoed back to the sender, so a single member can't wedge a channel with a
 *  giant mention list. Enforced in `ChannelService.post` →
 *  `CHANNEL_MENTIONS_TOO_MANY`. 64 is far above any real ping fan-out. */
export const CHANNEL_MENTIONS_MAX = 64;

/** Per-company channel cap. A company with N departments and
 *  cross-cutting workflows typically needs ~tens of channels;
 *  1000 leaves headroom for orgs that are channel-heavy without
 *  making the in-memory `state.channels` array unbounded. Enforced
 *  in `ChannelService.create` and surfaces as `CHANNEL_LIMIT_REACHED`. */
export const CHANNEL_MAX_COUNT = 1000;

/** Per-channel member cap. A single channel can hold at most
 *  256 members — a workspace with cross-functional participation
 *  caps at 256, larger audiences should split or use a one-to-many
 *  broadcast mechanism. The cap includes the auto-added creator
 *  and any initial members passed in `create({ members })`.
 *  Enforced in `ChannelService.create` and surfaces as
 *  `CHANNEL_LIMIT_REACHED`. */
export const CHANNEL_MAX_MEMBERS = 256;

/** Per-channel idempotency cap. See `ChannelState.idempotency`. */
export const CHANNEL_IDEMPOTENCY_CAP = 1000;

/** Per-channel message cap (A2 — DoS bound). `ChannelService.post` tail-evicts
 *  the oldest messages above this so a runaway poster cannot grow `channels.json`
 *  / the in-memory array (and the per-post `saveImmediate` whole-state
 *  re-serialization cost) without bound. Older history drops; the recent window —
 *  what `getMessages` / `ChannelView` actually read — stays. Large enough (5000)
 *  that normal use never trims. */
export const CHANNEL_MESSAGES_MAX = 5000;

/** Empty-channel retention. Plan KTD8. */
export const CHANNEL_EMPTY_TTL_HOURS_DEFAULT = 7 * 24;

/**
 * Outcome of a single `ChannelDelivery.deliver` call. The transport fills in
 * per-recipient `status` and `lastAttemptAt` on the snapshot it was given; the
 * service layer (`ChannelService.post`) is responsible for writing the
 * updated snapshot back onto the persisted message.
 *
 * `ok` is a coarse aggregate: `true` when at least one recipient was
 * `delivered`; `false` when every recipient ended up `target_gone` (no PTY
 * to deliver to). The transport never throws — a delivery that finds no
 * targets is a normal "no-op success," not a failure.
 */
export interface DeliveryResult {
  /**
   * The same `snapshot` the transport was given, with each entry's `status`
   * and `lastAttemptAt` updated. The transport may return the same
   * reference if all deliveries are no-ops, or a fresh array; callers
   * must not assume identity.
   */
  snapshot: ChannelRecipientStatus[];
  /** True when at least one recipient was `delivered`. */
  ok: boolean;
}

/**
 * ChannelDelivery is the transport-agnostic interface that ships a posted
 * message to the recipients in `snapshot`. The local transport wraps the
 * existing `submitBracketedPasteToPty` and live-TUI nudge path
 * (`src/renderer/channels/LocalPtyDelivery.ts`); future transports — LAN,
 * headless, archive — can be slotted in as siblings without changing the
 * service layer or the wire protocol.
 *
 * Plan KTD-A: this interface is the seam for fanout. It accepts the full
 * recipient snapshot so transports that batch or batch-and-defer don't need
 * a renderer round-trip.
 *
 * The transport must NOT mutate `ChannelState`. It returns the updated
 * snapshot; `ChannelService.post` writes it back inside the per-channel
 * mutex so the persisted message reflects the actual delivery outcome.
 */
export interface ChannelDelivery {
  /**
   * Deliver `message` to the recipients in `snapshot`. Resolves with a
   * `DeliveryResult` whose `snapshot` has each entry's `status` updated
   * (`pending` → `delivered` | `target_gone`).
   */
  deliver(
    message: ChannelMessage,
    snapshot: ChannelRecipientStatus[],
  ): Promise<DeliveryResult>;
}
