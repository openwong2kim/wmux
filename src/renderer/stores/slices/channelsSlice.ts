// ─── A2A Channels renderer state ─────────────────────────────────────────
//
// Mirrors the daemon-side `ChannelState` in the renderer for the sidebar
// (U7) + composer (U8) + unread-badge surfaces.
//
// Two paths drive mutations:
//
//   1. Event-driven (the authoritative path): a
//      `useChannelsEventSubscription` hook (mounted in AppLayout, see
//      `src/renderer/hooks/useChannelsEventSubscription.ts`) runs an
//      `events.poll` loop scoped to `channel.message` and dispatches
//      `appendMessageFromEvent` for each event the daemon fans out to
//      the current workspace. Channel create/archive/join/leave surface
//      in the slice via the post-event refresh path — the daemon emits
//      the relevant channel lifecycle and the slice reads the result
//      back through `refreshChannels`.
//
//   2. User-initiated: the sidebar/composer calls the `*Daemon` thunks
//      (`createChannelDaemon` / `postMessageDaemon`) for round-tripping
//      to the daemon. The `*Daemon` thunks await the RPC result and,
//      on success, call the matching `*Optimistic` thunk to apply the
//      authoritative row to the local mirror. On failure, the `*Daemon`
//      thunk returns the structured `ChannelError` envelope without
//      mutating local state — the caller (sidebar/composer) branches on
//      `result.error.code` for the user-visible error branch. The
//      `*Optimistic` thunks stay as the state-mirror-only primitive for
//      callers that arrange the daemon round-trip out of band (tests,
//      out-of-band MCP flows).
//
// Why a separate `*Daemon` layer (vs. making `*Optimistic` async):
//   - The `*Optimistic` primitives stay synchronous so tests can drive
//     state without a bridge mock.
//   - The `*Daemon` thunks are the wire-path entry points; their job is
//     RPC + error-mapping, NOT state mutation. State mutation always
//     goes through `*Optimistic` for one source of truth.
//
// Bridge access: `useRpcBridge` installs `window.__wmuxChannelsRpc` on
// mount; the `*Daemon` thunks read it lazily (mirroring the
// `searchSlice.runSearch` pattern at `src/renderer/stores/slices/
// searchSlice.ts:122-130`). If the bridge isn't mounted, the thunk
// warns and returns an `UNKNOWN` error rather than throwing — the
// caller still gets a structured error to branch on.
//
// Per-recipient scoping: the event hook filters by `recipientWorkspaceIds`
// before dispatching, so `appendMessageFromEvent` can trust that the
// message belongs to the current workspace and never needs to re-check.
//
// Failure surfacing: every action that takes an external result accepts
// `{ ok, ... } | { ok: false, error }`. The slice never throws on a
// failed mutation; the caller is expected to branch on the structured
// `error.code` (PERSIST_FAILED on the post path is the U2 maintainer
// directive — surfaced verbatim, not swallowed).
//
// Plan reference: U4 (create/post wire-up), U6 (state mirror).

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type {
  Channel,
  ChannelDroppedMention,
  ChannelMember,
  ChannelMention,
  ChannelMessage,
  ChannelVisibility,
  OperatorChannelSummary,
} from '../../../shared/channels';
import { HUMAN_WORKSPACE_ID } from '../../../shared/channels';
import { panePrincipalId } from '../../../shared/principals';
import { computePaneAutoName } from '../../utils/paneNaming';
import { findLeafPanes } from '../../hooks/a2aAddressing';

/** R2 — principal upsert debounce cache (id → last sent signature + timestamp).
 *  Agent meta broadcasts are periodic, so when the content is unchanged the
 *  daemon round-trip is skipped. Module-level non-reactive state — losing it on
 *  a renderer restart is the correct behavior.
 *
 *  TTL (review C3): when the daemon restarts, every pane-agent in the registry
 *  is backfilled as stale, but this renderer-side cache survives. If a
 *  suspend→recovery reuses the same session id, the signature is identical, so
 *  the upsert is skipped forever and the principal stays stale for good (= the
 *  auto-name member never gets nudged). Expiring the cache by TTL makes a
 *  periodic broadcast re-register it within at most a minute and self-heal —
 *  the simplest form that gives the same guarantee without wiring up
 *  daemon-reconnect detection. */
const lastPrincipalUpsertSig = new Map<string, { sig: string; at: number }>();
const PRINCIPAL_UPSERT_TTL_MS = 60_000;

/** A19: per-channel render cap. `channelMessages` is otherwise append-only and
 *  unbounded — a busy channel would grow the store until the panel re-render +
 *  search scan freezes the UI. Keep the most recent N in the renderer mirror;
 *  older history stays durable in the daemon and is re-loadable via getMessages.
 *  Set above CHANNEL_HISTORY_LOAD_LIMIT (200) so a fresh hydrate never trims. */
const CHANNEL_MESSAGES_RENDER_CAP = 500;

/** Caller identity the slice carries in optimistic mutations. Mirrors
 *  the daemon's `Member` row (workspaceId + memberId + display name). */
export interface ChannelMemberAddress {
  workspaceId: string;
  memberId: string;
  memberName: string;
  /** R2 — stable principal coordinate recorded on the member row at explicit-join time (optional). */
  principalId?: string;
}

/** Params for `createChannelOptimistic`. The caller (sidebar/composer)
 *  is expected to have invoked `a2a.channel.create` out-of-band (via
 *  MCP or the bridge layer) and have the daemon's resolved channel on
 *  hand. The slice stores it and updates the local mirror. */
export interface ChannelCreateParams {
  name: string;
  visibility: ChannelVisibility;
  topic?: string;
  createdBy: ChannelMemberAddress;
  /** The daemon's authoritative row after create. */
  channel: Channel;
}

/** Params for `postMessageOptimistic`. `clientMsgId` is the optional
 *  idempotency key (R13) — the daemon returns the original `seq` on a
 *  repeat hit instead of appending a duplicate. */
export interface ChannelPostParams {
  text: string;
  sender: ChannelMemberAddress;
  clientMsgId?: string;
  data?: unknown;
  /** @-mentions selected in the composer. Forwarded to the daemon, which
   *  re-validates them against current membership (the server is the source
   *  of truth — a forged/stale mention is dropped there). The optimistic row
   *  carries them only so the local insert renders the @tokens immediately. */
  mentions?: ChannelMention[];
  /** The daemon's authoritative message after post. */
  message: ChannelMessage;
}

/** Structured error envelope mirrored from `ChannelService`. Codes follow
 *  plan KTD-F. Kept as a literal union so callers can switch on `code`
 *  exhaustively. */
export interface ChannelError {
  code:
    | 'INVALID_NAME'
    | 'CHANNEL_NOT_FOUND'
    | 'CHANNEL_ARCHIVED'
    | 'NOT_A_MEMBER'
    | 'DUPLICATE_MEMBER'
    | 'PERSIST_FAILED'
    | 'ALREADY_EXISTS'
    | 'NOT_AUTHORIZED'
    | 'UNKNOWN';
  message: string;
}

/** Result envelope shared by every user-initiated action. */
export type ChannelActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ChannelError };

