// Handing an issue or PR from the Git page to an agent, main side.
//
// Send: record a work link for the item (origin issue / pr, owner = the
// target pane), then send it as a new A2A task to that pane over the
// operator lane (so the task joins the link) with the gated delivery: the
// renderer pastes only into a live agent, main waits until nobody is typing
// in the pane, and checks right before the paste and the Enter that the same
// agent is still there and nobody typed, under a deadline. The text is the
// fixed reference from buildHandoffMessage, never the issue's own text. A send
// that was not delivered cancels its task, so the item is free to send again.
//
// Start in a new worktree: the existing fan-out path from the repo's
// workspace, branch issue-<n>-<slug> (pr-<n>-<suffix> for a PR), the same
// fixed reference as the prompt, and the work link updated with the worktree
// and the agent. The fan-out mission's ledger states then move that link
// (watchHandoffWorktreeLinks).
//
// Either way, an item already linked to work in progress is refused unless
// the caller says to send anyway, and one item is handed off at a time.
import { randomUUID } from 'node:crypto';
import { parseIssueRef, serializeIssueRef } from '../../shared/issueRef';
import { parsePrDragRef, serializePrDragRef } from '../../shared/prDragRef';
import { HUMAN_WORKSPACE_ID } from '../../shared/channels';
import {
  buildHandoffMessage,
  issueBranchName,
  sanitizeHandoffTitle,
  type HandoffInProgress,
  type HandoffRef,
  type HandoffSendRequest,
  type HandoffSendResult,
  type HandoffStartRequest,
  type HandoffStartResult,
  type HandoffTarget,
} from '../../shared/gitHandoff';
import type { WorkLink, WorkLinkFilter, WorkLinkReason, WorkLinkState } from '../../shared/workLink';
import type { LedgerStatus } from '../../shared/ledger';
import type { WorkLinkUpsert } from '../workLink/workLinkStore';
import type { FanOutRequest, FanOutResult } from '../worktask/FanOutService';

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** States that mean work on the item is under way. */
const ACTIVE: WorkLinkState[] = ['queued', 'running', 'needs-you', 'blocked'];
/** The only host the Git page reads from. */
const HANDOFF_HOST = 'github.com';
/** The longest agent command accepted for a new worktree. */
const AGENT_CMD_MAX = 1_000;

export interface HandoffDeps {
  /** The operator-lane RPC (a2a.task.send, a2a.task.cancel). */
  invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  links: {
    list: (filter: WorkLinkFilter) => WorkLink[];
    upsert: (input: WorkLinkUpsert) => Promise<WorkLink | null>;
    setState: (id: string, state: WorkLinkState, reason?: WorkLinkReason) => Promise<WorkLink | null>;
  };
  startFanOut: (req: FanOutRequest) => Promise<FanOutResult>;
}

/** The item, re-validated (refs are re-derived from their URLs, github.com
 *  only), or null. */
