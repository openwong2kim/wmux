// ─── Renderer-side channel.message + agent.lifecycle subscription ────────
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
//   - We scope the poll to `types: ['channel.message', 'agent.lifecycle']`
//     so the response carries only channel traffic plus agent turn-boundary
//     (Stop) events — the latter triggers P1 autoresponse: queued @-mention
//     tasks are pasted into the now-idle pane's PTY (see channelMentionFlush).
//     The renderer still never pays for pane/process/notification events.
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
import { loadChannelHistory, hydrateChannelsCatalog } from './useChannelsHydration';
import { routeChannelMentionToInbox } from './channelMentionInbox';
import { isChannelMentionHandled, markChannelMentionHandled } from './channelMentionHandled';
import { isNudgeRateLimited, recordNudge } from './channelMentionRateLimit';
import { findLeafPanes } from './a2aAddressing';
import { publishA2aTask } from '../events/publisher';
import { flushMentions, type FlushOpts } from './channelMentionFlush';
import { submitBracketedPasteToPty } from '../utils/ptyMessageDelivery';
import type { WmuxEvent, ChannelMessageEvent, AgentLifecycleEvent } from '../../shared/events';

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

/** Paste is unsafe while the agent is actively producing ('running') or blocked
 *  on a confirmation prompt ('awaiting_input') — those defer to the agent's
 *  Stop. 'waiting' (turn ended, ready for input), 'complete', 'idle', and
 *  unknown are all paste-safe (deliver immediately). */
const PASTE_UNSAFE_STATUSES: ReadonlySet<string> = new Set(['running', 'awaiting_input']);
function isBusyStatus(status: string | undefined): boolean {
  return status != null && PASTE_UNSAFE_STATUSES.has(status);
}

/** Bridge global installed by `useRpcBridge` that forwards the
 *  `events.poll` call into the main process. Single-method facade
 *  matching the function-shaped global the bridge installs — the
 *  slice doesn't poll itself; events arrive exclusively through this
 *  hook. */
