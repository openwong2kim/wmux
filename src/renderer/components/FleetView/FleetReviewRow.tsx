// "Ready to review" rows for the Fleet attention board: one row per finished
// fan-out task whose record is still open (selectReviewQueue). Row click and
// Enter open the task's diff; a hover/focus ⋮ holds Open diff, Open/Create PR,
// Jump to task and Close task, with d / p / j / Backspace on a focused row.
// Every verb is an existing path: the task diff surface, the task PR IPC, the
// workspace jump, and the task close (which refuses dirty or unpushed work).
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { DiffNumstat } from '../../../shared/diffParse';
import type { PrStatus } from '../../../shared/types';
import type { TranslationKey } from '../../i18n/locales/en';
import type { ReviewQueueEntry } from '../../stores/selectors/reviewQueue';
import { selectWorkspaceAgentRoster } from '../../stores/selectors/workspaceAgentRoster';
import { CLOSE_SKIP_KEY, ORPHAN_GROUP_KEY, revalidateTaskForClose, withTimeout } from '../Sidebar/sidebarTree';
import { TASK_CLOSE_TIMEOUT_MS } from '../Sidebar/SidebarTaskGroup';
import { AGENT_STATUS_ICON } from '../Sidebar/agentStatusIcon';
import PaneActionsMenu, { type PaneActionItem } from '../Pane/PaneActionsMenu';
import { IconCheck, IconChevron, IconChevronDir, IconExternalLink, IconReview, IconX } from '../icons';
import { disposeWorkspacePtys } from '../../utils/paneTeardown';
import { displayWorkspaceName } from '../../utils/fanoutProvenance';
import { formatIdle, IDLE_SHOW_AFTER_MS } from '../../utils/idleTime';

export type ReviewEditorKind = 'close' | 'pr';
type Translate = ReturnType<typeof useT>;

const PR_STATE_KEY: Record<PrStatus['state'], TranslationKey> = {
  open: 'fleet.review.pr.open',
  draft: 'fleet.review.pr.draft',
  merged: 'fleet.review.pr.merged',
  closed: 'fleet.review.pr.closed',
};

/** Roving key of a review row (pane ids never take this form). */
export function reviewRowKey(workspaceId: string): string {
  return `fleet:review:${workspaceId}`;
}

// ─── Change summary ─────────────────────────────────────────────────────────

export interface ReviewChangeSummary {
  files: number;
  additions: number;
  deletions: number;
}

/** Files changed and lines added/removed. A binary file counts as a file and
 *  adds no lines. */
export function summarizeNumstat(numstat: readonly DiffNumstat[]): ReviewChangeSummary {
  let additions = 0;
  let deletions = 0;
  for (const n of numstat) {
    additions += n.additions ?? 0;
    deletions += n.deletions ?? 0;
  }
  return { files: numstat.length, additions, deletions };
}

// One read per task per completion: a reopened Fleet does not re-read a task
// that has not run again since. Bounded by the open-task cap.
const summaryCache = new Map<string, ReviewChangeSummary | null>();

/** The task's change summary from the task diff read (worktree vs target
 *  HEAD). Undefined while loading; null when the read failed. */
function useReviewChangeSummary(entry: ReviewQueueEntry): ReviewChangeSummary | null | undefined {
  const key = `${entry.taskId}:${entry.completedAt ?? 0}`;
  const [summary, setSummary] = useState<ReviewChangeSummary | null | undefined>(() => summaryCache.get(key));
  const worktreePath = entry.worktreePath;
  useEffect(() => {
    if (summaryCache.has(key)) { setSummary(summaryCache.get(key)); return; }
    if (!worktreePath || typeof window.electronAPI?.diff?.read !== 'function') { setSummary(null); return; }
    let cancelled = false;
    window.electronAPI.diff.read(worktreePath, '', 'task').then((res) => {
      const next = res.ok ? summarizeNumstat(res.numstat) : null;
      summaryCache.set(key, next);
      if (!cancelled) setSummary(next);
    }).catch(() => { if (!cancelled) setSummary(null); });
    return () => { cancelled = true; };
  }, [key, worktreePath]);
  return summary;
}