/**
 * Slice state:
 *  - `channels` is the renderer's mirror of the channel catalog.
 *  - `channelMembers` is keyed by channelId for O(1) sidebar lookups.
 *  - `channelMessages` is keyed by channelId; the per-channel array is
 *    append-only from the renderer's POV (the daemon is authoritative
 *    on ordering — see plan KTD2).
 *  - `activeChannelId` drives the channel view (U8). Setting it also
 *    marks the channel read (clear unread badge).
 *  - `channelUnread` counts messages appended while the channel was
 *    not active. Cleared by `markChannelRead` / `setActiveChannel`.
 */
export interface ChannelsSlice {
  channels: Record<string, Channel>;
  channelMembers: Record<string, ChannelMember[]>;
  channelMessages: Record<string, ChannelMessage[]>;
  activeChannelId: string | null;
  channelUnread: Record<string, number>;
  /** Per-channel count of unseen messages that @-mention THIS renderer's
   *  workspace — a strict subset of `channelUnread`, surfaced as a stronger
   *  dock badge. Cleared with unread by `markChannelRead` / `setActiveChannel`. */
  channelMentions: Record<string, number>;
  /**
   * C-2 — channelId → memberId → epoch ms of the last `channel.nudgeExhausted`
   * for that member. The wake worker fires it when a mention episode burns its
   * re-nudge budget: the bytes were written, nobody acted, and a human has to
   * look. It is the one delivery outcome `recipientSnapshot` cannot express, so
   * the sender's message row reads it to stop claiming "delivered".
   *
   * Cleared when that member finally posts in the channel (the episode is over
   * by demonstration, not by inference).
   */
  channelNudgeExhausted: Record<string, Record<string, number>>;
  markChannelNudgeExhausted: (channelId: string, memberId: string, at: number) => void;
  /** Ship review C1 — true when the attached daemon reported a channels epoch
   *  older than this renderer requires (a long-lived pre-P5 daemon survived the
   *  app upgrade). Drives the "restart wmux" banner in ChannelsPanel; set from
   *  hydration on every (re)connect, so it self-clears after a daemon restart. */
  channelsDaemonStale: boolean;
  setChannelsDaemonStale: (stale: boolean) => void;

  // ── User-initiated actions (optimistic local mutations) ─────────
  // Each action takes the daemon-resolved result as a parameter so the
  // slice can apply the authoritative row without a daemon round-trip
  // of its own. The caller (sidebar/composer) is responsible for
  // invoking the underlying `a2a.channel.*` RPC through whichever
  // bridge layer it owns (MCP tool, IPC bridge, or direct daemon call
  // when running inside the bundled MCP server).
  setActiveChannel: (channelId: string | null) => void;
  createChannelOptimistic: (
    params: ChannelCreateParams,
  ) => ChannelActionResult<Channel>;
  postMessageOptimistic: (
    channelId: string,
    params: ChannelPostParams,
  ) => ChannelActionResult<ChannelMessage>;
  joinChannelOptimistic: (
    channelId: string,
    member: ChannelMemberAddress,
    workspaceId: string,
  ) => ChannelActionResult<Record<string, never>>;
  leaveChannelOptimistic: (
    channelId: string,
    memberId: string,
    workspaceId: string,
  ) => ChannelActionResult<Record<string, never>>;
  // Kick removes a SPECIFIC other member — matches BOTH workspace + member so a
  // same-memberId row in a different workspace is never evicted by mistake.
  kickChannelOptimistic: (
    channelId: string,
    targetMemberId: string,
    targetWorkspaceId: string,
  ) => ChannelActionResult<Record<string, never>>;
  archiveChannelOptimistic: (
    channelId: string,
    archivedChannel: Channel,
  ) => ChannelActionResult<Channel>;

  // ── Wire-path entry points (U4, R4 + R11) ────────────────────────
  // The `*Daemon` thunks wrap the bridge RPC, await the daemon's
  // response, and apply the matching `*Optimistic` thunk on success.
  // On RPC failure or daemon-side error they return the structured
  // `ChannelError` envelope (no throw) so the caller (sidebar/
  // composer) can branch on `result.error.code`. They never mutate
  // state on failure — the local mirror only advances when the
  // daemon has the authoritative row in hand.
  createChannelDaemon: (
    params: ChannelCreateParams,
  ) => Promise<ChannelActionResult<Channel>>;
  // A6: the success branch carries the daemon's `droppedMentions` (non-member
  // @mentions that did not land) so the composer can warn the sender instead of
  // discarding the feedback — a strict superset of ChannelActionResult, so
  // existing callers that only read `value` are unaffected.
  postMessageDaemon: (
    channelId: string,
    params: ChannelPostParams,
  ) => Promise<
    | { ok: true; value: ChannelMessage; droppedMentions?: ChannelDroppedMention[] }
    | { ok: false; error: ChannelError }
  >;
  // Membership (channel members roster UX). join adds `member` pinned to
  // `workspaceId`; leave is SELF-ONLY (you can leave, not eject) so it takes
  // just the memberId + the caller's own workspaceId — the daemon's leave()
  // matches `m.workspaceId === verifiedWorkspaceId`, so workspaceId IS the
  // verified self.
  joinChannelDaemon: (
    channelId: string,
    member: ChannelMemberAddress,
    workspaceId: string,
  ) => Promise<ChannelActionResult<Record<string, never>>>;
  // Invite ANOTHER workspace (P1b). The inviter (`inviterWorkspaceId`) must be
  // a current member; the daemon adds `invitedMember` (NOT self-pinned). This is
  // the only way into a private channel. Any member may invite (daemon authz).
  inviteChannelDaemon: (
    channelId: string,
    invitedMember: ChannelMemberAddress,
    inviterWorkspaceId: string,
  ) => Promise<ChannelActionResult<Record<string, never>>>;
  leaveChannelDaemon: (
    channelId: string,
    memberId: string,
    workspaceId: string,
  ) => Promise<ChannelActionResult<Record<string, never>>>;
  // Eject ANOTHER member (HUMANS-ONLY). `callerWorkspaceId` is the verified human
  // performing the kick; `target*` identify the member row to remove. Unlike leave
  // (self-only), kick removes a different member — gated NOT by daemon authz but by
  // TRANSPORT: it rides the renderer-only mutateLocal path, unreachable from agents.
  kickChannelDaemon: (
    channelId: string,
    targetMemberId: string,
    targetWorkspaceId: string,
    callerWorkspaceId: string,
  ) => Promise<ChannelActionResult<Record<string, never>>>;
  // Archive a channel (one-way; read-only thereafter). Creator-only by the
  // daemon's authz gate; `workspaceId` is the verified caller (the renderer's
  // self). The daemon returns an empty result, so the thunk synthesizes the
  // archived row for `archiveChannelOptimistic` — best-effort until the next
  // catalog refresh corrects `archivedAt`.
  archiveChannelDaemon: (
    channelId: string,
    workspaceId: string,
  ) => Promise<ChannelActionResult<Channel>>;
  // Trash lifecycle (HUMANS-ONLY, mutateLocal like archive/kick). `trash` hides
  // the channel from the lists and starts the retention clock; `restore` puts it
  // back in the archived group; `destroy` deletes it for good and is refused
  // daemon-side unless the channel is already in the trash. All three return the
  // daemon's empty result, so the thunks patch the mirror row themselves — the
  // next catalog refresh replaces the synthesized values with the persisted ones.
  trashChannelDaemon: (
    channelId: string,
    workspaceId: string,
  ) => Promise<ChannelActionResult<Channel>>;
  restoreChannelDaemon: (
    channelId: string,
    workspaceId: string,
  ) => Promise<ChannelActionResult<Channel>>;
  destroyChannelDaemon: (
    channelId: string,
    workspaceId: string,
  ) => Promise<ChannelActionResult<Record<string, never>>>;

