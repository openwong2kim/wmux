// ─── Fan-out task groups (#1481, per requesting pane since 2026-09-27) ──────
//
// A rollup (`N tasks · M need you`, nothing at zero), a chevron that folds the
// group, a ⋮ menu with "Close finished tasks (N)", and the task rows
// themselves, indented on a hairline guide.
//
//   - PaneTaskGroup: the tasks one roster pane requested. Its chevron and
//     count ride that pane's own roster row; the rows nest right under it.
//   - SidebarTaskGroup: a group with a rollup line of its own — an owner's
//     "From closed pane" tasks, and the workspace-level "From closed
//     workspace" group for tasks whose owner is gone.
//
// It subscribes to its own tasks' statuses so the Sidebar list above it stays
// decoupled from per-pane churn (see Sidebar.tsx, A1).

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceAgentStatus } from '../../stores/selectors/fleet';
import { useT } from '../../hooks/useT';
import { IconChevron, IconFanOut, IconMoreVertical } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { HIT_TARGET_24 } from '../hitArea';
import Popover from '../ui/Popover';
import { placePopover } from '../AgentToolbar/placePopover';
import { CloseWorkspaceConfirm, type CloseConfirmAnchor } from './WorkspaceItem';
import { CLOSE_SKIP_KEY as SKIP_KEY, closedPaneFoldKey, isTaskGroupExpanded, paneRowsFinished, paneTaskFoldKey, revalidateTaskForClose, splitTasksByPane, taskRollup, withTimeout, type PaneTaskSplit } from './sidebarTree';
import { selectWorkspaceAgentRoster } from '../../stores/selectors/workspaceAgentRoster';
import { isTaskReadyForReview } from '../../stores/selectors/reviewQueue';
import { displayWorkspaceName } from '../../utils/fanoutProvenance';

const NO_TASKS: readonly string[] = [];

/**
 * An owner's tasks split by requesting pane, against the owner's live roster
 * rows. The selector yields one string per task (the row's surfaceId, or ''
 * for the "From closed pane" group), so it only re-renders when a task moves
 * between groups — not on the roster's output churn. The roster, the closed
 * pane group and the owner row all derive from this one split.
 */
export function usePaneTaskSplit(ownerId: string, taskIds: readonly string[] | undefined): PaneTaskSplit {
  const ids = taskIds ?? NO_TASKS;
  const assignment = useStore(useShallow((s) => {
    if (ids.length === 0) return NO_TASKS;
    const split = splitTasksByPane(ids, (id) => s.fanoutOrigin?.[id], selectWorkspaceAgentRoster(s, ownerId).rows);
    const rowOf = new Map<string, string>();
    for (const [surfaceId, list] of split.byRow) for (const id of list) rowOf.set(id, surfaceId);
    return ids.map((id) => rowOf.get(id) ?? '');
  }));
  return useMemo(() => {
    const byRow = new Map<string, string[]>();
    const closedPane: string[] = [];
    ids.forEach((id, i) => {
      const key = assignment[i];
      if (!key) { closedPane.push(id); return; }
      const list = byRow.get(key);
      if (list) list.push(id);
      else byRow.set(key, [id]);
    });
    return { byRow, closedPane };
  }, [ids, assignment]);
}

interface TaskGroupModelArgs {
  taskIds: readonly string[];
  /** Key of the remembered fold state (sidebarTaskGroupExpanded). */
  foldKey: string;
  /** The owner is the active workspace (opens the group by default). */
  ownerActive: boolean;
}

/** Rollup, fold state and the finished set of one task group. It subscribes
 *  to its own tasks' statuses so the lists above it stay decoupled from
 *  per-pane churn (see Sidebar.tsx, A1). */