export function parseHandoffRef(raw: unknown): HandoffRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, ref } = raw as { kind?: unknown; ref?: unknown };
  if (!ref || typeof ref !== 'object') return null;
  try {
    if (kind === 'issue') {
      const r = parseIssueRef(serializeIssueRef(ref as never));
      return r && r.host.toLowerCase() === HANDOFF_HOST ? { kind, ref: r } : null;
    }
    if (kind === 'pr') {
      const r = parsePrDragRef(serializePrDragRef(ref as never));
      return r && r.host.toLowerCase() === HANDOFF_HOST ? { kind, ref: r } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** The target pane from untrusted input, or null. */
export function parseHandoffTarget(raw: unknown): HandoffTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
  const workspaceId = str(t.workspaceId);
  const paneId = str(t.paneId);
  const ptyId = str(t.ptyId);
  if (!workspaceId || !paneId || !ptyId) return null;
  const agentName = typeof t.agentName === 'string' ? t.agentName.slice(0, 80) : '';
  const surfaceId = str(t.surfaceId);
  const agentSlug = typeof t.agentSlug === 'string' && /^[a-z0-9-]{1,32}$/.test(t.agentSlug) ? t.agentSlug : undefined;
  return { workspaceId, paneId, ptyId, agentName, ...(surfaceId ? { surfaceId } : {}), ...(agentSlug ? { agentSlug } : {}) };
}

/** The agent command for a new worktree: the fan-out dialog's rule (trimmed,
 *  `claude` when none is given), refusing what cannot be one command line. */
export function parseAgentCmd(raw: unknown): { ok: true; cmd: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, cmd: 'claude' };
  if (typeof raw !== 'string') return { ok: false, message: 'the agent command must be text' };
  const cmd = raw.trim();
  if (!cmd) return { ok: true, cmd: 'claude' };
  // eslint-disable-next-line no-control-regex -- control characters are what is refused
  if (/[\u0000-\u001f\u007f]/.test(cmd)) return { ok: false, message: 'the agent command cannot hold line breaks or control characters' };
  if (cmd.length > AGENT_CMD_MAX) return { ok: false, message: 'the agent command is too long' };
  return { ok: true, cmd };
}

const keyed = (h: HandoffRef) => ({ host: h.ref.host, owner: h.ref.owner, repo: h.ref.repo, number: h.ref.number });
const filterOf = (h: HandoffRef, states?: WorkLinkState[]): WorkLinkFilter =>
  h.kind === 'issue' ? { issue: keyed(h), ...(states ? { states } : {}) } : { pr: keyed(h), ...(states ? { states } : {}) };

/** One key per item, whatever the case of its URL. */
export function handoffKey(h: HandoffRef): string {
  return `${h.kind}:${h.ref.host}/${h.ref.owner}/${h.ref.repo}#${h.ref.number}`.toLowerCase();
}

/** Work in progress on the item: a link that is running, waiting on someone,
 *  blocked, or queued with a task or a worktree behind it. */
export function findInProgress(links: HandoffDeps['links'], h: HandoffRef): HandoffInProgress | null {
  const live = links.list(filterOf(h, ACTIVE)).find((l) => l.state !== 'queued' || !!l.a2aTaskId || !!l.worktree);
  return live ? { linkId: live.id, workspaceId: live.owner.workspaceId, state: live.state } : null;
}

/** A link already recorded for the item with nothing behind it yet (no task,
 *  no worktree, still queued), which a new hand-off takes over instead of
 *  starting a twin. */
export function findReusableLink(links: HandoffDeps['links'], h: HandoffRef): WorkLink | null {
  return links.list(filterOf(h, ['queued'])).find((l) => !l.a2aTaskId && !l.worktree) ?? null;
}

function linkFields(h: HandoffRef): Pick<WorkLinkUpsert, 'origin' | 'issue' | 'pr' | 'title'> {
  const title = sanitizeHandoffTitle(h.ref.title);
  if (h.kind === 'issue') return { origin: 'issue', issue: h.ref, title };
  const { host, owner, repo, number, url } = h.ref;
  return { origin: 'pr', pr: { host, owner, repo, number, url }, title };
}

const taskTitle = (h: HandoffRef) => `${h.kind === 'issue' ? 'Issue' : 'PR'} ${h.ref.owner}/${h.ref.repo}#${h.ref.number}`;

/** Items being handed off right now: a second hand-off of the same one is
 *  refused, never run alongside. */
const inFlight = new Set<string>();

const BUSY = 'this item is already being handed off; try again in a moment';

async function reserved<T>(h: HandoffRef, busy: () => T, run: () => Promise<T>): Promise<T> {
  const key = handoffKey(h);
  if (inFlight.has(key)) return busy();
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}

/** A send that delivered nothing: cancel its task so the link reads abandoned
 *  (and a retry is not blocked by it); close the link by hand if the cancel
 *  did not take. */