  // ── operator-join (설계 §2.1/§2.2) — humans-only 발견 + 자가 입장 ────────────
  /** 발견 어포던스: 전 채널(공개+비공개, active+archived)의 메타데이터만 가져온다.
   *  private 채널은 list()에서 비멤버에게 숨겨지므로 오퍼레이터 섹션이 "들어갈 수
   *  있는 방"을 보여주려면 이 목록이 필요하다. 읽기지만 humans-only 트랜스포트
   *  (mutateLocal)로만 도달한다(§2.2). 실패 시 빈 배열 + 콘솔 경고(비파괴적 조회). */
  operatorListDaemon: (workspaceId: string) => Promise<OperatorChannelSummary[]>;
  /** 오퍼레이터(사람)가 비공개 채널에 스스로 들어간다(§2.1). 성공 시 데몬이 사람
   *  좌석을 심고 서버-발행 시스템 메시지를 남긴다(§2.1.1). 채널 행은 지금까지
   *  private+비멤버라 미러에 없었을 수 있으므로, 성공만 신호하고 새로 보이게 된
   *  채널 행 재동기는 호출자의 카탈로그 재-hydrate(+ membership 이벤트)에 맡긴다. */
  operatorJoinDaemon: (
    channelId: string,
  ) => Promise<ChannelActionResult<Record<string, never>>>;

  // ── R2: Principal registry / system cleanup (renderer-only, fire-and-forget) ──
  // All take the same humans-only mutateLocal path as kick. Failures are left as
  // warn logs only: cleanup is idempotent, so it converges at the next
  // opportunity (re-delete, daemon-restart stale backfill, TTL reaper), and
  // there is no reason to block the UI flow.

  /** On workspace/pane deletion, clean up dead member rows across all channels.
   *  With principalId, only that pane's row (stable-coordinate match — immune to
   *  auto name drift); with only memberId, only that row; with neither, the whole
   *  workspace. Cleans the optimistic mirror, then calls the daemon. */
  purgeMembershipDaemon: (target: {
    workspaceId: string;
    memberId?: string;
    principalId?: string;
  }) => Promise<void>;
  /** At agent detection (setSurfaceAgent), register/refresh that pty's pane as a
   *  principal. When the content is unchanged the debounce cache skips the daemon round-trip. */
  principalRegisterPane: (ptyId: string) => Promise<void>;
  /** Pane closed — remove the principal whose coordinate is gone from the registry. */
  principalRemoveDaemon: (principalId: string) => Promise<void>;
  /** Workspace deleted — mark every pane-agent principal inside it as stale. */
  principalMarkStaleWorkspaceDaemon: (workspaceId: string) => Promise<void>;

