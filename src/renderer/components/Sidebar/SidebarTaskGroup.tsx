// ─── Fan-out task group under an owner workspace (#1481) ─────────────────────
//
// The owner row's rollup line (`N tasks · M need you`, nothing at zero), a
// chevron that folds the group, a ⋮ menu with "Close finished tasks (N)", and
// the task rows themselves, indented on a hairline guide. The same component
// renders the "From closed workspace" group for tasks whose owner is gone.
//
// It subscribes to its own tasks' statuses so the Sidebar list above it stays
// decoupled from per-pane churn (see Sidebar.tsx, A1).

import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
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
import { isTaskGroupExpanded, paneRowsFinished, revalidateTaskForClose, taskRollup, withTimeout, type CloseSkipReason } from './sidebarTree';
import { selectWorkspaceAgentRoster } from '../../stores/selectors/workspaceAgentRoster';
import type { TranslationKey } from '../../i18n/locales/en';
import { displayWorkspaceName } from '../../utils/fanoutProvenance';

interface SidebarTaskGroupProps {
  /** Owner workspace id, or ORPHAN_GROUP_KEY for the closed-owner group. */
  groupKey: string;
  taskIds: readonly string[];
  /** The owner is the active workspace (opens the group by default). */
  ownerActive: boolean;
  /** Leading label — set for the closed-owner group only. */
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

const SKIP_KEY: Record<CloseSkipReason, TranslationKey> = {
  gone: 'sidebar.tasks.skipGone',
  'no-record': 'sidebar.tasks.noRecord',
  detached: 'sidebar.tasks.skipDetached',
  moved: 'sidebar.tasks.skipMoved',
  'not-finished': 'sidebar.tasks.skipNotFinished',
};

function SidebarTaskGroup({ groupKey, taskIds, ownerActive, label, ownerName, renderTask, onCloseWorkspace }: SidebarTaskGroupProps) {
  const t = useT();
  const listId = useId();
  const statuses = useStore(useShallow((s) => taskIds.map((id) => selectWorkspaceAgentStatus(s, id))));
  // #1481 review — finished is decided per agent PANE, never from the
  // workspace roll-up (where `complete` outranks `running`).
  const finishedFlags = useStore(useShallow((s) => taskIds.map((id) => paneRowsFinished(selectWorkspaceAgentRoster(s, id).rows))));
  const remembered = useStore((s) => s.sidebarTaskGroupExpanded[groupKey]);
  const setExpanded = useStore((s) => s.setSidebarTaskGroupExpanded);

  const statusById = new Map(taskIds.map((id, i) => [id, statuses[i]]));
  const rollup = taskRollup(taskIds, (id) => statusById.get(id) ?? 'idle');
  const anyNeedsYou = (rollup?.needYou ?? 0) > 0;
  const childActive = useStore((s) => taskIds.includes(s.activeWorkspaceId ?? ''));
  const expanded = isTaskGroupExpanded({ remembered, ownerActive, anyNeedsYou, childActive });
  const finishedIds = taskIds.filter((_id, i) => finishedFlags[i]);
  const workspaceNames = useStore(useShallow((s) => taskIds.map((id) => s.workspaces.find((w) => w.id === id)?.name ?? '')));
  const nameOf = (id: string) => displayWorkspaceName(workspaceNames[taskIds.indexOf(id)] ?? '', true);
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
        const check = revalidateTaskForClose(st, id, groupKey, (wsId) => selectWorkspaceAgentRoster(st, wsId).rows);
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
  }, [groupKey, onCloseWorkspace, t]);

  if (!rollup) return null;

  const toggle = () => setExpanded(groupKey, !expanded);
  const rollupText = rollup.tasks === 1 ? t('sidebar.tasks.countOne') : t('sidebar.tasks.count', { count: rollup.tasks });
  const toggleLabel = [label, rollupText, anyNeedsYou ? t('strip.needsYou', { count: rollup.needYou }) : undefined,
    expanded ? t('sidebar.tasks.collapse') : t('sidebar.tasks.expand')].filter(Boolean).join(', ');

  const menuPos = menuAnchor ? placePopover(menuAnchor, { width: MENU_WIDTH, height: 48 }) : null;

  return (
    <div data-task-group={groupKey}>
      <div className="mx-2 flex h-6 items-center gap-1 pl-[22px] pr-1 text-[11px] text-[var(--text-muted)]" data-task-rollup>
        <button
          type="button"
          className={`flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded px-1 text-left hover:text-[var(--text-sub)] ${FOCUS_RING}`}
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
        <button
          type="button"
          className={`${HIT_TARGET_24} flex-none rounded text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
          aria-label={t('sidebar.tasks.menu')}
          title={t('sidebar.tasks.menu')}
          aria-haspopup="menu"
          aria-expanded={!!menuAnchor}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenuAnchor(menuAnchor ? null : { top: r.top, left: r.left, right: r.right, bottom: r.bottom });
          }}
          data-task-group-menu
        >
          <IconMoreVertical size={12} />
        </button>
      </div>
      {expanded && (
        <div
          id={listId}
          role="group"
          aria-label={t('sidebar.tasks.groupLabel', { owner: displayWorkspaceName(ownerName, false) })}
          className="ml-[25px] space-y-1 border-l border-[var(--border-soft)]"
          data-task-group-list
        >
          {taskIds.map((id) => <div key={id}>{renderTask(id)}</div>)}
        </div>
      )}
      {menuAnchor && menuPos && (
        <Popover
          ref={menuRef}
          role="menu"
          className="fixed z-[var(--z-popover-top)] sidebar-popover-enter"
          style={{ top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
        >
          <button
            type="button"
            role="menuitem"
            className="ui-section-row w-full text-left text-[13px] disabled:opacity-50"
            disabled={finishedIds.length === 0 || closing}
            onClick={() => {
              const anchor = menuAnchor;
              setMenuAnchor(null);
              setConfirmIds(finishedIds);
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
    </div>
  );
}

export default memo(SidebarTaskGroup);
