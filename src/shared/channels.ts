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
  /**
   * W1 (operator observation) — caller-relative, NOT persisted. Set true by
   * `ChannelService.list()` on a private channel the calling workspace can
   * OBSERVE but is not a member of (only the reserved human workspace, ws-human,
   * ever reaches this). The renderer uses it to place the channel in the normal
   * dock list with a read-only "observed" badge and to hide the composer (join
   * to participate). Absent for member channels and every agent caller — the
   * field never lands in `channels.json` (list stamps it on a shallow copy).
   */
  observed?: boolean;
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
  /**
   * Channels v2 (durable inbox): highest `seq` this member has CONSUMED.
   * Advance-only (`a2a.channel.ack` clamps to the channel head and never
   * moves backwards); `unread = messages with historyFromSeq ≤ seq >
   * lastReadSeq`. This is the delivery substrate — the wake worker re-nudges
   * a member while it has unread mentions, and stops on ack.
   *
   * OPTIONAL for backward compat (additive field, `ChannelState.version`
   * stays 1): rows persisted before v2 lack it and are backfilled to the
   * channel HEAD at ChannelService construction ("start reading from now"),
   * NOT to 0 — a 0 default would mark the entire history unread on upgrade
   * and set off a re-nudge storm. Same rule at join/create seeding time.
   * Multiple panes acking the same (workspaceId, memberId) row = last-ack-wins
   * (documented v1 simplification).
   */
  lastReadSeq?: number;
  /**
   * R2 (Principal registry) — the stable coordinate of the principal this
   * member row points to (`pane:${workspaceId}/${paneId}` etc., see
   * shared/principals.ts). memberId (auto name) drifts on workspace reorder,
   * but this id is immutable for the pane's lifetime, so it is the key the
   * wake worker uses to look up ptyId directly from the registry.
   *
   * OPTIONAL additive (`ChannelState.version` stays 1, lastReadSeq
   * convention): absent on legacy rows and human (local-ui) rows, and when
   * absent it degrades safely to the existing heuristic path. Display/routing
   * only, not authz (#113 boundary invariant).
   */
  principalId?: string;
  /**
   * 1b (server-owned roster identity) — the display name the DAEMON derived
   * for this row at create/join/invite time: the principal registry's
   * `display` when `principalId` resolves, else the memberId itself. Post
   * renders `ChannelMessage.memberName` from THIS (the roster row), never
   * from the caller-supplied free text — a client can no longer post under
   * an arbitrary name once its row exists.
   *
   * OPTIONAL additive (`ChannelState.version` stays 1, lastReadSeq /
   * principalId convention): absent on legacy rows; the renderer's
   * authorDisplay fallback (1a) covers those. Display only, not authz.
   */
  memberName?: string;
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
  /**
   * R1 — the poster's own pane identity, stamped server-side from the caller's
   * verified `senderPtyId` (the daemon session id of the sending pane; the MCP
   * transport attaches it on every channel RPC, the daemon resolves it to a live
   * session before accepting the post). Used ONLY by the receiving renderer to
   * distinguish a true self-loop (an agent @-mentioning its OWN pane) from a
   * legitimate same-workspace SIBLING mention (pane1 → pane2). The receiver
   * resolves this ptyId to a pane in its own live leaves, exactly as it resolves
   * a mention's `ptyId`. Absent for a human/composer post (local-ui has no pane)
   * and for legacy pre-R1 messages — both degrade safely to "no self-pane known".
   */
  senderPtyId?: string;
  /**
   * 서버-발행 시스템 메시지 판별자 (operator-join 설계 §2.1.1). 존재하면 이 행은
   * 사용자가 작성한 일반 메시지가 아니라 데몬이 발행한 감사 흔적이다 — 렌더러는
   * `text`(영어 폴백) 대신 이 종류로 문구를 localize한다. 일반 메시지에는 부재
   * (additive 선택 필드, `ChannelState.version` 불변 — senderPtyId 관례와 동일).
   */
  systemKind?: ChannelSystemMessageKind;
}

