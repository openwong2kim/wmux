// ─── 사이드바 "Missions" 섹션 (NB2 파동2 사이클 C) ───────────────────────────
//
// fan-out(J1)이 만든 미션(WorkTask)을 워크스페이스 리스트 상단의 별도 그룹으로
// 승격한다. 각 미션 = 프롬프트 1개가 펼쳐진 격리 태스크이고, `paneGroupId`가 곧
// 그 태스크 전용 자식 워크스페이스 id다. 행은 title·status(open/closed)와 미션
// 채널로 이어지는 링크를 보여준다.
//
// worktree 배지(⊕, WorkspaceItem)와의 공존: 배지는 "이 워크스페이스가 git worktree"
// 라는 저수준 사실을, 이 섹션은 "이 워크스페이스가 fan-out 태스크"라는 상위 개념을
// 얹는다(worktree ⊂ task는 아님 — broadcast 모드는 격리 없음). 둘은 서로 다른 축이라
// 같은 자식 워크스페이스가 사이드바 리스트(배지 있음)와 이 섹션(미션 행)에 모두 나올
// 수 있고, 이는 의도된 이중 표현이다.
//
// Empty state (changed): the section renders a single line rather than nothing.
// A section that disappears cannot answer "does this workspace have tasks?" —
// the reader is left unsure whether there are none or whether the list failed
// to load, and the fan-out button next to it implies a list that should exist.
// One line costs less than that ambiguity.
//
// Lifetime (owner policy): a mission row is visible only while its fan-out workspace
// is alive. When the workspace is gone the row goes with it, and the record stays in
// the mission channel (see selectLiveMissions).

