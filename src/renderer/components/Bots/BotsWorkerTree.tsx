// ─── A bot's workers, nested under its row in the list ───────────────────
//
// Owner decision 2026-10-14: the Bots list shows each bot's workers the way
// the Sidebar shows a workspace's fan-out tasks — an indented row per worker
// on a hairline guide, its status mark, the fan-out mark and the task's
// title, and under it the branch with its +/− diff counts (not the git
// line's clean dot: one dot per row, the state mark). Live workers come
// first, then ended tasks whose workspace is still open (botWorkerTree); a
// row drops off when its workspace is cleared. A click shows the worker's
// terminal in the panel beside the chat (BotsWorkerPanel); the row it shows
// is selected. The rows reuse the Sidebar's marks (StatusMarkView,
// IconFanOut, IconGitBranch), not its task group, whose menu closes
// worktrees.
import { useStore } from '../../stores';
import type { AgentStatus } from '../../../shared/types';
import { FOCUS_RING } from '../focusRing';
import { IconChevron, IconFanOut, IconGitBranch } from '../icons';
import { StatusMarkView } from '../Sidebar/AgentMarks';
import type { BotTreeRow } from './botsModel';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The Sidebar's status mark for a tree row's state. */
const ROW_STATUS: Record<BotTreeRow['state'], AgentStatus> = {
  running: 'running',
  needsYou: 'awaiting_input',
  error: 'error',
  // Reported for review: still open, so no done check and no colour.
  review: 'idle',
  done: 'complete',
  failed: 'error',
  // Stopped by the owner: no colour, no mark (red is for errors).
  cancelled: 'idle',
};

/** A tree row's state in words. */
export function treeRowState(row: BotTreeRow, t: T): string {
  switch (row.state) {
    case 'running': return t('botsPage.worker.running');
    case 'needsYou': return t(row.needsInput ? 'botsPage.worker.needsInput' : 'botsPage.worker.waiting');
    case 'error': return t('botsPage.worker.errored');
    case 'review': return t(row.workerPaused ? 'botsPage.worker.inReviewPaused' : 'botsPage.worker.inReview');
    case 'done': return t('botsPage.worker.done');
    case 'failed': return t('botsPage.worker.failed');
    case 'cancelled': return t('taskStatus.cancelled');
  }
}

/** A tree row's state with its folder note, as the row's label and the
 *  worker panel's header say it. */
export function treeRowLabel(row: BotTreeRow, t: T): string {
  const state = treeRowState(row, t);
  return row.folderKept ? `${state} · ${t('botsPage.worker.folderKept')}` : state;
}

function TreeRow({ row, selected, t, onOpen }: { row: BotTreeRow; selected: boolean; t: T; onOpen: () => void }) {
  const meta = useStore((s) => s.workspaces.find((w) => w.id === row.workspaceId)?.metadata);
  const state = treeRowState(row, t);
  const label = treeRowLabel(row, t);
  const needsYou = row.state === 'needsYou';
  return (
    <button
      type="button"
      data-bots-worker={row.workspaceId}
      data-worker-state={row.state}
      data-worker-needs-input={row.needsInput ? 'true' : undefined}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${row.title}, ${label}`}
      title={`${row.title} · ${label}`}
      onClick={onOpen}
      className={`wmux-bots-tree-row ${selected ? 'is-selected' : ''} ${FOCUS_RING}`}
    >
      <span className="mt-1 flex-none">
        <StatusMarkView status={ROW_STATUS[row.state]} quiet={!needsYou} label={state} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="flex-none text-[var(--text-muted)]" aria-hidden="true"><IconFanOut size={10} /></span>
          {/* The worker shown in the panel reads in the title weight, as the
              Sidebar marks its focused task: no second fill inside the group. */}
          <span className={`min-w-0 truncate text-[12px] ${selected ? 'font-[var(--title-weight,500)] text-[var(--text-main)]' : row.state === 'done' || row.state === 'failed' || row.state === 'cancelled' ? 'text-[var(--text-sub)]' : 'text-[var(--text-main)]'}`}>{row.title}</span>
        </span>
        {/* What a worker waiting on input asks, in the needs-you text. */}
        {row.summary && (
          <span data-bots-worker-summary title={row.summary} className="mt-0.5 block truncate text-[11px] text-[var(--attention-text)]">{row.summary}</span>
        )}
        {/* A neutral note, not an error: the folder waits for its changes. */}
        {row.folderKept && (
          <span data-bots-worker-folder-kept className="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">{t('botsPage.worker.folderKept')}</span>
        )}
        {meta?.gitBranch && (
          <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] leading-4 tabular-nums text-[color-mix(in_srgb,var(--text-main)_45%,transparent)]" data-bots-worker-branch>
            <span className="min-w-0 truncate">
              <span className="mr-1 inline-flex align-[-2px]" aria-hidden="true"><IconGitBranch size={12} /></span>
              {meta.gitBranch}
            </span>
            {/* The diff counts only: the git line's own clean dot would be a
                second dot on a row whose state mark leads it. */}
            {(meta.gitSync?.added ?? 0) > 0 && <span data-git-diff="added" className="shrink-0 font-mono" style={{ color: 'var(--accent-green)' }}>+{meta.gitSync!.added}</span>}
            {(meta.gitSync?.removed ?? 0) > 0 && <span data-git-diff="removed" className="shrink-0 font-mono" style={{ color: 'var(--accent-red)' }}>−{meta.gitSync!.removed}</span>}
          </span>
        )}
      </span>
    </button>
  );
}

/** The fold toggle on a bot's row: a chevron and how many workers it has. */
export function TreeToggle({ count, expanded, controls, name, t, onToggle }: {
  count: number;
  expanded: boolean;
  controls: string;
  name: string;
  t: T;
  onToggle: () => void;
}) {
  const label = t(expanded ? 'botsPage.worker.collapse' : 'botsPage.worker.expand', { name, count });
  return (
    <button
      type="button"
      data-bots-tree-toggle
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={`wmux-bots-tree-toggle ${FOCUS_RING}`}
    >
      <span className="tabular-nums">{count}</span>
      <span className="inline-flex transition-transform duration-150" style={{ transform: expanded ? 'rotate(90deg)' : undefined }} aria-hidden="true">
        <IconChevron size={8} />
      </span>
    </button>
  );
}

export default function BotsWorkerTree({ id, rows, name, shownId, t, onOpen }: {
  id: string;
  rows: readonly BotTreeRow[];
  /** The bot's name (the group's accessible name). */
  name: string;
  /** The worker shown in the panel for this bot, or null. */
  shownId: string | null;
  t: T;
  onOpen: (workspaceId: string) => void;
}) {
  return (
    <div id={id} role="group" aria-label={t('botsPage.worker.treeOf', { name })} className="wmux-bots-tree" data-bots-tree>
      {rows.map((row) => (
        <TreeRow key={row.workspaceId} row={row} selected={shownId === row.workspaceId} t={t} onOpen={() => onOpen(row.workspaceId)} />
      ))}
    </div>
  );
}
