import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useStore } from '../../stores';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../hooks/useT';
import {
  selectFleetBoard,
  selectHookRunningByPtyId,
  selectUnverifiablePaneMinutes,
  fleetTargetPtyId,
  type FleetPane,
  type FleetRow,
} from '../../stores/selectors/fleet';
import { selectApprovalInbox } from '../../stores/selectors/approvalInbox';
import { selectReviewQueue, selectReviewQueueIds, type ReviewQueueEntry } from '../../stores/selectors/reviewQueue';
import { selectRemoteInbox } from '../../stores/selectors/remoteInbox';
import { resolveInboxItem } from '../../utils/resolveInboxItem';
import {
  focusPaneByPtyId,
  activatePaneTarget,
  focusNotificationTarget,
} from '../../hooks/useNotificationListener';
import { fleetChangedSinceSeen, type FleetSeenEntry } from '../../stores/slices/uiSlice';
import { tailForPty } from '../../utils/terminalTail';
import { onTerminalRegistered } from '../../hooks/useTerminal';
import FleetBoardCard from './FleetBoardCard';
import PresetPicker from '../Sidebar/PresetPicker';
import {
  BOARD_COLUMNS, boardAgentCount, boardLayout, buildBoardColumns, foldByOwner, moveOnBoard, rowApprovalIndex, visibleChips,
  type BoardChip, type BoardColumn, type BoardGrid, type BoardGroup, type BoardItem,
} from './fleetBoardModel';
import { resolveTaskLink } from '../../utils/fanoutProvenance';
import { selectScheduleNavSummary } from '../../stores/selectors/schedules';
import { formatNextShort } from '../Schedules/format';
import FleetReviewRow, { reviewBusyKind, reviewPrVerb, reviewRowKey, type ReviewEditorKind } from './FleetReviewRow';
import { pruneReviewSummaries } from './reviewSummary';
import { openTaskDiff } from '../../utils/openTaskDiff';
import { FleetRowMenu, FleetRowEditor, fleetRowVerbsFromState, toggleFleetStash, type FleetEditorKind } from './FleetRowActions';
import ApprovalInboxList from './ApprovalInboxList';
import RecentAutoRuns from './RecentAutoRuns';
import RemoteInboxList from './RemoteInboxList';
import { fleetTitle, matchesFleetFilter, type FleetFilter } from './fleetPresentation';
import { formatIdle, IDLE_SHOW_AFTER_MS, IDLE_TICK_MS } from '../../utils/idleTime';
import { IconCheck, IconChevron, IconPlus } from '../icons';

