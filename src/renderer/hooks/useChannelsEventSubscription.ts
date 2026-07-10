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
// Per-recipient scoping (FIX-MULTI-WS): the poll is scoped to the UNION of
// every local workspace (`workspaceIds` param — daemon filters by set
// membership, see events.rpc.ts). Channels are workspace-independent, so a
// mention of a pane in a BACKGROUND workspace must deliver while the user is
// viewing another one — the v1 single-workspace poll silently dropped those.
// One loop, one cursor: the first multi-loop attempt (one poll loop per
// workspace) regressed same-workspace delivery and was reverted; the union
// scope keeps the loop structurally identical to v1. Because the batch now
// carries OTHER workspaces' events, this hook re-filters per event: display
// state (message cache / unread / catalog hydration) only for events relevant
// to the ACTIVE workspace, mention routing + flush for EVERY local recipient
// workspace.
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
import {
  isChannelMentionHandled,
  markChannelMentionHandled,
  isChannelMentionDeliveredPersisted,
  markChannelMentionDeliveredPersisted,
} from './channelMentionHandled';
import { HUMAN_WORKSPACE_ID } from '../../shared/channels';
import { isNudgeRateLimited, recordNudge, shouldWarnLoopSuspect } from './channelMentionRateLimit';
import { findLeafPanes } from './a2aAddressing';
import { panePrincipalId } from '../../shared/principals';
import { publishA2aTask } from '../events/publisher';
import { flushMentions, type FlushOpts } from './channelMentionFlush';
import { submitBracketedPasteToPty } from '../utils/ptyMessageDelivery';
import {
  createPasteGateState,
  isMentionPasteBusy,
  notePtyOutput,
  prunePasteGateState,
} from './channelMentionPasteGate';
import type {
  WmuxEvent,
  ChannelMessageEvent,
  ChannelCatalogEvent,
  AgentLifecycleEvent,
} from '../../shared/events';
import type { PaneLeaf } from '../../shared/types';

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

/**
 * FIX-MULTI-WS — per-`channel.message` delivery decision, extracted PURE so the
 * active-vs-background fan-out is unit-testable without the GUI. This is the
 * exact layer the first multi-workspace attempt regressed: it kept same-ws
 * delivery working in the daemon filter (whose tests passed) but broke the
 * renderer's same-ws ROUTING at runtime. Testing the decision here would have
 * caught that.
 *
 *   - `appendToDisplay`: update the message cache / unread / mention badges
 *     ONLY when the ACTIVE workspace is the sender or a recipient. A background
 *     workspace keeps no display cache (setChannels is a full replace — a
 *     background append would count unread against a catalog the active view
 *     doesn't hold); its view is rebuilt by hydration on switch.
 *   - `routeWorkspaces`: the LOCAL workspaces this post @-mentions — each gets
 *     an a2a inbox task (active OR background: the cross-workspace fix). A
 *     workspace mentioned but not local is skipped (its own renderer routes it).
 *
 * W1 (operator observation): `isObservedChannel` widens the display append to
 * private agent channels the human OBSERVES read-only. The human is NOT a
 * recipient of such a channel (no member row), so the P5 human-membership check
 * alone would drop its live messages; the caller passes `true` ONLY when the
 * catalog mirror row carries the daemon's `observed` flag (a private channel
 * ws-human watches without membership). NOT mere mirror presence: the ws-human
 * mirror also holds every PUBLIC channel — including unjoined/discoverable ones
 * — and appending those would leak non-member public traffic into the dock and
 * pile unread badges onto discoverable rows (GLM P2). Member channels are
 * already covered by the recipient check. This flag only ungates the human's
 * DISPLAY — message plumbing is unchanged: the post reaches this renderer via
 * the local-workspace poll scope as long as at least one member workspace is
 * LOCAL. Known gap (documented, unmanifested): if EVERY member of an observed
 * channel is REMOTE (LAN A2A), its posts never enter the local poll scope, so
 * the observed view silently updates only on the next hydration/refresh. LAN
 * A2A is not live today; a poll-scope fallback for observed channels is a
 * follow-up.
 */