// ─── Verbs ──────────────────────────────────────────────────────────────────

/** The PR to open: the metadata poll's (with state), else the recorded one. */
export function reviewPrUrl(entry: ReviewQueueEntry): string | undefined {
  return entry.pr?.url ?? entry.prUrl;
}

/**
 * Close one task the way the sidebar's "Close finished tasks" does: re-check it
 * against the current store, run the real task close (it refuses a dirty or
 * unpushed worktree with the reason), then dispose and remove the workspace.
 */
export async function closeReviewTask(workspaceId: string, t: Translate): Promise<boolean> {
  const st = useStore.getState();
  const name = displayWorkspaceName(st.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId, true);
  const owner = st.missionByPaneGroup[workspaceId]?.owner?.verifiedWorkspaceId ?? '';
  const groupKey = st.workspaces.some((w) => w.id === owner) ? owner : ORPHAN_GROUP_KEY;
  const check = revalidateTaskForClose(st, workspaceId, groupKey, (id) => selectWorkspaceAgentRoster(st, id).rows);
  const push = st.pushToast;
  if (!check.ok) {
    push({ level: 'warn', message: `${name}: ${t(CLOSE_SKIP_KEY[check.reason])}` });
    return false;
  }
  try {
    const res = await withTimeout(
      window.electronAPI.workTask.close(check.mission.id, check.mission.owner.verifiedWorkspaceId),
      TASK_CLOSE_TIMEOUT_MS,
    );
    if (res.ok) {
      const now = useStore.getState();
      const ws = now.workspaces.find((w) => w.id === workspaceId);
      if (ws) disposeWorkspacePtys(ws);
      now.removeWorkspace(workspaceId);
      push({ level: 'info', message: t('fleet.review.closed', { title: name }) });
      return true;
    }
    const reason = res.reason === 'dirty' ? t('worktask.cleanup.preserved')
      : res.reason === 'unpushed' ? t('worktask.cleanup.unpushed', { count: res.aheadCount ?? '' })
      : t('worktask.cleanup.closeFailed', { error: res.error ?? '' });
    push({ level: 'warn', message: `${name}: ${reason}` });
  } catch (err) {
    push({ level: 'warn', message: `${name}: ${t('worktask.cleanup.closeFailed', { error: err instanceof Error ? err.message : String(err) })}` });
  }
  return false;
}

/** Push the task branch and open a PR through the task PR path (gh gates and
 *  idempotent re-entry live in main), with the diff panel's result toasts. */
export async function createReviewTaskPr(entry: ReviewQueueEntry, t: Translate): Promise<void> {
  const push = useStore.getState().pushToast;
  try {
    const res = await window.electronAPI.workTask.createPr(entry.taskId, entry.ownerWorkspaceId);
    if (res.ok) {
      push({
        level: res.commitPending ? 'warn' : 'info',
        message: res.recovered
          ? t('diff.prRecovered', { url: res.prUrl ?? '' })
          : t('diff.prCreated', { url: res.prUrl ?? '' }) + (res.commitPending ? t('diff.prUrlPending') : ''),
        action: { label: t('diff.openPr'), onClick: () => window.open(res.prUrl, '_blank') },
      });
    } else if (res.reason === 'gh-missing' || res.reason === 'gh-unauth') {
      push({ level: 'warn', message: `${res.error}${res.browseFallback ? ` — ${res.browseFallback}` : ''}` });
    } else if (res.reason === 'dirty') {
      push({ level: 'warn', message: res.error });
    } else {
      push({ level: 'error', message: t('diff.prFailed', { error: res.error ?? '' }) });
    }
  } catch (err) {
    push({ level: 'error', message: t('diff.prFailed', { error: err instanceof Error ? err.message : String(err) }) });
  }
}

