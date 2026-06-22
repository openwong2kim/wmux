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
  }): Promise<EventsPollResponse | null>;
}

interface EventsPollResponse {
  events: WmuxEvent[];
  nextCursor: number;
  resync?: boolean;
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
  useEffect(() => {
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

    // Per-recipient scoping (plan U3, R3): the daemon's per-workspace
    // filter at `events.rpc.ts:115-124` requires the caller to identify
    // its own workspace or it silently drops every event. The
    // renderer-side identity source is `company.ceoWorkspaceId` (the
    // company workspace that owns the renderer instance — see
    // `ChannelsPanel.tsx`). On a non-company render the field is
    // undefined: send a literal `'unknown-workspace'` is NOT an option
    // because the strict filter would silently drop every event and the
    // UI would look identical to a healthy empty stream, so we skip the
    // tick and warn once. Multi-workspace renderers (FIX-MULTI-WS
    // follow-up) will iterate `company.departments[].members[].ptyId`
    // here; for v1 the company CEO workspace is the only one we poll.
    const company = useStore.getState().company;
    const workspaceId = company?.ceoWorkspaceId;
    if (!workspaceId) {
      console.warn(
        '[useChannelsEventSubscription] no company.ceoWorkspaceId — channel events will not auto-update (FIX-MULTI-WS follow-up)',
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
        .then((result) => {
          if (disposed || !result) return;
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
            return;
          }
          for (const event of result.events) {
            // The daemon already scoped by `events.poll`'s base
            // workspaceId + per-recipient fan-out, so every event
            // here is intended for the current workspace. No
            // re-filter needed — the slice trusts the dispatch.
            if (event.type === 'channel.message') {
              const channelEvent = event as ChannelMessageEvent;
              useStore.getState().appendMessageFromEvent(channelEvent.message);
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
  }, []);
}