export function planChannelMessageDelivery(
  senderWorkspaceId: string,
  recipientWorkspaceIds: readonly string[],
  mentionWorkspaceIds: readonly string[],
  localIds: readonly string[],
  isObservedChannel = false,
): { appendToDisplay: boolean; routeWorkspaces: string[] } {
  // P5: display exactly the channels the unified HUMAN is a member of, and
  // ONLY those — the human's view is workspace-independent. The old
  // active-workspace branch (ship review: Codex privacy_leak + Claude
  // adversarial F4) leaked private agent-only channel traffic into the human's
  // dock (the active workspace was a recipient but ws-human was not), producing
  // phantom unread badges on channels the human can't even open. Mention
  // ROUTING still fans out to every real local workspace (routeWorkspaces) so
  // agents are pinged; only the human's DISPLAY is scoped to their membership.
  void senderWorkspaceId; // retained for signature stability / future use
  // W1: OR in observation — a private agent channel the human observes read-only
  // has no ws-human recipient row, so append its live messages when its mirror
  // row is daemon-flagged `observed` (the caller resolves that flag; see the
  // JSDoc for why mirror PRESENCE alone would over-append).
  const appendToDisplay =
    recipientWorkspaceIds.includes(HUMAN_WORKSPACE_ID) || isObservedChannel;
  const mentionWs = new Set(mentionWorkspaceIds);
  const routeWorkspaces = localIds.filter((id) => mentionWs.has(id));
  return { appendToDisplay, routeWorkspaces };
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
    /** FIX-MULTI-WS: union scope — every LOCAL workspace id, so background
     *  workspaces' channel/lifecycle events arrive in the same single poll. */
    workspaceIds?: readonly string[];
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
  // P5 (unified human identity): the HUMAN's channel identity is the reserved
  // virtual workspace — hydration/catalog reads, display scope, and mutations
  // all key on it, NEVER on the active workspace, so switching workspaces no
  // longer changes what the human sees. It is a constant, so the poll starts
  // immediately (the old activeWorkspaceId boot race is gone).
  const workspaceId = HUMAN_WORKSPACE_ID;
  // FIX-MULTI-WS: every local workspace id, joined so the selector returns a
  // stable primitive (string) — the effect re-runs (rebuilding the poll scope)
  // only when a workspace is added/removed, not on unrelated store writes.
  const allWorkspaceIds = useStore((s) => s.workspaces.map((w) => w.id).join(','));
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

    // FIX-MULTI-WS: the poll's union scope — every local workspace. P5 widens
    // it with the reserved human workspace so events addressed to the unified
    // human seat arrive too. `localIds` (REAL workspaces only) keeps feeding
    // mention ROUTING and the flush/prune sweeps — ws-human owns no panes and
    // must never become a routing target; `pollIds` is scope only.
    const localIds = allWorkspaceIds ? allWorkspaceIds.split(',').filter(Boolean) : [];
    const pollIds = [...localIds, workspaceId];

    // A4: stamp the mount time so the first poll can keep events that arrived
    // AFTER mount (live) while skipping pre-mount ring history (see `tick`).
    const mountTs = Date.now();
    let disposed = false;
    let cursor = 0;
    let inFlight = false;
    // Generation guard for catalog re-hydration: hydrateChannelsCatalog awaits
    // list/member RPCs before setChannels, so a slower OLDER hydrate could land
    // after a newer one and overwrite the sidebar/roster with stale membership.
    // Both hydrate paths bump this; only the latest run may commit (CodeRabbit).
    let catalogHydrationRun = 0;
    // RCA 2026-07-05: grace clock for the isBusy unknown-status gate. Effect-
    // scoped so the per-pty first-unknown timestamp survives across poll ticks
    // (a fresh map per remount is correct — a remount re-establishes the poll).
    const pasteGate = createPasteGateState();
    // RCA 2026-07-05 (mid-turn paste race): stamp each pty's last-output time so
    // the paste gate's second (output-quiet) check can tell a slow/thinking
    // background agent (still emitting) from a truly idle one. main forwards
    // background pane pty output to the renderer too (pty.handler.ts, no mounted
    // gating), so this sees every local pane. Optional-chained for the (test /
    // pre-mount) window where electronAPI isn't installed yet.
    const removePtyDataListener = window.electronAPI?.pty?.onData?.((id, data) =>
      // 2c: pass the chunk so pure DSR/CPR query-answer echo (an idle TUI
      // answering cursor probes) does not count as activity and pin the pane
      // under the output-quiet bar until the hold ceiling.
      notePtyOutput(pasteGate, id, Date.now(), data),
    );

    // Drain queued channel mentions into their target panes' PTYs. Reads live
    // store state on each call (no stale closure). Stop path pins onlyPtyId +
    // requireIdle:false; arrival path scans all targets + requireIdle:true.
    // FIX-MULTI-WS: parameterized by workspace — the mention queue, pane tree,
    // and delivery are all per-workspace, and a background workspace's queue
    // must drain without that workspace being active. `pty.write` goes through
    // the main process, so an unmounted (background) pane still receives.
    const runFlush = (wsId: string, opts: FlushOpts) => {
      const st = useStore.getState();
      // A3 sweep: runFlush now fires EVERY poll (not only on a new message) so a
      // mention queued for a pane that read as 'unknown' (fail-closed busy) at
      // arrival is retried once that pane's status resolves to idle. Cheap
      // early-out when nothing is queued so the per-poll sweep skips the
      // findLeafPanes DFS on an empty queue.
      if (st.getUndeliveredChannelMentionTasks(wsId).length === 0) return;
      const selfWs = st.workspaces.find((w) => w.id === wsId);
      if (!selfWs) return;
      const selfLeaves = findLeafPanes(selfWs.rootPane);
      // 2b: ptys currently hosting a detected agent — the ws-level single-agent
      // delivery rule needs to know when the workspace has exactly one.
      const agentPtys = new Set<string>();
      for (const leaf of selfLeaves) {
        for (const s of leaf.surfaces) {
          if (s.ptyId && st.surfaceAgent[s.ptyId]) agentPtys.add(s.ptyId);
        }
      }
      flushMentions(wsId, selfLeaves, {
        getUndeliveredChannelMentionTasks: st.getUndeliveredChannelMentionTasks,
        agentPtys,
        // surfaceAgent (NOT surfaceAgentStatus) is the busy source: surfaceAgentStatus
        // is attention-only and DELETES running/idle entries (paneSlice.setSurfaceAgentStatus),
        // so a running agent would read as undefined→idle and get pasted mid-turn (codex P1).
        // surfaceAgent retains the live status for the PTY's lifetime.
        // A3 + RCA 2026-07-05: fail-CLOSED on unknown agent state, but only for
        // a GRACE window. A missing surfaceAgent entry (status broadcast not yet
        // landed, or a cleanup/reattach window) must NOT immediately read as idle
        // — pasting into a running agent corrupts its turn. BUT an agent that has
        // been idle since its pty attached never re-emits a status pattern, so
        // its status stays undefined forever; the old permanent fail-closed left
        // such mentions stuck until an unrelated repaint (e.g. a pane split)
        // finally emitted 'waiting'. A running agent broadcasts 'running' within
        // ~1 output burst, so an unknown status that persists past the grace
        // window is quiet/idle = paste-safe. See channelMentionPasteGate.
        isBusy: (ptyId) =>
          isMentionPasteBusy(st.surfaceAgent[ptyId]?.status, ptyId, Date.now(), pasteGate),
        deliverNudge: (ptyId, text) => submitBracketedPasteToPty(ptyId, text),
        markDelivered: st.markChannelMentionDelivered,
        // 2f: rate cap unchanged; the first capped observation per window also
        // raises a one-shot user-visible toast (the cap itself only console-
        // warned, so a mention loop looked like "the agent ignored me").
        isRateLimited: (ptyId) => {
          const limited = isNudgeRateLimited(ptyId, Date.now());
          if (limited && shouldWarnLoopSuspect(ptyId, Date.now())) {
            useStore.getState().pushToast({
              level: 'info',
              message:
                'Possible agent mention loop — auto-nudges for a pane are rate-capped; queued mentions stay pullable via a2a_task_query.',
            });
          }
          return limited;
        },
        recordNudge,
        // 2a-2 + 2d: after a successful paste, persist the durable delivered
        // mark (reload no longer resurrects it) and report the nudge to the
        // daemon wake worker's shared ledger (its re-nudge budget counts this
        // paste instead of immediately double-pasting the same member).
        onNudgeDelivered: (_ptyId, tasks) => {
          const st2 = useStore.getState();
          const bridge = st2.channelsRpc();
          // One paste = ONE nudge per (channel, member): a group of N mentions
          // must not fire N RPCs and burn N ledger slots (CAP is 3 — that would
          // trigger a premature human handoff; ship perf review).
          const reported = new Set<string>();
          for (const task of tasks) {
            const md = task.history?.[0]?.metadata as Record<string, unknown> | undefined;
            const handledKey = md?.['handledKey'];
            if (typeof handledKey === 'string' && handledKey) {
              markChannelMentionDeliveredPersisted(handledKey);
            }
            const channelId = md?.['channelId'];
            if (!bridge || typeof channelId !== 'string' || !channelId) continue;
            // Resolve the ledger member key from the pane's R2 roster row FIRST
            // (authoritative — the worker keys its budget on the row's memberId):
            // GUI-composed mentions carry no memberId at all (only MCP posts
            // do), and a sender-supplied mention.memberId can drift from the
            // row ("w16-1" vs "w16-1(claude)"), silently no-op'ing the debit
            // (ship testing + adversarial reviews). mentionMemberId is the
            // fallback for degraded tasks with no pinned pane.
            let memberId = '';
            const paneId = task.metadata.to.paneId;
            if (paneId) {
              const pid = panePrincipalId(wsId, paneId);
              memberId =
                st2.channelMembers[channelId]?.find((m) => m.principalId === pid)?.memberId ?? '';
            }
            if (!memberId && typeof md?.['mentionMemberId'] === 'string') {
              memberId = md['mentionMemberId'] as string;
            }
            if (!memberId) continue;
            const dedupKey = `${channelId}|${memberId}`;
            if (reported.has(dedupKey)) continue;
            reported.add(dedupKey);
            void bridge
              .mutateLocal('a2a.channel.nudgeRecorded', {
                channelId,
                verifiedWorkspaceId: wsId,
                memberId,
              })
              .catch(() => undefined);
          }
        },
      }, opts);
    };

    // FIX-MULTI-WS: flush every local workspace's queue. Each per-workspace
    // call early-outs on an empty queue, so the sweep stays cheap; on the
    // Stop path only the pty's OWNER workspace resolves a target (the others
    // no-match on `onlyPtyId`), so flushing all is correct and avoids trusting
    // the lifecycle event's workspace stamp.
    const runFlushAll = (opts: FlushOpts) => {
      for (const wsId of localIds) runFlush(wsId, opts);
    };

    // Map-leak guard (3-model consensus): prune the paste gate's per-pty clocks
    // down to the live leaf ptys. Runs in the tick's `.finally` — poll-outcome
    // independent, so a stretch of failed polls can't let the global pty-data
    // listener grow `lastOutputAt` unbounded (Codex map-leak follow-up).
    const pruneGateToLivePanes = () => {
      const st = useStore.getState();
      const live = new Set<string>();
      for (const wsId of localIds) {
        const ws = st.workspaces.find((w) => w.id === wsId);
        if (ws) {
          for (const leaf of findLeafPanes(ws.rootPane)) {
            for (const s of leaf.surfaces) if (s.ptyId) live.add(s.ptyId);
          }
        }
      }
      prunePasteGateState(pasteGate, live);
    };

    const tick = () => {
      if (disposed || inFlight) return;
      inFlight = true;
      bridge({
        cursor,
        types: ['channel.message', 'agent.lifecycle', 'channel.catalog'],
        max: EVENT_POLL_MAX,
        workspaceId,
        // FIX-MULTI-WS + P5: union scope — every local workspace PLUS the
        // reserved human workspace; the daemon filters by set membership.
        workspaceIds: pollIds,
      })
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
          // 2d amendment: keep pre-mount channel.message events for ROUTING
          // (a mention that arrived while the app was closed must still
          // enqueue — for an attached-Claude target the wake worker declines,
          // so this replay is its ONLY active delivery path). Display/unread
          // stays mount-gated per event below; lifecycle/catalog history is
          // still dropped (stale stops / catalog re-hydrates on mount anyway).
          // Routing is idempotent: persisted handled/delivered sets +
          // deterministic task ids. Applied on EVERY batch — a boot backlog
          // larger than EVENT_POLL_MAX spans multiple polls, and gating this
          // on the first batch let batch 2+ re-inflate badges and route
          // through a not-yet-hydrated pane tree (adversarial review F5).
          // Post-catch-up the filter is a no-op (the cursor is monotonic, so
          // later polls never return pre-mount events).
          result.events = result.events.filter(
            (e) => e.ts >= mountTs || e.type === 'channel.message',
          );
          cursor = result.nextCursor;
          if (result.resync) {
            // FIX-MULTI-WS: recovery below is ACTIVE-workspace display state
            // only — background workspaces keep no display cache, so there is
            // nothing to rebuild for them. A mention that fell out of the ring
            // during the drift is a rare bounded loss (1024-event window),
            // same trade-off as the pre-multi-ws behavior.
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
          // A16 (generalized for FIX-MULTI-WS): compute each workspace's leaf
          // set at most ONCE per poll batch — it can't change mid-batch, and
          // findLeafPanes is a DFS that a busy poll (many channel.message
          // events) would otherwise re-walk per message. Lazy per-workspace
          // cache: only workspaces actually mentioned in this batch pay it.
          const batchLeaves = new Map<string, PaneLeaf[]>();
          const leavesFor = (wsId: string): PaneLeaf[] => {
            const cached = batchLeaves.get(wsId);
            if (cached) return cached;
            const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
            const leaves = ws ? findLeafPanes(ws.rootPane) : [];
            batchLeaves.set(wsId, leaves);
            return leaves;
          };
          for (const event of result.events) {
            // FIX-MULTI-WS: the daemon scoped this batch to the UNION of local
            // workspaces, so an event here may concern a BACKGROUND workspace.
            // Display state is re-filtered to the active workspace; mention
            // routing fans out to every local recipient workspace.
            if (event.type === 'channel.message') {
              const channelEvent = event as ChannelMessageEvent;
              const st = useStore.getState();
              // FIX-MULTI-WS: the pure decision (append-to-active-display +
              // which local workspaces to route the mention into). See
              // planChannelMessageDelivery — display is scoped to human
              // membership (P5), routing fans out to real local workspaces.
              const plan = planChannelMessageDelivery(
                channelEvent.workspaceId,
                channelEvent.recipientWorkspaceIds,
                (channelEvent.message.mentions ?? []).map((m) => m.workspaceId),
                localIds,
                // W1: append-without-recipient ONLY for a mirror row the daemon
                // flagged `observed` (private channel ws-human watches read-only).
                // Mere mirror presence is NOT enough — the ws-human mirror holds
                // every public channel too, and matching on presence leaked
                // non-member public traffic into the dock (GLM P2). Member
                // channels don't need this: the recipient check above covers them.
                st.channels[channelEvent.channelId]?.observed === true,
              );
              // Display cache / unread / mention badges: ACTIVE workspace only,
              // and never for pre-mount ring history (A4 — badge inflation).
              const preMount = event.ts < mountTs;
              if (plan.appendToDisplay && !preMount) st.appendMessageFromEvent(channelEvent.message);
              // Route on REPLAYED events too (no historical drop): a mention
              // that arrived while this poll was down must still enqueue on
              // restart (codex R6). routeChannelMentionToInbox is idempotent
              // (deterministic task id + getTask short-circuit), and the
              // flush's busy check stops a stale replay from pasting into a
              // running agent. Duplicate re-delivery after a FULL renderer
              // reload (transient delivered map lost) is a known trade-off —
              // durable delivery state is a follow-up.
              // #7 + agent-pane redesign: a post that @-mentions a LOCAL
              // workspace becomes an a2a inbox task in THAT workspace — active
              // or not (FIX-MULTI-WS: this is the cross-workspace delivery
              // fix). The router resolves the mention's pinned paneId against
              // that workspace's own live leaves (fail-closed ptyId re-check)
              // and pins to.paneId so a split workspace routes to EXACTLY the
              // mentioned agent; a miss falls back to a ws-level task (any
              // live agent picks it up via role:agent query). Idempotent by
              // per-target deterministic task id.
              for (const wsId of plan.routeWorkspaces) {
                const routeLeaves = leavesFor(wsId);
                // Boot-replay guard: routing a pane-pinned mention through a
                // not-yet-hydrated (empty) pane tree would degrade it to a
                // ws-level badge task. Skip — the events are ring history; the
                // next full reload retries, and the wake worker still covers
                // non-attached-Claude targets via the durable cursor.
                if (preMount && routeLeaves.length === 0) continue;
                routeChannelMentionToInbox(channelEvent.message, wsId, routeLeaves, {
                  getTask: st.getTask,
                  createA2aTask: st.createA2aTask,
                  channelName: (id) => useStore.getState().channels[id]?.name ?? id,
                  workspaceName: (id) =>
                    useStore.getState().workspaces.find((w) => w.id === id)?.name ?? id,
                  publish: publishA2aTask,
                  isHandled: isChannelMentionHandled,
                  markHandled: markChannelMentionHandled,
                  // 2d: lets the route guard re-route a pane-targeted mention
                  // that was routed-but-never-pasted before a reload.
                  isDeliveredPersisted: isChannelMentionDeliveredPersisted,
                });
              }
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
              // FIX-MULTI-WS: the stop may belong to a BACKGROUND workspace's
              // pane — flush all local queues; only the pty's owner matches.
              if (ev.kind === 'agent.stop') {
                runFlushAll({ onlyPtyId: ev.ptyId });
              }
            } else if (event.type === 'channel.catalog') {
              // A1: a channel's catalog/membership changed (create/archive/join/
              // leave/kick/invite — by us or another client). Flag a one-shot
              // re-hydrate after the batch so the sidebar + roster re-sync
              // instead of going silently stale (the audit's top structural gap:
              // 6 of 7 mutations used to emit nothing).
              // FIX-MULTI-WS: hydration is membership-scoped to the ACTIVE
              // workspace (setChannels is a full replace — hydrating for a
              // background workspace would clobber the active view), so only
              // an active-relevant catalog event triggers it. A background
              // workspace's catalog is rebuilt on switch.
              // P5: catalog re-hydrates on any change touching the human seat
              // or broadcast — the human's catalog is ws-human-scoped, so an
              // active-workspace-only catalog change is not the human's view.
              const ce = event as ChannelCatalogEvent;
              if (
                ce.recipientWorkspaceIds.includes('*') ||
                ce.workspaceId === workspaceId ||
                ce.recipientWorkspaceIds.includes(workspaceId)
              ) {
                sawCatalog = true;
              }
            }
          }
          // Idle-immediate + A3 sweep: deliver any queued mention to a now-idle
          // pane. Runs EVERY poll (not only on a new message) so a mention queued
          // while its target pane read as 'unknown' (fail-closed busy) is retried
          // once that pane resolves to idle — without this, A3's fail-closed left
          // such mentions undelivered forever (GLM P2). The per-workspace
          // early-out in runFlush keeps an empty-queue tick cheap.
          runFlushAll({});
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
          pruneGateToLivePanes();
        });
    };

    const timer = setInterval(tick, EVENT_POLL_INTERVAL_MS);
    // Fire one tick immediately so the first batch arrives within ~1s
    // of mount rather than waiting for the first interval.
    tick();

    return () => {
      disposed = true;
      clearInterval(timer);
      removePtyDataListener?.();
    };
    // FIX-MULTI-WS: allWorkspaceIds rebuilds the loop (and its union scope)
    // when a workspace is added/removed — a NEW workspace must join the poll
    // scope or its mentions would silently drop until the next remount. P5: the
    // active workspace no longer affects display, so it is not a dependency (no
    // poll restart on workspace switch).
  }, [allWorkspaceIds]);
}