/** True when a key event comes from a text-entry control. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** A value safe inside a double-quoted attribute selector. */
function attr(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** How long a sidebar "N to review" request waits for its row to appear. */
const FOCUS_REVIEW_WAIT_MS = 5_000;

/** Idle agents named in the collapsed Idle column before "+N more". */
const IDLE_PEEK = 5;

/** Roving key of the collapsed "Idle N" row (pane ids never take this form). */
const IDLE_TOGGLE_KEY = 'fleet:idle-toggle';

/** Fleet is a non-modal overlay above the tools dock. AppLayout owns its
 * positioning, so opening it never resizes terminal panes. The covered dock
 * stays mounted but inert; close restores it and the original focus target.
 * Subscriptions and polling run only while Fleet is open. */
export default function FleetView() {
  const t = useT();
  const setVisible = useStore((s) => s.setFleetViewVisible);
  const workspaces = useStore((s) => s.workspaces);
  const surfaceAgentStatus = useStore((s) => s.surfaceAgentStatus);
  // Hook-driven per-pane activity line (fleet-activity-line-hook). Subscribed
  // here so the selector re-runs when an agent's PostToolUse activity changes.
  const surfaceActivity = useStore((s) => s.surfaceActivity);
  const paneLabel = useStore((s) => s.paneLabel);
  // #850: per-PTY agent identity — gates workspace metadata inheritance so a
  // non-agent active pane never borrows the real agent's name/status.
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const surfacePendingQuestion = useStore((s) => s.surfacePendingQuestion);
  const surfaceActivityAt = useStore((s) => s.surfaceActivityAt);
  const surfaceTurnOpenAt = useStore((s) => s.surfaceTurnOpenAt);
  const commandRunningByPtyId = useStore((s) => s.commandRunningByPtyId);
  const agentAliveByPtyId = useStore((s) => s.agentAliveByPtyId);
  const usageLimitWaiting = useStore((s) => s.usageLimitWaiting);
  const hookRunningByPtyId = useStore(useShallow(selectHookRunningByPtyId));
  const unverifiableMinutes = useStore(useShallow(selectUnverifiablePaneMinutes));
  const missions = useStore((s) => s.missionByPaneGroup);
  // Ready to review: finished fan-out tasks whose record is still open. The
  // id list is the shared selector the sidebar rollup counts with (#1508).
  const reviewIds = useStore(useShallow(selectReviewQueueIds));
  const surfaceTurnEndAt = useStore((s) => s.surfaceTurnEndAt);
  const setFleetFocusReview = useStore((s) => s.setFleetFocusReview);
  const fleetFocusReview = useStore((s) => s.fleetFocusReview);
  const surfaceLastMessage = useStore((s) => s.surfaceLastMessage);
  const fleetIdleExpanded = useStore((s) => s.fleetIdleExpanded);
  // Baseline from the previous close; only written on unmount, so it stays
  // fixed for the whole time the overlay is open.
  const fleetLastSeen = useStore((s) => s.fleetLastSeen);
  const setFleetIdleExpanded = useStore((s) => s.setFleetIdleExpanded);
  // X8 supervision mirror — subscribed here so the selector re-runs when a
  // supervised pane arms/stops or its restart count changes.
  const supervisionByPtyId = useStore((s) => s.supervisionByPtyId);
  // #1343 — attached remote-host mirrors, so remote agents get a card here
  // (the sidebar roster has shown them since #1163). Fleet View is a VIEW; the
  // deck's commandable roster deliberately does not pass this.
  const remoteWorkspaces = useStore((s) => s.remoteWorkspaces);

  // S-C2: tab lives in uiSlice (not FleetView-local) so the A2A / MCP approval
  // modals can suppress themselves while the inbox tab is open (AppLayout delta
  // 5). Reset to 'fleet' on unmount (mount-gated = close) so reopening the
  // cockpit always lands on the agent list.
  const tab = useStore((s) => s.fleetActiveTab);
  const setTab = useStore((s) => s.setFleetActiveTab);
  useEffect(() => () => setTab('fleet'), [setTab]);

  // S-C1 follow-up — situational sort: 'attention' (awaiting_input floats up,
  // then sidebar order) ↔ 'workspace' (pure sidebar order). Persists across
  // cockpit open/close within a session (not reset on unmount, unlike the tab).
  const fleetSortMode = useStore((s) => s.fleetSortMode);
  const setFleetSortMode = useStore((s) => s.setFleetSortMode);

  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [previewOpen, setPreviewOpen] = useState(false);
  // The one inline row editor that is open (message / label / close confirm).
  const [editor, setEditor] = useState<{ paneId: string; kind: FleetEditorKind } | null>(null);
  // The inline confirm open under a review row (close task / create PR).
  const [reviewEditor, setReviewEditor] = useState<{ workspaceId: string; kind: ReviewEditorKind } | null>(null);
  const reviewEditorRef = useRef(reviewEditor);
  reviewEditorRef.current = reviewEditor;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), IDLE_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  const [inboxIdx, setInboxIdx] = useState(0);
  const [remoteIdx, setRemoteIdx] = useState(0);
  // Selected terminal preview, populated only while its disclosure is open.
  const [tails, setTails] = useState<Record<string, string[]>>({});
  // TASK-6 — per-pane agent RAM. {ptyId: {rss bytes, image?}}. Filled by ONE
  // shared 4s poll below that only runs while this (mount-gated) cockpit is open.
  const [resources, setResources] = useState<Record<string, { rss: number; image?: string }>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The board's inputs are assembled in selectFleetBoard, which the
  // fleet.triage RPC also calls, so what an agent is told matches this screen.
  // The output stamp moves on every chunk, so it is read on the minute tick
  // (`now`) rather than subscribed; elapsed time is minute-granular anyway.
  const { panes, groups } = useMemo(() => selectFleetBoard({
      workspaces, surfaceAgentStatus, surfaceActivity, paneLabel, supervisionByPtyId,
      surfaceAgent, surfacePendingQuestion, surfaceActivityAt, surfaceTurnOpenAt,
      commandRunningByPtyId, agentAliveByPtyId, hookRunningByPtyId, remoteWorkspaces,
      surfaceLastMessage, surfaceOutputAt: useStore.getState().surfaceOutputAt,
      unverifiablePaneMinutes: unverifiableMinutes, usageLimitWaiting,
    }, { now, sortMode: fleetSortMode }), [usageLimitWaiting, workspaces, surfaceAgentStatus, surfaceActivity, paneLabel, supervisionByPtyId,
    surfaceAgent, surfacePendingQuestion, surfaceActivityAt, surfaceTurnOpenAt,
    commandRunningByPtyId, agentAliveByPtyId, hookRunningByPtyId, remoteWorkspaces, unverifiableMinutes,
    surfaceLastMessage, now, fleetSortMode]);
  // On close (unmount), remember what each pane's status was, so the next open
  // can mark needs-you rows that changed while Fleet was not being looked at.
  const panesRef = useRef(panes);
  panesRef.current = panes;
  useEffect(() => () => {
    const questions = useStore.getState().surfacePendingQuestion;
    const statuses: Record<string, FleetSeenEntry> = {};
    for (const pane of panesRef.current) {
      if (!pane.ptyId) continue;
      const question = questions[fleetTargetPtyId(pane)];
      statuses[pane.ptyId] = question ? { status: pane.agentStatus, question } : { status: pane.agentStatus };
    }
    useStore.getState().setFleetLastSeen(statuses);
  }, []);
  // Search and status filters narrow each section; the sections themselves
  // (and so the chip counts) come from the one groupFleetPanes pass.
  const visibleGroups = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const keep = (row: FleetRow) => matchesFleetFilter(row, filter) && (!term || [
      fleetTitle(row.pane, missions[row.pane.workspaceId]), row.pane.workspaceName, row.pane.agentName,
      row.pane.title, row.pane.cwd, row.pane.activity, row.detail,
    ].some((value) => value?.toLocaleLowerCase().includes(term)));
    return { needsYou: groups.needsYou.filter(keep), running: groups.running.filter(keep), idle: groups.idle.filter(keep) };
  }, [groups, filter, query, missions]);
  // Rows re-derive when a task's record, its workspace (name, metadata.pr —
  // both live on the workspaces array) or a turn-end stamp changes. The
  // output stamp (fallback for panes finished before stamping existed) is read
  // on the minute tick, as for the board. Membership comes from reviewIds.
  const reviewQueue = useMemo(
    () => (reviewIds.length === 0 ? [] : selectReviewQueue(useStore.getState())),
    [reviewIds, workspaces, missions, surfaceTurnEndAt, now],
  );
  // Cached change counts for tasks that left the queue are dropped.
  useEffect(() => {
    pruneReviewSummaries(new Set(reviewQueue.map((entry) => entry.taskId)));
  }, [reviewQueue]);
  const visibleReview = useMemo(() => {
    if (filter !== 'all' && filter !== 'complete') return [];
    const term = query.trim().toLocaleLowerCase();
    if (!term) return reviewQueue;
    return reviewQueue.filter((entry) => [entry.title, entry.ownerName, entry.branch]
      .some((value) => value?.toLocaleLowerCase().includes(term)));
  }, [reviewQueue, filter, query]);
  // Idle stays collapsed to its count unless expanded, or unless the user is
  // searching (a hidden match would read as none).
  const idleForced = filter === 'idle' || query.trim() !== '';
  const idleShown = fleetIdleExpanded || idleForced;
  // The four board columns (the same sections as the sidebar and
  // fleet.triage; finished panes split into Ready to review).
  const columns = useMemo(
    () => buildBoardColumns(visibleGroups, visibleReview, reviewRowKey),
    [visibleGroups, visibleReview],
  );
  // How many agents and finished tasks exist at all — the layout follows
  // the fleet, not the search.
  const boardCount = useMemo(
    () => boardAgentCount(buildBoardColumns(groups, reviewQueue, reviewRowKey)),
    [groups, reviewQueue],
  );
  const layout = boardLayout(boardCount);
  const dense = layout === 'dense';
  // Dense board: a mission's cards fold under the first of them.
  const fanoutLineage = useStore((s) => s.fanoutLineage);
  const fanoutSpawnOwner = useStore((s) => s.fanoutSpawnOwner);
  const [openFolds, setOpenFolds] = useState<Set<string>>(() => new Set());
  const ownerOf = useCallback((item: BoardItem) => {
    const ws = item.kind === 'pane' ? item.row.pane.workspaceId : item.entry.workspaceId;
    const link = resolveTaskLink(missions[ws], fanoutLineage[ws], fanoutSpawnOwner[ws]);
    return link?.ownerId || undefined;
  }, [missions, fanoutLineage, fanoutSpawnOwner]);
  const columnGroups = useMemo(() => {
    const out = {} as Record<BoardColumn, BoardGroup[]>;
    for (const c of BOARD_COLUMNS) {
      out[c] = dense ? foldByOwner(columns[c], ownerOf) : columns[c].map((lead) => ({ lead, folded: [] }));
    }
    return out;
  }, [columns, dense, ownerOf]);
  // Focusable keys per column in display order (folded cards are hidden;
  // the idle column starts with its count toggle).
  const grid = useMemo<BoardGrid>(() => {
    const keysOf = (c: BoardColumn) => columnGroups[c].flatMap((g) => [
      g.lead.key,
      ...(g.owner && openFolds.has(`${c}:${g.owner}`) ? g.folded.map((f) => f.key) : []),
    ]);
    return {
      needsYou: keysOf('needsYou'),
      running: keysOf('running'),
      review: keysOf('review'),
      idle: columns.idle.length === 0 ? [] : [
        ...(idleForced ? [] : [IDLE_TOGGLE_KEY]),
        ...(idleShown ? keysOf('idle') : []),
      ],
    };
  }, [columnGroups, openFolds, columns.idle.length, idleForced, idleShown]);
  const rovingKeys = useMemo(() => BOARD_COLUMNS.flatMap((c) => grid[c]), [grid]);
  const visibleRows = useMemo(
    () => BOARD_COLUMNS.flatMap((c) => columns[c]).flatMap((item) => (item.kind === 'pane' ? [item.row] : [])),
    [columns],
  );
  const matchCount = BOARD_COLUMNS.reduce((n, c) => n + columns[c].length, 0);
  const idleOldestMs = visibleGroups.idle.reduce<number | undefined>(
    (max, row) => (row.idleForMs !== undefined && (max === undefined || row.idleForMs > max) ? row.idleForMs : max),
    undefined,
  );
  // Preserve the selected pane when live status updates reorder the list.
  const focusedIdx = Math.max(0, rovingKeys.indexOf(focusedPaneId ?? ''));
  const focusedKey = rovingKeys[focusedIdx];
  const selectedPane = visibleRows.find((row) => row.pane.paneId === focusedKey)?.pane;
  const focusedReview = visibleReview.find((entry) => reviewRowKey(entry.workspaceId) === focusedKey);
  // A short fleet opens its preview: there is room, and it is the point.
  useEffect(() => { if (layout === 'list') setPreviewOpen(true); }, [layout]);
  const previewPtyId = previewOpen && tab === 'fleet' && selectedPane?.surfaceType === 'terminal'
    ? selectedPane.ptyId : '';
  // Stable identity key of the terminal ptyIds to poll for RAM. `panes`
  // recomputes on every streaming activity tick (surfaceActivity/agentStatus
  // are memo deps), so keying the resource-poll effect on `panes` directly
  // would tear down + re-fire the poll (a fresh CIM spawn) each tick while
  // Fleet View is open and any agent streams. This string only changes when the
  // set of polled ptyIds changes, so the effect's interval stays stable.
  const resourcePtyIdsKey = useMemo(
    () => panes.filter((p) => p.surfaceType === 'terminal' && p.ptyId).map((p) => p.ptyId).sort().join(','),
    [panes],
  );

  // S-C2 approval inbox — pure derivation of the pending-approval sources
  // (A2A-first, then browser help requests, then MCP). Mirrors the fleet
  // selector's narrow subscription.
  const mcpPrompts = useStore((s) => s.mcpPrompts);
  const mcpPromptOrder = useStore((s) => s.mcpPromptOrder);
  const pendingExecuteApprovals = useStore((s) => s.pendingExecuteApprovals);
  const pendingExecuteApprovalOrder = useStore((s) => s.pendingExecuteApprovalOrder);
  const browserHelpRequests = useStore((s) => s.browserHelpRequests);
  const browserHelpOrder = useStore((s) => s.browserHelpOrder);
  const inbox = useMemo(
    () => selectApprovalInbox({
      mcpPrompts,
      mcpPromptOrder,
      pendingExecuteApprovals,
      pendingExecuteApprovalOrder,
      browserHelpRequests,
      browserHelpOrder,
    }),
    [mcpPrompts, mcpPromptOrder, pendingExecuteApprovals, pendingExecuteApprovalOrder, browserHelpRequests, browserHelpOrder],
  );

  // LanLink PR-5 remote inbox — pure derivation of off-machine peer messages
  // (PR-2 built the slice + selector; this is the first consumer). dismissRemoteItem
  // is a view action (per-card X / Delete key); it never touches peer trust state.
  const remoteItems = useStore((s) => s.remoteItems);
  const remoteItemOrder = useStore((s) => s.remoteItemOrder);
  const dismissRemoteItem = useStore((s) => s.dismissRemoteItem);
  const remoteInbox = useMemo(
    () => selectRemoteInbox({ remoteItems, remoteItemOrder }),
    [remoteItems, remoteItemOrder],
  );

  // Raw terminal output is opt-in and only read for the selected pane. A closed
  // preview does no buffer polling; chrome/prompts never masquerade as progress.
  useEffect(() => {
    setTails({});
    if (!previewPtyId) return;
    const refresh = () => {
      const tail = tailForPty(previewPtyId, 20);
      setTails((prev) => {
        const before = prev[previewPtyId];
        return before?.length === tail.length && tail.every((line, i) => before[i] === line)
          ? prev : { [previewPtyId]: tail };
      });
    };
    refresh();
    const id = window.setInterval(refresh, 750);
    const unsub = onTerminalRegistered(refresh);
    return () => { window.clearInterval(id); unsub(); };
  }, [previewPtyId]);

  // TASK-6 — per-pane agent resource attribution. The whole component is
  // mount-gated on `fleetViewVisible`, so this interval exists ONLY while the
  // cockpit is open: a closed Fleet View issues ZERO Win32_Process snapshots
  // (the plan's polling-gate acceptance criterion). Each 4s tick sends the
  // currently-shown terminal ptyIds to main, which takes ONE CIM snapshot, walks
  // each pane shell's descendant tree, and returns summed RAM + heaviest child
  // image. Non-Windows / local mode / snapshot failure → empty map → no chips.
  useEffect(() => {
    if (typeof window.electronAPI?.pty?.resources !== 'function') return;
    let cancelled = false;
    const ptyIds = resourcePtyIdsKey ? resourcePtyIdsKey.split(',') : [];
    if (ptyIds.length === 0) {
      setResources((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    // In-flight guard: a CIM snapshot can take up to ~8s (slow machines), longer
    // than the 4s tick — without this the interval would stack concurrent
    // whole-machine powershell spawns. Skip a tick while one is still running.
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await window.electronAPI.pty.resources(ptyIds);
        if (!cancelled) setResources(next ?? {});
      } catch {
        // Fail-soft: keep the last-known values, drop no chips mid-glance.
      } finally {
        inFlight = false;
      }
    };
    void poll(); // paint immediately; don't wait 4s for the first sample.
    const id = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [resourcePtyIdsKey]);

  // Fleet is a rail page: a jump lands on a pane, so it always returns to
  // Workspaces, where the focus-key effect hands input to that pane.
  const finishJump = useCallback(() => {
    // Navigation supersedes the opener.
    restoreFocusRef.current = null;
    setVisible(false);
  }, [setVisible]);

  // Jump to a pane and go back to Workspaces.
  // Terminal panes resolve by their active-surface ptyId via the full
  // notification jump — which also marks that surface's notifications read and
  // clears its attention ring. That side effect is intentional here: jumping to
  // a pane from the cockpit acknowledges it, exactly like the toast-click and
  // pane-click paths. It does NOT touch the agentStatus, so the card keeps
  // showing awaiting_input until the agent actually resumes. Browser/editor/
  // unspawned surfaces have no ptyId (and no ring), so they activate the
  // workspace+pane+surface directly via the shared activation core.
  const jump = useCallback((card: FleetPane) => {
    const getState = () => useStore.getState();
    // #1343 — `!card.remote` is load-bearing: a remote row's ptyId is the
    // SYNTHETIC `remote:{host}:{session}` key, which no local surface carries,
    // so focusPaneByPtyId would fail its lookup and the click would silently do
    // nothing. Remote rows take the pane/surface path below, as they did when
    // they still had an empty ptyId.
    if (card.ptyId && !card.remote) {
      // focusPaneByPtyId unstashes on the way (#977). A background tab that
      // won the row's attention is the one the jump lands on.
      focusPaneByPtyId(getState, fleetTargetPtyId(card));
    } else if (card.surfaceId) {
      // No ptyId — an unspawned surface, or a stashed pane whose session died.
      // activatePaneTarget only works on the visible tree, so put the pane back
      // first; the dead-pane recovery offer then renders in its own slot, which
      // is where the user can see what is being recovered.
      if (card.stashed) useStore.getState().unstashPane(card.paneId, card.workspaceId);
      activatePaneTarget(getState, {
        workspaceId: card.workspaceId,
        paneId: card.paneId,
        surfaceId: card.surfaceId,
      });
    } else {
      focusNotificationTarget(getState, { workspaceId: card.workspaceId });
    }
    finishJump();
  }, [finishJump]);

  // Same clamp for the inbox: a row resolving (or the A2A 30s auto-deny)
  // shrinks the list, so the focused index must never dangle past the end.
  useEffect(() => {
    setInboxIdx((i) => Math.min(i, Math.max(inbox.length - 1, 0)));
  }, [inbox.length]);

  // Same clamp for the remote inbox: dismissing a card shrinks the list.
  useEffect(() => {
    setRemoteIdx((i) => Math.min(i, Math.max(remoteInbox.length - 1, 0)));
  }, [remoteInbox.length]);

  // 현재 탭·포커스 인덱스에 해당하는 카드/행에 실제 DOM 포커스를 건다. 성공 시 true.
  // 패널 컨테이너(panelRef)가 아니라 항목 요소에 직접 걸어야 (1) 보조기술이 최초
  // 선택을 announce하고 (2) 탭에 카드가 하나뿐이어도 로빙 인덱스 클램프에 갇히지
  // 않는다. 마운트 효과와 로빙 효과가 공유하는 단일 포커스 경로.
  const focusActiveItem = useCallback(() => {
    if (tab === 'fleet' && rovingKeys.length > 0) {
      const review = visibleReview.find((entry) => reviewRowKey(entry.workspaceId) === focusedKey);
      const el = !focusedKey ? null : review
        ? listRef.current?.querySelector<HTMLElement>(`[data-fleet-review-row][data-workspace-id="${attr(review.workspaceId)}"]`)
        : listRef.current?.querySelector<HTMLElement>(`[data-board-key="${attr(focusedKey)}"]`);
      if (el) { el.focus(); return true; }
    } else if (tab === 'approvals' && inbox.length > 0) {
      const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[role=option]');
      const el = rows && rows[inboxIdx];
      if (el) { el.focus(); return true; }
    } else if (tab === 'remote' && remoteInbox.length > 0) {
      const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[role=option]');
      const el = rows && rows[remoteIdx];
      if (el) { el.focus(); return true; }
    }
    return false;
  }, [tab, focusedKey, visibleReview, inboxIdx, remoteIdx, rovingKeys.length, inbox.length, remoteInbox.length]);

  // 마운트 효과([] deps)가 매 포커스 변경마다 재실행되지 않으면서도 최신 상태를
  // 읽도록, 최신 focusActiveItem 클로저를 ref에 보관한다.
  const focusActiveItemRef = useRef(focusActiveItem);
  focusActiveItemRef.current = focusActiveItem;

  // Close the inline editor and hand focus back to the roving row (the row
  // may be gone after a close; then the next row takes the slot).
  const closeEditor = useCallback(() => {
    setEditor(null);
    setReviewEditor(null);
    requestAnimationFrame(() => { focusActiveItemRef.current(); });
  }, []);
  // An editor whose pane left the visible rows (closed elsewhere, filtered
  // out, collapsed into Idle) has nothing to act on: drop it.
  useEffect(() => {
    if (editor && !visibleRows.some((row) => row.pane.paneId === editor.paneId)) setEditor(null);
  }, [editor, visibleRows]);
  // Same for a review row that left the queue (an agent resumed, the task
  // closed) — except while its own action is running, which closes it.
  useEffect(() => {
    if (reviewEditor && !visibleReview.some((entry) => entry.workspaceId === reviewEditor.workspaceId)) setReviewEditor(null);
  }, [reviewEditor, visibleReview]);

  // A row closes only its own confirm: another row's may be open by now.
  // Focus goes back to the list only when this confirm was the one open.
  const finishReviewEditor = useCallback((workspaceId: string) => {
    if (reviewEditorRef.current?.workspaceId !== workspaceId) return;
    setReviewEditor(null);
    requestAnimationFrame(() => { focusActiveItemRef.current(); });
  }, []);

  const openReviewDiff = useCallback((entry: ReviewQueueEntry) => {
    restoreFocusRef.current = null;
    // worktree:false task: nothing to diff — its result is the folder.
    if (entry.outputDir && !entry.branch) {
      void window.electronAPI.shell.openPath(entry.outputDir);
      setVisible(false);
      return;
    }
    openTaskDiff(entry.taskId, entry.workspaceId, entry.title, entry.ownerWorkspaceId);
    setVisible(false);
  }, [setVisible]);
  const jumpToReviewTask = useCallback((entry: ReviewQueueEntry) => {
    focusNotificationTarget(() => useStore.getState(), { workspaceId: entry.workspaceId });
    finishJump();
  }, [finishJump]);
  const openReviewEditor = useCallback((entry: ReviewQueueEntry, kind: ReviewEditorKind) => {
    // One close or PR at a time per task.
    if (reviewBusyKind(entry.workspaceId)) return;
    setFocusedPaneId(reviewRowKey(entry.workspaceId));
    setEditor(null);
    setReviewEditor({ workspaceId: entry.workspaceId, kind });
  }, []);

  // The sidebar's `N to review` link opens Fleet on this section: clear
  // anything that could hide it and select its first row, once.
  // Consumed only once the queue has a row to land on: right after launch
  // the task records and statuses may still be hydrating. A request that
  // never finds a row lapses after a few seconds.
  useEffect(() => {
    if (!fleetFocusReview) return;
    const first = reviewQueue[0];
    if (!first) {
      const timer = window.setTimeout(() => setFleetFocusReview(false), FOCUS_REVIEW_WAIT_MS);
      return () => window.clearTimeout(timer);
    }
    setFleetFocusReview(false);
    setQuery('');
    setFilter('all');
    setFocusedPaneId(reviewRowKey(first.workspaceId));
    requestAnimationFrame(() => {
      listRef.current?.querySelector('[data-fleet-section="review"]')?.scrollIntoView?.({ block: 'nearest' });
      focusActiveItemRef.current();
    });
  }, [fleetFocusReview, reviewQueue, setFleetFocusReview]);

  // The ⋮ menu that is open, if any (its close function), so Escape closes the
  // menu rather than the overlay.
  const closeRowMenuRef = useRef<(() => void) | null>(null);
  const onRowMenuOpenChange = useCallback((close: (() => void) | null) => {
    closeRowMenuRef.current = close;
  }, []);
  // Verb availability needs live signals the row itself does not carry.
  // The listed maps are dependencies so verbs re-derive when they change.
  const verbsFor = useCallback(
    (pane: FleetPane) => fleetRowVerbsFromState(pane, useStore.getState()),
    [workspaces, surfacePendingQuestion, hookRunningByPtyId, commandRunningByPtyId, surfaceAgent],
  );
  const openEditor = useCallback((pane: FleetPane, kind: FleetEditorKind) => {
    setFocusedPaneId(pane.paneId);
    setEditor({ paneId: pane.paneId, kind });
  }, []);

  // 닫힐 때 포커스를 되돌릴 대상(열기 트리거 시점의 activeElement)을 담아두는 ref.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // 상시 크롬 전환: 열림(마운트) 시 딱 한 번 현재 항목으로 포커스를 당긴다. 예전엔
  // 여기서 panelRef에만 포커스를 줬는데, 아래 로빙 효과의 "포커스가 이미 패널 안"
  // 가드가 rAF 콜백보다 먼저 동기 실행돼 거짓이라 즉시 return → 어떤 카드에도 실제
  // DOM 포커스가 안 걸리고, 카드가 하나뿐이면 화살표 클램프로 인덱스가 안 바뀌어
  // 로빙이 영영 안 살아나는 레이스가 있었다. 이제 실제 카드/행에 직접 포커스하고,
  // 항목이 하나도 없을 때만 패널 컨테이너로 폴백한다. 모달과 달리 그 뒤로는 절대
  // 포커스를 강탈하지 않는다(아래 로빙 효과가 "이미 패널 안"일 때만 이동).
  //
  // 닫힘(Esc/닫기 버튼/Ctrl+Shift+A) 시엔 포커스가 있던 요소가 사라지며 브라우저가
  // 포커스를 body로 되돌린다. 이를 막기 위해 마운트 시점(아직 아래 rAF가 포커스를
  // 뺏기 전 = 열기 트리거 직후의 activeElement)을 저장해뒀다가 언마운트에서 복원한다.
  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = requestAnimationFrame(() => {
      if (!focusActiveItemRef.current()) panelRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      // 열기 시점 요소가 아직 문서에 살아있으면 포커스를 되돌린다(예: 타이핑 중이던
      // 페인의 xterm textarea). 그새 사라졌으면 억지로 옮기지 않고 브라우저 기본
      // (body)에 맡긴다.
      const el = restoreFocusRef.current;
      if (el && el.isConnected) el.focus();
    };
  }, []);


  // 로빙 포커스: 화살표 이동에 맞춰 DOM 포커스가 카드/행을 따라가고 보조기술이
  // 선택을 읽어주도록 한다. 단 상시 크롬이므로 포커스가 "이미 패널 안"일 때만
  // 이동한다 — 사용자가 다른 페인에서 타이핑 중일 때 리렌더가 포커스를 뺏으면
  // 안 된다(모달 트랩과의 결정적 차이). 포커스가 밖이면 아무것도 하지 않는다.
  useEffect(() => {
    const panel = panelRef.current;
    const active = document.activeElement;
    if (!panel || !panel.contains(active)) return;
    // Search, filters and tabs retain focus while the results change.
    if (active !== panel && (!(active instanceof HTMLElement) || active.getAttribute('role') !== 'option')) return;
    const raf = requestAnimationFrame(() => {
      // A kept-open jump may have moved focus since this frame was queued.
      if (panel.contains(document.activeElement)) focusActiveItem();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusActiveItem]);

  // A card that changes column is a new element: when the one holding focus
  // moves, focus follows it instead of falling to the page.
  const focusInsideRef = useRef(false);
  useEffect(() => {
    if (!focusInsideRef.current) return undefined;
    // A frame later, so a deliberate move queued this render (the sidebar's
    // review request) lands first; only a focus that is still lost is taken.
    const raf = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!focusInsideRef.current || (active && active !== document.body)) return;
      focusActiveItemRef.current();
    });
    return () => cancelAnimationFrame(raf);
  }, [grid]);

  // Keyboard (상시 크롬 재설계): 모달 시절의 전역 window 캡처 리스너 + Tab 트랩을
  // 걷어냈다. 대신 이 핸들러는 패널 DOM에 onKeyDownCapture로 붙어 "포커스가 패널
  // 안에 있을 때만" 발동한다 — 다른 페인의 xterm에 포커스가 있으면 아무 키도
  // 가로채지 않으므로 화면 전체를 가두지 않는다. Tab은 더 이상 붙잡지 않는다:
  // 네이티브 Tab이 role=listbox 관례(로빙 tabindex, 화살표=내부 이동, Tab=위젯
  // 진입/이탈)대로 포커스를 패널 밖 다른 페인으로 내보낼 수 있다. Esc는 포커스가
  // 패널 안일 때 크롬을 닫는다. Ctrl+Shift+A 토글은 useKeyboard 전역 핸들러 담당.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Innermost first: an open ⋮ menu, then an open row editor, then Fleet.
        if (closeRowMenuRef.current) closeRowMenuRef.current();
        else if (editor || reviewEditor) closeEditor();
        else if (tab !== 'fleet') setTab('fleet');
        else setVisible(false);
        return;
      }
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableTarget(e.target);
      // `/` finds; 1–4 go to a column — never while typing.
      if (plain && e.key === '/') {
        e.preventDefault();
        if (tab !== 'fleet') setTab('fleet');
        requestAnimationFrame(() => panelRef.current?.querySelector<HTMLInputElement>('input[type=search]')?.focus());
        return;
      }
      if (plain && tab === 'fleet' && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        const next = moveOnBoard(grid, focusedKey ?? null, Number(e.key) as 1 | 2 | 3 | 4);
        if (next) {
          setFocusedPaneId(next);
          requestAnimationFrame(() => { focusActiveItemRef.current(); });
        }
        return;
      }
      // Approvals tab: Enter approves the focused row (guard #5 — non-critical
      // only), Backspace/Delete denies it (always safe). Both swallowed so the
      // keystroke never leaks to the background xterm. A critical MCP row's
      // Enter is a deliberate no-op: granting a critical capability requires an
      // explicit click / Tab-to-Approve, never a blind keyboard grant.
      //
      // The roving shortcuts fire ONLY when the inbox ROW itself (role=option)
      // holds focus. If the user has Tab-focused a dialog <button> (a row's
      // Deny / Approve, or a tab button), we must NOT intercept: native button
      // activation owns Enter/Space there. Otherwise the capture-phase Enter
      // would approve the focused ROW even when the user pressed Enter on the
      // Deny button (opposite of intent — codex P1), and a critical row's
      // explicit keyboard Approve (the sanctioned path per guard #5) would be
      // unreachable because the critical-row no-op swallows Enter first.
      const active = document.activeElement;
      // 행 단축키(Enter=승인, Backspace/Delete=거부/dismiss)는 role=option 행 자체에
      // 포커스가 있을 때만 발동한다. 예전엔 <button>만 예외 처리했는데, Tab 트랩을
      // 걷어내며 A2A 행의 auto-approve 체크박스(input)도 키보드 포커스를 받게 됐다.
      // 체크박스에 포커스가 있을 때 Enter/Backspace/Delete가 행 승인/거부로 오발화하면
      // 신뢰경계 위반이다 — 그래서 버튼·체크박스 등 어떤 인터랙티브 컨트롤이든 행
      // 자신이 아니면 가로채지 않고 네이티브 활성화(체크박스 토글, 버튼 클릭)에 맡긴다.
      const onOptionRow =
        active instanceof HTMLElement && active.getAttribute('role') === 'option' &&
        !!panelRef.current?.contains(active);
      // Space shows or hides the preview. Cards are buttons, so Space would
      // otherwise click — and jump away.
      if (tab === 'fleet' && onOptionRow && e.key === ' ' && plain) {
        e.preventDefault();
        e.stopPropagation();
        setPreviewOpen((open) => !open);
        return;
      }
      if (tab === 'approvals' && inbox.length > 0 && onOptionRow) {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const it = inbox[inboxIdx];
          if (it && !(it.source === 'mcp' && it.isCritical)) {
            resolveInboxItem(it, true);
          }
          return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          e.stopPropagation();
          const it = inbox[inboxIdx];
          if (it) resolveInboxItem(it, false);
          return;
        }
      }
      // Remote tab: read-only, so no Enter action — Backspace/Delete dismisses the
      // focused card (mirrors approvals' deny-key path; same onOptionRow guard so a
      // Tab-focused dismiss <button> / checkbox keeps native activation).
      if (tab === 'remote' && remoteInbox.length > 0 && onOptionRow) {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          e.stopPropagation();
          const it = remoteInbox[remoteIdx];
          if (it) dismissRemoteItem(it.recordId);
          return;
        }
      }

      // Review row verbs: d diff, p PR (open or create), j jump, Backspace
      // close. Enter/Space stay native (the row's click opens the diff).
      // Only on the row itself — never while its confirm or a ⋮ menu is open.
      const onReviewRow = !!focusedReview && active instanceof HTMLElement
        && active.hasAttribute('data-fleet-review-row') && active.dataset.workspaceId === focusedReview.workspaceId;
      if (tab === 'fleet' && onReviewRow && focusedReview && !reviewEditor && !closeRowMenuRef.current
        && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableTarget(e.target)) {
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (key === 'd' || key === 'p' || key === 'j' || key === 'Backspace') {
          e.preventDefault();
          e.stopPropagation();
          if (key === 'd') openReviewDiff(focusedReview);
          else if (key === 'p') reviewPrVerb(focusedReview, openReviewEditor);
          else if (key === 'j') jumpToReviewTask(focusedReview);
          else openReviewEditor(focusedReview, 'close');
          return;
        }
      }

      // Fleet row verbs on the focused row: m message, s stash, l label,
      // Backspace close. Only when the row itself holds focus — never while
      // typing in an input, textarea or contenteditable.
      if (tab === 'fleet' && onOptionRow && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableTarget(e.target)) {
        const row = visibleRows.find((r) => r.pane.paneId === focusedKey);
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        // a — open the Approvals tab on the request waiting on this agent's
        // workspace (else on the list as it is). It never approves: the card
        // does not show the request text and several may be waiting, so the
        // user reads the row and approves it there (rowApprovalIndex).
        if (row && key === 'a') {
          e.preventDefault();
          e.stopPropagation();
          const idx = rowApprovalIndex(inbox, row.pane.workspaceId);
          if (idx >= 0) setInboxIdx(idx);
          setTab('approvals');
          // The focused card unmounts with the tab switch; put focus on the row.
          requestAnimationFrame(() => { focusActiveItemRef.current(); });
          return;
        }
        if (row && !row.pane.remote && (key === 'm' || key === 's' || key === 'l' || key === 'Backspace')) {
          e.preventDefault();
          e.stopPropagation();
          if (key === 's') toggleFleetStash(row.pane);
          else if (key === 'l') setEditor({ paneId: row.pane.paneId, kind: 'label' });
          else if (key === 'Backspace') {
            if (verbsFor(row.pane).closeEnabled) setEditor({ paneId: row.pane.paneId, kind: 'close' });
          } else if (verbsFor(row.pane).messageEnabled) setEditor({ paneId: row.pane.paneId, kind: 'message' });
          return;
        }
      }

      const isArrow =
        e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
        e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      const isBoundary = e.key === 'Home' || e.key === 'End';
      if ((!isArrow && !isBoundary) || !onOptionRow || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (tab === 'fleet' && rovingKeys.length > 0) {
        // ↑↓ within a column, ←→ across columns, Home/End in the column.
        const move = e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down'
          : e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right'
          : e.key === 'Home' ? 'home' : 'end';
        setFocusedPaneId(moveOnBoard(grid, focusedKey ?? null, move));
        return;
      }
      if (tab === 'approvals' && inbox.length > 0) {
        if (isBoundary) {
          setInboxIdx(e.key === 'Home' ? 0 : inbox.length - 1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          setInboxIdx((i) => Math.min(i + 1, inbox.length - 1));
        } else {
          setInboxIdx((i) => Math.max(i - 1, 0));
        }
        return;
      }
      if (tab === 'remote' && remoteInbox.length > 0) {
        if (isBoundary) {
          setRemoteIdx(e.key === 'Home' ? 0 : remoteInbox.length - 1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          setRemoteIdx((i) => Math.min(i + 1, remoteInbox.length - 1));
        } else {
          setRemoteIdx((i) => Math.max(i - 1, 0));
        }
      }
    }, [tab, setTab, grid, rovingKeys.length, inbox, inboxIdx, remoteInbox, remoteIdx, dismissRemoteItem, setVisible,
      editor, reviewEditor, closeEditor, visibleRows, focusedKey, verbsFor,
      focusedReview, openReviewDiff, openReviewEditor, jumpToReviewTask]);

  // ── Board data that only the board shows ───────────────────────────────
  // Workspaces with an A2A request waiting for a decision (the card's chip).
  const approvalWorkspaces = useMemo(() => new Set(inbox.flatMap((it) =>
    (it.source === 'a2a' ? [it.senderWorkspaceId, it.receiverWorkspaceId] : []))), [inbox]);
  // Work-task ledger status per task workspace, read per owner (first-party
  // IPC) and re-read when that owner's ledger changes.
  const [ledger, setLedger] = useState<Record<string, string>>({});
  const ownerKey = useMemo(() => [...new Set(panes.map((p) =>
    resolveTaskLink(missions[p.workspaceId], fanoutLineage[p.workspaceId], fanoutSpawnOwner[p.workspaceId])?.ownerId)
    .filter((id): id is string => Boolean(id)))].sort().join(','), [panes, missions, fanoutLineage, fanoutSpawnOwner]);
  useEffect(() => {
    const api = window.electronAPI?.deck?.ledger;
    if (!api?.summary || !ownerKey) return undefined;
    const owners = ownerKey.split(',');
    const byOwner: Record<string, Record<string, string>> = {};
    let cancelled = false;
    const load = async (owner: string) => {
      try {
        const summary = await api.summary(owner);
        byOwner[owner] = Object.fromEntries([...(summary.rows ?? []), ...(summary.finishedRows ?? [])]
          .map((row) => [row.taskWorkspaceId, row.status]));
        if (!cancelled) setLedger(Object.assign({}, ...Object.values(byOwner)));
      } catch { /* no chip: the ledger stays what it was */ }
    };
    for (const owner of owners) void load(owner);
    const off = api.onChanged?.(({ workspaceId }) => { if (owners.includes(workspaceId)) void load(workspaceId); });
    return () => { cancelled = true; off?.(); };
  }, [ownerKey]);
  // Summary strip: account usage, the next scheduled run, phones watching.
  const usage = useStore((s) => (s.anthropicUsageEnabled ? s.anthropicUsage.snapshot : null));
  const scheduleNav = useStore(useShallow(selectScheduleNavSummary));
  const [phones, setPhones] = useState(0);
  useEffect(() => {
    const status = window.electronAPI?.web?.status;
    if (typeof status !== 'function') return undefined;
    let cancelled = false;
    const poll = () => { status().then((info) => { if (!cancelled) setPhones(info.running ? info.clients ?? 0 : 0); }, () => undefined); };
    poll();
    const id = window.setInterval(poll, 10_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);
  // The empty board's "recently finished": the newest completed A2A tasks.
  const a2aTasks = useStore((s) => s.a2aTasks);
  const recentDone = useMemo(() => (layout !== 'empty' ? [] : Object.values(a2aTasks)
    .filter((task) => task.status.state === 'completed')
    .sort((a, b) => Date.parse(b.status.timestamp ?? '') - Date.parse(a.status.timestamp ?? ''))
    .slice(0, 3)), [a2aTasks, layout]);
  // "+ New agent" opens the same picker as the titlebar +.
  const [pickerAnchor, setPickerAnchor] = useState<{ left: number; top: number } | null>(null);
  const openPicker = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPickerAnchor({ left: Math.max(8, Math.min(r.left, window.innerWidth - 216)), top: r.bottom + 4 });
  };

  const counts = {
    needsYou: columns.needsYou.length, running: columns.running.length,
    review: columns.review.length, idle: columns.idle.length,
  };
  const nextRun = scheduleNav.nextRunAt !== null && scheduleNav.nextRunAt > now ? scheduleNav.nextRunAt : null;
  const chips = visibleChips([
    { id: 'needsYou', count: counts.needsYou },
    { id: 'running', count: counts.running },
    { id: 'review', count: counts.review },
    { id: 'idle', count: counts.idle },
    { id: 'approvals', count: inbox.length },
    { id: 'lan', count: remoteInbox.length },
    { id: 'usage', text: usage ? t('fleetBoard.usage', { session: Math.round(usage.sessionPct), weekly: Math.round(usage.weeklyPct) }) : '' },
    { id: 'next', text: nextRun !== null ? t('fleetBoard.nextSchedule', { time: formatNextShort(nextRun, now) }) : '' },
    { id: 'phones', count: phones },
  ]);
  // With no agents the board is a call to action, but waiting approvals and
  // LAN messages still need their way in.
  const stripChips = layout === 'empty' ? chips.filter((c) => c.id === 'approvals' || c.id === 'lan') : chips;
  const chipLabel = (chip: BoardChip): string => {
    if (chip.text) return chip.text;
    if (chip.id === 'approvals') return t('fleetBoard.approvals', { count: chip.count ?? 0 });
    if (chip.id === 'lan') return t('fleetBoard.lan', { count: chip.count ?? 0 });
    if (chip.id === 'phones') return t('fleetBoard.phones', { count: chip.count ?? 0 });
    return t(`fleetBoard.col.${chip.id}`);
  };

  const idleSummary = idleOldestMs !== undefined && idleOldestMs >= IDLE_SHOW_AFTER_MS
    ? t('fleet.section.idleOldest', { count: visibleGroups.idle.length, age: formatIdle(idleOldestMs) })
    : t('fleet.section.idle', { count: visibleGroups.idle.length });

  const renderItem = (item: BoardItem, column: BoardColumn) => {
    if (item.kind === 'review') {
      const entry = item.entry;
      return (
        <FleetReviewRow
          key={item.key}
          entry={entry}
          now={now}
          focused={item.key === focusedKey}
          onFocus={() => setFocusedPaneId(item.key)}
          onOpenDiff={openReviewDiff}
          onJump={jumpToReviewTask}
          onEdit={openReviewEditor}
          onMenuOpenChange={onRowMenuOpenChange}
          editor={reviewEditor?.workspaceId === entry.workspaceId ? reviewEditor.kind : undefined}
          onEditorDone={finishReviewEditor}
        />
      );
    }
    const { row } = item;
    const card = row.pane;
    return (
      <div key={`${card.workspaceId}:${card.paneId}:${card.surfaceId}`} role="presentation" className="wmux-fleet-row">
        <FleetBoardCard
          card={card}
          row={row}
          column={column}
          focused={card.paneId === focusedKey}
          dense={dense}
          now={now}
          changed={column === 'needsYou' && fleetChangedSinceSeen(fleetLastSeen, card.ptyId, card.agentStatus, surfacePendingQuestion[fleetTargetPtyId(card)])}
          ledgerStatus={ledger[card.workspaceId]}
          approvalPending={approvalWorkspaces.has(card.workspaceId)}
          resource={card.ptyId ? resources[card.ptyId] : undefined}
          onJump={jump}
          onFocus={() => setFocusedPaneId(card.paneId)}
        />
        <FleetRowMenu pane={card} verbs={verbsFor(card)} focused={card.paneId === focusedKey} onJump={jump}
          onEdit={openEditor} onMenuOpenChange={onRowMenuOpenChange} />
        {editor?.paneId === card.paneId && <FleetRowEditor pane={card} kind={editor.kind} onDone={closeEditor} />}
      </div>
    );
  };
  const ownerName = (ownerId: string) => workspaces.find((w) => w.id === ownerId)?.name ?? '';
  const renderColumn = (column: BoardColumn) => {
    const items = columns[column];
    // No dead gauges: a column with nothing in it is not drawn.
    if (items.length === 0) return null;
    const section = column === 'review' ? 'review' : column;
    return (
      <section key={column} className="wmux-board-col" data-board-column={column} aria-label={t(`fleetBoard.col.${column}`)}>
        {column === 'idle' && items.length > 0 && !idleForced ? (
          <button
            type="button"
            role="option"
            aria-selected={focusedKey === IDLE_TOGGLE_KEY}
            aria-expanded={idleShown}
            tabIndex={focusedKey === IDLE_TOGGLE_KEY ? 0 : -1}
            className="wmux-board-col-head is-toggle"
            data-fleet-section="idle"
            data-fleet-idle-toggle
            data-board-key={IDLE_TOGGLE_KEY}
            onFocus={() => setFocusedPaneId(IDLE_TOGGLE_KEY)}
            onClick={() => setFleetIdleExpanded(!fleetIdleExpanded)}
          >
            <span className="wmux-fleet-idle-chevron" aria-hidden="true"><IconChevron size={12} /></span>
            <span>{idleSummary}</span>
          </button>
        ) : (
          <h3 className="wmux-board-col-head" data-fleet-section={section}>
            {column !== 'idle' && <span className={`wmux-board-col-dot is-${column}`} aria-hidden="true" />}
            <span>{column === 'idle' ? idleSummary : t(`fleetBoard.col.${column}`)}</span>
            {column !== 'idle' && <span className="wmux-board-col-count">{items.length}</span>}
          </h3>
        )}
        {column === 'idle' && !idleShown && (
          // Collapsed: a glance at who is idle — name and idle time, five at most.
          <div className="wmux-board-idle-peek" data-fleet-idle-peek>
            {items.slice(0, IDLE_PEEK).map((item) => (item.kind === 'pane' ? (
              <button key={item.key} type="button" tabIndex={-1} className="wmux-board-idle-row"
                onClick={() => jump(item.row.pane)} data-pty-id={item.row.pane.ptyId}>
                <span className="truncate">{fleetTitle(item.row.pane, missions[item.row.pane.workspaceId])}</span>
                <span className="wmux-board-elapsed" data-usage-waiting={item.row.pane.usageLimitWaiting || undefined}>
                  {item.row.pane.usageLimitWaiting ? t('usageLimit.waiting')
                    : item.row.idleForMs !== undefined && item.row.idleForMs >= IDLE_SHOW_AFTER_MS ? formatIdle(item.row.idleForMs) : ''}
                </span>
              </button>
            ) : null))}
            {items.length > IDLE_PEEK && (
              <button type="button" tabIndex={-1} className="wmux-board-fold" onClick={() => setFleetIdleExpanded(true)}>
                {t('fleetBoard.more', { count: items.length - IDLE_PEEK })}
              </button>
            )}
          </div>
        )}
        {(column !== 'idle' || idleShown) && (
          <div className="wmux-board-col-body">
            {columnGroups[column].map((group) => {
              const foldKey = group.owner ? `${column}:${group.owner}` : '';
              const open = foldKey !== '' && openFolds.has(foldKey);
              return [
                renderItem(group.lead, column),
                ...(group.folded.length > 0 ? [
                  <button key={`fold:${foldKey}`} type="button" className="wmux-board-fold" aria-expanded={open}
                    data-fleet-fold={group.owner}
                    onClick={() => setOpenFolds((prev) => {
                      const next = new Set(prev);
                      if (next.has(foldKey)) next.delete(foldKey); else next.add(foldKey);
                      return next;
                    })}>
                    {t('fleetBoard.fold', { count: group.folded.length, owner: ownerName(group.owner ?? '') })}
                  </button>,
                  ...(open ? group.folded.map((item) => renderItem(item, column)) : []),
                ] : []),
              ];
            })}
          </div>
        )}
      </section>
    );
  };

  const kbd = (keys: string, label: string) => (
    <span className="wmux-board-key"><kbd>{keys}</kbd>{label}</span>
  );

  return (
    // The Fleet rail page: a four-column attention board.
    <div
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-label={t('fleet.title')}
      data-fleet-view
      data-layout={layout}
      onKeyDownCapture={handleKeyDown}
      onFocusCapture={() => { focusInsideRef.current = true; }}
      onBlurCapture={(e) => {
        // Focus leaving for somewhere else (not just a removed card) ends it.
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) focusInsideRef.current = false;
      }}
      className="wmux-fleet-panel wmux-board flex flex-col h-full overflow-hidden outline-none"
    >
      <div className="wmux-board-head">
        <h2 className="wmux-board-title">{t('fleet.title')}</h2>
        <span className="flex-1" />
        {tab === 'fleet' && layout !== 'empty' && (
          <>
            <input type="search" className="wmux-board-search" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder={t('fleet.search')} aria-label={t('fleet.search')}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && rovingKeys.length > 0) {
                  event.preventDefault();
                  focusActiveItem();
                }
              }} />
            <button type="button" className="wmux-board-btn"
              onClick={() => setFleetSortMode(fleetSortMode === 'attention' ? 'workspace' : 'attention')}
              title={t('fleet.sort.tooltip')} aria-label={t('fleet.sort.tooltip')}>
              {t(fleetSortMode === 'attention' ? 'fleet.sort.attention' : 'fleet.sort.workspace')}
            </button>
          </>
        )}
        {layout !== 'empty' && (
          <button type="button" className="wmux-board-btn" onClick={openPicker} data-fleet-new-agent>
            <IconPlus size={12} />{t('fleetBoard.newAgent')}
          </button>
        )}
      </div>

      {stripChips.length > 0 && (
        <div className="wmux-board-strip" data-fleet-summary>
          {stripChips.map((chip) => {
            const opens = chip.id === 'approvals' ? 'approvals' : chip.id === 'lan' ? 'remote' : null;
            const body = (
              <>
                {chip.count !== undefined && ['needsYou', 'running', 'review'].includes(chip.id)
                  && <span className={`wmux-board-col-dot is-${chip.id}`} aria-hidden="true" />}
                {chip.count !== undefined && !opens && chip.id !== 'phones' && <strong>{chip.count}</strong>}
                <span>{chipLabel(chip)}</span>
              </>
            );
            return opens ? (
              <button key={chip.id} type="button" className="wmux-board-stat is-action" data-fleet-stat={chip.id}
                aria-pressed={tab === opens} onClick={() => setTab(tab === opens ? 'fleet' : opens)}>{body}</button>
            ) : (
              <span key={chip.id} className="wmux-board-stat" data-fleet-stat={chip.id}>{body}</span>
            );
          })}
        </div>
      )}

      <div ref={bodyRef} className="wmux-board-body">
        {tab === 'approvals' || tab === 'remote' ? (
          <div className="wmux-board-panel" data-fleet-panel={tab}>
            <button type="button" className="wmux-board-back" onClick={() => setTab('fleet')} data-fleet-back>
              ← {t('fleetBoard.back')}
            </button>
            {tab === 'approvals' ? (
              <>
                {inbox.length > 0 ? (
                  <ApprovalInboxList items={inbox} focusedIdx={inboxIdx} onResolve={resolveInboxItem} onNavigate={() => { restoreFocusRef.current = null; }} />
                ) : (
                  <p className="wmux-board-quiet">{t('fleet.approvals.empty')}</p>
                )}
                <RecentAutoRuns />
              </>
            ) : remoteInbox.length > 0 ? (
              <RemoteInboxList items={remoteInbox} focusedIdx={remoteIdx} onDismiss={dismissRemoteItem} />
            ) : (
              <p className="wmux-board-quiet">{t('fleet.remote.empty')}</p>
            )}
          </div>
        ) : layout === 'empty' ? (
          <div className="wmux-board-empty" data-fleet-empty>
            <h3>{t('fleetBoard.empty.title')}</h3>
            <p>{t('fleetBoard.empty.body')}</p>
            <button type="button" className="wmux-board-cta" onClick={openPicker} data-fleet-new-agent>
              <IconPlus size={12} />{t('fleetBoard.newAgent')}
            </button>
            {recentDone.length > 0 && (
              <ul className="wmux-board-recent" aria-label={t('fleetBoard.recent')}>
                {recentDone.map((task) => (
                  <li key={task.id}>
                    <span className="truncate"><IconCheck size={12} /> {task.metadata.title}</span>
                    <span>{task.status.timestamp ? formatIdle(Math.max(0, now - Date.parse(task.status.timestamp))) : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : matchCount === 0 ? (
          <div className="wmux-fleet-empty">
            <p>{t('fleet.noMatches')}</p>
            <button type="button" onClick={() => { setQuery(''); setFilter('all'); }}>{t('fleet.resetFilters')}</button>
          </div>
        ) : (
          <div ref={listRef} role="listbox" aria-label={t('fleet.title')} className="wmux-board-columns" data-layout={layout}
            style={layout === 'list' ? undefined : {
              // The drawn columns share the width; Idle keeps a narrow one.
              gridTemplateColumns: [
                ...(['needsYou', 'running', 'review'] as const).filter((c) => columns[c].length > 0).map(() => 'minmax(0, 1fr)'),
                ...(columns.idle.length > 0 ? ['minmax(0, 0.6fr)'] : []),
              ].join(' '),
            }}>
            {BOARD_COLUMNS.map(renderColumn)}
          </div>
        )}
      </div>

      {tab === 'fleet' && previewOpen && selectedPane?.surfaceType === 'terminal' && (
        <div className="wmux-board-preview" data-fleet-preview>
          <span className="wmux-board-preview-head">{t('fleetBoard.preview', { name: fleetTitle(selectedPane, missions[selectedPane.workspaceId]) })}</span>
          <pre id="fleet-output-preview" tabIndex={0}>{tails[previewPtyId]?.join('\n') || t('fleet.previewEmpty')}</pre>
        </div>
      )}

      {tab === 'fleet' && layout !== 'empty' && (
        <div className="wmux-board-keys" aria-hidden="true">
          {kbd('←→', t('fleetBoard.key.columns'))}
          {kbd('↑↓', t('fleetBoard.key.cards'))}
          {kbd('1–4', t('fleetBoard.key.jumpColumn'))}
          {kbd('↵', t('fleet.jumpHint'))}
          {kbd('Space', t('fleetBoard.key.preview'))}
          {kbd('/', t('fleetBoard.key.search'))}
        </div>
      )}
      {pickerAnchor && <PresetPicker onClose={() => setPickerAnchor(null)} anchorStyle={pickerAnchor} />}
    </div>
  );
}
