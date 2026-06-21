// ─── A2A Channels renderer state ─────────────────────────────────────────
//
// Mirrors the daemon-side `ChannelState` in the renderer for the sidebar
// (U7) + composer (U8) + unread-badge surfaces. The slice is a STATE MIRROR
// only — it never calls the daemon directly.
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
//   2. User-initiated (optimistic): the sidebar/composer calls the slice
//      actions (createChannel / postMessage / joinChannel /
//      leaveChannel / archiveChannel) for optimistic local updates.
//      The slice is intentionally agnostic to the transport that
//      reaches the daemon — the higher-level component is expected to
//      have already arranged the daemon round-trip (e.g. via an
//      out-of-band MCP tool invocation) before mutating local state.
//      The actions in this slice therefore focus on consistent local
//      state: they accept an externally-resolved result and apply it
//      to the mirror, returning the result so the caller can branch on
//      the structured error code.
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
// Plan reference: U6 (a2a-channels renderer integration).

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type {
  Channel,
  ChannelMember,
  ChannelMessage,
  ChannelVisibility,
} from '../../../shared/channels';

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
  ) => ChannelActionResult<Record<string, never>>;
  archiveChannelOptimistic: (
    channelId: string,
    archivedChannel: Channel,
  ) => ChannelActionResult<Channel>;

  // ── Catalog refresh (called on mount + after lifecycle events) ──
  setChannels: (
    channels: Channel[],
    members: Record<string, ChannelMember[]>,
  ) => void;

  // ── Event-driven actions (dispatched from the subscription hook) ─
  markChannelRead: (channelId: string) => void;
  appendMessageFromEvent: (message: ChannelMessage) => void;
}

export const createChannelsSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  ChannelsSlice
> = (set) => ({
  channels: {},
  channelMembers: {},
  channelMessages: {},
  activeChannelId: null,
  channelUnread: {},

  setActiveChannel: (channelId) =>
    set((state: StoreState) => {
      state.activeChannelId = channelId;
      // Switching active channel clears the unread badge immediately —
      // the channel view (U8) will render the messages regardless of
      // unread count. Keeping the badge and the active state in sync
      // here means a single source of truth (no double-bookkeeping).
      if (channelId !== null) {
        state.channelUnread[channelId] = 0;
      }
    }),

  markChannelRead: (channelId) =>
    set((state: StoreState) => {
      state.channelUnread[channelId] = 0;
    }),

  setChannels: (channels, members) =>
    set((state: StoreState) => {
      const next: Record<string, Channel> = {};
      for (const ch of channels) {
        next[ch.id] = ch;
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
        state.channelMessages[channelId] = [...list, params.message];
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
      const already = existing.some((m) => m.memberId === member.memberId);
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

  leaveChannelOptimistic: (channelId, memberId) => {
    set((state: StoreState) => {
      const list = state.channelMembers[channelId] ?? [];
      state.channelMembers[channelId] = list.filter(
        (m) => m.memberId !== memberId,
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
        state.channelMessages[channelId] = [...list, message];
      } else {
        const next = list.slice();
        next[idx] = message;
        state.channelMessages[channelId] = next;
      }
      if (isNew && state.activeChannelId !== channelId) {
        state.channelUnread[channelId] =
          (state.channelUnread[channelId] ?? 0) + 1;
      }
    }),
});