import { memo, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { WorkTask } from '../../../shared/workTask';
import { IconChevron } from '../icons';
import { FOCUS_RING } from '../focusRing';

/**
 * 모든 부모 캐시를 평탄화·정렬한 미션 목록(순수 함수 — 테스트 가능). open을 먼저,
 * 그 안에서 최신(createdAt desc) 순으로 정렬한다. 태스크는 부모 하나에만 속하므로
 * 중복은 없다.
 */
export function flattenMissions(byWorkspace: Record<string, WorkTask[]>): WorkTask[] {
  const all: WorkTask[] = [];
  for (const tasks of Object.values(byWorkspace)) all.push(...tasks);
  return all.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

/**
 * Mission = workspace lifetime (owner policy). Visibility is decided on
 * **workspace existence alone** — derived/inferred signals (agent status, delivery
 * status, and the like) have reported false several times in this repo, so they are
 * not used here. `liveWorkspaceIds` is the workspace list restored from the session,
 * verbatim.
 *
 *   - paneGroupId materialized + workspace absent → **excluded** (the record stays in the channel).
 *   - paneGroupId materialized + workspace present → shown.
 *   - paneGroupId not materialized (fan-out in flight) → **shown**. There is no
 *     workspace yet; that is not the same as one having disappeared — hiding a
 *     mission that is still running is far worse.
 */
export function selectLiveMissions(
  byWorkspace: Record<string, WorkTask[]>,
  liveWorkspaceIds: ReadonlySet<string>,
): WorkTask[] {
  return flattenMissions(byWorkspace).filter(
    (task) => !task.paneGroupId || liveWorkspaceIds.has(task.paneGroupId),
  );
}

/** One parent workspace and the tasks it started. */
export interface MissionGroup {
  parentId: string;
  /** The parent workspace's name, or its id when it is no longer in the list
   *  (a task outliving its parent is rare but must not render as blank). */
  parentName: string;
  tasks: WorkTask[];
}

/**
 * Group live tasks under the workspace that started them. A task belongs to
 * exactly one parent (the cache is keyed by it), so this is a partition, not a
 * join — and the parent is what makes a flat list of eight `task #2`s legible
 * once two fan-outs are running at once.
 *
 * Ordering is the parent's own order in the sidebar, so the tree reads in the
 * same sequence as the workspace list above it; a parent that has gone away
 * sorts last, under its id.
 */
export function groupMissionsByParent(
  byWorkspace: Record<string, WorkTask[]>,
  liveWorkspaceIds: ReadonlySet<string>,
  parentNames: ReadonlyMap<string, string>,
  parentOrder: readonly string[],
): MissionGroup[] {
  const groups: MissionGroup[] = [];
  const rank = new Map(parentOrder.map((id, i) => [id, i]));
  for (const [parentId, tasks] of Object.entries(byWorkspace)) {
    const live = tasks.filter((task) => !task.paneGroupId || liveWorkspaceIds.has(task.paneGroupId));
    if (live.length === 0) continue;
    groups.push({
      parentId,
      parentName: parentNames.get(parentId) ?? parentId,
      tasks: live.sort((a, b) => b.createdAt - a.createdAt),
    });
  }
  return groups.sort(
    (a, b) => (rank.get(a.parentId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.parentId) ?? Number.MAX_SAFE_INTEGER),
  );
}

function useLiveMissions(): WorkTask[] {
  const byWorkspace = useStore(useShallow((s) => s.missionsByWorkspace));
  // Subscribe to the id array with a shallow compare (renames and metadata changes do
  // not recompute). Do NOT use a joined string key — with zero workspaces
  // `''.split(',')` yields `['']`, which makes the empty-string id count as "alive",
  // and any id containing a comma would be split apart.
  const workspaceIds = useStore(useShallow((s) => s.workspaces.map((w) => w.id)));
  return useMemo(
    () => selectLiveMissions(byWorkspace, new Set(workspaceIds)),
    [byWorkspace, workspaceIds],
  );
}

/** The same live set, partitioned by the workspace that started each task. */
function useLiveMissionGroups(): MissionGroup[] {
  const byWorkspace = useStore(useShallow((s) => s.missionsByWorkspace));
  const workspaceIds = useStore(useShallow((s) => s.workspaces.map((w) => w.id)));
  // Names are subscribed to separately so a rename repaints the parent row —
  // and shallow-compared, so unrelated workspace metadata churn does not.
  const workspaceNames = useStore(useShallow((s) => s.workspaces.map((w) => w.name)));
  return useMemo(
    () =>
      groupMissionsByParent(
        byWorkspace,
        new Set(workspaceIds),
        new Map(workspaceIds.map((id, i) => [id, workspaceNames[i] ?? id])),
        workspaceIds,
      ),
    [byWorkspace, workspaceIds, workspaceNames],
  );
}

function MissionRow({ task, indented = false }: { task: WorkTask; indented?: boolean }): React.ReactElement {
  const t = useT();
  // 자식 워크스페이스 존재 여부(존재할 때만 행 클릭으로 점프 가능).
  const childExists = useStore((s) =>
    task.paneGroupId ? s.workspaces.some((w) => w.id === task.paneGroupId) : false,
  );
  const isOpen = task.status === 'open';
  const statusColor = isOpen ? 'var(--accent-green)' : 'var(--text-muted)';

  const jumpToChild = (): void => {
    if (task.paneGroupId && childExists) {
      useStore.getState().setActiveWorkspace(task.paneGroupId);
    }
  };
  const openMissionChannel = (): void => {
    // 기존 채널 열기 경로 재사용(setActiveChannel이 dock을 열고 채널을 선택) —
    // 새 라우팅을 만들지 않는다.
    useStore.getState().setActiveChannel(task.missionChannelId);
  };

  return (
    <div
      className={`group flex items-center gap-2 mx-2 ${indented ? 'pl-6 pr-3' : 'px-3'} py-1 rounded-md select-none ${
        task.paneGroupId && childExists
          ? 'cursor-pointer hover:bg-[rgba(var(--bg-surface-rgb),0.5)]'
          : ''
      }`}
      onClick={jumpToChild}
      data-mission-row
      data-task-id={task.id}
      data-task-status={task.status}
    >
      {/* status dot: open=green, closed=muted */}
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: statusColor }}
        title={isOpen ? t('missions.open') : t('missions.closed')}
      />
      <span
        className={`flex-1 min-w-0 truncate text-caption font-mono ${
          isOpen ? 'text-[var(--text-sub)]' : 'text-[var(--text-muted)] line-through'
        }`}
        title={task.title}
      >
        {task.title}
      </span>
      {/* 미션 채널 링크 — 기존 ChannelDock으로 해당 채널을 연다. */}
      <button
        type="button"
        className="flex-shrink-0 text-[10px] font-mono text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          openMissionChannel();
        }}
        title={t('missions.openChannel')}
        aria-label={t('missions.openChannelFor', { title: task.title })}
        data-mission-channel-link
      >
        #
      </button>
    </div>
  );
}

