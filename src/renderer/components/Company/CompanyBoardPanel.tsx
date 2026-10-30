import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type StoreState } from '../../stores';
import { createWorkspaceAgentRosterSelector, type WorkspaceAgentRosterRow } from '../../stores/selectors/workspaceAgentRoster';
import { useT } from '../../hooks/useT';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { paneTag } from '../../utils/paneNaming';
import { timeAgo } from '../../utils/timeAgo';
import { IDLE_TICK_MS } from '../../utils/idleTime';
import { FOCUS_RING } from '../focusRing';
import { StatusMarkView } from '../Sidebar/AgentMarks';
import { AGENT_STATUS_ICON } from '../Sidebar/agentStatusIcon';
import { rosterPrimaryLabel } from '../Sidebar/WorkspaceAgentRoster';
import type { Task } from '../../../shared/types';
import { useMoaDecisions, useWorkLinks } from '../FleetView/useFleetSources';
import { buildFleetTickets, type FleetTicket } from '../FleetView/fleetTickets';
import { isTerminalKindSurfaceType } from '../Pane/surfaceKinds';
import { buildCompanyBoard, type BoardSeat } from './companyBoard';

const NOW_SHOWN = 2;
const NO_TASKS: Record<string, Task> = {};
const NO_AGENTS: StoreState['surfaceAgent'] = {};

function Section({ title, count, needsYou = false, children }: { title: string; count?: number; needsYou?: boolean; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="mb-1 text-[11px] font-medium text-[var(--text-muted)]">
        {title}
        {count !== undefined && (
          <span className={`ml-1.5 tabular-nums ${needsYou ? 'text-[var(--attention-text)]' : ''}`}>{count}</span>
        )}
      </h3>
      <div className="flex flex-col divide-y divide-[var(--stroke)]">{children}</div>
    </section>
  );
}

function focusSeat(row: WorkspaceAgentRosterRow | undefined, surfaceId: string): void {
  focusNotificationTarget(() => useStore.getState(), row
    ? { ptyId: row.remote ? null : row.ptyId || null, surfaceId: row.surfaceId }
    : { surfaceId });
}

/**
 * Company mode's board (DESIGN.md "Company board"): a work tab that shows who
 * holds each seat of the workspace's company and what each seat is doing, from
 * the roster and the delegated-work tickets.
 */
