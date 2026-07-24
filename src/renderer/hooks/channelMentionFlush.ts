// ─── Channel mention flush — Stop-triggered PTY delivery (P1 autoresponse) ────
//
// `channelMentionInbox.ts` queues an @-mention as an a2a inbox task but never
// touches the agent's terminal — the agent only sees it if it voluntarily runs
// `a2a_task_query`. This module is the "call → it answers" half: it pastes a
// ONE-LINE nudge into the mentioned pane's PTY at a SAFE moment (the agent's
// turn boundary / Stop, or right now if the pane is idle), so the agent picks
// the mention up as its next prompt and replies via `channel_post`.
//
// Why this is Stop-triggered, not paste-on-arrival (outside-voice redesign):
//   - `submitBracketedPasteToPty` submits with `\r` ~100ms after the paste, so
//     pasting into a BUSY agent injects text mid-turn and corrupts its input.
//   - A mention pasted into the working context also makes the agent spend its
//     task tokens on an unrelated channel ping (consumptive context).
//   So we leave the mention QUEUED (no paste) while the agent is busy, and
//   deliver only when it goes idle: either on its Stop lifecycle event (the
//   `agent.stop` we observe via events.poll) or immediately if it is already
//   idle at mention-arrival time. The body stays in the task store; the nudge
//   just points at it (`a2a_task_query <id>`) — the agent fetches the full text
//   only if it chooses to (context-cheap, like Claude Code's `/btw`).
//
// Pure + dependency-injected so it unit-tests without a store/window. The hook
// (`useChannelsEventSubscription`) wires the real store actions + PTY writer.

import type { Task, PaneLeaf } from '../../shared/types';
import { resolvePaneAddress, resolveSenderPaneAddress } from './a2aAddressing';

/** Task-id prefix minted by `channelMentionTaskId` (channelMentionInbox.ts). A
 *  channel-mention inbox task is identified structurally by this prefix — no
 *  separate metadata flag needed. */
export const CHANNEL_MENTION_TASK_PREFIX = 'chmention-';

export function isChannelMentionTask(taskId: string): boolean {
  return taskId.startsWith(CHANNEL_MENTION_TASK_PREFIX);
}

/**
 * Force a string onto a SINGLE line. A nudge is pasted into a live agent's
 * input box, so any CR/LF/TAB/ESC/NUL would either submit early (`\r`) or forge
 * a terminal control sequence. Collapse every control char to a space and
 * squeeze runs — the nudge is one line, period.
 */
function singleLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build the one-line nudge for one or more pending mentions to the SAME pane.
 * Carries the task title (channel + sender, from `channelMentionInbox`) and
 * tells the agent to run `a2a_task_query role:agent` to read the queued
 * mention(s). a2a_task_query filters by status/role and does NOT accept a task
 * id (codex R7), so the nudge points at the query — not an id. Several mentions
 * to one pane collapse into ONE nudge (one paste) so a Stop never floods the
 * prompt with N lines.
 *
 * NB: deliberately NOT `buildA2aNudge` (useRpcBridge.ts) — its `id8` slices the
 * first 8 chars after stripping a `task` prefix, which on a `chmention-…` id
 * yields the garbage `chmentio`; this channel-specific formatter keeps the
 * channel/sender context instead.
 */