async function releaseUndelivered(deps: HandoffDeps, linkId: string | undefined, taskId: string | undefined): Promise<void> {
  let cancelled = false;
  if (taskId) {
    const res = (await deps.invoke('a2a.task.cancel', { taskId, workspaceId: HUMAN_WORKSPACE_ID }).catch(() => null)) as
      | { ok?: boolean; result?: { ok?: unknown } }
      | null;
    cancelled = !!res && res.ok !== false && res.result?.ok === true;
  }
  if (!cancelled && linkId) await deps.links.setState(linkId, 'abandoned', 'other').catch(() => null);
}

export async function sendHandoff(deps: HandoffDeps, raw: unknown): Promise<HandoffSendResult> {
  const req = (raw ?? {}) as Partial<HandoffSendRequest>;
  const item = parseHandoffRef(req.item);
  const target = parseHandoffTarget(req.target);
  if (!item || !target) return { ok: false, code: 'invalid', message: 'not a GitHub issue or PR and an agent pane' };
  return reserved<HandoffSendResult>(item, () => ({ ok: false, code: 'refused', message: BUSY }), async () => {
    if (req.force !== true) {
      const busy = findInProgress(deps.links, item);
      if (busy) return { ok: false, code: 'in-progress', inProgress: busy };
    }
    const reuse = findReusableLink(deps.links, item);
    const link = await deps.links.upsert({
      ...(reuse ? { id: reuse.id } : {}),
      ...linkFields(item),
      owner: { workspaceId: target.workspaceId, paneId: target.paneId },
      ...(target.agentSlug ? { agent: target.agentSlug } : {}),
    }).catch(() => null);
    const message = buildHandoffMessage(item, typeof req.note === 'string' ? req.note : undefined);
    const res = (await deps.invoke('a2a.task.send', {
      workspaceId: HUMAN_WORKSPACE_ID,
      to: target.workspaceId,
      paneId: target.paneId,
      ...(target.surfaceId ? { surfaceId: target.surfaceId } : {}),
      title: taskTitle(item),
      message,
      ...(link ? { workLinkId: link.id } : {}),
      gatedDelivery: true,
      // Paste the fixed reference itself, not a "query the task" nudge.
      referenceDelivery: true,
    }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))) as {
      ok?: boolean;
      error?: string;
      result?: { taskId?: unknown; error?: unknown; delivery?: { notified?: unknown; hint?: unknown; reason?: unknown } };
    };
    if (!res || res.ok === false) {
      await releaseUndelivered(deps, link?.id, undefined);
      return { ok: false, code: 'error', message: res?.error ?? 'the send failed' };
    }
    const result = res.result ?? {};
    if (typeof result.error === 'string') {
      await releaseUndelivered(deps, link?.id, undefined);
      return { ok: false, code: 'refused', message: result.error };
    }
    const taskId = typeof result.taskId === 'string' ? result.taskId : undefined;
    const delivered = result.delivery?.notified === true;
    const hint = typeof result.delivery?.hint === 'string' ? result.delivery.hint : undefined;
    const why = result.delivery?.reason;
    const reason = !delivered && typeof why === 'string' && /^[a-z_]{1,40}$/.test(why) ? why : undefined;
    if (!delivered) await releaseUndelivered(deps, link?.id, taskId);
    return {
      ok: true,
      linkId: link?.id ?? '',
      ...(taskId ? { taskId } : {}),
      delivered,
      ...(hint ? { note: hint } : {}),
      ...(reason ? { reason } : {}),
    };
  });
}

/** The worktree branch: issue-<n>-<slug>, or pr-<n>-<suffix> (a PR can be
 *  started more than once, and git refuses a branch that exists). */
export function handoffBranch(h: HandoffRef, suffix: () => string = () => randomUUID().slice(0, 6)): string {
  return h.kind === 'issue' ? issueBranchName(h.ref.number, h.ref.title) : `pr-${h.ref.number}-${suffix()}`;
}