  // Internal helpers — exposed on the slice so the `*Daemon` thunks
  // can call them via `get()`, and so tests can drive the bridge-
  // mount and error-mapping paths directly without re-implementing
  // the same shape guard.
  channelsRpc: () =>
    | {
        rpc: (
          method: string,
          params: Record<string, unknown>,
        ) => Promise<unknown>;
        mutateLocal: (
          method: string,
          params: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    | undefined;
  mapRpcError: (raw: unknown, fallbackMessage: string) => ChannelError;

  // ── Catalog refresh (called on mount + after lifecycle events) ──
  setChannels: (
    channels: Channel[],
    members: Record<string, ChannelMember[]>,
  ) => void;

  // ── Event-driven actions (dispatched from the subscription hook) ─
  markChannelRead: (channelId: string) => void;
  appendMessageFromEvent: (message: ChannelMessage) => void;
  /** Hydrate a channel's message history (P0). Merges the daemon's
   *  `getMessages` result with any live/optimistic rows already in the
   *  store, deduped by `seq` (existing rows win — a live event may carry a
   *  fresher delivery snapshot than the persisted history row). Result is
   *  sorted by `seq`. Does NOT touch `channelUnread` — loading history is
   *  not new unread. */
  hydrateChannelMessages: (channelId: string, messages: ChannelMessage[]) => void;
}

/**
 * Review fix (C-2) — expire the exhausted-nudge flags a roster refresh settles.
 *
 * An entry is a claim that ONE member never answered. It survives only while
 * that stays true, so it is dropped when the member's read cursor advances (it
 * caught up), when the member leaves the roster, or when the channel leaves the
 * catalog. Compares the INCOMING roster against the one still in state, so it
 * must run before `state.channelMembers` is overwritten.
 */
function clearSettledNudgeExhausted(
  state: StoreState,
  incoming: Record<string, ChannelMember[]>,
  liveChannelIds: ReadonlySet<string>,
): void {
  for (const channelId of Object.keys(state.channelNudgeExhausted)) {
    if (!liveChannelIds.has(channelId)) {
      delete state.channelNudgeExhausted[channelId];
      continue;
    }
    const entry = state.channelNudgeExhausted[channelId];
    const before = new Map(
      (state.channelMembers[channelId] ?? []).map((m) => [m.memberId, m.lastReadSeq]),
    );
    const live = new Set((incoming[channelId] ?? []).map((m) => m.memberId));
    for (const memberId of Object.keys(entry)) {
      if (!live.has(memberId)) {
        delete entry[memberId];
        continue;
      }
      const row = (incoming[channelId] ?? []).find((m) => m.memberId === memberId);
      const prev = before.get(memberId);
      const nextSeq = row?.lastReadSeq;
      if (typeof nextSeq === 'number' && (typeof prev !== 'number' || nextSeq > prev)) {
        delete entry[memberId];
      }
    }
    if (Object.keys(entry).length === 0) delete state.channelNudgeExhausted[channelId];
  }
}

export const createChannelsSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  ChannelsSlice
> = (set, get) => ({
  channels: {},
  channelMembers: {},
  channelMessages: {},
  activeChannelId: null,
  channelUnread: {},
  channelMentions: {},
  channelNudgeExhausted: {},
  channelsDaemonStale: false,

  markChannelNudgeExhausted: (channelId, memberId, at) =>
    set((state: StoreState) => {
      const forChannel = state.channelNudgeExhausted[channelId] ?? {};
      state.channelNudgeExhausted[channelId] = { ...forChannel, [memberId]: at };
    }),

  setChannelsDaemonStale: (stale) =>
    set((state: StoreState) => {
      state.channelsDaemonStale = stale;
    }),

  setActiveChannel: (channelId) =>
    set((state: StoreState) => {
      state.activeChannelId = channelId;
      // Switching active channel clears the unread badge immediately —
      // the channel view (U8) will render the messages regardless of
      // unread count. Keeping the badge and the active state in sync
      // here means a single source of truth (no double-bookkeeping).
      if (channelId !== null) {
        state.channelUnread[channelId] = 0;
        state.channelMentions[channelId] = 0;
        // Auto-open the right channel dock so clicking a channel reveals the
        // conversation (the dock is collapsed by default — uiSlice).
        state.channelDockVisible = true;
      }
    }),

  markChannelRead: (channelId) =>
    set((state: StoreState) => {
      state.channelUnread[channelId] = 0;
      state.channelMentions[channelId] = 0;
    }),

  setChannels: (channels, members) =>
    set((state: StoreState) => {
      const next: Record<string, Channel> = {};
      const liveIds = new Set<string>();
      for (const ch of channels) {
        next[ch.id] = ch;
        liveIds.add(ch.id);
        // Preserve any messages we've already accumulated locally for
        // this channel. If the daemon truncated (very rare — only on
        // a future migration), the local copy is at least a
        // best-effort cache until the next event arrives.
        if (!state.channelMessages[ch.id]) {
          state.channelMessages[ch.id] = [];
        }
      }
      // Review fix (C-2): an exhausted-nudge flag is a claim that a member
      // never answered. It must expire the moment that member demonstrably
      // caught up — its read cursor advanced — or a single burnt nudge episode
      // marks the sender's rows "no answer" for the life of the channel.
      // `setChannels` is the authoritative roster refresh, so it is where the
      // previous cursor and the new one can be compared.
      clearSettledNudgeExhausted(state, members, liveIds);
      state.channels = next;
      state.channelMembers = members;
      // A19: drop caches for channels no longer in the catalog (archived out of
      // view, a private channel we were removed from, etc.) — channelMessages was
      // otherwise append-only and leaked these forever. setChannels is the
      // authoritative catalog refresh, so a channel absent here is gone for us.
      for (const id of Object.keys(state.channelMessages)) {
        if (!liveIds.has(id)) delete state.channelMessages[id];
      }
      for (const id of Object.keys(state.channelUnread)) {
        if (!liveIds.has(id)) delete state.channelUnread[id];
      }
      for (const id of Object.keys(state.channelMentions)) {
        if (!liveIds.has(id)) delete state.channelMentions[id];
      }
    }),

  createChannelOptimistic: (params) => {
    set((state: StoreState) => {
      state.channels[params.channel.id] = params.channel;
      // Auto-membership: the daemon adds the creator as a member
      // (KTD10). Seed an optimistic entry so the sidebar can show the
      // new channel immediately; the next refresh reconciles against
      // the authoritative `members` record.
      const existing = state.channelMembers[params.channel.id] ?? [];
      const already = existing.some(
        (m) => m.memberId === params.createdBy.memberId,
      );
      if (!already) {
        state.channelMembers[params.channel.id] = [
          ...existing,
          {
            workspaceId: params.createdBy.workspaceId,
            memberId: params.createdBy.memberId,
            joinedAt: Date.now(),
            historyFromSeq: 0,
          },
        ];
      }
      if (!state.channelMessages[params.channel.id]) {
        state.channelMessages[params.channel.id] = [];
      }
    });
    return { ok: true, value: params.channel };
  },

  postMessageOptimistic: (channelId, params) => {
    set((state: StoreState) => {
      const list = state.channelMessages[channelId] ?? [];
      const existing = list.find((m) => m.seq === params.message.seq);
      if (!existing) {
        // A19: cap the optimistic append too — the event-driven path
        // (appendMessageFromEvent) trims, but a user posting repeatedly through
        // postMessageDaemon → here would otherwise grow the mirror unbounded
        // until a hydrate/resync (CodeRabbit). Older rows stay durable in the daemon.
        const appended = [...list, params.message];
        state.channelMessages[channelId] =
          appended.length > CHANNEL_MESSAGES_RENDER_CAP
            ? appended.slice(appended.length - CHANNEL_MESSAGES_RENDER_CAP)
            : appended;
        if (state.activeChannelId !== channelId) {
          state.channelUnread[channelId] =
            (state.channelUnread[channelId] ?? 0) + 1;
        }
      }
      // Dedup case: message already present (the event arrived first,
      // or a prior optimistic post with the same seq). Drop the
      // second bump — the existing row was already counted.
    });
    return { ok: true, value: params.message };
  },

  joinChannelOptimistic: (channelId, member, workspaceId) => {
    set((state: StoreState) => {
      const existing = state.channelMembers[channelId] ?? [];
      // Dedup on (workspaceId, memberId) — the SAME composite key the daemon
      // uses (ChannelService.join). The in-app roster reuses a single constant
      // memberId (UI_MEMBER_ID) for every workspace it adds, so keying on
      // memberId alone collapses distinct workspaces: the creator already holds
      // UI_MEMBER_ID, so the first "Add a workspace" looked like a duplicate and
      // the new member never appeared in the roster (daemon added it; UI didn't).
      const already = existing.some(
        (m) => m.workspaceId === workspaceId && m.memberId === member.memberId,
      );
      if (!already) {
        state.channelMembers[channelId] = [
          ...existing,
          {
            workspaceId,
            memberId: member.memberId,
            joinedAt: Date.now(),
            historyFromSeq: 0,
            // R2: carry the explicit-join's stable coordinate into the mirror too,
            // so the roster liveness badge can be computed immediately, even before
            // the next catalog sync.
            ...(member.principalId ? { principalId: member.principalId } : {}),
          },
        ];
      }
      if (!state.channelMessages[channelId]) {
        state.channelMessages[channelId] = [];
      }
    });
    return { ok: true, value: {} as Record<string, never> };
  },

  leaveChannelOptimistic: (channelId, memberId, workspaceId) => {
    set((state: StoreState) => {
      const list = state.channelMembers[channelId] ?? [];
      // A7: match the composite (workspaceId, memberId) key — join/kick already
      // do. Every in-app UI member shares one `local-ui` memberId, so a
      // memberId-only filter wiped OTHER workspaces' rows on a leave, desyncing
      // the mirror from the daemon (which removes only the caller's own row).
      state.channelMembers[channelId] = list.filter(
        (m) => !(m.memberId === memberId && m.workspaceId === workspaceId),
      );
      // We are out of the room: there is no sender-side row left to annotate.
      delete state.channelNudgeExhausted[channelId];
    });
    return { ok: true, value: {} as Record<string, never> };
  },

  kickChannelOptimistic: (channelId, targetMemberId, targetWorkspaceId) => {
    set((state: StoreState) => {
      const list = state.channelMembers[channelId] ?? [];
      // Remove the EXACT (workspace, member) row — unlike leave (memberId only),
      // kick targets a specific OTHER member, so match both keys to avoid evicting
      // a same-memberId row that belongs to a different workspace.
      state.channelMembers[channelId] = list.filter(
        (m) => !(m.workspaceId === targetWorkspaceId && m.memberId === targetMemberId),
      );
      // The member is gone — a "no answer" claim about it is now unfalsifiable.
      if (state.channelNudgeExhausted[channelId]) {
        delete state.channelNudgeExhausted[channelId][targetMemberId];
      }
    });
    return { ok: true, value: {} as Record<string, never> };
  },

  archiveChannelOptimistic: (channelId, archivedChannel) => {
    set((state: StoreState) => {
      // The archived row carries `status: 'archived'` and `archivedAt`.
      // Overwrite the catalog row — the daemon is authoritative; the
      // optimistic update is best-effort until the next refresh.
      state.channels[channelId] = archivedChannel;
      // Nobody will be nudged in an archived channel, so a pending "no answer"
      // claim about it can never be resolved. Drop it with the channel.
      delete state.channelNudgeExhausted[channelId];
    });
    return { ok: true, value: archivedChannel };
  },

  appendMessageFromEvent: (message) =>
    set((state: StoreState) => {
      const channelId = message.channelId;
      const list = state.channelMessages[channelId] ?? [];
      // Dedup by seq — the optimistic append in `postMessageOptimistic`
      // may have already inserted this row. Same seq means same message;
      // any divergence (text drift, recipient snapshot) is the event's
      // authoritative version, so overwrite when colliding. The unread
      // counter must NOT double-bump in that case — the optimistic
      // append already counted the message, and the event is just
      // catching us up to the authoritative payload.
      const idx = list.findIndex((m) => m.seq === message.seq);
      const isNew = idx === -1;
      // C-2: the member answered, so its exhausted-nudge episode is over. Cleared
      // on demonstration (a post from that member), never on a timer — a stale
      // "no answer" badge is exactly the false receipt this row exists to kill.
      if (state.channelNudgeExhausted[channelId]?.[message.memberId] !== undefined) {
        const { [message.memberId]: _cleared, ...rest } = state.channelNudgeExhausted[channelId];
        state.channelNudgeExhausted[channelId] = rest;
      }
      if (isNew) {
        // A19: cap the per-channel render mirror so a busy channel can't grow the
        // store unbounded (older rows stay durable in the daemon).
        const appended = [...list, message];
        state.channelMessages[channelId] =
          appended.length > CHANNEL_MESSAGES_RENDER_CAP
            ? appended.slice(appended.length - CHANNEL_MESSAGES_RENDER_CAP)
            : appended;
      } else {
        const next = list.slice();
        next[idx] = message;
        state.channelMessages[channelId] = next;
      }
      // P5: `self` = the unified human seat — the human's own posts are muted;
      // agent posts (any workspace, incl. the active one) DO count as unread
      // now, which is the honest badge (they are news to the human).
      const selfWs = HUMAN_WORKSPACE_ID;
      if (isNew && state.activeChannelId !== channelId) {
        // A6 self-mute (unread): a workspace's OWN posts must not badge it as
        // unread. A composer post never bumps unread anyway (the activeChannelId
        // check above — the composer always posts to the active channel), but an
        // MCP/agent post has NO optimistic row and arrives only as an event, so
        // without this guard an agent posting via the API would see its own
        // message as unread noise. TRADEOFF (ws-level unread limit): in a
        // single-ws multi-agent setup a SIBLING pane's post is also muted here —
        // pane-level unread would distinguish them, but the badge is ws-scoped.
        if (message.workspaceId !== selfWs) {
          state.channelUnread[channelId] =
            (state.channelUnread[channelId] ?? 0) + 1;
        }
        // The @mention badge is evaluated INDEPENDENTLY of the self-mute (GLM
        // review P2): being mentioned is a real signal even from a same-ws
        // sender (pane A @-mentions sibling pane B), so a self-ws mention bumps
        // the stronger red @ badge regardless of who sent it.
        if (selfWs && message.mentions?.some((mn) => mn.workspaceId === selfWs)) {
          state.channelMentions[channelId] =
            (state.channelMentions[channelId] ?? 0) + 1;
        }
      }
    }),

  hydrateChannelMessages: (channelId, messages) =>
    set((state: StoreState) => {
      const existing = state.channelMessages[channelId] ?? [];
      // Merge history (from getMessages) with whatever live/optimistic rows
      // are already in the store, deduped by seq. Seed with history first, then
      // overlay `existing` so a live event row generally WINS on a seq collision
      // (it may carry a fresher payload than the persisted row).
      //
      // A8 exception: deliveryStatus/recipientSnapshot only advance via `ack`,
      // which emits NO event — so the live row's status can be a STALE 'pending'
      // while the persisted history row already reads 'delivered'. On a collision
      // we therefore adopt the higher-information delivery status (delivered beats
      // pending) from the fetched row, keeping the live row otherwise. Without
      // this, reopening a channel left deliveryStatus stuck at pending forever
      // (the "make deliveryStatus real" feature silently no-op'd on reopen).
      const bySeq = new Map<number, ChannelMessage>();
      for (const m of messages) bySeq.set(m.seq, m);
      for (const m of existing) {
        const fetched = bySeq.get(m.seq);
        // Only promote pending→delivered. A live `target_gone` row (delivery
        // failed / dead PTY) is HIGHER information than a stale persisted
        // `delivered`, so it must NOT be promoted — promoting it would disguise a
        // failure as success and overwrite recipientSnapshot with stale data
        // (GLM P2). The live row wins in that case.
        if (fetched && m.deliveryStatus === 'pending' && fetched.deliveryStatus === 'delivered') {
          bySeq.set(m.seq, {
            ...m,
            deliveryStatus: fetched.deliveryStatus,
            ...(fetched.recipientSnapshot ? { recipientSnapshot: fetched.recipientSnapshot } : {}),
          });
        } else {
          bySeq.set(m.seq, m);
        }
      }
      // A19: cap the merged mirror (keep the most recent N).
      const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
      state.channelMessages[channelId] =
        merged.length > CHANNEL_MESSAGES_RENDER_CAP
          ? merged.slice(merged.length - CHANNEL_MESSAGES_RENDER_CAP)
          : merged;
      // channelUnread is intentionally NOT touched — loading history is not
      // "new unread" (P0). Only live appends (appendMessageFromEvent /
      // postMessageOptimistic) bump the badge.
    }),

  // ── *Daemon thunks (U4) — wire-path entry points ───────────────────

  // ── R2: Principal registry / system cleanup implementation ────────────

  purgeMembershipDaemon: async (target) => {
    // Clean the optimistic mirror — the daemon's catalog (membership) event re-syncs the source of truth.
    set((state: StoreState) => {
      for (const chId of Object.keys(state.channelMembers)) {
        state.channelMembers[chId] = (state.channelMembers[chId] ?? []).filter(
          (m) =>
            !(
              m.workspaceId === target.workspaceId &&
              (target.principalId !== undefined
                ? m.principalId === target.principalId
                : target.memberId === undefined || m.memberId === target.memberId)
            ),
        );
        // A purged member cannot answer and cannot be nudged again: keeping its
        // exhausted flag would freeze "no answer" on the sender's rows forever.
        const exhausted = state.channelNudgeExhausted[chId];
        if (!exhausted) continue;
        const live = new Set(state.channelMembers[chId].map((m) => m.memberId));
        for (const memberId of Object.keys(exhausted)) {
          if (!live.has(memberId)) delete exhausted[memberId];
        }
      }
    });
    const bridge = get().channelsRpc();
    const self = get().activeWorkspaceId || get().workspaces[0]?.id || '';
    if (!bridge || !self) return;
    try {
      await bridge.mutateLocal('a2a.channel.purgeMembership', {
        workspaceId: target.workspaceId,
        ...(target.memberId !== undefined ? { memberId: target.memberId } : {}),
        ...(target.principalId !== undefined ? { principalId: target.principalId } : {}),
        verifiedWorkspaceId: self,
      });
    } catch (err) {
      console.warn('[channelsSlice] purgeMembership failed:', err);
    }
  },

  principalRegisterPane: async (ptyId) => {
    const s = get();
    const agent = s.surfaceAgent[ptyId];
    if (!agent?.name) return; // pty with no identity — nothing to register
    for (const w of s.workspaces) {
      for (const leaf of findLeafPanes(w.rootPane)) {
        if (!leaf.surfaces.some((sf) => sf.surfaceType !== 'browser' && sf.ptyId === ptyId)) {
          continue;
        }
        const autoName = computePaneAutoName(w.wsOrdinal ?? 0, leaf.ordinal ?? 0, agent.slug);
        const record = {
          id: panePrincipalId(w.id, leaf.id),
          kind: 'pane-agent' as const,
          display: autoName,
          // an attached claude pane is woken by the renderer hook (mention→a2a task),
          // other agents by the wake worker's PTY nudge (architecture §4).
          reachability: agent.slug === 'claude' ? ('renderer-hook' as const) : ('pty-nudge' as const),
          workspaceId: w.id,
          paneId: leaf.id,
          ptyId,
          memberId: autoName,
          ...(agent.slug ? { agentSlug: agent.slug } : {}),
        };
        const sig = JSON.stringify(record);
        const cached = lastPrincipalUpsertSig.get(record.id);
        if (cached && cached.sig === sig && Date.now() - cached.at < PRINCIPAL_UPSERT_TTL_MS) {
          return;
        }
        const bridge = s.channelsRpc();
        const self = s.activeWorkspaceId || s.workspaces[0]?.id || '';
        if (!bridge || !self) return;
        try {
          await bridge.mutateLocal('a2a.principal.upsert', {
            record,
            verifiedWorkspaceId: self,
          });
          lastPrincipalUpsertSig.set(record.id, { sig, at: Date.now() });
        } catch (err) {
          console.warn('[channelsSlice] principal upsert failed:', err);
        }
        return;
      }
    }
  },

  principalRemoveDaemon: async (principalId) => {
    lastPrincipalUpsertSig.delete(principalId);
    const bridge = get().channelsRpc();
    const self = get().activeWorkspaceId || get().workspaces[0]?.id || '';
    if (!bridge || !self) return;
    try {
      await bridge.mutateLocal('a2a.principal.remove', {
        principalId,
        verifiedWorkspaceId: self,
      });
    } catch (err) {
      console.warn('[channelsSlice] principal remove failed:', err);
    }
  },

  principalMarkStaleWorkspaceDaemon: async (workspaceId) => {
    // Clear the debounce cache for that workspace's coordinates — so if the same
    // coordinate reappears (rare, id reuse) it is guaranteed to be re-sent.
    for (const id of lastPrincipalUpsertSig.keys()) {
      if (id.startsWith(`pane:${workspaceId}/`)) lastPrincipalUpsertSig.delete(id);
    }
    const bridge = get().channelsRpc();
    const self = get().activeWorkspaceId || get().workspaces[0]?.id || '';
    if (!bridge || !self) return;
    try {
      await bridge.mutateLocal('a2a.principal.markStaleWorkspace', {
        workspaceId,
        verifiedWorkspaceId: self,
      });
    } catch (err) {
      console.warn('[channelsSlice] principal markStaleWorkspace failed:', err);
    }
  },

  /** Bridge accessor. Returns the global installed by `useRpcBridge`,
   *  or `undefined` if the hook hasn't mounted yet. Mirrors
   *  `searchSlice.runSearch`'s bridge-missing handling. */
  channelsRpc(): {
    rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    mutateLocal: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  } | undefined {
    return (window as unknown as {
      __wmuxChannelsRpc?: {
        rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
        mutateLocal: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      };
    }).__wmuxChannelsRpc;
  },

  /** Map a raw RPC result to the renderer's `ChannelError` envelope.
   *  The daemon's `Result<T>` shape is `{ ok: true, ... } | { ok: false, error }`,
   *  where `error: { code: ChannelErrorCode, message: string }`. Codes
   *  the renderer doesn't know are bucketed as `UNKNOWN` so callers
   *  can switch exhaustively without a runtime type guard at the call
   *  site (U6 expands the union; new codes automatically get bucketed
   *  to `UNKNOWN` until the union is widened). */
  mapRpcError(raw: unknown, fallbackMessage: string): ChannelError {
    if (
      raw !== null &&
      typeof raw === 'object' &&
      'ok' in raw &&
      (raw as { ok: unknown }).ok === false &&
      'error' in raw
    ) {
      const err = (raw as { error: unknown }).error;
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        typeof (err as { code: unknown }).code === 'string'
      ) {
        const code = (err as { code: string }).code;
        const message =
          'message' in err && typeof (err as { message: unknown }).message === 'string'
            ? (err as { message: string }).message
            : fallbackMessage;
        // Restrict the code to the renderer's known union. Codes the
        // renderer doesn't model (e.g. NOT_A_MEMBER pre-U6, or future
        // NOT_AUTHORIZED post-U5) are bucketed to UNKNOWN so the
        // caller's switch remains exhaustive — the original `code`
        // value travels in the `message` so the user-facing toast
        // still surfaces the daemon's reason verbatim.
        const KNOWN_CODES: ReadonlySet<ChannelError['code']> = new Set([
          'INVALID_NAME',
          'CHANNEL_NOT_FOUND',
          'CHANNEL_ARCHIVED',
          'NOT_A_MEMBER',
          'PERSIST_FAILED',
          'ALREADY_EXISTS',
          // B5/archive: kick + archive surface NOT_AUTHORIZED (non-member kick,
          // non-creator archive). Model it so the toast shows the real reason
          // instead of bucketing to UNKNOWN with the code mangled into the text.
          'NOT_AUTHORIZED',
          // 6g2: join + operatorJoin branch on "already a member" for a benign
          // info toast. Modeled so callers can test `.code` — the previous
          // behavior (UNKNOWN bucket with the code prepended to the message)
          // made that branch depend on a message-substring accident.
          'DUPLICATE_MEMBER',
          'UNKNOWN',
        ]);
        if (KNOWN_CODES.has(code as ChannelError['code'])) {
          return { code: code as ChannelError['code'], message };
        }
        return { code: 'UNKNOWN', message: `${code}: ${message}` };
      }
    }
    return { code: 'UNKNOWN', message: fallbackMessage };
  },

  createChannelDaemon: async (params) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn(
        '[channelsSlice] createChannelDaemon invoked before bridge mounted — call ignored',
      );
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    let raw: unknown;
    try {
      // D5: route the renderer-only mutation IPC. `verifiedWorkspaceId` is the
      // creator's own workspace (the human/CEO surface that owns this UI);
      // main trusts it by the process boundary and the daemon pins
      // `createdBy` to it. The pipe `a2a.channel.create` would fail this
      // closed (no senderPtyId).
      raw = await bridge.mutateLocal('a2a.channel.create', {
        name: params.name,
        visibility: params.visibility,
        topic: params.topic,
        createdBy: params.createdBy,
        verifiedWorkspaceId: params.createdBy.workspaceId,
      });
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      return { ok: false, error: get().mapRpcError(raw, 'a2a.channel.create failed') };
    }
    const channel = (raw as { channel?: unknown }).channel;
    if (channel === null || typeof channel !== 'object') {
      return { ok: false, error: { code: 'UNKNOWN', message: 'a2a.channel.create: missing channel' } };
    }
    // Apply through the state-mirror primitive. The `channel` field on
    // the params is overwritten with the daemon's authoritative row
    // (the synthesized row passed in by the caller is discarded — the
    // optimistic insert was never applied because we waited for the
    // RPC). This keeps the *Optimistic thunk as the single state-
    // mutation entry point.
    return get().createChannelOptimistic({
      ...params,
      channel: channel as Channel,
    });
  },

  postMessageDaemon: async (channelId, params) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn(
        '[channelsSlice] postMessageDaemon invoked before bridge mounted — call ignored',
      );
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    let raw: unknown;
    try {
      // D5: route the renderer-only mutation IPC. `verifiedWorkspaceId` is the
      // sender's own workspace; the daemon's sender-pin gate requires
      // `sender.workspaceId === verifiedWorkspaceId`, so they must match. The
      // pipe `a2a.channel.post` would fail this closed (no senderPtyId).
      raw = await bridge.mutateLocal('a2a.channel.post', {
        channelId,
        text: params.text,
        sender: params.sender,
        clientMsgId: params.clientMsgId,
        data: params.data,
        mentions: params.mentions,
        verifiedWorkspaceId: params.sender.workspaceId,
      });
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      return { ok: false, error: get().mapRpcError(raw, 'a2a.channel.post failed') };
    }
    const message = (raw as { message?: unknown }).message;
    if (message === null || typeof message !== 'object') {
      return { ok: false, error: { code: 'UNKNOWN', message: 'a2a.channel.post: missing message' } };
    }
    // Daemon returned the authoritative message. The renderer's local
    // mirror applies it through the *Optimistic primitive; the same-
    // seq dedup in `appendMessageFromEvent` handles the case where
    // the event-driven `channel.message` fan-out lands first.
    const applied = get().postMessageOptimistic(channelId, {
      ...params,
      message: message as ChannelMessage,
    });
    // A6: thread the daemon's droppedMentions (non-member @mentions) through to
    // the caller. Previously discarded here, which made A2's "mention did not
    // land" feedback dead on the human composer path.
    const dropped = (raw as { droppedMentions?: ChannelDroppedMention[] }).droppedMentions;
    if (applied.ok && dropped && dropped.length > 0) {
      return { ok: true, value: applied.value, droppedMentions: dropped };
    }
    return applied;
  },