export function buildChannelMentionNudge(
  tasks: Array<
    Pick<Task, 'id'> & {
      metadata: Pick<Task['metadata'], 'title'> & { to?: Task['metadata']['to'] };
      history?: Task['history'];
    }
  >,
): string {
  // B7: the nudge is pasted into a live agent's prompt and AUTO-SUBMITTED (the
  // trailing \r in submitBracketedPasteToPty), so it must NOT interpolate
  // sender-controlled free text (memberName) — a crafted name is a prompt-
  // injection vector into another agent. Carry only the channel name (validated
  // [a-z0-9-]) extracted from the task title; the sender + body live in the task
  // and are read via the a2a_task_query the nudge points at, where they are
  // treated as untrusted channel content rather than as the nudge command line.
  // Splitting strips memberName only for well-formed titles. A persisted/malformed
  // title without the delimiter would otherwise paste the WHOLE title into the
  // auto-submitted nudge — re-validate the `#channel` shape and fall back safely.
  const rawChannelLabel = tasks[0]?.metadata.title.split(' — mention from ')[0] ?? '';
  const validLabel = /^#[a-z0-9-]+$/u.test(rawChannelLabel);
  const channelLabel = validLabel ? rawChannelLabel : '`#channel`';
  // 2a-1 (shared-completion audit): the nudge used to point ONLY at
  // a2a_task_query — nothing ever told the agent to advance its CHANNEL cursor,
  // so the wake worker kept re-nudging (and eventually false-"exhausted") an
  // agent that had already replied. Close the loop with an explicit ack command.
  // Injection-safe by construction: channel name is regex-validated above, seq
  // is a server-assigned integer from route-time metadata, and the member id is
  // allow-listed to quote-free chars before being single-quoted.
  const seqs = tasks
    .map((t) => {
      const md = t.history?.[0]?.metadata as Record<string, unknown> | undefined;
      const s = md?.['seq'];
      return typeof s === 'number' && Number.isSafeInteger(s) && s > 0 ? s : null;
    })
    .filter((s): s is number => s !== null);
  const sameChannel = tasks.every(
    (t) => (t.metadata.title.split(' — mention from ')[0] ?? '') === rawChannelLabel,
  );
  const memberIds = new Set(
    tasks.map((t) => {
      const md = t.history?.[0]?.metadata as Record<string, unknown> | undefined;
      const m = md?.['mentionMemberId'];
      return typeof m === 'string' ? m : '';
    }),
  );
  const soleMemberId = memberIds.size === 1 ? [...memberIds][0] : '';
  // --member pins the ACK to the mentioned member's cursor — only safe when
  // every task in the group is still addressed to that member's OWN pane. A
  // degraded delivery may land on a DIFFERENT agent; acking the intended
  // member's cursor from there would erase their unread and stop the wake
  // worker's retry toward them (adversarial review F4). Un-pinned groups ack
  // the delivering agent's own row instead (the CLI resolves it).
  const allPanePinned = tasks.every((t) => !!t.metadata.to?.paneId);
  const memberFlag =
    allPanePinned && soleMemberId && /^[A-Za-z0-9()._-]+$/.test(soleMemberId)
      ? ` --member '${soleMemberId}'`
      : '';
  const ackHint =
    validLabel && sameChannel && seqs.length === tasks.length && seqs.length > 0
      ? `then ack: fmux channel ack ${channelLabel.slice(1)} ${Math.max(...seqs)}${memberFlag}`
      : 'then ack: fmux channel unread';
  // Dogfood RCA 2026-07-05 (no-signal greeting loop): the nudge used to say
  // "read + reply", which — pasted and AUTO-SUBMITTED into the agent's prompt —
  // forced a reply to EVERY mention, so a greeting drew a greeting, which
  // @-mentioned the peer, which drew another greeting… with no stop condition.
  // ack (above) ends the MECHANICAL re-nudge of one message; this reply-gate
  // ends the SEMANTIC loop: acknowledge/greeting mentions are read + acked but
  // NOT answered. Reply is now the agent's judgement (a real question/task),
  // not a reflex. The peer/human still gets nothing to reply to → the chain dies.
  const replyGate =
    'Reply via channel_post ONLY if it needs an answer (a question or task); do NOT reply to greetings or acknowledgements.';
  if (tasks.length === 1) {
    return singleLine(
      `[fmux-channel] mention in ${channelLabel} — read: a2a_task_query role:agent, ${ackHint}. ${replyGate}`,
    );
  }
  return singleLine(
    `[fmux-channel] ${tasks.length} channel mentions — read: a2a_task_query role:agent, ${ackHint}. ${replyGate}`,
  );
}

/**
 * Resolve a queued mention task to the live ptyId it should be auto-delivered
 * to, WITHIN the receiving workspace's own leaves (fail-closed). ONLY
 * pane-pinned tasks are auto-delivered:
 *   - `to.paneId` pinned → that pane's terminal pty, but ONLY if the route-time
 *     ptyId snapshot (`to.ptyId`) still matches the pane's live pty. A restarted
 *     pane (its pty replaced, a successor agent now holding it) fails closed to
 *     null so we never paste the old mention into the wrong agent (codex R5).
 *   - ws-level task (no paneId): delivered ONLY when the workspace has EXACTLY
 *     ONE live agent pane (2b — mirrors the wake worker's `eligible.length ===
 *     1` discipline: never guess between two agents). A ws-level chmention is
 *     EITHER a human/legacy mention OR a degraded pane-target whose pane
 *     vanished/restarted (`routeChannelMentionToInbox` strips paneId on a
 *     gone/changed pane). With a single live agent there is no wrong pane to
 *     hit — and this closes the zero-delivery hole where an attached-Claude
 *     workspace's ws-level mention had NO active delivery path at all (the
 *     wake worker declines attached Claude; this path used to decline
 *     everything ws-level). Multi-agent workspaces keep the conservative
 *     queue-only behavior (dock badge + self-driven `a2a_task_query`).
 * Returns null when there is no validated pane target — the caller leaves the
 * task queued.
 */
