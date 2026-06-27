// ─── Channel mention → a2a inbox routing (Phase 2 #7) ────────────────────
//
// Channels have no agent-read path yet (channel_history is deferred), so an
// agent never *sees* a channel post — even one that @-mentions it. This module
// bridges that gap WITHOUT a new agent surface: when a channel.message that
// mentions the current workspace lands in the renderer (the same event that
// drives the dock badge in #6), we mint an a2a task addressed to this
// workspace. The agent then receives it through its NORMAL inbox poll
// (`a2a_task_query` / `wmux_events_poll` for `a2a.task`) and can reply with
// `channel_post` (#8). We reuse the a2a task infrastructure rather than invent
// a parallel channel-mention event type.
//
// Trust: the mention set is server-validated (ChannelService.post keeps only
// current-member mentions, frozen at critical-section entry), so `from`
// (= the post's sender workspace) is the daemon's authoritative sender, not a
// renderer-forgeable value. The mentioned workspace's own renderer is the one
// that observes the event and creates the task — `to` is always self.
//
// Routing granularity: WORKSPACE-LEVEL. The task carries no `to.paneId`, so any
// agent in the mentioned workspace picks it up via `a2a_task_query(role:agent)`
// — robust to splits (multiple panes/agents in one workspace) without guessing
// which pane "owns" the mention.
//
// Idempotency: the task id is deterministic (`chmention-<channelId>-<seq>`), so
// event re-delivery (resync replay, double poll) is a no-op — `getTask` short-
// circuits before a duplicate task or a duplicate `a2a.task` event is emitted.

import type { ChannelMessage } from '../../shared/channels';
import type { Task, Message, Part, Artifact, TaskState } from '../../shared/types';

/** Dependencies injected so the routing logic stays a pure, unit-testable
 *  function (no store / window coupling). The hook wires these to the real
 *  store actions + EventBus publisher. */
export interface MentionInboxDeps {
  /** Look up an existing task by id (idempotency guard). */
  getTask: (taskId: string) => Task | undefined;
  /** Create the inbox task; returns its id. Mirrors `a2aSlice.createA2aTask`. */
  createA2aTask: (task: {
    id?: string;
    title: string;
    from: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
    to: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
    history: Message[];
    artifacts: Artifact[];
  }) => string;
  /** Resolve a channel's display name (falls back to the id). */
  channelName: (channelId: string) => string;
  /** Resolve a workspace's display name (falls back to the id). */
  workspaceName: (workspaceId: string) => string;
  /** Emit the dual-party `a2a.task` pointer (events/publisher.publishA2aTask). */
  publish: (
    from: string,
    to: string,
    taskId: string,
    state: TaskState,
    kind: 'created' | 'updated' | 'cancelled',
  ) => void;
}

/** Deterministic task id for a channel mention — idempotent across event
 *  re-delivery. Exported for the test + any future reconciliation. */
export function channelMentionTaskId(channelId: string, seq: number): string {
  return `chmention-${channelId}-${seq}`;
}

/**
 * Route one channel.message into the a2a inbox iff it @-mentions `selfWorkspaceId`.
 * Returns the created task id, or `null` when nothing was routed (not mentioned,
 * self-posted, or already routed). Never throws — a routing failure must not
 * break the channel message dispatch that drives the UI.
 */
export function routeChannelMentionToInbox(
  message: ChannelMessage,
  selfWorkspaceId: string,
  deps: MentionInboxDeps,
): string | null {
  // Only act on a mention of THIS workspace.
  if (!message.mentions?.some((m) => m.workspaceId === selfWorkspaceId)) return null;
  // Never ping yourself — a post this workspace authored that happens to carry
  // a self mention (composer excludes self, but a non-UI client could include
  // it; the daemon validates membership, not self-exclusion).
  if (message.workspaceId === selfWorkspaceId) return null;

  const taskId = channelMentionTaskId(message.channelId, message.seq);
  // Idempotent: a re-delivered event (resync replay / overlapping poll) must
  // not mint a second task or re-emit the pointer.
  if (deps.getTask(taskId)) return null;

  const chName = deps.channelName(message.channelId);
  const parts: Part[] = [{ kind: 'text', text: message.text }];
  const history: Message[] = [
    {
      kind: 'message',
      // Deterministic message id mirrors the task id's idempotency intent.
      messageId: `chmention-msg-${message.channelId}-${message.seq}`,
      role: 'user',
      parts,
      metadata: {
        source: 'channel-mention',
        channelId: message.channelId,
        seq: message.seq,
      },
    },
  ];

  try {
    deps.createA2aTask({
      id: taskId,
      title: `#${chName} — mention from ${message.memberName}`,
      from: { workspaceId: message.workspaceId, name: message.memberName },
      to: { workspaceId: selfWorkspaceId, name: deps.workspaceName(selfWorkspaceId) },
      history,
      artifacts: [],
    });
    // Emit AFTER the store write so a poller that follows the pointer can
    // immediately query the task (created-before-queryable race guard — same
    // ordering rule as the a2a.task.send path).
    deps.publish(message.workspaceId, selfWorkspaceId, taskId, 'submitted', 'created');
  } catch {
    // Best-effort: never let inbox routing break channel message dispatch.
    return null;
  }
  return taskId;
}
