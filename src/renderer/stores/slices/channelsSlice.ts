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
} from '../../../shared/channels';

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
    });
    return { ok: true, value: {} as Record<string, never> };
  },

  archiveChannelOptimistic: (channelId, archivedChannel) => {
    set((state: StoreState) => {
      // The archived row carries `status: 'archived'` and `archivedAt`.
      // Overwrite the catalog row — the daemon is authoritative; the
      // optimistic update is best-effort until the next refresh.
      state.channels[channelId] = archivedChannel;
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
      // `self` = the company CEO workspace when set, else the active workspace —
      // mirrors ChannelView/Composer identity resolution.
      const selfWs = state.company?.ceoWorkspaceId ?? state.activeWorkspaceId;
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
});