  joinChannelDaemon: async (channelId, member, workspaceId) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn('[channelsSlice] joinChannelDaemon invoked before bridge mounted — call ignored');
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    let raw: unknown;
    try {
      // mutateLocal returns the daemon reply directly (no transport envelope).
      // The daemon pins the joining member's workspaceId to verifiedWorkspaceId.
      raw = await bridge.mutateLocal('a2a.channel.join', {
        channelId,
        member,
        verifiedWorkspaceId: workspaceId,
        includeHistory: true,
      });
    } catch (err) {
      return { ok: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) } };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      return { ok: false, error: get().mapRpcError(raw, 'a2a.channel.join failed') };
    }
    return get().joinChannelOptimistic(channelId, member, workspaceId);
  },

  inviteChannelDaemon: async (channelId, invitedMember, inviterWorkspaceId) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn('[channelsSlice] inviteChannelDaemon invoked before bridge mounted — call ignored');
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    let raw: unknown;
    try {
      // The inviter (verifiedWorkspaceId) must be a current member; the daemon
      // adds the invitedMember workspace (NOT self-pinned) — the only path into
      // a private channel. Invited members get full history by default.
      raw = await bridge.mutateLocal('a2a.channel.invite', {
        channelId,
        invitedMember,
        verifiedWorkspaceId: inviterWorkspaceId,
        includeHistory: true,
      });
    } catch (err) {
      return { ok: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) } };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      return { ok: false, error: get().mapRpcError(raw, 'a2a.channel.invite failed') };
    }
    // Optimistically add the INVITEE row (keyed to the invitee's workspace).
    return get().joinChannelOptimistic(channelId, invitedMember, invitedMember.workspaceId);
  },

  leaveChannelDaemon: async (channelId, memberId, workspaceId) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn('[channelsSlice] leaveChannelDaemon invoked before bridge mounted — call ignored');
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    let raw: unknown;
    try {
      // Self-only: workspaceId is BOTH the member's workspace and the verified
      // caller — the daemon's leave() matches m.workspaceId === verifiedWorkspaceId.
      raw = await bridge.mutateLocal('a2a.channel.leave', {
        channelId,
        workspaceId,
        memberId,
        verifiedWorkspaceId: workspaceId,
      });
    } catch (err) {
      return { ok: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) } };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      return { ok: false, error: get().mapRpcError(raw, 'a2a.channel.leave failed') };
    }
    return get().leaveChannelOptimistic(channelId, memberId, workspaceId);
  },

  kickChannelDaemon: async (channelId, targetMemberId, targetWorkspaceId, callerWorkspaceId) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn('[channelsSlice] kickChannelDaemon invoked before bridge mounted — call ignored');
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    let raw: unknown;
    try {
      // Humans-only eject: callerWorkspaceId is the verified human (renderer
      // process-boundary trust); target* identify the member row to remove. Rides
      // the renderer-only mutateLocal path — the daemon's kick() is pipe-unreachable,
      // so no agent can eject anyone.
      raw = await bridge.mutateLocal('a2a.channel.kick', {
        channelId,
        targetWorkspaceId,
        targetMemberId,
        verifiedWorkspaceId: callerWorkspaceId,
      });
    } catch (err) {
      return { ok: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) } };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      return { ok: false, error: get().mapRpcError(raw, 'a2a.channel.kick failed') };
    }
    return get().kickChannelOptimistic(channelId, targetMemberId, targetWorkspaceId);
  },

  archiveChannelDaemon: async (channelId, workspaceId) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn('[channelsSlice] archiveChannelDaemon invoked before bridge mounted — call ignored');
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    const existing = get().channels[channelId];
    if (!existing) {
      return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${channelId}` } };
    }
    let raw: unknown;
    try {
      // Archive authz is creator-or-CEO, gated daemon-side on verifiedWorkspaceId
      // (the renderer's own/CEO workspace). `archivedBy` is metadata only.
      raw = await bridge.mutateLocal('a2a.channel.archive', {
        channelId,
        verifiedWorkspaceId: workspaceId,
        archivedBy: workspaceId,
      });
    } catch (err) {
      return { ok: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) } };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      return { ok: false, error: get().mapRpcError(raw, 'a2a.channel.archive failed') };
    }
    // The daemon returns an empty result, not the row — synthesize the archived
    // channel optimistically. The daemon is authoritative; the next catalog
    // refresh overwrites `archivedAt` with the persisted value.
    return get().archiveChannelOptimistic(channelId, {
      ...existing,
      status: 'archived',
      archivedAt: Date.now(),
      archivedBy: workspaceId,
    });
  },

  trashChannelDaemon: async (channelId, workspaceId) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn('[channelsSlice] trashChannelDaemon invoked before bridge mounted — call ignored');
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    const existing = get().channels[channelId];
    if (!existing) {
      return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${channelId}` } };
    }
    let raw: unknown;
    try {
      raw = await bridge.mutateLocal('a2a.channel.trash', {
        channelId,
        verifiedWorkspaceId: workspaceId,
      });
    } catch (err) {
      return { ok: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) } };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      return { ok: false, error: get().mapRpcError(raw, 'a2a.channel.trash failed') };
    }
    // Trashing an active channel archives it too (the daemon does both in one
    // commit) — mirror that here so the row leaves the active list immediately.
    const now = Date.now();
    const next: Channel = {
      ...existing,
      status: 'archived',
      archivedAt: existing.archivedAt ?? now,
      archivedBy: existing.archivedBy ?? workspaceId,
      trashedAt: now,
      trashedBy: workspaceId,
    };
    set((state: StoreState) => {
      state.channels[channelId] = next;
      // A channel in the trash must not stay open in the dock.
      if (state.activeChannelId === channelId) state.activeChannelId = null;
      // ...nor keep counting toward the dock's total unread. A trashed channel
      // stays in the catalog, so `setChannels`'s eviction never fires for it and
      // the badge would go on advertising a room the user cannot open.
      delete state.channelUnread[channelId];
      delete state.channelMentions[channelId];
    });
    return { ok: true, value: next };
  },

  restoreChannelDaemon: async (channelId, workspaceId) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn('[channelsSlice] restoreChannelDaemon invoked before bridge mounted — call ignored');
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    const existing = get().channels[channelId];
    if (!existing) {
      return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${channelId}` } };
    }
    let raw: unknown;
    try {
      raw = await bridge.mutateLocal('a2a.channel.restore', {
        channelId,
        verifiedWorkspaceId: workspaceId,
      });
    } catch (err) {
      return { ok: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) } };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      return { ok: false, error: get().mapRpcError(raw, 'a2a.channel.restore failed') };
    }
    // Restore clears the trash marker only — the channel stays archived, so it
    // reappears in the Archived group, not the active list.
    const next: Channel = { ...existing };
    delete next.trashedAt;
    delete next.trashedBy;
    set((state: StoreState) => {
      state.channels[channelId] = next;
    });
    return { ok: true, value: next };
  },

  destroyChannelDaemon: async (channelId, workspaceId) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn('[channelsSlice] destroyChannelDaemon invoked before bridge mounted — call ignored');
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    let raw: unknown;
    try {
      raw = await bridge.mutateLocal('a2a.channel.destroy', {
        channelId,
        verifiedWorkspaceId: workspaceId,
      });
    } catch (err) {
      return { ok: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) } };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      const error = get().mapRpcError(raw, 'a2a.channel.destroy failed');
      // CHANNEL_NOT_FOUND is the end state the caller asked for — the row is
      // already gone daemon-side (another window destroyed it, or the retention
      // sweep did). Fall through to the eviction below and report success, so a
      // stale mirror row can't survive as an undeletable ghost.
      if (error.code !== 'CHANNEL_NOT_FOUND') return { ok: false, error };
    }
    // Evict every per-channel cache — same tuple `setChannels` drops for a
    // channel that has left the catalog (A19), applied eagerly here because the
    // row is gone daemon-side and no refresh will mention it again.
    set((state: StoreState) => {
      delete state.channels[channelId];
      delete state.channelMembers[channelId];
      delete state.channelMessages[channelId];
      delete state.channelUnread[channelId];
      delete state.channelMentions[channelId];
      delete state.channelNudgeExhausted[channelId];
      if (state.activeChannelId === channelId) state.activeChannelId = null;
    });
    return { ok: true, value: {} as Record<string, never> };
  },

  operatorListDaemon: async (workspaceId) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn('[channelsSlice] operatorListDaemon invoked before bridge mounted — call ignored');
      return [];
    }
    let raw: unknown;
    try {
      // 발견 어포던스(§2.2). 읽기지만 humans-only 트랜스포트라 mutateLocal로 탄다.
      // 데몬은 { ok: true, channels: OperatorChannelSummary[] }를 반환한다.
      raw = await bridge.mutateLocal('a2a.channel.operatorList', {
        verifiedWorkspaceId: workspaceId,
      });
    } catch (err) {
      console.warn('[channelsSlice] operatorListDaemon failed:', err);
      return [];
    }
    if (
      raw !== null &&
      typeof raw === 'object' &&
      'ok' in raw &&
      (raw as { ok: unknown }).ok === true &&
      'channels' in raw &&
      Array.isArray((raw as { channels: unknown }).channels)
    ) {
      return (raw as { channels: OperatorChannelSummary[] }).channels;
    }
    console.warn('[channelsSlice] operatorListDaemon: unexpected reply shape', raw);
    return [];
  },

  operatorJoinDaemon: async (channelId) => {
    const bridge = get().channelsRpc();
    if (!bridge) {
      console.warn('[channelsSlice] operatorJoinDaemon invoked before bridge mounted — call ignored');
      return { ok: false, error: { code: 'UNKNOWN', message: 'channels bridge not mounted' } };
    }
    let raw: unknown;
    try {
      // 좌석은 데몬이 상수로 심는다(§2.1) — verifiedWorkspaceId=ws-human만 보낸다.
      // 여분 필드(member/includeHistory 등)는 데몬이 읽지 않으므로 전달하지 않는다.
      raw = await bridge.mutateLocal('a2a.channel.operatorJoin', {
        channelId,
        verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
      });
    } catch (err) {
      return { ok: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) } };
    }
    if (raw === null || typeof raw !== 'object' || !('ok' in raw) || (raw as { ok: unknown }).ok !== true) {
      return { ok: false, error: get().mapRpcError(raw, 'a2a.channel.operatorJoin failed') };
    }
    // 낙관적 미러 갱신: 채널 행은 지금까지 private+비멤버라 미러에 없었을 수 있으므로
    // 좌석만 optimistic-add하지 않고, 호출자(ChannelsPanel)가 카탈로그를 재-hydrate해
    // 새로 보이게 된 채널 행 + 멤버를 끌어온다. 데몬의 membership 카탈로그 이벤트도
    // 동일 재동기를 유발한다(이중 안전). 여기선 성공만 신호한다.
    return { ok: true, value: {} };
  },
});