import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type StoreState } from '../../stores';
import { createWorkspaceAgentRosterSelector, type WorkspaceAgentRosterRow } from '../../stores/selectors/workspaceAgentRoster';
import { selectFleetBoard, selectHookRunningByPtyId, selectUnverifiablePaneMinutes, type FleetRow } from '../../stores/selectors/fleet';
import { useT } from '../../hooks/useT';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import { renderSentence } from '../../i18n/renderSentence';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import type { HandOutEntry } from '../../../shared/handOut';
import { paneTag } from '../../utils/paneNaming';
import { timeAgo } from '../../utils/timeAgo';
import { displayPath } from '../../utils/displayPath';
import { shortDir } from '../../utils/shortDir';
import { IDLE_TICK_MS } from '../../utils/idleTime';
import { FOCUS_RING } from '../focusRing';
import { StatusMarkView } from '../Sidebar/AgentMarks';
import { AGENT_STATUS_ICON } from '../Sidebar/agentStatusIcon';
import { rosterPrimaryLabel } from '../Sidebar/WorkspaceAgentRoster';
import { selectOwnerWorkspaces } from '../Sidebar/botTasks';
import type { Task } from '../../../shared/types';
import type { A2aSpawnOutgoingSummary } from '../../../shared/a2aSpawn';
import { remoteWorkspaceId } from '../../../shared/a2aRemoteDelivery';
import { agentRow } from '../../../shared/agentIdentity';
import { useHandOutItems, useMoaDecisions, useWorkLinks } from '../FleetView/useFleetSources';
import { buildFleetTickets, handOutTicketLine, paneLiveIn, type FleetTicket } from '../FleetView/fleetTickets';
import { HandOutAddForm, HandOutRing, handOutAddedLine, handOutFolderChoices } from '../FleetView/HandOutList';
import HandOutPopover from '../FleetView/HandOutPopover';
import { isTerminalKindSurfaceType } from '../Pane/surfaceKinds';
import { spawnUntil } from '../Remote/RemoteSpawnAskDialog';
import { REMOTE_SPAWN_UI_ENABLED } from '../Remote/remoteSpawnFlag';
import {
  buildCompanyBoard, companyHandOutItems, remoteSeatsOf, seatAsksOf, type BoardRemoteSeat, type BoardSeat, type BoardSeatAsk,
} from './companyBoard';
import { companyFolder } from './companyFolder';
import AddRemoteSeatDialog from './AddRemoteSeatDialog';
import HireSeatDialog from './HireSeatDialog';

const NOW_SHOWN = 2;
const NO_TASKS: Record<string, Task> = {};
const NO_AGENTS: StoreState['surfaceAgent'] = {};
const NO_REQUESTS: A2aSpawnOutgoingSummary[] = [];
const NO_FLAGS: Record<string, boolean> = {};
const NO_MINUTES: Record<string, number> = {};
const NO_ROWS: FleetRow[] = [];

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

type Rect = { top: number; left: number; right: number; bottom: number };

/**
 * Every Fleet row while `enabled`, live, from the inputs Fleet feeds
 * selectFleetBoard: the Hand out… popover reads a pane's section (a pane that
 * needs you is not offered) and idle time there, as it does in Fleet.
 */
function useFleetRows(enabled: boolean, now: number): readonly FleetRow[] {
  const inputs = useStore(useShallow((s) => (enabled ? {
    workspaces: selectOwnerWorkspaces(s),
    surfaceAgentStatus: s.surfaceAgentStatus,
    surfaceActivity: s.surfaceActivity,
    paneLabel: s.paneLabel,
    supervisionByPtyId: s.supervisionByPtyId,
    surfaceAgent: s.surfaceAgent,
    surfacePendingQuestion: s.surfacePendingQuestion,
    surfaceShellPrompt: s.surfaceShellPrompt,
    surfaceActivityAt: s.surfaceActivityAt,
    surfaceTurnOpenAt: s.surfaceTurnOpenAt,
    commandRunningByPtyId: s.commandRunningByPtyId,
    agentAliveByPtyId: s.agentAliveByPtyId,
    remoteWorkspaces: s.remoteWorkspaces,
    surfaceLastMessage: s.surfaceLastMessage,
    usageLimitWaiting: s.usageLimitWaiting,
  } : null)));
  const hookRunningByPtyId = useStore(useShallow((s) => (enabled ? selectHookRunningByPtyId(s) : NO_FLAGS)));
  const unverifiablePaneMinutes = useStore(useShallow((s) => (enabled ? selectUnverifiablePaneMinutes(s) : NO_MINUTES)));
  return useMemo(() => {
    if (!inputs) return NO_ROWS;
    // The output stamp moves on every chunk, so it is read, not subscribed, as Fleet does.
    const { groups } = selectFleetBoard(
      { ...inputs, hookRunningByPtyId, unverifiablePaneMinutes, surfaceOutputAt: useStore.getState().surfaceOutputAt },
      { now, sortMode: 'attention' },
    );
    return [...groups.needsYou, ...groups.finished, ...groups.running, ...groups.idle];
  }, [inputs, hookRunningByPtyId, unverifiablePaneMinutes, now]);
}