/** Open the PR, or ask to create one when the task has none. */
export function reviewPrVerb(entry: ReviewQueueEntry, onEdit: (entry: ReviewQueueEntry, kind: ReviewEditorKind) => void): void {
  const url = reviewPrUrl(entry);
  if (url) window.open(url, '_blank');
  else onEdit(entry, 'pr');
}

// ─── Row ────────────────────────────────────────────────────────────────────

interface FleetReviewRowProps {
  entry: ReviewQueueEntry;
  focused: boolean;
  now: number;
  onFocus: () => void;
  onOpenDiff: (entry: ReviewQueueEntry) => void;
  onJump: (entry: ReviewQueueEntry) => void;
  onEdit: (entry: ReviewQueueEntry, kind: ReviewEditorKind) => void;
  onMenuOpenChange?: (close: (() => void) | null) => void;
  /** The inline confirm open under this row, if any. */
  editor?: ReviewEditorKind;
  onEditorDone: () => void;
}

function FleetReviewRow({ entry, focused, now, onFocus, onOpenDiff, onJump, onEdit, onMenuOpenChange, editor, onEditorDone }: FleetReviewRowProps) {
  const t = useT();
  const summary = useReviewChangeSummary(entry);
  const [anchor, setAnchor] = useState<{ top: number; left: number; right: number; bottom: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => {
    setAnchor(null);
    onMenuOpenChange?.(null);
  }, [onMenuOpenChange]);
  const openRef = useRef(false);
  openRef.current = anchor !== null;
  useEffect(() => () => { if (openRef.current) onMenuOpenChange?.(null); }, [onMenuOpenChange]);

  const icon = AGENT_STATUS_ICON.complete;
  const prUrl = reviewPrUrl(entry);
  const elapsedMs = entry.completedAt !== undefined ? Math.max(0, now - entry.completedAt) : undefined;
  const elapsed = elapsedMs !== undefined && elapsedMs >= IDLE_SHOW_AFTER_MS ? formatIdle(elapsedMs) : undefined;
  const owner = entry.ownerName ?? t('sidebar.tasks.orphanGroup');
  const changeText = summary
    ? summary.files === 0
      ? t('fleet.review.noChanges')
      : t(summary.files === 1 ? 'fleet.review.filesOne' : 'fleet.review.files', { count: summary.files })
    : undefined;
  const prText = entry.pr
    ? t('fleet.review.prState', { number: entry.pr.number, state: t(PR_STATE_KEY[entry.pr.state]) })
    : prUrl ? t('fleet.review.prLinked') : undefined;
  const label = [entry.title, t('fleet.review.statusLabel'), owner, entry.branch,
    changeText && summary && summary.files > 0 ? `${changeText}, +${summary.additions} −${summary.deletions}` : changeText,
    prText, t('fleet.review.openDiff')].filter(Boolean).join(', ');

  const items: PaneActionItem[] = [
    { key: 'diff', label: t('fleet.review.openDiff'), shortcut: 'D', icon: <IconReview size={12} />, onSelect: () => onOpenDiff(entry) },
    {
      key: 'pr',
      label: prUrl ? t('diff.openPr') : t('fleet.review.createPr'),
      shortcut: 'P',
      icon: <IconExternalLink size={12} />,
      onSelect: () => reviewPrVerb(entry, onEdit),
    },
    { key: 'jump', label: t('fleet.review.jump'), shortcut: 'J', icon: <IconChevron size={12} />, onSelect: () => onJump(entry) },
    { key: 'close', label: t('fleet.review.close'), shortcut: '⌫', icon: <IconX size={12} />, separatorBefore: true, onSelect: () => onEdit(entry, 'close') },
  ];

  const run = async (kind: ReviewEditorKind) => {
    setBusy(true);
    try {
      if (kind === 'close') await closeReviewTask(entry.workspaceId, t);
      else await createReviewTaskPr(entry, t);
    } finally {
      setBusy(false);
      onEditorDone();
    }
  };

  return (
    <div role="presentation" className="wmux-fleet-row" data-fleet-review={entry.workspaceId}>
      <button
        type="button"
        role="option"
        aria-selected={focused}
        aria-label={label}
        tabIndex={focused ? 0 : -1}
        onFocus={onFocus}
        onClick={() => onOpenDiff(entry)}
        data-fleet-review-row
        data-workspace-id={entry.workspaceId}
        className="wmux-fleet-card"
      >
        <span className="wmux-fleet-status" style={{ color: icon.dotVar }}>
          <span aria-hidden="true" className="inline-flex"><IconCheck size={11} /></span>
          <span>{t('fleet.review.statusLabel')}</span>
        </span>
        <span className="wmux-fleet-identity">
          <span className="wmux-fleet-name" title={entry.title}>{entry.title}</span>
          <span className="wmux-fleet-context" title={entry.branch ? `${owner} · ${entry.branch}` : owner}>
            <span>{owner}</span>
            {entry.branch && <span className="font-mono" data-fleet-review-branch>{entry.branch}</span>}
          </span>
        </span>
        <span className="wmux-fleet-progress">
          {/* Nothing is drawn until the read lands (no placeholder gauge). */}
          <span className="wmux-fleet-detail" data-fleet-review-changes={summary ? `${summary.files}:${summary.additions}:${summary.deletions}` : undefined}>
            {changeText && (
              <>
                {changeText}
                {summary && summary.files > 0 && (
                  <>
                    {' · '}
                    <span className="text-[var(--accent-green)]">+{summary.additions}</span>{' '}
                    <span className="text-[var(--accent-red)]">−{summary.deletions}</span>
                  </>
                )}
              </>
            )}
          </span>
          <span className="wmux-fleet-meta">
            {prText && <span data-fleet-review-pr={entry.pr?.state ?? 'linked'}>{prText}</span>}
            {elapsed && <span data-fleet-elapsed>{elapsed}</span>}
          </span>
        </span>
        <span className="wmux-fleet-action" aria-hidden="true">
          <span>{t('fleet.action.result')}</span><IconChevronDir dir="right" size={12} />
        </span>
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="wmux-fleet-row-trigger"
        tabIndex={focused ? 0 : -1}
        title={t('pane.moreActions')}
        aria-label={t('pane.moreActions')}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        data-fleet-row-trigger
        onClick={(e) => {
          e.stopPropagation();
          if (anchor) { closeMenu(); return; }
          setAnchor(e.currentTarget.getBoundingClientRect());
          onMenuOpenChange?.(closeMenu);
        }}
      >
        <span aria-hidden="true" className="font-mono text-[13px] leading-none">⋮</span>
      </button>
      {anchor && <PaneActionsMenu anchor={anchor} triggerRef={triggerRef} items={items} onClose={closeMenu} />}
      {editor && (
        <div className="wmux-fleet-editor" role="group" data-fleet-editor={`review-${editor}`}
          aria-label={editor === 'close' ? t('fleet.review.close') : t('fleet.review.createPr')}>
          <span className="wmux-fleet-editor-text">
            {editor === 'close'
              ? t('fleet.review.closeConfirm')
              : t('fleet.review.prConfirm', { branch: entry.branch ?? entry.title })}
          </span>
          {/* Cancel is first and focused, so Enter on arrival cancels. */}
          <button type="button" autoFocus data-fleet-review-cancel onClick={onEditorDone} disabled={busy}>
            {t('fleet.close.cancel')}
          </button>
          <button type="button" className={editor === 'close' ? 'is-destructive' : undefined}
            data-fleet-review-confirm={editor} disabled={busy} onClick={() => void run(editor)}>
            {editor === 'close' ? t('fleet.review.close') : t('fleet.review.createPr')}
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(FleetReviewRow);
