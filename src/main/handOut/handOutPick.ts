// A pick from the app (shared/handOut.ts HandOutPickRequest): one To hand out
// item to an agent pane, a company's CEO, or a new worktree. The item is held
// for the whole call, so a second pick of it is refused, never sent alongside.
//
// Pane and company: the item's work link is recorded first (origin
// 'hand-out', owner = the target pane), then the item goes over the Git page's
// gated operator delivery (git/handoff.ts) as a task that joins that link. A
// send that was not delivered cancels its task, so the link goes abandoned and
// the item is open again. A company's CEO gets the owner's task with the item
// as its job, and briefs a seat as a follow-on.
//
// Worktree: the fan-out path the Git page's "Start in a new worktree" takes,
// in the item's folder, and the link records the worktree and the agent; the
// fan-out mission's ledger then moves it (watchHandoffWorktreeLinks).
import { randomUUID } from 'node:crypto';
import { sanitizeHandoffTitle, type HandoffTarget } from '../../shared/gitHandoff';
import {
  buildHandOutMessage,
  handOutBranchName,
  isHandOutId,
  type HandOutItem,
  type HandOutPickRequest,
  type HandOutPickResult,
} from '../../shared/handOut';
import {
  deliverOperatorTask,
  parseAgentCmd,
  parseHandoffTarget,
  prepNoticeOf,
  releaseUndelivered,
  startWorktreeTask,
  type HandoffDeps,
} from '../git/handoff';
import type { HandOutStore } from './handOutStore';

/** A workspace on this PC (a link's local owner id; never `remote:`). */
const LOCAL_WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export interface HandOutPickDeps extends HandoffDeps {
  store: Pick<HandOutStore, 'get' | 'reserve' | 'release'>;
  /** The item's folder as a local folder the app may open, or null. */
  confinePath: (folder: string) => Promise<string | null>;
}

/** A pick request from untrusted input (IPC), or null. */
export function parseHandOutPick(raw: unknown): HandOutPickRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const { itemId, to } = raw as { itemId?: unknown; to?: unknown };
  if (!isHandOutId(itemId) || !to || typeof to !== 'object') return null;
  const { kind, target: rawTarget, workspaceId, agentCmd } = to as Record<string, unknown>;
  if (kind === 'pane' || kind === 'company') {
    const target = parseHandoffTarget(rawTarget);
    if (!target) return null;
    return kind === 'pane' ? { itemId, to: { kind: 'pane', target } } : { itemId, to: { kind: 'company', target } };
  }
  if (kind !== 'worktree' || typeof workspaceId !== 'string' || !LOCAL_WORKSPACE_ID_RE.test(workspaceId)) return null;
  if (agentCmd !== undefined && typeof agentCmd !== 'string') return null;
  return { itemId, to: { kind: 'worktree', workspaceId, ...(typeof agentCmd === 'string' ? { agentCmd } : {}) } };
}

export async function pickHandOut(deps: HandOutPickDeps, raw: unknown): Promise<HandOutPickResult> {
  const req = parseHandOutPick(raw);
  if (!req) return { ok: false, code: 'invalid', message: 'not a To hand out item and an agent pane, a company or a workspace to hand it to' };
  const { to } = req;
  let agentCmd = 'claude';
  if (to.kind === 'worktree') {
    const agent = parseAgentCmd(to.agentCmd);
    if (!agent.ok) return { ok: false, code: 'invalid', message: agent.message };
    agentCmd = agent.cmd;
  }
  const item = deps.store.get(req.itemId);
  if (!item) return { ok: false, code: 'unknown', message: 'this item is no longer on To hand out' };
  if (!deps.store.reserve(item.id)) return { ok: false, code: 'taken', message: 'this item is already handed out, or being handed out' };
  try {
    if (to.kind === 'worktree') return await toWorktree(deps, item, to.workspaceId, agentCmd);
    return await toPane(deps, item, to.target, to.kind === 'company');
  } catch (err) {
    return { ok: false, code: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    deps.store.release(item.id);
  }
}

async function toPane(deps: HandOutPickDeps, item: HandOutItem, target: HandoffTarget, company: boolean): Promise<HandOutPickResult> {
  const link = await deps.links.upsert({
    origin: 'hand-out',
    handOutId: item.id,
    title: item.title,
    owner: { workspaceId: target.workspaceId, paneId: target.paneId },
    ...(target.agentSlug ? { agent: target.agentSlug } : {}),
  }).catch(() => null);
  // Without its link the item would read open while its work is out.
  if (!link) return { ok: false, code: 'error', message: 'wmux could not record the work for this item; nothing was sent' };
  const sent = await deliverOperatorTask(deps.invoke, {
    target,
    title: sanitizeHandoffTitle(item.title),
    message: buildHandOutMessage(item, { company }),
    workLinkId: link.id,
  });
  if (!sent.ok) {
    await releaseUndelivered(deps, link.id, undefined);
    return { ok: false, code: sent.code, message: sent.message };
  }
  if (!sent.delivered) await releaseUndelivered(deps, link.id, sent.taskId);
  return {
    ok: true,
    linkId: link.id,
    ...(sent.taskId ? { taskId: sent.taskId } : {}),
    delivered: sent.delivered,
    ...(sent.delivered ? { assurance: sent.assurance } : {}),
    ...(sent.note ? { note: sent.note } : {}),
    ...(sent.reason ? { reason: sent.reason } : {}),
  };
}

async function toWorktree(deps: HandOutPickDeps, item: HandOutItem, workspaceId: string, agentCmd: string): Promise<HandOutPickResult> {
  const repoPath = await deps.confinePath(item.folder);
  if (!repoPath) return { ok: false, code: 'invalid', message: 'the item\'s folder is not a local folder wmux can open' };
  const branch = handOutBranchName(item.title, randomUUID().slice(0, 6));
  // The link comes first, as a pane pick's does: a start whose link could not
  // be recorded would run while the item still read open.
  const link = await deps.links.upsert({ origin: 'hand-out', handOutId: item.id, title: item.title, owner: { workspaceId } }).catch(() => null);
  if (!link) return { ok: false, code: 'error', message: 'the pick could not be recorded, so nothing was started' };
  const started = await startWorktreeTask(deps.startFanOut, {
    key: `hand-out-${randomUUID()}`,
    prompt: buildHandOutMessage(item),
    branch,
    repoPath,
    agentCmd,
    workspaceId,
  });
  if (!started.ok) {
    await deps.links.setState(link.id, 'abandoned').catch(() => null);
    return { ok: false, code: 'error', message: started.message };
  }
  const { task, result } = started;
  const worktree = task.worktreePath ? { worktree: { path: task.worktreePath, ...(task.branch ? { branch: task.branch } : {}) } } : {};
  const placed = await deps.links.upsert({
    id: link.id,
    owner: { workspaceId: task.workspaceId },
    ...(task.agent ? { agent: task.agent } : {}),
    ...worktree,
  }).catch(() => null);
  // The worktree is what lets the fan-out mission move the link; an agent name
  // the link refuses must not cost it.
  if (!placed && (await deps.links.upsert({ id: link.id, owner: { workspaceId: task.workspaceId }, ...worktree }).catch(() => null)) === null) {
    console.warn(`[handOut] the worktree pick's link ${link.id} could not take its worktree`);
  }
  const prep = prepNoticeOf(result, task);
  return { ok: true, linkId: link.id, branch: task.branch ?? branch, ...(prep ? { prep } : {}) };
}