function useTaskGroupModel({ taskIds, foldKey, ownerActive }: TaskGroupModelArgs) {
  const statuses = useStore(useShallow((s) => taskIds.map((id) => selectWorkspaceAgentStatus(s, id))));
  // #1481 review — finished is decided per agent PANE, never from the
  // workspace roll-up (where `complete` outranks `running`).
  const finishedFlags = useStore(useShallow((s) => taskIds.map((id) => paneRowsFinished(selectWorkspaceAgentRoster(s, id).rows))));
  // Ready to review — the same predicate as Fleet's section (#1508 parity).
  const readyFlags = useStore(useShallow((s) => taskIds.map((id) => isTaskReadyForReview(s, id))));
  const remembered = useStore((s) => s.sidebarTaskGroupExpanded[foldKey]);
  const setExpanded = useStore((s) => s.setSidebarTaskGroupExpanded);
  const childActive = useStore((s) => taskIds.includes(s.activeWorkspaceId ?? ''));
  const workspaceNames = useStore(useShallow((s) => taskIds.map((id) => s.workspaces.find((w) => w.id === id)?.name ?? '')));

  const statusById = new Map(taskIds.map((id, i) => [id, statuses[i]]));
  const readyById = new Map(taskIds.map((id, i) => [id, readyFlags[i]]));
  const rollup = taskRollup(taskIds, (id) => statusById.get(id) ?? 'idle', (id) => readyById.get(id) ?? false);
  const anyNeedsYou = (rollup?.needYou ?? 0) > 0;
  const expanded = isTaskGroupExpanded({ remembered, ownerActive, anyNeedsYou, childActive });
  const finishedIds = taskIds.filter((_id, i) => finishedFlags[i]);
  const nameOf = (id: string) => displayWorkspaceName(workspaceNames[taskIds.indexOf(id)] ?? '', true);
  const toggle = () => setExpanded(foldKey, !expanded);
  return { rollup, anyNeedsYou, expanded, toggle, finishedIds, nameOf };
}

/** Opens Fleet on its Ready to review section. */
function openReview(): void {
  const st = useStore.getState();
  st.setFleetFocusReview(true);
  st.setFleetActiveTab('fleet');
  st.setFleetViewVisible(true);
}

interface TaskGroupMenuProps {
  /** Owner workspace id, or ORPHAN_GROUP_KEY — what a task must still belong
   *  to when it is closed (revalidateTaskForClose). */
  ownerKey: string;
  finishedIds: readonly string[];
  nameOf: (id: string) => string;
  /** Pane groups have no rollup line to show "N to review" on: the menu
   *  offers it instead. */
  toReview?: number;
  onCloseWorkspace: (id: string) => void;
  className: string;
}