interface EventsPollBridge {
  (params: {
    cursor: number;
    types: readonly ('channel.message' | 'agent.lifecycle' | 'channel.catalog')[];
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

    // A4: stamp the mount time so the first poll can keep events that arrived
    // AFTER mount (live) while skipping pre-mount ring history (see `tick`).
    const mountTs = Date.now();
    let disposed = false;
    let cursor = 0;
    let inFlight = false;
    // A4: the first poll establishes a ring-head baseline (see the guard in
    // `tick`) instead of replaying still-in-ring history as if it were new.
    let primed = false;
    // Generation guard for catalog re-hydration: hydrateChannelsCatalog awaits
    // list/member RPCs before setChannels, so a slower OLDER hydrate could land
    // after a newer one and overwrite the sidebar/roster with stale membership.
    // Both hydrate paths bump this; only the latest run may commit (CodeRabbit).
    let catalogHydrationRun = 0;

    // Drain queued channel mentions into their target panes' PTYs. Reads live
    // store state on each call (no stale closure). Stop path pins onlyPtyId +
    // requireIdle:false; arrival path scans all targets + requireIdle:true.
    const runFlush = (opts: FlushOpts) => {
      const st = useStore.getState();
      // A3 sweep: runFlush now fires EVERY poll (not only on a new message) so a
      // mention queued for a pane that read as 'unknown' (fail-closed busy) at
      // arrival is retried once that pane's status resolves to idle. Cheap
      // early-out when nothing is queued so the per-poll sweep skips the
      // findLeafPanes DFS on an empty queue.
      if (st.getUndeliveredChannelMentionTasks(workspaceId).length === 0) return;
      const selfWs = st.workspaces.find((w) => w.id === workspaceId);
      if (!selfWs) return;
      const selfLeaves = findLeafPanes(selfWs.rootPane);
      flushMentions(workspaceId, selfLeaves, {
        getUndeliveredChannelMentionTasks: st.getUndeliveredChannelMentionTasks,
        // surfaceAgent (NOT surfaceAgentStatus) is the busy source: surfaceAgentStatus
        // is attention-only and DELETES running/idle entries (paneSlice.setSurfaceAgentStatus),
        // so a running agent would read as undefined→idle and get pasted mid-turn (codex P1).
        // surfaceAgent retains the live status for the PTY's lifetime.
        // A3: fail-CLOSED on unknown agent state. A missing surfaceAgent entry
        // (a pty whose status broadcast hasn't landed yet, or a cleanup/reattach
        // window) must NOT read as idle — pasting a nudge into a running agent
        // corrupts its turn / fires an unintended submit. Treat unknown as busy
        // and let the agent's Stop event flush the queued mention instead.
        isBusy: (ptyId) => {
          const status = st.surfaceAgent[ptyId]?.status;
          if (status == null) return true;
          return isBusyStatus(status);
        },
        deliverNudge: (ptyId, text) => submitBracketedPasteToPty(ptyId, text),
        markDelivered: st.markChannelMentionDelivered,
        isRateLimited: isNudgeRateLimited,
        recordNudge,
      }, opts);
    };

    const tick = () => {
      if (disposed || inFlight) return;
      inFlight = true;
      bridge({ cursor, types: ['channel.message', 'agent.lifecycle', 'channel.catalog'], max: EVENT_POLL_MAX, workspaceId })
        .then((raw) => {
          if (disposed || !raw) return;
          // Peel the RPC transport envelope { id, ok, result }. The daemon's
          // events.poll payload lives at `.result` — reading the top level
          // gave undefined and dispatched nothing.
          if (raw.ok !== true || !raw.result) return;
          const result = raw.result;
          // A4: the first poll starts at cursor 0, which replays every event
          // still in the 1024-entry ring. Replaying PRE-mount history as "new"
          // inflates unread badges AND re-routes already-completed @mentions into
          // the a2a inbox (task resurrection). But we must NOT drop the whole
          // first batch (codex+GLM P1): an event that arrived between mount and
          // this first poll resolving is genuinely live. So on the first batch,
          // keep only events stamped at/after mount and process them normally;
          // pre-mount history is skipped (durable history is shown by the
          // open-channel hydration path, not by ring replay).
          if (!primed) {
            primed = true;
            result.events = result.events.filter((e) => e.ts >= mountTs);
          }
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
              // A17: channelMentions is a subset of channelUnread — clearing
              // unread without it leaves stale red @-badges floating over the
              // wiped messages until the channel is opened.
              s.channelMentions = {};
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
            // C3 (codex P2): catalog/membership changes are delivered ONLY via
            // channel.catalog now, so a ring drift can have dropped create/
            // archive/join/leave/kick/invite signals. Re-hydrate the FULL catalog
            // (channels + members), not just messages, so the sidebar + roster
            // don't stay stale indefinitely after a long pause / saturated ring.
            if (rpcBridge && workspaceId) {
              const hydrationRun = ++catalogHydrationRun;
              void hydrateChannelsCatalog({
                rpc: rpcBridge.rpc,
                workspaceId,
                setChannels: useStore.getState().setChannels,
                isCurrent: () => !disposed && hydrationRun === catalogHydrationRun,
              });
            }
            return;
          }
          let sawCatalog = false;
          // A16: compute this workspace's leaf set ONCE per poll batch — it can't
          // change mid-batch, and findLeafPanes is a DFS that a busy poll (many
          // channel.message events) would otherwise re-walk per message.
          const batchSelfWs = useStore.getState().workspaces.find((w) => w.id === workspaceId);
          const batchSelfLeaves = batchSelfWs ? findLeafPanes(batchSelfWs.rootPane) : [];
          for (const event of result.events) {
            // The daemon already scoped by `events.poll`'s base
            // workspaceId + per-recipient fan-out, so every event
            // here is intended for the current workspace. No
            // re-filter needed — the slice trusts the dispatch.
            if (event.type === 'channel.message') {
              const channelEvent = event as ChannelMessageEvent;
              const st = useStore.getState();
              st.appendMessageFromEvent(channelEvent.message);
              // Route on REPLAYED events too (no historical drop): with single-ws
              // polling, a mention that arrived while this subscription was on
              // ANOTHER workspace must still enqueue on switch-back (codex R6).
              // routeChannelMentionToInbox is idempotent (deterministic task id +
              // getTask short-circuit), and the flush's busy check stops a stale
              // replay from pasting into a running agent. Duplicate re-delivery
              // after a FULL renderer reload (transient delivered map lost) is a
              // known trade-off — durable delivery state is a follow-up.
              // #7 + agent-pane redesign: a post that @-mentions THIS workspace
              // becomes an a2a inbox task. The router resolves the mention's
              // pinned paneId against our own live leaves (fail-closed ptyId
              // re-check) and pins to.paneId so a split workspace routes to
              // EXACTLY the mentioned agent; a miss falls back to a ws-level task
              // (any live agent picks it up via role:agent query). Idempotent by
              // per-target deterministic task id.
              routeChannelMentionToInbox(channelEvent.message, workspaceId, batchSelfLeaves, {
                getTask: st.getTask,
                createA2aTask: st.createA2aTask,
                channelName: (id) => useStore.getState().channels[id]?.name ?? id,
                workspaceName: (id) =>
                  useStore.getState().workspaces.find((w) => w.id === id)?.name ?? id,
                publish: publishA2aTask,
                isHandled: isChannelMentionHandled,
                markHandled: markChannelMentionHandled,
              });
            } else if (event.type === 'agent.lifecycle') {
              // P1 autoresponse: agent.stop is the flush trigger, but only the
              // RIGHT kind+source is a paste-safe idle boundary.
              //   - subagent_stop: a nested subagent returned while the PARENT is
              //     still processing (often the same pty) → ignored, else we paste
              //     mid-turn (codex+GLM P1). The parent's own agent.stop flushes.
              //   - awaiting_input: mid-turn confirmation prompt → ignored.
              //   - source hook/detector: a real agent turn boundary → deliver
              //     unconditionally (requireIdle:false).
              //   - source osc133: a generic shell command_end (e.g. `npm test`
              //     finishing) on the pty, NOT an agent boundary — the agent may
              //     still be running, so KEEP the busy check (codex round-2 P1).
              const ev = event as AgentLifecycleEvent;
              // EVERY agent.stop triggers a flush — we do NOT filter on decision.
              //   - A hook stop can be polled while surfaceAgent is still 'running'
              //     (the detector's status broadcast hasn't landed yet) → busy
              //     skip; the detector's later dedup stop carries the now-idle
              //     status and MUST be allowed to retry (codex round-8 P1).
              //   - A genuinely stale stop (agent already in a new turn), a
              //     replayed historical stop, or an osc133 shell command_end on a
              //     busy agent are all made safe by the flush's live busy check
              //     plus per-task idempotency: a busy pty is skipped, and an
              //     already-delivered mention is dropped from the undelivered set
              //     (no double paste — codex round-4/7). The pty's CURRENT status
              //     is the single source of truth.
              // subagent_stop / awaiting_input never reach here (kind check).
              if (ev.kind === 'agent.stop') {
                runFlush({ onlyPtyId: ev.ptyId });
              }
            } else if (event.type === 'channel.catalog') {
              // A1: a channel's catalog/membership changed (create/archive/join/
              // leave/kick/invite — by us or another client). Flag a one-shot
              // re-hydrate after the batch so the sidebar + roster re-sync
              // instead of going silently stale (the audit's top structural gap:
              // 6 of 7 mutations used to emit nothing).
              sawCatalog = true;
            }
          }
          // Idle-immediate + A3 sweep: deliver any queued mention to a now-idle
          // pane. Runs EVERY poll (not only on a new message) so a mention queued
          // while its target pane read as 'unknown' (fail-closed busy) is retried
          // once that pane resolves to idle — without this, A3's fail-closed left
          // such mentions undelivered forever (GLM P2). The early-out in runFlush
          // keeps an empty-queue tick cheap.
          runFlush({});
          // A1: re-hydrate the catalog once per batch when any channel.catalog
          // event arrived. The six non-post mutations now emit this signal; the
          // receiver re-fetches list+members (daemon = source of truth), so a
          // channel created/archived elsewhere appears, a kicked/left member's
          // mirror drops it, and rosters stay consistent without a manual refresh.
          if (sawCatalog) {
            const st = useStore.getState();
            const rpcBridge = st.channelsRpc();
            if (rpcBridge && workspaceId) {
              const hydrationRun = ++catalogHydrationRun;
              void hydrateChannelsCatalog({
                rpc: rpcBridge.rpc,
                workspaceId,
                setChannels: st.setChannels,
                isCurrent: () => !disposed && hydrationRun === catalogHydrationRun,
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
