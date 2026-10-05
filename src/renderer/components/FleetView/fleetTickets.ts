// Fleet tickets: one delegated job each — a Moa hand-off (proposed or
// delivered) or an A2A task carried by a WorkLink. A plain chat message is
// never a ticket. Everything here is a pure read of data main already
// persists (work-links.json, the decision store, the A2A task mirror), so a
// ticket survives a Moa restart with no store of its own.
import type { MoaPendingDecision } from '../../../shared/moa';
import { deriveLinkState, type WorkLink, type WorkLinkOrigin } from '../../../shared/workLink';
import { isVerifiedItem } from '../../../shared/completionEvidence';
import type { Message, Task } from '../../../shared/types';

export type TicketState = 'queued' | 'working' | 'needs-you' | 'done' | 'failed';

export interface FleetTicket {
  /** The WorkLink id, or `handoff:<decision id>` for a proposal not yet handed off. */
  id: string;
  title: string;
  /** The request as it was sent (untrusted text). */
  request?: string;
  workspaceId: string;
  paneId?: string;
  agent?: string;
  state: TicketState;
  /** Decisions about this job that still wait on the operator. */
  decisionIds: string[];
  /** The worker's report once the job ended (untrusted text). */
  result?: { summary: string; verification?: string };
  a2aTaskId?: string;
  origin: WorkLinkOrigin | 'handoff';
  updatedAt: number;
}

/** How long a finished ticket stays listed. */
export const TICKET_RECENT_MS = 24 * 60 * 60 * 1000;

/** A WorkLink's derived state in the five ticket words. Abandoned → null (not listed). */
export function ticketStateOf(link: WorkLink, pendingDecision: boolean): TicketState | null {
  const { state, reason } = deriveLinkState(link, pendingDecision);
  switch (state) {
    case 'queued': return 'queued';
    case 'running': return 'working';
    case 'needs-you': return 'needs-you';
    // Blocked on the agent's side: only a failed task is an end; CI, conflicts
    // and requested changes are still the worker's to fix.
    case 'blocked': return reason === 'task-failed' || link.a2aState === 'failed' ? 'failed' : 'working';
    case 'review':
    case 'done': return 'done';
    default: return null;
  }
}

function textOf(message: Message | undefined): string {
  if (!message) return '';
  return message.parts
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** The job's request: the first message the worker received. */
function requestOf(task: Task | undefined): string | undefined {
  const first = task?.history.find((m) => m.role === 'user') ?? task?.history[0];
  return textOf(first) || undefined;
}

/** The worker's closing report and its verification, from the A2A completion. */
export function ticketResultOf(task: Task | undefined): FleetTicket['result'] {
  if (!task) return undefined;
  const { state, message, evidence } = task.status;
  if (state !== 'completed' && state !== 'failed') return undefined;
  const summary = evidence?.summary?.trim() || textOf(message);
  if (!summary) return undefined;
  let verification: string | undefined;
  if (evidence && evidence.items.length > 0) {
    const verified = evidence.items.filter(isVerifiedItem).length;
    verification = `${verified}/${evidence.items.length}`;
  }
  return verification ? { summary, verification } : { summary };
}

export interface TicketSources {
  links: readonly WorkLink[];
  decisions: readonly MoaPendingDecision[];
  a2aTasks: Readonly<Record<string, Task>>;
  now: number;
}

/**
 * Every ticket, the ones that need you first, then newest first. Finished
 * tickets older than TICKET_RECENT_MS drop off; abandoned ones never show.
 */
export function buildFleetTickets({ links, decisions, a2aTasks, now }: TicketSources): FleetTicket[] {
  const pending = new Set(decisions.map((d) => d.decision.id));
  const out: FleetTicket[] = [];
  for (const link of links) {
    const fromMoa = link.origin === 'moa' || link.origin === 'moa-auto';
    if (!link.a2aTaskId && !fromMoa) continue;
    const decisionIds = link.decisionIds.filter((id) => pending.has(id));
    const state = ticketStateOf(link, decisionIds.length > 0);
    if (!state) continue;
    if ((state === 'done' || state === 'failed') && now - link.updatedAt > TICKET_RECENT_MS) continue;
    const task = link.a2aTaskId ? a2aTasks[link.a2aTaskId] : undefined;
    const ticket: FleetTicket = {
      id: link.id,
      title: link.title || task?.metadata.title || '',
      workspaceId: link.owner.workspaceId,
      state,
      decisionIds,
      origin: link.origin,
      updatedAt: link.updatedAt,
    };
    const request = requestOf(task);
    if (request) ticket.request = request;
    if (link.owner.paneId) ticket.paneId = link.owner.paneId;
    if (link.agent) ticket.agent = link.agent;
    if (link.a2aTaskId) ticket.a2aTaskId = link.a2aTaskId;
    const result = state === 'done' || state === 'failed' ? ticketResultOf(task) : undefined;
    if (result) ticket.result = result;
    out.push(ticket);
  }
  // A hand-off Moa proposed that nobody has clicked yet: it waits on you.
  // Once delivered, its WorkLink takes over and this card is gone.
  for (const d of decisions) {
    if (!d.handoff) continue;
    out.push({
      id: `handoff:${d.decision.id}`,
      title: d.handoff.title,
      request: d.handoff.body,
      workspaceId: d.workspaceId,
      paneId: d.handoff.targetPaneId,
      agent: d.handoff.agentName,
      state: 'needs-you',
      decisionIds: [d.decision.id],
      origin: 'handoff',
      updatedAt: d.decision.raisedAt,
    });
  }
  const rank: Record<TicketState, number> = { 'needs-you': 0, failed: 1, working: 2, queued: 3, done: 4 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt);
}

/** The open ticket a pane is working on, if any: matched on the pane, else on
 *  its workspace when the ticket names no pane. */
export function openTicketFor(tickets: readonly FleetTicket[], workspaceId: string, paneId: string): FleetTicket | undefined {
  const open = tickets.filter((t) => t.workspaceId === workspaceId && t.state !== 'done' && t.state !== 'failed');
  return open.find((t) => t.paneId === paneId) ?? open.find((t) => !t.paneId);
}

/** Longest issue body put in the URL; browsers and GitHub refuse much longer ones. */
const ISSUE_BODY_MAX = 4000;

/**
 * A prefilled "new issue" URL for a ticket, or null when the repo is not on
 * GitHub. `repoKey` is main's `host/owner/repo` for the workspace's origin.
 * Nothing is posted: the user reviews and submits the form themselves.
 */
export function ticketIssueUrl(repoKey: string | null | undefined, ticket: Pick<FleetTicket, 'title' | 'request' | 'result'>): string | null {
  const parts = repoKey?.split('/') ?? [];
  if (parts.length !== 3 || parts[0] !== 'github.com' || !parts[1] || !parts[2]) return null;
  const sections = [ticket.request?.trim()];
  if (ticket.result) sections.push(`Result: ${ticket.result.summary}`);
  let body = sections.filter(Boolean).join('\n\n');
  if (body.length > ISSUE_BODY_MAX) body = `${body.slice(0, ISSUE_BODY_MAX)}…`;
  const query = `title=${encodeURIComponent(ticket.title)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
  return `https://github.com/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}/issues/new?${query}`;
}