export default function CompanyBoardPanel({ workspaceId, isActive }: { workspaceId: string; isActive: boolean }) {
  const t = useT();
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const company = workspace?.company;
  const workspaceNames = useStore(useShallow((s) => Object.fromEntries(s.workspaces.map((w) => [w.id, w.name]))));
  const rosterSelector = useMemo(() => createWorkspaceAgentRosterSelector(workspaceId), [workspaceId]);
  const roster = useStore(rosterSelector);
  const paneRole = useStore((s) => s.paneRole);
  const paneLabel = useStore((s) => s.paneLabel);
  const surfaceAgent = useStore((s) => (isActive ? s.surfaceAgent : NO_AGENTS));
  // The task mirror only fills in a request or report a link lacks; a hidden
  // board need not redraw on every task update in the app.
  const a2aTasks = useStore((s) => (isActive ? s.a2aTasks : NO_TASKS));
  const links = useWorkLinks(isActive && !!company);
  const { decisions } = useMoaDecisions(isActive && !!company);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!isActive) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), IDLE_TICK_MS);
    return () => window.clearInterval(id);
  }, [isActive]);

  const leaves = useMemo(() => (workspace ? getWorkspaceLeafPanes(workspace) : []), [workspace]);
  const agentPaneIds = useMemo(
    () => new Set(leaves.filter((leaf) => leaf.surfaces.some((sf) => !!sf.ptyId && !!surfaceAgent[sf.ptyId]?.name)).map((leaf) => leaf.id)),
    [leaves, surfaceAgent],
  );
  const board = useMemo(() => {
    // The log keeps the last ten finished jobs however old, not Fleet's last day.
    const tickets = buildFleetTickets({ links, decisions, a2aTasks, now, recentMs: Infinity });
    return buildCompanyBoard({
      workspaceId,
      coordinatorPaneId: company?.coordinatorPaneId ?? null,
      paneIds: leaves.map((leaf) => leaf.id),
      agentPaneIds,
      rows: roster.rows,
      tickets,
      links,
      paneRole,
    });
  }, [links, decisions, a2aTasks, now, workspaceId, company?.coordinatorPaneId, leaves, agentPaneIds, roster.rows, paneRole]);

  const tagOf = (paneId: string): string => {
    const leaf = leaves.find((l) => l.id === paneId);
    return workspace && leaf ? paneTag(workspace, leaf) : '';
  };
  const seatTitle = (seat: BoardSeat): string =>
    seat.row ? rosterPrimaryLabel(seat.row) : paneLabel[seat.paneId]?.trim() || tagOf(seat.paneId);
  const seatName = (paneId: string | undefined): string => {
    const seat = paneId ? board.seats.find((s) => s.paneId === paneId) : undefined;
    return seat ? seatTitle(seat) : '';
  };
  // A job inside the company is placed by its seat, one handed out by the
  // workspace or other PC's pane it went to.
  const whereOf = (ticket: FleetTicket): string => (ticket.workspaceId === workspaceId
    ? seatName(ticket.paneId)
    : workspaceNames[ticket.workspaceId] ?? ticket.workspaceName ?? t('fleet.ticket.unknownWorkspace'));
  const stateWord = (ticket: FleetTicket) => t(`fleet.ticket.state.${ticket.state}`);
  const ticketTitle = (ticket: FleetTicket) => ticket.title || t('fleet.ticket.untitled');

  const ticketRow = (ticket: FleetTicket, where: string, detail?: string) => (
    <div key={ticket.id} className="flex flex-col gap-0.5 py-1.5" data-board-ticket={ticket.id}>
      <span className="truncate text-[var(--text-main)]">{ticketTitle(ticket)}</span>
      <span className="truncate text-[11px] text-[var(--text-muted)]">
        {[where, ticket.state === 'needs-you' ? undefined : stateWord(ticket), timeAgo(ticket.updatedAt, now)].filter(Boolean).join(' · ')}
      </span>
      {detail && <span className="line-clamp-2 text-[11px] text-[var(--text-sub)]">{detail}</span>}
    </div>
  );

  const seatRow = (seat: BoardSeat) => {
    const { row } = seat;
    const title = seatTitle(seat);
    const trailer = row ? row.paneName : tagOf(seat.paneId);
    // The pane's agent tab when its roster row reads another tab (a stashed
    // pane with a shell in front), else its first terminal; never the board.
    const leaf = leaves.find((l) => l.id === seat.paneId);
    const agentTab = row ? undefined : leaf?.surfaces.find((sf) => !!sf.ptyId && !!surfaceAgent[sf.ptyId]?.name);
    const status = row?.status ?? (agentTab ? surfaceAgent[agentTab.ptyId].status : 'idle');
    const statusLabel = row || agentTab ? t(AGENT_STATUS_ICON[status].labelKey) : t('company.noAgent');
    const surfaceId = (agentTab ?? leaf?.surfaces.find((sf) => isTerminalKindSurfaceType(sf.surfaceType)))?.id ?? leaf?.activeSurfaceId ?? '';
    return (
      <button
        key={seat.paneId}
        type="button"
        className={`flex w-full flex-col gap-0.5 py-1.5 text-left hover:bg-[var(--hover-fill)] ${FOCUS_RING}`}
        // The board's own pane takes a click that bubbles up and would win the focus back.
        onClick={(event) => { event.stopPropagation(); focusSeat(row, surfaceId); }}
        aria-label={[title, seat.coordinator ? t('company.ceo') : undefined, statusLabel].filter(Boolean).join(', ')}
        data-board-seat={seat.paneId}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusMarkView status={status} quiet usageWaiting={row?.usageLimitWaiting} />
          {seat.coordinator && <span className="flex-none text-[11px] text-[var(--text-muted)]" data-board-ceo>{t('company.ceo')}</span>}
          <span className={`min-w-0 truncate font-semibold ${row ? 'text-[var(--text-main)]' : 'text-[var(--text-sub)]'}`}>{title}</span>
          {/* The coordinate gives way before the title does. */}
          {trailer !== title && <span className="min-w-0 shrink-[4] truncate text-[11px] text-[var(--text-muted)]">{trailer}</span>}
        </span>
        <span className="flex flex-col gap-0.5 pl-[16px]">
          {!seat.agent && <span className="truncate text-[11px] text-[var(--text-muted)]" data-board-no-agent>{t('company.noAgent')}</span>}
          {seat.owns && <span className="truncate text-[11px] text-[var(--text-muted)]">{t('company.board.owns', { role: seat.owns })}</span>}
          {seat.now.slice(0, NOW_SHOWN).map((ticket) => (
            <span
              key={ticket.id}
              className={`truncate ${ticket.state === 'needs-you' ? 'text-[var(--attention-text)]' : 'text-[var(--text-sub)]'}`}
              data-board-now={ticket.id}
            >
              {ticketTitle(ticket)}
            </span>
          ))}
          {seat.now.length > NOW_SHOWN && (
            <span className="text-[11px] text-[var(--text-muted)]">{t('company.board.more', { count: seat.now.length - NOW_SHOWN })}</span>
          )}
          {seat.next.length > 0 && (
            <span className="truncate text-[11px] text-[var(--text-muted)]" data-board-next>
              {t('company.board.next', { title: ticketTitle(seat.next[0]) })}
              {seat.next.length > 1 && ` ${t('company.board.more', { count: seat.next.length - 1 })}`}
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div
      className="absolute inset-0 overflow-y-auto bg-[var(--bg-base)]"
      style={{ display: isActive ? 'block' : 'none' }}
      data-testid="company-board"
    >
      {!company ? (
        <p className="px-4 py-4 text-xs text-[var(--text-muted)]">{t('company.board.notCompany')}</p>
      ) : (
        <div className="flex flex-col gap-5 px-4 py-4 text-xs">
          <header className="flex flex-col gap-1">
            <h2 className="truncate text-[16px] font-semibold text-[var(--text-main)]">{workspace?.name}</h2>
            {company.mission && <p className="text-[var(--text-sub)]" data-board-mission>{company.mission}</p>}
            {company.standingOrders && (
              <p className="line-clamp-3 whitespace-pre-wrap text-[11px] text-[var(--text-muted)]">{company.standingOrders}</p>
            )}
          </header>

          {board.needsYou.length > 0 && (
            <Section title={t('company.board.needsYou')} count={board.needsYou.length} needsYou>
              {board.needsYou.map((ticket) => ticketRow(ticket, whereOf(ticket)))}
            </Section>
          )}

          <Section title={t('company.board.seats')}>{board.seats.map(seatRow)}</Section>

          {board.handedOut.length > 0 && (
            <Section title={t('company.board.handedOut')} count={board.handedOut.length}>
              {board.handedOut.map((ticket) => ticketRow(ticket, whereOf(ticket)))}
            </Section>
          )}

          {board.unseated.length > 0 && (
            <Section title={t('company.board.unseated')} count={board.unseated.length}>
              {board.unseated.map((ticket) => ticketRow(ticket, ''))}
            </Section>
          )}

          {board.log.length > 0 && (
            <Section title={t('company.board.log')}>
              {board.log.map((ticket) => ticketRow(ticket, whereOf(ticket), ticket.result?.summary))}
            </Section>
          )}

          <p className="text-[11px] text-[var(--text-muted)]">{t('company.board.notShown')}</p>
        </div>
      )}
    </div>
  );
}