/**
 * 서버-발행 시스템 메시지 종류 (operator-join 설계 §2.1.1). 채널 히스토리에 일반
 * 메시지와 동일한 영속 경로로 append되는 감사 메시지의 판별자다. additive-only:
 * 종류 추가만 허용(디스크 계약). 현재는 오퍼레이터(사람)가 비공개 채널에
 * operatorJoin했음을 알리는 한 종류뿐이며, 이 흔적은 내구 감사(leave 후에도 남음)
 * 이자 #113 잔여로 위조된 입장을 사람이 GUI에서 발견하게 하는 유일한 장치다.
 */
export type ChannelSystemMessageKind = 'operator-join';

/**
 * operator-join 시스템 메시지의 영어 폴백 본문. 렌더러는 `systemKind`로 판별해
 * i18n 문자열로 대체하므로, 이 텍스트는 비-GUI 소비자(CLI/로그/구 렌더러)용
 * 폴백일 뿐이다. `ChannelMessage.text`는 필수 필드라 값이 반드시 있어야 한다.
 */
export const OPERATOR_JOIN_SYSTEM_TEXT = 'Operator joined the channel.';

/**
 * operator-list 프로젝션 행 (operator-join 설계 §2.2) — 발견 어포던스가 반환하는
 * 채널 메타데이터만. 메시지 미리보기·멤버 상세 없음(내용을 읽으려면 operatorJoin
 * 해야 하고, 그건 서버-발행 시스템 메시지를 남긴다 §2.1.1). 데몬이 반환하고 렌더러
 * 오퍼레이터 섹션이 소비하므로 shared에 둔다.
 */
export interface OperatorChannelSummary {
  id: string;
  name: string;
  visibility: ChannelVisibility;
  status: ChannelStatus;
  memberCount: number;
  createdAt: number;
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

/**
 * P5 (unified human identity) — the VIRTUAL workspace that owns every human
 * membership row. The human is ONE principal, not one-per-workspace: joining
 * or creating a channel used to stamp whichever workspace happened to be
 * active (`(ws-X, 'local-ui')`), scattering "you" across rows and binding the
 * whole channel view to the active workspace. All human rows merge into
 * `(HUMAN_WORKSPACE_ID, HUMAN_MEMBER_ID)` at daemon load — deterministic and
 * crash-safe, the same contract as the lastReadSeq backfill. No collision is
 * possible: real workspace ids are `ws-<uuid>`.
 *
 * Trust: only the renderer-local mutate path (channels:mutate-local) may claim
 * this workspace id; a pipe caller asserting it is rejected — same class as
 * the 'local-ui' spoof guard (a2a.channel.rpc.ts).
 */
export const HUMAN_WORKSPACE_ID = 'ws-human';

/** The reserved human/GUI member id (one seat, app-wide). The pipe rejects it
 *  as a caller identity (a2a.channel.rpc.ts spoof guard); the renderer
 *  substitutes the localized "Me" at display time. Single source of truth —
 *  renderer modules and the daemon previously each carried their own copy. */
export const HUMAN_MEMBER_ID = 'local-ui';

/**
 * Channels schema epoch — the DAEMON-SIDE migration generation the current
 * renderer requires. The daemon reports it additively on the
 * `a2a.channel.list` response; the renderer compares on hydration and shows a
 * "restart wmux" banner when the value is missing/lower (a long-lived daemon
 * survives app upgrades by design, so a P5 renderer can find itself attached
 * to a pre-P5 daemon whose state still holds scattered per-workspace human
 * rows — posts would fail NOT_A_MEMBER with no explanation; ship review C1).
 * Bump ONLY when a new daemon load-time channel migration is a prerequisite
 * for renderer correctness.
 *
 * Epoch 1 = P5 unified human identity (ws-human row merge).
 */
export const CHANNELS_EPOCH = 1;

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
