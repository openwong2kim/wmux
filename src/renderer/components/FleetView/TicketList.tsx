// Fleet's Tickets view: Moa's delegated work, one row per job, and the
// selected job's detail. Ticket text (request, result) is untrusted agent or
// operator text: rendered as text only.
import { memo, useEffect, useState } from 'react';
import type { MoaPendingDecision } from '../../../shared/moa';
import { formatIdle } from '../../utils/idleTime';
import { ticketIssueUrl, type FleetTicket, type TicketState } from './fleetTickets';

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
  t: T;
}

function TicketRowImpl({ ticket, assignee, focused, now, onFocus, onSelect, t }: TicketRowProps) {
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
  /** The assignee's working directory, for the GitHub remote lookup. */
  cwd?: string;
  decisions: readonly MoaPendingDecision[];
  onJump: (ticket: FleetTicket) => void;
  onOpenDecision: (ticket: FleetTicket) => void;
  t: T;
}

/** main's `host/owner/repo` for a checkout's origin; null when unknown. */
function useRepoKey(cwd: string | undefined): string | null {
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    setKey(null);
    const repoKey = window.electronAPI?.github?.repoKey;
    if (!cwd || typeof repoKey !== 'function') return undefined;
    let cancelled = false;
    repoKey(cwd).then((r) => { if (!cancelled) setKey(r?.key ?? null); }, () => undefined);
    return () => { cancelled = true; };
  }, [cwd]);
  return key;
}

export function TicketDetail({ ticket, assignee, cwd, decisions, onJump, onOpenDecision, t }: TicketDetailProps) {
  const repoKey = useRepoKey(cwd);
  const issueUrl = ticketIssueUrl(repoKey, ticket);
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
      {ticket.result && (
        <>
          <h4>{t('fleet.ticket.result')}</h4>
          <p className="wmux-fleet-ticket-text" data-fleet-ticket-result>{ticket.result.summary}</p>
          {ticket.result.verification && (
            <p className="wmux-fleet-ticket-meta" data-fleet-ticket-verification>
              {t('fleet.ticket.verification', { value: ticket.result.verification })}
            </p>
          )}
        </>
      )}
      <div className="wmux-fleet-ticket-actions">
        <button type="button" onClick={() => onJump(ticket)} data-fleet-ticket-jump>{t('fleet.ticket.jump')}</button>
        {issueUrl && (
          <button type="button" data-fleet-ticket-issue
            onClick={() => { void window.electronAPI?.shell?.openExternal?.(issueUrl); }}>
            {t('fleet.ticket.openIssue')}
          </button>
        )}
      </div>
    </section>
  );
}