export function resolveTaskTargetPty(
  task: Task,
  leaves: PaneLeaf[],
  agentPtys?: ReadonlySet<string>,
): string | null {
  const to = task.metadata.to;
  if (!to.paneId) {
    // 2b applies ONLY to a DEGRADED pane target: the mention pinned a pane at
    // post time (mentionPaneId stamped at route time) but the pane restarted /
    // vanished before delivery. A ws-level mention BY CONSTRUCTION (human
    // mention, member_id omitted over MCP, deliberate workspace ping) stays
    // badge-only — auto-pasting it into "the one live agent" is how a message
    // meant for the human reached an agent PTY (adversarial review F1).
    const md = task.history?.[0]?.metadata as Record<string, unknown> | undefined;
    if (typeof md?.['mentionPaneId'] !== 'string' || !md['mentionPaneId']) return null;
    if (!agentPtys || agentPtys.size === 0) return null;
    const candidates: string[] = [];
    for (const leaf of leaves) {
      for (const s of leaf.surfaces) {
        if (s.ptyId && agentPtys.has(s.ptyId)) candidates.push(s.ptyId);
      }
    }
    return candidates.length === 1 ? candidates[0] : null;
  }
  if (to.ptyId) {
    // Resolve by the route-time ptyId snapshot, NOT paneId+active-surface: a pane
    // can hold several terminal surfaces and resolvePaneAddress(paneId-only) picks
    // the active/first one, which may not be the originally-mentioned agent —
    // leaving a still-alive mention queued forever (CodeRabbit review). Deliver
    // ONLY when that exact pty is still live in the SAME pane; a restarted pane
    // (pty replaced, a successor agent now holding it) fails closed to null so we
    // never paste the old mention into the wrong agent (codex round-5 P2).
    const addr = resolveSenderPaneAddress(leaves, to.ptyId);
    return addr && addr.paneId === to.paneId ? addr.ptyId : null;
  }
  // No ptyId snapshot (legacy/human pane target): resolve by paneId/surfaceId.
  const r = resolvePaneAddress(leaves, to.paneId, to.surfaceId ?? '');
  if ('error' in r) return null;
  return r.ptyId;
}

/** Injected store/PTY dependencies — keeps `flushMentions` pure + testable. */
export interface FlushMentionDeps {
  /** Undelivered channel-mention tasks (chmention-*, non-terminal, not yet
   *  pasted) for this workspace. From a2aSlice.getUndeliveredChannelMentionTasks. */
  getUndeliveredChannelMentionTasks: (workspaceId: string) => Task[];
  /** True when the pty hosts a BUSY agent whose input must not be disturbed
   *  ('running' or 'awaiting_input'). Skipped under `requireIdle` so the mention
   *  waits for that agent's Stop. NOTE: 'waiting' (turn ended, ready for input)
   *  is NOT busy — it must receive immediately, else a quiet agent never sees
   *  the mention until its next user-driven turn. */
  isBusy: (ptyId: string) => boolean;
  /** Paste the one-line nudge into the pty (submitBracketedPasteToPty). The
   *  initial bracketed-paste write is SYNCHRONOUS — a throw there leaves the
   *  task UNMARKED so the next Stop retries. The trailing CR submit (~100ms
   *  later) is async and not awaited; if only THAT fails, the text is pasted but
   *  unsubmitted (a partial, not a silent loss). This synchronous-throw contract
   *  is what keeps mark-after-deliver correct (GLM review). */
  deliverNudge: (ptyId: string, text: string) => void;
  /** Mark a task delivered so it is never pasted twice (idempotency). Called
   *  ONLY after a successful deliverNudge. */
  markDelivered: (taskId: string) => void;
  /** A5 loop-breaker: true if this pane has been auto-nudged too many times in
   *  the recent window — suppress the nudge (the task stays queued + pullable).
   *  Optional for back-compat with callers/tests that don't wire it. */
  isRateLimited?: (ptyId: string) => boolean;
  /** Record a delivered auto-nudge toward the rate cap (after a successful
   *  deliverNudge). Optional (paired with isRateLimited). */
  recordNudge?: (ptyId: string) => void;
  /** 2b: ptys currently hosting a DETECTED agent (surfaceAgent keys ∩ live leaf
   *  ptys), used only by the ws-level single-agent delivery rule. Optional —
   *  absent keeps the conservative "ws-level never auto-pastes" behavior. */
  agentPtys?: ReadonlySet<string>;
  /** 2a-2/2d: called after a successful paste with the tasks it covered.
   *  The wiring persists the durable delivered mark AND reports the nudge to
   *  the daemon wake worker's shared ledger (so the worker's re-nudge budget
   *  counts the renderer's paste instead of double-pasting). Best-effort:
   *  a throw here must not affect delivery bookkeeping. */
  onNudgeDelivered?: (ptyId: string, tasks: Task[]) => void;
}