/** The ⋮ button with "Close finished tasks (N)" and its confirm. */
function TaskGroupMenu({ ownerKey, finishedIds, nameOf, toReview = 0, onCloseWorkspace, className }: TaskGroupMenuProps) {
  const t = useT();
  // The exact set the confirm lists — closed as listed, each re-checked.
  const [confirmIds, setConfirmIds] = useState<string[]>([]);
  const [menuAnchor, setMenuAnchor] = useState<CloseConfirmAnchor | null>(null);
  const [confirmAnchor, setConfirmAnchor] = useState<CloseConfirmAnchor | null>(null);
  const [closing, setClosing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuAnchor) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setMenuAnchor(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuAnchor(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuAnchor]);

  // Same outside-click / Escape dismissal the workspace close confirm uses
  // (the confirm stops its own mousedown from reaching the document).
  useEffect(() => {
    if (!confirmAnchor) return;
    const close = () => setConfirmAnchor(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConfirmAnchor(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [confirmAnchor]);

  const closeFinished = useCallback(async (ids: readonly string[]) => {
    setClosing(true);
    const kept: string[] = [];
    let closed = 0;
    try {
      for (const id of ids) {
        // Re-validate against the CURRENT store right before each close: the
        // task may have resumed, been detached or closed while the confirm
        // was open or while an earlier close ran.
        const st = useStore.getState();
        const name = displayWorkspaceName(st.workspaces.find((w) => w.id === id)?.name ?? id, true);
        const check = revalidateTaskForClose(st, id, ownerKey, (wsId) => selectWorkspaceAgentRoster(st, wsId).rows);
        if (!check.ok) {
          kept.push(`${name}: ${t(SKIP_KEY[check.reason])}`);
          continue;
        }
        const mission = check.mission;
        try {
          // Always the real task close — also for a record already closed in
          // the ledger (it is idempotent there): it refuses a dirty or unpushed
          // worktree with the reason and removes the worktree otherwise.
          // The owner id is the same authz anchor the other GUI close paths
          // pass (renderer-trusted IPC; see the PR notes).
          const res = await withTimeout(
            window.electronAPI.workTask.close(mission.id, mission.owner.verifiedWorkspaceId),
            TASK_CLOSE_TIMEOUT_MS,
          );
          if (res.ok) {
            onCloseWorkspace(id);
            closed += 1;
          } else if (res.reason === 'dirty') {
            kept.push(`${name}: ${t('worktask.cleanup.preserved')}`);
          } else if (res.reason === 'unpushed') {
            kept.push(`${name}: ${t('worktask.cleanup.unpushed', { count: res.aheadCount ?? '' })}`);
          } else {
            kept.push(`${name}: ${t('worktask.cleanup.closeFailed', { error: res.error ?? '' })}`);
          }
        } catch (err) {
          kept.push(`${name}: ${t('worktask.cleanup.closeFailed', { error: err instanceof Error ? err.message : String(err) })}`);
        }
      }
    } finally {
      setClosing(false);
    }
    const push = useStore.getState().pushToast;
    if (closed > 0) push({ level: 'info', message: t('sidebar.tasks.closeFinishedDone', { count: closed }) });
    for (const line of kept) push({ level: 'warn', message: line });
  }, [ownerKey, onCloseWorkspace, t]);

  const menuHeight = toReview > 0 ? 88 : 48;
  const menuPos = menuAnchor ? placePopover(menuAnchor, { width: MENU_WIDTH, height: menuHeight }) : null;

  return (
    <>
      <button
        type="button"
        draggable={false}
        className={className}
        aria-label={t('sidebar.tasks.menu')}
        title={t('sidebar.tasks.menu')}
        aria-haspopup="menu"
        aria-expanded={!!menuAnchor}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAnchor(menuAnchor ? null : { top: r.top, left: r.left, right: r.right, bottom: r.bottom });
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        data-task-group-menu
      >
        <IconMoreVertical size={12} />
      </button>
      {menuAnchor && menuPos && (
        <Popover
          ref={menuRef}
          role="menu"
          className="fixed z-[var(--z-popover-top)] sidebar-popover-enter"
          style={{ top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
        >
          {toReview > 0 && (
            <button
              type="button"
              role="menuitem"
              className="ui-section-row w-full text-left text-[13px]"
              onClick={(e) => {
                e.stopPropagation();
                setMenuAnchor(null);
                openReview();
              }}
              data-task-to-review={toReview}
            >
              {t('sidebar.tasks.toReviewLabel', { count: toReview })}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="ui-section-row w-full text-left text-[13px] disabled:opacity-50"
            disabled={finishedIds.length === 0 || closing}
            onClick={(e) => {
              e.stopPropagation();
              const anchor = menuAnchor;
              setMenuAnchor(null);
              setConfirmIds([...finishedIds]);
              setConfirmAnchor(anchor);
            }}
            data-close-finished
          >
            {t('sidebar.tasks.closeFinished', { count: finishedIds.length })}
          </button>
        </Popover>
      )}
      {confirmAnchor && (
        <CloseWorkspaceConfirm
          anchor={confirmAnchor}
          title={t('sidebar.tasks.closeFinishedConfirm', { count: confirmIds.length })}
          terminalCount={confirmIds.length}
          detail={() => t('sidebar.tasks.closeFinishedDetail')}
          items={confirmIds.map(nameOf)}
          cancelLabel={t('workspace.closeCancel')}
          confirmLabel={t('sidebar.tasks.closeFinishedYes')}
          onCancel={() => setConfirmAnchor(null)}
          onConfirm={() => {
            setConfirmAnchor(null);
            void closeFinished(confirmIds);
          }}
        />
      )}
    </>
  );
}

const stopBubble = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * The indented task rows. Inside a roster the list sits within the owner
 * workspace's row, which selects, renames, opens its menu and drags on these
 * gestures: none of them may bubble past a nested task row to it. Mousedown
 * is left alone (document-level menu dismissal listens for it; the roster
 * lets it through for this subtree so the task row can still start a drag).
 */
function TaskList({ id, label, taskIds, renderTask, className }: {
  id: string;
  label: string;
  taskIds: readonly string[];
  renderTask: (id: string) => ReactNode;
  className: string;
}) {
  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      className={className}
      data-task-group-list
      data-pane-tasks
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      onContextMenu={stopBubble}
      onDragStart={stopBubble}
      onDragEnd={stopBubble}
      onDragOver={stopBubble}
      onDragLeave={stopBubble}
      onDrop={stopBubble}
    >
      {taskIds.map((taskId) => <div key={taskId}>{renderTask(taskId)}</div>)}
    </div>
  );
}

interface SidebarTaskGroupProps {
  /** Owner workspace id, or ORPHAN_GROUP_KEY for the closed-owner group. */
  groupKey: string;
  /** Fold-state key when it differs from the owner (the "From closed pane"
   *  group of an owner). Defaults to groupKey. */
  foldKey?: string;
  taskIds: readonly string[];
  /** The owner is the active workspace (opens the group by default). */
  ownerActive: boolean;
  /** Leading label ("From closed workspace", "From closed pane"). */
  label?: string;
  /** Names the group for assistive tech ("Fan-out tasks of <owner>"). */
  ownerName: string;
  renderTask: (id: string) => ReactNode;
  /** Sidebar's workspace close (disposes PTYs, removes the workspace). */
  onCloseWorkspace: (id: string) => void;
}

const MENU_WIDTH = 220;

/** A close that has not answered in this long is reported stuck; the menu comes back. */
export const TASK_CLOSE_TIMEOUT_MS = 90_000;

function SidebarTaskGroup({ groupKey, foldKey, taskIds, ownerActive, label, ownerName, renderTask, onCloseWorkspace }: SidebarTaskGroupProps) {
  const t = useT();
  const listId = useId();
  const { rollup, anyNeedsYou, expanded, toggle, finishedIds, nameOf } = useTaskGroupModel({
    taskIds, foldKey: foldKey ?? groupKey, ownerActive,
  });

  if (!rollup) return null;

  const toReview = rollup.toReview;
  const rollupText = rollup.tasks === 1 ? t('sidebar.tasks.countOne') : t('sidebar.tasks.count', { count: rollup.tasks });
  const toggleLabel = [label, rollupText, anyNeedsYou ? t('strip.needsYou', { count: rollup.needYou }) : undefined,
    expanded ? t('sidebar.tasks.collapse') : t('sidebar.tasks.expand')].filter(Boolean).join(', ');

  return (
    <div data-task-group={foldKey ?? groupKey}>
      <div className="mx-2 flex h-6 items-center gap-1 pl-[22px] pr-1 text-[11px] text-[var(--text-muted)]" data-task-rollup>
        <button
          type="button"
          className={`flex min-w-0 ${toReview > 0 ? 'flex-initial' : 'flex-1'} items-center gap-1.5 self-stretch rounded px-1 text-left hover:text-[var(--text-sub)] ${FOCUS_RING}`}
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={toggle}
        >
          <span className="flex-none transition-transform duration-150" style={{ transform: expanded ? 'rotate(90deg)' : undefined }} aria-hidden="true">
            <IconChevron size={8} />
          </span>
          <span className="flex-none" aria-hidden="true"><IconFanOut size={10} /></span>
          <span className="min-w-0 truncate">
            {label ? `${label} · ` : ''}{rollupText}
            {anyNeedsYou && (
              <>
                {' · '}
                {/* Red only while folded: then this line is the only place the
                    blocked task shows. Unfolded, the task row itself carries
                    the red (attention grammar: two renditions, not three). */}
                <span className={expanded ? '' : 'font-semibold text-[var(--accent-red)]'}>
                  {t('strip.needsYou', { count: rollup.needYou })}
                </span>
              </>
            )}
          </span>
        </button>
        {toReview > 0 && (
          <>
            <span className="flex-none" aria-hidden="true">·</span>
            <button
              type="button"
              className={`flex-none self-stretch truncate rounded px-1 hover:text-[var(--accent-blue)] ${FOCUS_RING}`}
              aria-label={t('sidebar.tasks.toReviewLabel', { count: toReview })}
              title={t('sidebar.tasks.toReviewLabel', { count: toReview })}
              onClick={openReview}
              data-task-to-review={toReview}
            >
              {t('sidebar.tasks.toReview', { count: toReview })}
            </button>
            <span className="flex-1" aria-hidden="true" />
          </>
        )}
        <TaskGroupMenu
          ownerKey={groupKey}
          finishedIds={finishedIds}
          nameOf={nameOf}
          onCloseWorkspace={onCloseWorkspace}
          className={`${HIT_TARGET_24} flex-none rounded text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
        />
      </div>
      {expanded && (
        <TaskList
          id={listId}
          label={t('sidebar.tasks.groupLabel', { owner: displayWorkspaceName(ownerName, false) })}
          taskIds={taskIds}
          renderTask={renderTask}
          className="ml-[25px] space-y-1 border-l border-[var(--border-soft)]"
        />
      )}
    </div>
  );
}

interface PaneTaskGroupProps {
  ownerId: string;
  /** The requesting roster row's surface — the group's identity. */
  surfaceId: string;
  /** The requesting pane's name, for the group's accessible name. */
  paneName: string;
  taskIds: readonly string[];
  ownerActive: boolean;
  renderTask: (id: string) => ReactNode;
  onCloseWorkspace: (id: string) => void;
  /** Renders the pane's own roster row; `controls` (the fold toggle and ⋮
   *  menu) go at its end. */
  children: (controls: ReactNode) => ReactNode;
}

/**
 * The tasks one roster pane requested, nested under that pane's row. The
 * row itself carries the fold chevron and the task count; while folded with a
 * task that needs you, the count leads with the needs-you number in red — the
 * only place the blocked task shows then. Unfolded, the task row carries the
 * red itself (two renditions, not three).
 */
function PaneTaskGroupInner({ ownerId, surfaceId, paneName, taskIds, ownerActive, renderTask, onCloseWorkspace, children }: PaneTaskGroupProps) {
  const t = useT();
  const listId = useId();
  const foldKey = paneTaskFoldKey(ownerId, surfaceId);
  const { rollup, anyNeedsYou, expanded, toggle, finishedIds, nameOf } = useTaskGroupModel({ taskIds, foldKey, ownerActive });

  if (!rollup) return <>{children(null)}</>;

  const rollupText = rollup.tasks === 1 ? t('sidebar.tasks.countOne') : t('sidebar.tasks.count', { count: rollup.tasks });
  const toggleLabel = [rollupText, anyNeedsYou ? t('strip.needsYou', { count: rollup.needYou }) : undefined,
    rollup.toReview > 0 ? t('sidebar.tasks.toReview', { count: rollup.toReview }) : undefined,
    expanded ? t('sidebar.tasks.collapse') : t('sidebar.tasks.expand')].filter(Boolean).join(', ');
  const redCount = anyNeedsYou && !expanded;

  const controls = (
    <>
      <button
        type="button"
        draggable={false}
        className={`flex-none self-center inline-flex items-center gap-0.5 rounded px-1 text-[10px] font-mono tabular-nums text-[var(--text-muted)] hover:text-[var(--text-sub)] ${FOCUS_RING}`}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        data-pane-task-toggle={rollup.tasks}
        data-pane-task-needs-you={anyNeedsYou ? rollup.needYou : undefined}
      >
        <span className="flex-none transition-transform duration-150" style={{ transform: expanded ? 'rotate(90deg)' : undefined }} aria-hidden="true">
          <IconChevron size={8} />
        </span>
        <span className="flex-none" aria-hidden="true"><IconFanOut size={9} /></span>
        {redCount ? (
          <span aria-hidden="true">
            <span className="font-semibold text-[var(--accent-red)]" data-pane-task-red>{rollup.needYou}</span>/{rollup.tasks}
          </span>
        ) : (
          <span aria-hidden="true">{rollup.tasks}</span>
        )}
      </button>
      {/* Revealed like the row's `@`: zero width at rest, its own 24px under
          the pointer or keyboard focus. */}
      <TaskGroupMenu
        ownerKey={ownerId}
        finishedIds={finishedIds}
        nameOf={nameOf}
        toReview={rollup.toReview}
        onCloseWorkspace={onCloseWorkspace}
        className={`inline-flex h-6 w-0 min-w-0 flex-none items-center justify-center self-center -my-1.5 overflow-hidden rounded-[5px] text-[var(--text-muted)] hover:text-[var(--text-main)] group-hover/mention:w-6 focus-visible:w-6 aria-expanded:w-6 ${FOCUS_RING}`}
      />
    </>
  );

  return (
    <div data-task-group={foldKey}>
      {children(controls)}
      {expanded && (
        <TaskList
          id={listId}
          label={t('sidebar.tasks.paneGroupLabel', { pane: paneName })}
          taskIds={taskIds}
          renderTask={renderTask}
          className="ml-[9px] mt-0.5 space-y-1 border-l border-[var(--border-soft)]"
        />
      )}
    </div>
  );
}

export const PaneTaskGroup = memo(PaneTaskGroupInner);

interface ClosedPaneTaskGroupProps {
  ownerId: string;
  ownerName: string;
  /** All of the owner's nested tasks; this group keeps the ones no live
   *  roster row requested. */
  taskIds: readonly string[];
  ownerActive: boolean;
  renderTask: (id: string) => ReactNode;
  onCloseWorkspace: (id: string) => void;
}

/**
 * An owner's tasks with no live requesting pane — its pane closed (or no
 * longer runs an agent), the GUI or the orchestrator asked, or the stamp
 * predates origins. One trailing group under the owner, after its roster.
 */
function ClosedPaneTaskGroupInner({ ownerId, ownerName, taskIds, ownerActive, renderTask, onCloseWorkspace }: ClosedPaneTaskGroupProps) {
  const t = useT();
  const { closedPane } = usePaneTaskSplit(ownerId, taskIds);
  if (closedPane.length === 0) return null;
  return (
    <SidebarTaskGroup
      groupKey={ownerId}
      foldKey={closedPaneFoldKey(ownerId)}
      taskIds={closedPane}
      ownerActive={ownerActive}
      label={t('sidebar.tasks.closedPaneGroup')}
      ownerName={ownerName}
      renderTask={renderTask}
      onCloseWorkspace={onCloseWorkspace}
    />
  );
}

export const ClosedPaneTaskGroup = memo(ClosedPaneTaskGroupInner);

export default memo(SidebarTaskGroup);
