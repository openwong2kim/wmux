// ─── Renderer-side channel.message subscription ──────────────────────────
//
// The renderer has no inbound event subscription mechanism today
// (`events.publish` in `src/preload/preload.ts` is one-way outbound). To
// react to `channel.message` events without a full main-process→preload
// push channel, we mirror the PluginFrame forwardEvents pattern
// (see `src/renderer/plugins/PluginFrame.tsx:81-112`): a 1-second
// `events.poll` loop, scoped to `channel.message`, dispatched into
// `channelsSlice.appendMessageFromEvent`.
//
// Why a renderer-side poll is OK here:
//   - The ring read is in-process (main → renderer IPC is a single
//     invoke) and costs ~one poll per second. The PluginFrame precedent
//     runs at the same cadence.
//   - Channels are a low-frequency, low-stakes surface — even a
//     2-3s tail-latency on a new message is fine for chat.
//   - We can scope the poll to `types: ['channel.message']` so the
//     poll response carries only channel traffic; the renderer never
//     pays the cost of receiving pane/process/agent events it doesn't
//     care about.
//
// Per-recipient scoping: `events.poll` already filters by caller's
// `workspaceId` for the base event; the channel.event fan-out adds every
// `recipientWorkspaceId` as a matchable key (see events.rpc.ts). This
// hook does NOT need to re-filter — it only receives events that the
// daemon intended for the current workspace. The slice's
// `appendMessageFromEvent` therefore doesn't re-check `recipientWorkspaceIds`.
//
// Resync handling: `events.poll` returns `resync: true` when the caller's
// cursor drifted past the 1024-event ring window. On resync we drop the
// local message cache for the channel(s) and let the next refresh rebuild
// it — the message catalog is durable in the daemon, so a transient
// cache loss is recoverable.
//
// Boot cursor: starting at `0` replays every still-in-ring channel
// message. For a renderer that mounted seconds after the daemon this is
// fine (the ring is 1024 events, usually empty of channel traffic
// shortly after boot). For a renderer that mounted minutes later, the
// ring may have already wrapped past those messages — `resync: true`
// triggers the recovery path.
//
// Mount: `useEffect` in AppLayout (registered once per renderer
// lifetime, parallel to `useApprovalInboxBridge`).
//
// Plan reference: U6 (a2a-channels renderer integration).

import { useEffect } from 'react';
import { useStore } from '../stores';
import { loadChannelHistory } from './useChannelsHydration';
import { routeChannelMentionToInbox } from './channelMentionInbox';
import { publishA2aTask } from '../events/publisher';
import type { WmuxEvent, ChannelMessageEvent } from '../../shared/events';

/** Polling cadence. 1 Hz is the same as the PluginFrame forwardEvents
 *  loop — established precedent. Higher frequency buys sub-second
 *  delivery at the cost of more IPC; the channel UI tolerates up to
 *  ~2s tail latency for new messages. */
const EVENT_POLL_INTERVAL_MS = 1000;

/** Per-poll max. We expect ≪1 channel event per second in normal use;
 *  64 is generous headroom that bounds memory + parse cost per poll
 *  cycle. The daemon's POLL_DEFAULT_MAX (256) is the upper bound and
 *  is fine here too, but 64 keeps the per-poll JSON small. */
const EVENT_POLL_MAX = 64;

/** Bridge global installed by `useRpcBridge` that forwards the
 *  `events.poll` call into the main process. Single-method facade
 *  matching the function-shaped global the bridge installs — the
 *  slice doesn't poll itself; events arrive exclusively through this
 *  hook. */
interface EventsPollBridge {
  (params: {
    cursor: number;
    types: ['channel.message'];
    max?: number;
    workspaceId: string;
  }): Promise<EventsPollEnvelope | null>;
}

interface EventsPollResponse {
  events: WmuxEvent[];
  nextCursor: number;
  resync?: boolean;
}

/**
 * The renderer rpc bridge (electronAPI.rpc.invoke → pipe RpcRouter) wraps the
 * daemon reply in the RPC protocol envelope `{ id, ok, result }`, where
 * `result` is the events.poll payload. Reading `result.events` directly (one
 * level too shallow) silently dispatched NOTHING — the cursor stayed 0 and the
 * `for…of` ran over `undefined`, swallowed by the catch. PluginFrame's
 * forwardEvents loop reads `resp.result.events` correctly; we mirror it.
 */
interface EventsPollEnvelope {
  ok?: boolean;
  result?: EventsPollResponse;
}

interface BridgeWindow {
  __wmuxEventsPoll?: EventsPollBridge;
}

function readEventsPollBridge(): EventsPollBridge | undefined {
  return (window as unknown as BridgeWindow).__wmuxEventsPoll;
}

/**
 * Mount once in AppLayout. Returns nothing — the subscription is owned
 * by the store, and tearing it down is just `clearInterval`.
 *
 * Defensive guards:
 *   - Bridge missing: warn once and bail (consistent with
 *     `searchSlice.runSearch`'s missing-bridge behavior).
 *   - `result === null`: transient IPC failure — keep polling.
 *   - `resync: true`: drop the channel message cache so the next
 *     `refreshChannels` rebuilds from authoritative state.
 */