/**
 * To hand out on the board: the open items for the company's folder, each
 * given out through Fleet's Hand out… popover, and Add a task… with that
 * folder first. With no items it is one line, the heading and Add a task…,
 * so the company has a way in. It reads the list only while the board shows.
 */
function HandOutSection({ workspaceId, folder, isActive, now, scrollRef }: {
  workspaceId: string;
  folder: string;
  isActive: boolean;
  now: number;
  /** The board's scroll container: scrolling it closes the popover. */
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  // Bot workers are not Fleet's, so not the popover's or the form's either.
  const workspaces = useStore(selectOwnerWorkspaces);
  const listed = useHandOutItems(isActive);
  const items = useMemo(() => companyHandOutItems(listed, folder), [listed, folder]);
  const folders = useMemo(
    () => [folder, ...handOutFolderChoices(workspaces, workspaceId).filter((f) => f !== folder)],
    [folder, workspaces, workspaceId],
  );
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState<{ id: string; anchor: Rect; bounds: Rect } | null>(null);
  const pickItem = pick ? items.find((item) => item.id === pick.id) : undefined;
  const rows = useFleetRows(pick !== null, now);
  const addRef = useRef<HTMLButtonElement>(null);
  const pickTrigger = useRef<HTMLElement | null>(null);
  const ids = useId();
  // A pick whose item left the list, or whose board was hidden, has nothing to point at.
  useEffect(() => {
    if (pick && (!pickItem || !isActive)) setPick(null);
  }, [pick, pickItem, isActive]);
  // The row moves when the list changes above it: the popover follows the row.
  useLayoutEffect(() => {
    if (!pick) return;
    const row = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-board-hand-out]') ?? [])]
      .find((el) => el.dataset.boardHandOut === pick.id);
    if (!row) return;
    const r = row.getBoundingClientRect();
    const at = pick.anchor;
    if (r.top === at.top && r.left === at.left && r.right === at.right && r.bottom === at.bottom) return;
    setPick({ ...pick, anchor: { top: r.top, left: r.left, right: r.right, bottom: r.bottom } });
  });

  // A pane of this company that added an item needs no workspace name here.
  const workspaceName = (id: string) => (id === workspaceId ? '' : workspaces.find((ws) => ws.id === id)?.name ?? '');

  const openPick = (item: HandOutEntry, trigger: HTMLElement) => {
    const row = trigger.closest<HTMLElement>('[data-board-hand-out]');
    if (!row) return;
    const r = row.getBoundingClientRect();
    // The window, not the board's pane: a narrow board would squeeze the popover.
    const bounds = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
    pickTrigger.current = trigger;
    setPick({ id: item.id, anchor: { top: r.top, left: r.left, right: r.right, bottom: r.bottom }, bounds });
  };
  const closePick = useCallback(() => {
    setPick(null);
    // Back to the row's Hand out…, unless the press that closed it focused something else.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if ((!active || active === document.body) && pickTrigger.current?.isConnected) pickTrigger.current.focus({ preventScroll: true });
    });
  }, []);
  // A scroll moves the row out from under the popover: close it.
  const picking = pick !== null;
  useEffect(() => {
    const board = scrollRef.current;
    if (!picking || !board) return undefined;
    board.addEventListener('scroll', closePick, { passive: true });
    return () => board.removeEventListener('scroll', closePick);
  }, [picking, closePick, scrollRef]);
  const closeForm = useCallback(() => {
    setAdding(false);
    requestAnimationFrame(() => addRef.current?.focus());
  }, []);

  const addLink = (
    <button
      ref={addRef}
      type="button"
      className={`rounded-sm text-[12px] text-[var(--text-sub)] underline decoration-[var(--line)] underline-offset-[3px] hover:text-[var(--text-main)] ${FOCUS_RING}`}
      // The board's own pane takes a click that bubbles up and would win the focus back.
      onClick={(event) => { event.stopPropagation(); setAdding(true); }}
      data-board-hand-out-add
    >
      {t('fleet.handOut.addRow')}
    </button>
  );
  // Escape cancels, as Fleet's key handler does there. A click inside stays
  // off the board's pane, which would win the focus back.
  const form = adding && (
    <div
      className="mt-2 w-full"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        closeForm();
      }}
    >
      <HandOutAddForm folders={folders} onDone={closeForm} t={t} />
    </div>
  );
  const full = displayPath(folder);
  const folderLine = (
    <span className="min-w-0 text-[11px] text-[var(--text-muted)]" title={full} data-board-hand-out-folder>
      {renderSentence(t('company.board.handOutFolder'), {
        folder: (
          <span className="font-mono">
            <span aria-hidden="true">{shortDir(full)}</span>
            <span className="sr-only">{full}</span>
          </span>
        ),
      })}
    </span>
  );

  // Item text is untrusted: rendered as text only. In a narrow board Hand out…
  // wraps onto a line of its own rather than squeeze the title away.
  const itemRow = (item: HandOutEntry) => {
    const titleId = `${ids}-${item.id}`;
    return (
      <div key={item.id} className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-0.5 py-1.5" data-board-hand-out={item.id}>
        <span className="flex min-w-0 grow basis-40 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="flex h-2.5 w-2.5 flex-none items-center justify-center"><HandOutRing /></span>
            <span id={titleId} className="min-w-0 truncate text-[var(--text-main)]" title={item.note || undefined}>{item.title}</span>
          </span>
          <span className="truncate pl-[16px] text-[11px] text-[var(--text-muted)]" data-board-hand-out-meta>
            <span className={item.agent ? 'text-[var(--text-sub)]' : undefined}>{item.agent ?? t('fleet.handOut.anyAgent')}</span>
            {` · ${handOutAddedLine(item, now, workspaceName, t)}`}
          </span>
        </span>
        <button
          type="button"
          aria-describedby={titleId}
          aria-haspopup="dialog"
          aria-expanded={pick?.id === item.id}
          className={`ml-auto flex-none rounded-sm text-[12px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
          // The board's own pane takes a click that bubbles up and would win the focus back.
          onClick={(event) => { event.stopPropagation(); openPick(item, event.currentTarget); }}
          data-board-hand-out-pick
        >
          {t('fleet.handOut.handOut')}
        </button>
      </div>
    );
  };

  // Both states are one tree, so Add a task… keeps its node, and the focus,
  // when the first item arrives. Empty, the heading and the link share a line.
  const empty = items.length === 0;
  return (
    <section className={empty ? 'flex flex-wrap items-baseline gap-x-3 gap-y-1' : 'flex flex-col'} data-board-hand-out-section>
      <h3 className={`text-[11px] font-medium text-[var(--text-muted)] ${empty ? '' : 'mb-1'}`}>
        {t('fleet.handOut.title')}
        {!empty && <span className="ml-1.5 tabular-nums">{items.length}</span>}
      </h3>
      {!empty && <div className="flex flex-col divide-y divide-[var(--stroke)]">{items.map(itemRow)}</div>}
      {!adding && (
        <div className={empty ? 'flex items-baseline' : 'mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1'}>
          {addLink}
          {!empty && folderLine}
        </div>
      )}
      {form}
      {pick && pickItem && (
        // A portal, but its clicks still bubble up through React to the board's pane.
        <div onClick={(event) => event.stopPropagation()}>
          <HandOutPopover item={pickItem} anchor={pick.anchor} bounds={pick.bounds} rows={rows} workspaces={workspaces}
            onClose={closePick} t={t} />
        </div>
      )}
    </section>
  );
}

/**
 * Company mode's board (DESIGN.md "Company board"): a work tab that shows who
 * holds each seat of the workspace's company and what each seat is doing, from
 * the roster and the delegated-work tickets.
 */
export default function CompanyBoardPanel({ workspaceId, isActive, visible = true }: {
  workspaceId: string;
  /** The active tab of its pane. */
  isActive: boolean;
  /** Its workspace is on screen and no other pane is zoomed over it: To
   *  hand out reads its list, and keeps its pick open, only then. */
  visible?: boolean;
}) {
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
  const [hireSeat, setHireSeat] = useState(false);
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
  const folder = workspace && company ? companyFolder(workspace, leaves.find((l) => l.id === company.coordinatorPaneId)) : undefined;
  const rootRef = useRef<HTMLDivElement>(null);
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

  // A job picked from To hand out says so, with its PR once it has one, as in Fleet.
  const fromLine = (ticket: FleetTicket) => {
    const line = handOutTicketLine(ticket, t);
    return line && <span className="truncate text-[11px] text-[var(--text-muted)]" title={line} data-board-hand-out-line>{line}</span>;
  };

  const ticketRow = (ticket: FleetTicket, where: string, detail?: string) => (
    <div key={ticket.id} className="flex flex-col gap-0.5 py-1.5" data-board-ticket={ticket.id}>
      <span className="truncate text-[var(--text-main)]">{ticketTitle(ticket)}</span>
      <span className="truncate text-[11px] text-[var(--text-muted)]">
        {[where, ticket.state === 'needs-you' ? undefined : stateWord(ticket), timeAgo(ticket.updatedAt, now)].filter(Boolean).join(' · ')}
      </span>
      {fromLine(ticket)}
      {detail && <span className="line-clamp-2 text-[11px] text-[var(--text-sub)]">{detail}</span>}
    </div>
  );

  // A seat's open jobs, the ones that need you in the needs-you colour, and
  // the first job queued for it.
  const jobLines = (seat: Pick<BoardSeat, 'now' | 'next'>) => (
    <>
      {seat.now.slice(0, NOW_SHOWN).map((ticket) => (
        <Fragment key={ticket.id}>
          <span
            className={`truncate ${ticket.state === 'needs-you' ? 'text-[var(--attention-text)]' : 'text-[var(--text-sub)]'}`}
            data-board-now={ticket.id}
          >
            {ticketTitle(ticket)}
            {ticket.waitingOn && (
              <span className="text-[11px] text-[var(--text-muted)]" data-board-reported>{` · ${reportedTo(ticket)}`}</span>
            )}
          </span>
          {fromLine(ticket)}
        </Fragment>
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
      {seat.next.length > 0 && fromLine(seat.next[0])}
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
      ref={rootRef}
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

          {/* Placed here until the board's direction is chosen (DESIGN.md). */}
          {folder && <HandOutSection workspaceId={workspaceId} folder={folder} isActive={isActive && visible} now={now} scrollRef={rootRef} />}

          <Section
            title={t('company.board.seats')}
            after={ceoPaneId && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                <button
                  type="button"
                  className={`self-start rounded-sm text-[12px] text-[var(--text-sub)] underline decoration-[var(--line)] underline-offset-[3px] hover:text-[var(--text-main)] ${FOCUS_RING}`}
                  // The board's own pane takes a click that bubbles up and would win the focus back.
                  onClick={(event) => { event.stopPropagation(); setHireSeat(true); }}
                  data-board-hire-seat
                >
                  {t('company.hireSeat.menu')}
                </button>
                {REMOTE_SPAWN_UI_ENABLED && (
                  <button
                    type="button"
                    className={`self-start rounded-sm text-[12px] text-[var(--text-sub)] underline decoration-[var(--line)] underline-offset-[3px] hover:text-[var(--text-main)] ${FOCUS_RING}`}
                    onClick={(event) => { event.stopPropagation(); setAddSeat(true); }}
                    data-board-add-remote-seat
                  >
                    {t('company.addSeat.menu')}
                  </button>
                )}
              </div>
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
      {hireSeat && <HireSeatDialog workspaceId={workspaceId} onClose={() => setHireSeat(false)} />}
    </div>
  );
}