export interface FlushOpts {
  /**
   * Restrict the flush to tasks whose target pty === this id. Set on the Stop
   * path (one pane just stopped) so a Stop for pane A never delivers pane B's
   * still-queued mentions. Absent on the arrival path (scan every target).
   */
  onlyPtyId?: string;
}

/**
 * Deliver queued channel mentions to their target panes. Two entry points share
 * this one function:
 *   - Stop:    flushMentions(ws, leaves, deps, { onlyPtyId: ptyId })
 *   - Arrival: flushMentions(ws, leaves, deps, {})
 *
 * Mentions queued for the SAME pane collapse into one nudge (one paste). A
 * paste throw leaves that pane's tasks unmarked (retried on the next Stop);
 * other panes are unaffected. Returns the task ids actually delivered (test aid).
 */
export function flushMentions(
  workspaceId: string,
  selfLeaves: PaneLeaf[],
  deps: FlushMentionDeps,
  opts: FlushOpts,
): string[] {
  const tasks = deps.getUndeliveredChannelMentionTasks(workspaceId);
  // Group by resolved target pty so multiple mentions to one pane = one paste.
  const byPty = new Map<string, Task[]>();
  for (const task of tasks) {
    const ptyId = resolveTaskTargetPty(task, selfLeaves, deps.agentPtys);
    if (!ptyId) continue; // human / dead / stale pane → leave queued, no paste
    if (opts.onlyPtyId && ptyId !== opts.onlyPtyId) continue; // other pane's Stop
    // ALWAYS gate on the CURRENT busy status, even on the Stop path: lifecycle
    // events are consumed up to ~1s late by the poll loop, so by the time we see
    // an agent.stop the pty may have started a new turn. The live surfaceAgent
    // status (immediate IPC, lands before the polled stop) is the source of
    // truth — 'running' here means a genuinely new turn, skip it (codex R7 P1).
    if (deps.isBusy(ptyId)) continue;
    const arr = byPty.get(ptyId);
    if (arr) arr.push(task);
    else byPty.set(ptyId, [task]);
  }
  const delivered: string[] = [];
  for (const [ptyId, group] of byPty) {
    // A5: rate-BOUND the auto-nudge if this pane has been nudged too often
    // lately. This caps the RATE (not a hard stop) — once the burst subsides the
    // window clears and auto-nudges resume; a true per-message chain depth isn't
    // trackable (agents post freely). The tasks stay queued + unmarked so the
    // agent can still pull them via a2a_task_query — only the automatic paste is
    // withheld. NOTE: this can't distinguish a 1:1 ping-pong from legit fan-in
    // (many senders → one pane); both are bounded. Log it (don't suppress
    // silently — that's the very failure pattern this sprint is fixing).
    if (deps.isRateLimited?.(ptyId)) {
      console.warn(
        `[channelMentionFlush] auto-nudge rate-capped for pty ${ptyId} — ${group.length} mention(s) stay queued (pull via a2a_task_query)`,
      );
      continue;
    }
    const nudge = buildChannelMentionNudge(group);
    try {
      deps.deliverNudge(ptyId, nudge);
      deps.recordNudge?.(ptyId); // count this nudge toward the per-pane cap (A5)
      // Mark ONLY after a successful paste — a throw above retries next Stop.
      for (const t of group) {
        deps.markDelivered(t.id);
        delivered.push(t.id);
      }
      // 2a-2/2d side effects AFTER the marks — isolated so a throw here can
      // never make an already-pasted group look undelivered (double paste).
      try {
        deps.onNudgeDelivered?.(ptyId, group);
      } catch (hookErr) {
        console.warn(`[channelMentionFlush] onNudgeDelivered hook failed for pty ${ptyId}:`, hookErr);
      }
    } catch (err) {
      // Best-effort: a bad pty must not abort other panes' delivery. Log for
      // observability — a silent failure here reads as "the agent never
      // answered" with no breadcrumb (Claude+GLM review). The task stays
      // unmarked, so the next Stop retries it.
      console.warn(`[channelMentionFlush] nudge delivery failed for pty ${ptyId}:`, err);
    }
  }
  return delivered;
}
