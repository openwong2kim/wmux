// Handing an issue or PR from the Git page to an agent, main side.
//
// Send: record a work link for the item (origin issue / pr, owner = the
// target pane), then send it as a new A2A task to that pane over the
// operator lane (so the task joins the link) with the gated delivery: the
// renderer waits until nobody is typing in the pane, then pastes through
// main's approval gate, checked again right before the Enter. The text is the
// fixed reference from buildHandoffMessage, never the issue's own text.
//
// Start in a new worktree: the existing fan-out path from the repo's
// workspace, branch issue-<n>-<slug>, the same fixed reference as the prompt,
// and the work link updated with the worktree and the agent.
//
// Either way, an item already linked to work in progress is refused unless
// the caller says to send anyway.
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
import type { WorkLink, WorkLinkFilter, WorkLinkState } from '../../shared/workLink';
import type { WorkLinkUpsert } from '../workLink/workLinkStore';
import type { FanOutRequest, FanOutResult } from '../worktask/FanOutService';

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** States that mean work on the item is under way. */
const ACTIVE: WorkLinkState[] = ['queued', 'running', 'needs-you', 'blocked'];

export interface HandoffDeps {
  /** The operator-lane RPC (a2a.task.send). */
  invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  links: {
    list: (filter: WorkLinkFilter) => WorkLink[];
    upsert: (input: WorkLinkUpsert) => Promise<WorkLink | null>;
  };
  startFanOut: (req: FanOutRequest) => Promise<FanOutResult>;
}

/** The item, re-validated (refs are re-derived from their URLs), or null. */
export function parseHandoffRef(raw: unknown): HandoffRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, ref } = raw as { kind?: unknown; ref?: unknown };
  if (!ref || typeof ref !== 'object') return null;
  try {
    if (kind === 'issue') {
      const r = parseIssueRef(serializeIssueRef(ref as never));
      return r ? { kind, ref: r } : null;
    }
    if (kind === 'pr') {
      const r = parsePrDragRef(serializePrDragRef(ref as never));
      return r ? { kind, ref: r } : null;
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

const keyed = (h: HandoffRef) => ({ host: h.ref.host, owner: h.ref.owner, repo: h.ref.repo, number: h.ref.number });

/** Work in progress on the item: a link that is running, waiting on someone,
 *  blocked, or queued with a task or a worktree behind it. */
export function findInProgress(links: HandoffDeps['links'], h: HandoffRef): HandoffInProgress | null {
  const filter: WorkLinkFilter = h.kind === 'issue' ? { issue: keyed(h), states: ACTIVE } : { pr: keyed(h), states: ACTIVE };
  const live = links.list(filter).find((l) => l.state !== 'queued' || !!l.a2aTaskId || !!l.worktree);
  return live ? { linkId: live.id, workspaceId: live.owner.workspaceId, state: live.state } : null;
}

function linkFields(h: HandoffRef): Pick<WorkLinkUpsert, 'origin' | 'issue' | 'pr' | 'title'> {
  const title = sanitizeHandoffTitle(h.ref.title);
  if (h.kind === 'issue') return { origin: 'issue', issue: h.ref, title };
  const { host, owner, repo, number, url } = h.ref;
  return { origin: 'pr', pr: { host, owner, repo, number, url }, title };
}

const taskTitle = (h: HandoffRef) => `${h.kind === 'issue' ? 'Issue' : 'PR'} ${h.ref.owner}/${h.ref.repo}#${h.ref.number}`;

export async function sendHandoff(deps: HandoffDeps, raw: unknown): Promise<HandoffSendResult> {
  const req = (raw ?? {}) as Partial<HandoffSendRequest>;
  const item = parseHandoffRef(req.item);
  const target = parseHandoffTarget(req.target);
  if (!item || !target) return { ok: false, code: 'invalid', message: 'not an issue or PR and an agent pane' };
  if (req.force !== true) {
    const busy = findInProgress(deps.links, item);
    if (busy) return { ok: false, code: 'in-progress', inProgress: busy };
  }
  const link = await deps.links.upsert({
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
  }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))) as {
    ok?: boolean;
    error?: string;
    result?: { taskId?: unknown; error?: unknown; delivery?: { notified?: unknown; hint?: unknown; refused?: unknown } };
  };
  if (!res || res.ok === false) return { ok: false, code: 'error', message: res?.error ?? 'the send failed' };
  const result = res.result ?? {};
  if (typeof result.error === 'string') return { ok: false, code: 'refused', message: result.error };
  const taskId = typeof result.taskId === 'string' ? result.taskId : undefined;
  const delivered = result.delivery?.notified === true;
  const hint = typeof result.delivery?.hint === 'string' ? result.delivery.hint : undefined;
  return {
    ok: true,
    linkId: link?.id ?? '',
    ...(taskId ? { taskId } : {}),
    delivered,
    ...(hint ? { note: hint } : {}),
  };
}

export async function startHandoffWorktree(deps: HandoffDeps, raw: unknown): Promise<HandoffStartResult> {
  const req = (raw ?? {}) as Partial<Record<keyof HandoffStartRequest, unknown>>;
  const item = parseHandoffRef(req.item);
  const repoPath = typeof req.repoPath === 'string' && req.repoPath ? req.repoPath : null;
  const workspaceId = typeof req.workspaceId === 'string' && ID_RE.test(req.workspaceId) ? req.workspaceId : null;
  if (!item || !repoPath || !workspaceId) return { ok: false, code: 'invalid', message: 'not an issue or PR in a repo workspace' };
  if (req.force !== true) {
    const busy = findInProgress(deps.links, item);
    if (busy) return { ok: false, code: 'in-progress', inProgress: busy };
  }
  const branch = item.kind === 'issue' ? issueBranchName(item.ref.number, item.ref.title) : `pr-${item.ref.number}`;
  const agentCmd = typeof req.agentCmd === 'string' && /^[\w./ -]{1,200}$/.test(req.agentCmd) ? req.agentCmd : 'claude';
  const result = await deps.startFanOut({
    idempotencyKey: `git-handoff-${randomUUID()}`,
    prompt: buildHandoffMessage(item, typeof req.note === 'string' ? req.note : undefined),
    titles: [branch],
    branches: [branch],
    repoPath,
    agentCmd,
    worktree: true,
    verifiedWorkspaceId: workspaceId,
  }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err), tasks: [] }) as FanOutResult);
  const task = result.tasks?.find((t) => t.ok);
  if (!result.ok || !task || !task.workspaceId) {
    return { ok: false, code: 'error', message: result.error ?? result.tasks?.find((t) => t.error)?.error ?? 'the worktree could not be started' };
  }
  const link = await deps.links.upsert({
    ...linkFields(item),
    owner: { workspaceId: task.workspaceId },
    ...(task.agent ? { agent: task.agent } : {}),
    ...(task.worktreePath ? { worktree: { path: task.worktreePath, ...(task.branch ? { branch: task.branch } : {}) } } : {}),
  }).catch(() => null);
  return { ok: true, linkId: link?.id ?? '', workspaceId: task.workspaceId, branch: task.branch ?? branch };
}
