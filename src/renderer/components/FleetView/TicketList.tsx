// Fleet's Tickets view: Moa's delegated work, one row per job, and the
// selected job's detail. Ticket text (request, result) is untrusted agent or
// operator text: rendered as text only.
import { memo, useEffect, useState } from 'react';
import type { MoaPendingDecision } from '../../../shared/moa';
import { formatIdle } from '../../utils/idleTime';
import type { Task } from '../../../shared/types';
import { ticketResultOf, type FleetTicket, type TicketState } from './fleetTickets';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Colour carries state only: waits on you, failed, done; the rest is neutral. */
const STATE_COLOR: Record<TicketState, string> = {
  'needs-you': 'var(--accent-yellow)',
  failed: 'var(--accent-red)',
  done: 'var(--accent-green)',
  working: 'var(--text-sub)',
  queued: 'var(--text-muted)',
};

export const ticketKey = (id: string) => `ticket:${id}`;

interface TicketRowProps {
  ticket: FleetTicket;
  assignee: string;
  focused: boolean;
  now: number;
  onFocus: () => void;
  onSelect: (ticket: FleetTicket) => void;
  /** Enter jumps to the agent, as on an agent row; a click selects. */
  onJump: (ticket: FleetTicket) => void;
  t: T;
}

function TicketRowImpl({ ticket, assignee, focused, now, onFocus, onSelect, onJump, t }: TicketRowProps) {
  const title = ticket.title || t('fleet.ticket.untitled');
  const state = t(`fleet.ticket.state.${ticket.state}`);
  return (
    <button
      type="button"
      role="option"
      aria-selected={focused}
      aria-label={`${title}, ${state}, ${assignee}`}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onClick={() => onSelect(ticket)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        onJump(ticket);
      }}
      className="wmux-fleet-card wmux-fleet-ticket"
      data-fleet-ticket={ticket.id}
      data-fleet-key={ticketKey(ticket.id)}
      data-state={ticket.state}
    >
      <span className="wmux-fleet-status" style={{ color: STATE_COLOR[ticket.state] }}>
        <span aria-hidden="true" className="wmux-fleet-dot" />
        <span>{state}</span>
      </span>
      <span className="wmux-fleet-identity">
        <span className="wmux-fleet-name" title={title}>{title}</span>
        <span className="wmux-fleet-context"><span>{assignee}</span></span>
      </span>
      <span className="wmux-fleet-progress">
        <span className="wmux-fleet-detail" title={ticket.result?.summary ?? ticket.request}>
          {ticket.result?.summary ?? ticket.request ?? ''}
        </span>
      </span>
      <span className="wmux-fleet-action">
        <span>{formatIdle(Math.max(0, now - ticket.updatedAt))}</span>
      </span>
    </button>
  );
}

export const TicketRow = memo(TicketRowImpl);

interface TicketDetailProps {
  ticket: FleetTicket;
  assignee: string;
  decisions: readonly MoaPendingDecision[];
  onJump: (ticket: FleetTicket) => void;
  onOpenDecision: (ticket: FleetTicket) => void;
  /** The result is on screen (the final report has been shown). */
  onResultShown?: (ticket: FleetTicket) => void;
  t: T;
}

/** The task out of an `a2a.task.query` page view, bare or in the router's envelope. */
function taskFromQuery(reply: unknown): Task | undefined {
  const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const body = rec(reply) && rec(reply.result) ? reply.result : reply;
  const task = rec(body) ? body.task : undefined;
  return rec(task) && rec(task.status) ? (task as unknown as Task) : undefined;
}

/**
 * A finished ticket's result. The renderer's task mirror is memory only, so
 * after a reload the result is read back from the durable copy (the daemon's
 * task record, which keeps the completion evidence) through main's
 * `a2a.task.query`, the same read agents use.
 */
function useTicketResult(ticket: FleetTicket): FleetTicket['result'] {
  const [loaded, setLoaded] = useState<{ id: string; result: FleetTicket['result'] } | null>(null);
  const ended = ticket.state === 'done' || ticket.state === 'failed';
  const need = ended && !ticket.result && !!ticket.a2aTaskId;
  useEffect(() => {
    if (!need || !ticket.a2aTaskId) return undefined;
    const invoke = window.electronAPI?.rpc?.invoke;
    if (typeof invoke !== 'function') return undefined;
    let cancelled = false;
    invoke('a2a.task.query', { workspaceId: ticket.workspaceId, view: 'page', taskId: ticket.a2aTaskId })
      .then((reply) => { if (!cancelled) setLoaded({ id: ticket.id, result: ticketResultOf(taskFromQuery(reply)) }); }, () => undefined);
    return () => { cancelled = true; };
  }, [need, ticket.id, ticket.a2aTaskId, ticket.workspaceId]);
  return ticket.result ?? (loaded?.id === ticket.id ? loaded.result : undefined);
}

export function TicketDetail({ ticket, assignee, decisions, onJump, onOpenDecision, onResultShown, t }: TicketDetailProps) {
  const result = useTicketResult(ticket);
  useEffect(() => {
    if (result) onResultShown?.(ticket);
  }, [result, ticket, onResultShown]);
  const waiting = decisions.filter((d) => ticket.decisionIds.includes(d.decision.id));
  return (
    <section className="wmux-fleet-ticket-detail" data-fleet-ticket-detail={ticket.id}
      aria-label={t('fleet.ticket.detailLabel', { title: ticket.title || t('fleet.ticket.untitled') })}>
      <div className="wmux-fleet-ticket-head">
        <span className="wmux-fleet-status" style={{ color: STATE_COLOR[ticket.state] }}>
          <span aria-hidden="true" className="wmux-fleet-dot" />
          <span>{t(`fleet.ticket.state.${ticket.state}`)}</span>
        </span>
        <span className="truncate">{assignee}</span>
      </div>
      {ticket.request && (
        <>
          <h4>{t('fleet.ticket.request')}</h4>
          <p className="wmux-fleet-ticket-text" data-fleet-ticket-request>{ticket.request}</p>
        </>
      )}
      {waiting.length > 0 && (
        <>
          <h4>{t('fleet.ticket.decisions')}</h4>
          <ul className="wmux-fleet-ticket-decisions">
            {waiting.map((d) => (
              <li key={d.decision.id}>
                <button type="button" data-fleet-ticket-decision={d.decision.id} onClick={() => onOpenDecision(ticket)}>
                  {d.handoff ? t('fleet.ticket.handoffWaiting') : d.decision.question}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {result && (
        <>
          <h4>{t('fleet.ticket.result')}</h4>
          <p className="wmux-fleet-ticket-text" data-fleet-ticket-result>{result.summary}</p>
          {result.verification && (
            <p className="wmux-fleet-ticket-meta" data-fleet-ticket-verification>
              {t('fleet.ticket.verification', { value: result.verification })}
            </p>
          )}
        </>
      )}
      <div className="wmux-fleet-ticket-actions">
        <button type="button" onClick={() => onJump(ticket)} data-fleet-ticket-jump>{t('fleet.ticket.jump')}</button>
      </div>
    </section>
  );
}
