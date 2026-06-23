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
  postMessageDaemon: (
    channelId: string,
    params: ChannelPostParams,
  ) => Promise<ChannelActionResult<ChannelMessage>>;

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

  setActiveChannel: (channelId) =>
    set((state: StoreState) => {
      state.activeChannelId = channelId;
      // Switching active channel clears the unread badge immediately —
      // the channel view (U8) will render the messages regardless of
      // unread count. Keeping the badge and the active state in sync
      // here means a single source of truth (no double-bookkeeping).
      if (channelId !== null) {
        state.channelUnread[channelId] = 0;
        // Auto-open the right channel dock so clicking a channel reveals the
        // conversation (the dock is collapsed by default — uiSlice).
        state.channelDockVisible = true;
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
    return get().postMessageOptimistic(channelId, {
      ...params,
      message: message as ChannelMessage,
    });
  },
});