export function useChannelsEventSubscription(): void {
  // Per-recipient scoping (plan U3, R3): the daemon's per-workspace filter at
  // `events.rpc.ts:115-124` requires the caller to identify its own workspace
  // or it silently drops every event. Channels are decoupled from in-app
  // Company mode, so the identity is the company CEO workspace when set, else
  // the active workspace (mirrors useChannelsHydration / ChannelsPanel).
  //
  // SUBSCRIBE to this (not getState() inside a []-deps effect): a prior bug read
  // it once at mount, and if this hook mounted before `activeWorkspaceId` was
  // set (boot race), self was null, the effect early-returned, and events.poll
  // NEVER started — so live channel messages, the unread/mention dock badges,
  // AND the mention→a2a inbox routing all silently no-op'd. Keying the effect on
  // `workspaceId` re-runs it the moment self lands, starting the poll then.
  // Multi-workspace renderers (FIX-MULTI-WS follow-up) will iterate every member
  // workspace here; for v1 we poll one.
  const workspaceId = useStore((s) => s.company?.ceoWorkspaceId ?? s.activeWorkspaceId);
  useEffect(() => {
    if (!workspaceId) {
      // No resolvable self yet (pre-boot). The selector above re-runs this
      // effect once `activeWorkspaceId` is set — a wait, not a dead end.
      return;
    }
    const bridge = readEventsPollBridge();
    if (!bridge) {
      // The renderer should never reach this state — `useRpcBridge`
      // mounts the events.poll bridge alongside the rest of the RPC
      // handlers. If it doesn't, the channel view will still work
      // (user-initiated actions don't need events), but live updates
      // won't. Surface the timing edge case for debugging without
      // sentinel-erroring the user-visible state.
      console.warn(
        '[useChannelsEventSubscription] events.poll bridge not mounted — channel events will not auto-update',
      );
      return;
    }

    let disposed = false;
    let cursor = 0;
    let inFlight = false;

    const tick = () => {
      if (disposed || inFlight) return;
      inFlight = true;
      bridge({ cursor, types: ['channel.message'], max: EVENT_POLL_MAX, workspaceId })
        .then((raw) => {
          if (disposed || !raw) return;
          // Peel the RPC transport envelope { id, ok, result }. The daemon's
          // events.poll payload lives at `.result` — reading the top level
          // gave undefined and dispatched nothing.
          if (raw.ok !== true || !raw.result) return;
          const result = raw.result;
          cursor = result.nextCursor;
          if (result.resync) {
            // Drift past the ring window — drop the local message
            // cache so the next refresh rebuilds it from the
            // authoritative daemon state. The channel catalog
            // (`channels`, `channelMembers`) survives — it's the
            // messages that drift, not the channel list. New
            // messages arriving via subsequent events will
            // repopulate the active channels.
            useStore.setState((s) => {
              s.channelMessages = {};
              s.channelUnread = {};
            });
            // P0 (C1): the wipe just blanked the OPEN channel's hydrated
            // history too, and nothing re-fetches it (history hydration
            // triggers on activeChannelId change, not on resync). Re-load the
            // active channel's recent history so the open view doesn't go
            // blank mid-session. Best-effort — loadChannelHistory no-ops on any
            // failure and a later event/open retries.
            const st = useStore.getState();
            const activeId = st.activeChannelId;
            const activeCh = activeId ? st.channels[activeId] : undefined;
            const rpcBridge = st.channelsRpc();
            if (activeId && activeCh && rpcBridge && workspaceId) {
              void loadChannelHistory({
                rpc: rpcBridge.rpc,
                channelId: activeId,
                nextSeq: activeCh.nextSeq,
                workspaceId,
                apply: st.hydrateChannelMessages,
              });
            }
            return;
          }
          for (const event of result.events) {
            // The daemon already scoped by `events.poll`'s base
            // workspaceId + per-recipient fan-out, so every event
            // here is intended for the current workspace. No
            // re-filter needed — the slice trusts the dispatch.
            if (event.type === 'channel.message') {
              const channelEvent = event as ChannelMessageEvent;
              const st = useStore.getState();
              st.appendMessageFromEvent(channelEvent.message);
              // #7 Phase 2: a post that @-mentions THIS workspace becomes an
              // a2a inbox task so the workspace's agent receives it through its
              // normal poll (a2a_task_query / wmux_events_poll), bridging the
              // deferred channel-read gap. Workspace-level (no pane pin);
              // idempotent by deterministic task id.
              routeChannelMentionToInbox(channelEvent.message, workspaceId, {
                getTask: st.getTask,
                createA2aTask: st.createA2aTask,
                channelName: (id) => useStore.getState().channels[id]?.name ?? id,
                workspaceName: (id) =>
                  useStore.getState().workspaces.find((w) => w.id === id)?.name ?? id,
                publish: publishA2aTask,
              });
            }
          }
        })
        .catch(() => {
          // Transient IPC / pipe failure — keep the cursor and try
          // again next tick. We don't drop the cache here because
          // the failure mode is "missed events this cycle", not
          // "missed events indefinitely".
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const timer = setInterval(tick, EVENT_POLL_INTERVAL_MS);
    // Fire one tick immediately so the first batch arrives within ~1s
    // of mount rather than waiting for the first interval.
    tick();

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [workspaceId]);
}
