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
  tasks: Array<Pick<Task, 'id'> & { metadata: Pick<Task['metadata'], 'title'> }>,
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
  const channelLabel = /^#[a-z0-9-]+$/u.test(rawChannelLabel) ? rawChannelLabel : '`#channel`';
  if (tasks.length === 1) {
    return singleLine(
      `[wmux-channel] new mention in ${channelLabel} — run a2a_task_query role:agent to read`,
    );
  }
  return singleLine(
    `[wmux-channel] ${tasks.length} new channel mentions — run a2a_task_query role:agent to read`,
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
 *   - ws-level task (no paneId) → null. A ws-level chmention is EITHER a
 *     human/legacy mention OR a degraded pane-target whose pane vanished
 *     (`routeChannelMentionToInbox` strips paneId on a gone/changed pane to
 *     avoid wrong-pane delivery). We cannot tell them apart, so auto-pasting to
 *     the active pane would reintroduce exactly that wrong-pane delivery
 *     (codex P2). ws-level tasks stay queued (dock badge) for the human or a
 *     self-driven `a2a_task_query` — they are never auto-pasted.
 * Returns null when there is no validated pane target — the caller leaves the
 * task queued.
 */
export function resolveTaskTargetPty(task: Task, leaves: PaneLeaf[]): string | null {
  const to = task.metadata.to;
  if (!to.paneId) return null;
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
    const ptyId = resolveTaskTargetPty(task, selfLeaves);
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