function MissionsSection(): React.ReactElement {
  const t = useT();
  const missions = useLiveMissions();
  const groups = useLiveMissionGroups();
  // Collapse for the whole section (expanded by default — running tasks are the work
  // that is happening right now).
  const [expanded, setExpanded] = useState(true);
  // Finished tasks get their own disclosure, collapsed by default, with a one-line
  // summary on the toggle itself. A task row stays valid as long as its workspace is
  // alive (jump and channel links still work), but there is no reason for a finished
  // one to sit permanently expanded taking up room — and the summary means collapsing
  // it does not hide WHICH task finished last.
  const [doneExpanded, setDoneExpanded] = useState(false);
  const done = missions.filter((m) => m.status !== 'open');
  // Only the running tasks are grouped under their parent: a finished task's parent
  // is no longer where the reader is going next, and repeating the tree there would
  // double the section's height for information nobody acts on.
  const openGroups = groups
    .map((g) => ({ ...g, tasks: g.tasks.filter((m) => m.status === 'open') }))
    .filter((g) => g.tasks.length > 0);

  return (
    <div className="mb-1" data-missions-section>
      <button
        type="button"
        className={`w-full flex items-center gap-1 px-4 pt-1 pb-1 text-[9px] font-mono font-semibold tracking-widest text-[var(--text-muted)] uppercase hover:text-[var(--text-subtle)] transition-colors ${FOCUS_RING}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-missions-toggle
      >
        <span
          className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          <IconChevron size={9} />
        </span>
        <span>{t('missions.title', { count: missions.length })}</span>
      </button>
      {expanded && missions.length === 0 && (
        <div className="px-4 py-1 text-[10px] font-mono text-[var(--text-muted)]" data-missions-empty>
          {t('missions.empty')}
        </div>
      )}
      {expanded && missions.length > 0 && (
        <>
          <div className="space-y-0.5" data-missions-open-group>
            {openGroups.map((group) => (
              <div key={group.parentId} data-missions-parent={group.parentId}>
                <div
                  className="px-4 py-0.5 truncate text-[9px] font-mono uppercase tracking-widest text-[var(--text-subtle)]"
                  title={group.parentName}
                >
                  {group.parentName}
                </div>
                {group.tasks.map((task) => (
                  <MissionRow key={task.id} task={task} indented />
                ))}
              </div>
            ))}
          </div>
          {done.length > 0 && (
            <div data-missions-done-group>
              <div className="flex items-center">
              <button
                type="button"
                className={`min-w-0 flex-1 flex items-center gap-1 px-4 py-0.5 text-[9px] font-mono uppercase tracking-widest text-[var(--text-muted)] hover:text-[var(--text-subtle)] transition-colors ${FOCUS_RING}`}
                onClick={() => setDoneExpanded((v) => !v)}
                aria-expanded={doneExpanded}
                data-missions-done-toggle
              >
                <span
                  className={`transition-transform ${doneExpanded ? 'rotate-90' : ''}`}
                  aria-hidden="true"
                >
                  <IconChevron size={9} />
                </span>
                <span>{t('missions.done', { count: done.length })}</span>
                {/* `done` is newest-first (selectLiveMissions sorts by createdAt
                    desc within a status), so [0] is the most recent one. */}
                <span className="min-w-0 flex-1 truncate text-left normal-case tracking-normal text-[var(--text-subtle)]" data-missions-done-summary>
                  {t('missions.doneSummary', { title: done[0]?.title ?? '' })}
                </span>
              </button>
              {/* C-4: finished tasks are where cleanup starts. The worktree scan
                  had no entry point outside the command palette, so a task whose
                  close failed was invisible from the section that lists it. */}
              <button
                type="button"
                className={`shrink-0 pr-4 pl-1 py-0.5 text-[9px] font-mono uppercase tracking-widest text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors ${FOCUS_RING}`}
                onClick={() => useStore.getState().setWorktaskCleanupVisible(true)}
                title={t('missions.cleanUpTooltip')}
                aria-label={t('missions.cleanUpTooltip')}
                data-missions-cleanup
              >
                {t('missions.cleanUp')}
              </button>
              </div>
              {doneExpanded && (
                <div className="space-y-0.5 opacity-60">
                  {done.map((task) => (
                    <MissionRow key={task.id} task={task} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default memo(MissionsSection);
