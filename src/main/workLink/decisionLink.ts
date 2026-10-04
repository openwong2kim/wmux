// Decisions on work links: `deck_ask_decision({ task_id })` attaches the new
// decision to that task's link, and answering a decision re-derives the links
// that hold it. Best-effort throughout: a decision is raised or resolved
// whatever happens here.

import { getWorkLinkStore, type WorkLinkStore } from './workLinkStore';

export type DecisionLinkResult =
  | { linked: true; linkId: string }
  | { linked: false; linkError: 'unknown_task' | 'not_your_task' };

/**
 * Attach a decision the commander brain of `workspaceId` raised to the link of
 * the A2A task it named. The brain may only attach to work its workspace
 * handed out or owns. Never rejects.
 */
export async function attachDecisionToTask(
  workspaceId: string,
  taskId: string,
  decisionId: string,
  store: WorkLinkStore = getWorkLinkStore(),
): Promise<DecisionLinkResult> {
  try {
    const link = store.getByTaskId(taskId);
    if (!link) return { linked: false, linkError: 'unknown_task' };
    if (link.owner.workspaceId !== workspaceId && link.requester?.workspaceId !== workspaceId) {
      return { linked: false, linkError: 'not_your_task' };
    }
    const next = await store.attachDecision(link.id, decisionId);
    return next ? { linked: true, linkId: next.id } : { linked: false, linkError: 'unknown_task' };
  } catch {
    return { linked: false, linkError: 'unknown_task' };
  }
}

/**
 * A stale decision re-raised as a sharper one gets a new id: keep it on the
 * links the old one was on. Never rejects.
 */
export async function carryDecision(
  oldId: string,
  newId: string,
  store: WorkLinkStore = getWorkLinkStore(),
): Promise<void> {
  try {
    for (const link of store.list()) {
      if (link.decisionIds.includes(oldId)) await store.attachDecision(link.id, newId);
    }
  } catch {
    /* best-effort */
  }
}

/** A decision was answered: re-derive the links that hold it. Never rejects. */
export function refreshDecisionLinks(decisionId: string, store?: WorkLinkStore): Promise<void> {
  try {
    return (store ?? getWorkLinkStore()).refreshDecision(decisionId);
  } catch {
    return Promise.resolve();
  }
}
