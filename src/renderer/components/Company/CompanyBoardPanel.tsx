import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import type { A2aSpawnOutgoingSummary } from '../../../shared/a2aSpawn';
import { remoteWorkspaceId } from '../../../shared/a2aRemoteDelivery';
import { agentRow } from '../../../shared/agentIdentity';
import { useMoaDecisions, useWorkLinks } from '../FleetView/useFleetSources';
import { buildFleetTickets, paneLiveIn, type FleetTicket } from '../FleetView/fleetTickets';
import { isTerminalKindSurfaceType } from '../Pane/surfaceKinds';
import { spawnUntil } from '../Remote/RemoteSpawnAskDialog';
import { REMOTE_SPAWN_UI_ENABLED } from '../Remote/remoteSpawnFlag';
import { buildCompanyBoard, remoteSeatsOf, seatAsksOf, type BoardRemoteSeat, type BoardSeat, type BoardSeatAsk } from './companyBoard';
import AddRemoteSeatDialog from './AddRemoteSeatDialog';

const NOW_SHOWN = 2;
const NO_TASKS: Record<string, Task> = {};
const NO_AGENTS: StoreState['surfaceAgent'] = {};
const NO_REQUESTS: A2aSpawnOutgoingSummary[] = [];

function Section({ title, count, needsYou = false, children, after }: { title: string; count?: number; needsYou?: boolean; children: ReactNode; after?: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="mb-1 text-[11px] font-medium text-[var(--text-muted)]">
        {title}
        {count !== undefined && (
          <span className={`ml-1.5 tabular-nums ${needsYou ? 'text-[var(--attention-text)]' : ''}`}>{count}</span>
        )}
      </h3>
      <div className="flex flex-col divide-y divide-[var(--stroke)]">{children}</div>
      {after}
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
  const workspaces = useStore((s) => s.workspaces);
  const workspace = workspaces.find((w) => w.id === workspaceId);
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
  const remoteLinks = useStore((s) => s.a2aRemote.links);
  const remoteHosts = useStore((s) => s.a2aRemote.hosts);
  // What the CEO pane asked other PCs to start; not in the store, so read
  // here while the board shows, again on every link nudge (a request this PC
  // sent rides that channel). A failed read keeps the last list.
  const [requests, setRequests] = useState<A2aSpawnOutgoingSummary[]>(NO_REQUESTS);
  const readRequests = useCallback(async () => {
    const read = window.electronAPI?.a2aRemote?.spawnOutgoing;
    if (!read) return;
    const v = await read().catch(() => null);
    if (v && Array.isArray(v.requests)) setRequests(v.requests);
  }, []);
  const readsRequests = REMOTE_SPAWN_UI_ENABLED && isActive && !!company;
  useEffect(() => {
    if (!readsRequests) return undefined;
    void readRequests();
    return window.electronAPI?.a2aRemote?.onLinkEvent?.(() => void readRequests());
  }, [readsRequests, readRequests]);
  const [addSeat, setAddSeat] = useState(false);
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
  // The CEO's seat while it is still a pane of the workspace.
  const ceoPaneId = company?.coordinatorPaneId && leaves.some((l) => l.id === company.coordinatorPaneId) ? company.coordinatorPaneId : null;
  const remoteSeats = useMemo(
    () => remoteSeatsOf({ workspaceId, coordinatorPaneId: ceoPaneId, links: remoteLinks, hosts: remoteHosts }),
    [workspaceId, ceoPaneId, remoteLinks, remoteHosts],
  );
  const asks = useMemo(
    () => seatAsksOf({ workspaceId, coordinatorPaneId: ceoPaneId, requests, hosts: remoteHosts, now }),
    [workspaceId, ceoPaneId, requests, remoteHosts, now],
  );
  const board = useMemo(() => {
    // The log keeps the last ten finished jobs however old, not Fleet's last day.
    const tickets = buildFleetTickets({ links, decisions, a2aTasks, now, recentMs: Infinity, paneLive: paneLiveIn(workspaces) });
    return buildCompanyBoard({
      workspaceId,
      coordinatorPaneId: company?.coordinatorPaneId ?? null,
      paneIds: leaves.map((leaf) => leaf.id),
      agentPaneIds,
      rows: roster.rows,
      tickets,
      links,
      paneRole,
      remoteSeats,
    });
  }, [links, decisions, a2aTasks, now, workspaces, workspaceId, company?.coordinatorPaneId, leaves, agentPaneIds, roster.rows, paneRole, remoteSeats]);

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
  // A job inside the company is placed by its seat (a seat on another PC by
  // its name), one handed out by the workspace or other PC's pane it went to.
  const whereOf = (ticket: FleetTicket): string => (ticket.workspaceId === workspaceId
    ? seatName(ticket.paneId)
    : board.remoteSeats.find((seat) => remoteWorkspaceId(seat.linkId) === ticket.workspaceId)?.name
      ?? workspaceNames[ticket.workspaceId] ?? ticket.workspaceName ?? t('fleet.ticket.unknownWorkspace'));
  // A job that reported back waits on the pane that sent it: the CEO, a seat,
  // or a workspace outside the company.
  const reportedTo = (ticket: FleetTicket): string | undefined => {
    const party = ticket.waitingOn;
    if (!party) return undefined;
    const name = party.workspaceId !== workspaceId
      ? workspaceNames[party.workspaceId] ?? t('fleet.ticket.unknownWorkspace')
      : party.paneId === company?.coordinatorPaneId ? t('company.ceo') : seatName(party.paneId) || workspace?.name || '';
    return t('company.board.reportedTo', { name });
  };
  const stateWord = (ticket: FleetTicket) => reportedTo(ticket) ?? t(`fleet.ticket.state.${ticket.state}`);
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

  // A seat's open jobs, the ones that need you in the needs-you colour, and
  // the first job queued for it.
  const jobLines = (seat: Pick<BoardSeat, 'now' | 'next'>) => (
    <>
      {seat.now.slice(0, NOW_SHOWN).map((ticket) => (
        <span
          key={ticket.id}
          className={`truncate ${ticket.state === 'needs-you' ? 'text-[var(--attention-text)]' : 'text-[var(--text-sub)]'}`}
          data-board-now={ticket.id}
        >
          {ticketTitle(ticket)}
          {ticket.waitingOn && (
            <span className="text-[11px] text-[var(--text-muted)]" data-board-reported>{` · ${reportedTo(ticket)}`}</span>
          )}
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
    </>
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
          {jobLines(seat)}
        </span>
      </button>
    );
  };

  // A seat on another PC: no pane here to focus, so not a button. Running
  // while it holds an open job; a report back reads as one, not as needs-you.
  const remoteSeatRow = (seat: BoardRemoteSeat) => {
    const status = seat.now.length > 0 ? 'running' : 'idle';
    return (
      <div key={seat.linkId} className="flex flex-col gap-0.5 py-1.5" data-board-remote-seat={seat.linkId}>
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusMarkView status={status} quiet label={t(AGENT_STATUS_ICON[status].labelKey)} />
          <span className="min-w-0 truncate font-semibold text-[var(--text-main)]">{seat.name}</span>
          {/* A long PC name takes only the room the seat's name leaves. */}
          <span className="min-w-0 flex-1 basis-0 truncate text-[11px] text-[var(--text-muted)]">{t('company.board.onPc', { pc: seat.pc })}</span>
        </span>
        <span className="flex flex-col gap-0.5 pl-[16px]">{jobLines(seat)}</span>
      </div>
    );
  };

  // An ask the CEO pane made for a seat on another PC: waiting for that PC,
  // or, for a day, why it did not start.
  const askRow = (ask: BoardSeatAsk) => {
    const name = ask.label ?? agentRow(ask.agent)?.display ?? ask.agent;
    const line = !ask.pending
      ? `${t('company.board.askEnded', { reason: t(`remoteSpawn.code.${ask.code ?? 'failed'}`, { pc: ask.pc }) })} · ${timeAgo(ask.updatedAt, now)}`
      : ask.online
        ? t('company.board.askWaiting', { pc: ask.pc, age: timeAgo(ask.createdAt, now) })
        : t('company.board.askOffline', { pc: ask.pc, time: spawnUntil(ask.expiresAt) });
    return (
      <div key={ask.spawnId} className="flex flex-col gap-0.5 py-1.5" data-board-ask={ask.spawnId} data-pending={ask.pending || undefined}>
        <span className="flex min-w-0 items-center gap-1.5">
          {ask.pending ? (
            <span className="flex h-2.5 w-2.5 flex-none items-center justify-center" data-status-mark="asked" aria-hidden="true">
              <span className="h-[7px] w-[7px] rounded-full border-[1.5px] border-dashed border-[var(--text-muted)]" />
            </span>
          ) : (
            <StatusMarkView status="idle" quiet />
          )}
          <span className="min-w-0 truncate font-semibold text-[var(--text-sub)]">{name}</span>
          <span className="min-w-0 flex-1 basis-0 truncate text-[11px] text-[var(--text-muted)]">{t('company.board.onPc', { pc: ask.pc })}</span>
        </span>
        <span className="truncate pl-[16px] text-[11px] text-[var(--text-muted)]" data-board-ask-line>{line}</span>
      </div>
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

          <Section
            title={t('company.board.seats')}
            after={REMOTE_SPAWN_UI_ENABLED && ceoPaneId && (
              <button
                type="button"
                className={`mt-2 self-start rounded-sm text-[12px] text-[var(--text-sub)] underline decoration-[var(--line)] underline-offset-[3px] hover:text-[var(--text-main)] ${FOCUS_RING}`}
                // The board's own pane takes a click that bubbles up and would win the focus back.
                onClick={(event) => { event.stopPropagation(); setAddSeat(true); }}
                data-board-add-remote-seat
              >
                {t('company.addSeat.menu')}
              </button>
            )}
          >
            {board.seats.map(seatRow)}
            {board.remoteSeats.map(remoteSeatRow)}
            {asks.map(askRow)}
          </Section>

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
      {addSeat && <AddRemoteSeatDialog workspaceId={workspaceId} onClose={() => setAddSeat(false)} />}
    </div>
  );
}