export async function startHandoffWorktree(deps: HandoffDeps, raw: unknown): Promise<HandoffStartResult> {
  const req = (raw ?? {}) as Partial<Record<keyof HandoffStartRequest, unknown>>;
  const item = parseHandoffRef(req.item);
  const repoPath = typeof req.repoPath === 'string' && req.repoPath ? req.repoPath : null;
  const workspaceId = typeof req.workspaceId === 'string' && ID_RE.test(req.workspaceId) ? req.workspaceId : null;
  if (!item || !repoPath || !workspaceId) return { ok: false, code: 'invalid', message: 'not a GitHub issue or PR in a repo workspace' };
  const agent = parseAgentCmd(req.agentCmd);
  if (!agent.ok) return { ok: false, code: 'invalid', message: agent.message };
  return reserved<HandoffStartResult>(item, () => ({ ok: false, code: 'error', message: BUSY }), async () => {
    if (req.force !== true) {
      const busy = findInProgress(deps.links, item);
      if (busy) return { ok: false, code: 'in-progress', inProgress: busy };
    }
    const branch = handoffBranch(item);
    const result = await deps.startFanOut({
      idempotencyKey: `git-handoff-${randomUUID()}`,
      prompt: buildHandoffMessage(item, typeof req.note === 'string' ? req.note : undefined),
      titles: [branch],
      branches: [branch],
      repoPath,
      agentCmd: agent.cmd,
      worktree: true,
      verifiedWorkspaceId: workspaceId,
    }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err), tasks: [] }) as FanOutResult);
    const task = result.tasks?.find((t) => t.ok);
    if (!result.ok || !task || !task.workspaceId) {
      return { ok: false, code: 'error', message: result.error ?? result.tasks?.find((t) => t.error)?.error ?? 'the worktree could not be started' };
    }
    const reuse = findReusableLink(deps.links, item);
    const link = await deps.links.upsert({
      ...(reuse ? { id: reuse.id } : {}),
      ...linkFields(item),
      owner: { workspaceId: task.workspaceId },
      ...(task.agent ? { agent: task.agent } : {}),
      ...(task.worktreePath ? { worktree: { path: task.worktreePath, ...(task.branch ? { branch: task.branch } : {}) } } : {}),
    }).catch(() => null);
    return { ok: true, linkId: link?.id ?? '', workspaceId: task.workspaceId, branch: task.branch ?? branch };
  });
}

/** The link state a fan-out mission's ledger status stands for. */
export function linkStateForLedger(status: LedgerStatus): { state: WorkLinkState; reason?: WorkLinkReason } {
  switch (status) {
    case 'completed':
      return { state: 'done' };
    case 'cancelled':
      return { state: 'abandoned' };
    case 'failed':
      return { state: 'blocked', reason: 'task-failed' };
    case 'input_required':
      return { state: 'needs-you', reason: 'input-required' };
    case 'review_requested':
      return { state: 'review' };
    default:
      return { state: 'running' };
  }
}

/**
 * Keep a worktree hand-off's link in step with its fan-out mission: the
 * mission's ledger transitions (working, review requested, done, failed,
 * closed) move the link that names the mission's workspace as its owner. Such
 * a link has no A2A task, so the state set here is the state it shows.
 * Returns the unsubscribe.
 */
export function watchHandoffWorktreeLinks(
  ledger: { onTransition: (fn: (t: { entry: { taskWorkspaceId: string }; to: LedgerStatus }) => void) => () => void },
  links: Pick<HandoffDeps['links'], 'list' | 'setState'>,
): () => void {
  return ledger.onTransition(({ entry, to }) => {
    const owned = links
      .list({})
      .filter((l) => l.owner.workspaceId === entry.taskWorkspaceId && !!l.worktree && !l.a2aTaskId && (l.origin === 'issue' || l.origin === 'pr'));
    if (owned.length === 0) return;
    const next = linkStateForLedger(to);
    for (const l of owned) void links.setState(l.id, next.state, next.reason).catch(() => null);
  });
}
