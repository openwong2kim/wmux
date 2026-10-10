// Compact goal status for the Moa panel (above the composer): which goal is
// running, its task budget, each done criterion as ✓ / ✗ / ○, the last gate
// failure with its log, and the PRs Moa opened. The same data Settings › Moa
// shows in full (MoaGoalPanel), so the operator does not have to dig for it.
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { MoaGoalPanel } from '../../../shared/moa';
import { MoaGoalDrafts } from './MoaGoalDrafts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shown for an open goal, and for a goal that ended in the last day. */
export function goalStripVisible(goal: MoaGoalPanel | null | undefined, now: number): goal is MoaGoalPanel {
  if (!goal) return false;
  if (goal.status === 'pending' || goal.status === 'active') return true;
  return goal.endedAt !== undefined && now - goal.endedAt < DAY_MS;
}

const MARK = { pass: '✓', fail: '✗', open: '○' } as const;

export function MoaGoalStrip() {
  const t = useT();
  const goal = useStore((s) => s.moa?.goal);
  const drafts = useStore((s) => s.moa?.learning?.drafts.length ?? 0);
  if (!goalStripVisible(goal, Date.now())) {
    return drafts > 0 ? (
      <div className="mx-3 mb-1 rounded-md border border-[var(--line)] px-2.5 py-1.5 text-[var(--text-sub)]" data-testid="moa-goal-strip" data-status="drafts">
        <MoaGoalDrafts compact />
      </div>
    ) : null;
  }
  const problem = goal.problems?.[0];
  const status = goal.status === 'active' && !goal.live ? 'inert' : goal.status;
  return (
    <div
      className="mx-3 mb-1 rounded-md border border-[var(--line)] px-2.5 py-1.5 text-[11px] leading-snug text-[var(--text-sub)]"
      data-testid="moa-goal-strip"
      data-status={status}
    >
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="font-semibold text-[var(--text-main)] shrink-0">{t('moa.goalStrip.title', { id: goal.id })}</span>
        <span className="shrink-0">· {t(`moa.goalStrip.status.${status}`)}</span>
        {goal.status === 'active' && (
          <span className="shrink-0">· {t('moa.goalStrip.tasks', { n: goal.tasksUsed, max: goal.maxTasks })}</span>
        )}
        <span className="truncate" title={goal.goal}>· {goal.goal}</span>
      </div>
      {goal.criteria && goal.criteria.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-x-2" data-testid="moa-goal-strip-criteria">
          {goal.criteria.map((c) => (
            <span key={c.n} title={c.text} data-state={c.state} data-testid={`moa-goal-strip-criterion-${c.n}`}>
              {MARK[c.state]} ({c.n}) <span className="inline-block max-w-[16ch] truncate align-bottom">{c.text}</span>
            </span>
          ))}
        </div>
      )}
      {problem && (
        <div className="mt-0.5" data-testid="moa-goal-strip-problem">
          ✗ {problem.text}
          {problem.logPath && (
            <button
              type="button"
              className="ml-1.5 underline"
              onClick={() => { void window.electronAPI.shell?.openPath?.(problem.logPath as string); }}
              data-testid="moa-goal-strip-log"
            >
              {t('moa.goalStrip.openLog')}
            </button>
          )}
        </div>
      )}
      {drafts > 0 && <div className="mt-1"><MoaGoalDrafts compact /></div>}
      {goal.delivery?.items.filter((d) => d.prUrl).map((d) => (
        <div key={d.prUrl} className="mt-0.5">
          <a
            href={d.prUrl}
            className="underline"
            onClick={(e) => { e.preventDefault(); void window.electronAPI.shell?.openExternal?.(d.prUrl as string); }}
          >
            {t('moa.settings.goalPr', { n: d.prNumber ?? '?', branch: d.branch })}
          </a>
          {goal.delivery?.reverted ? ` · ${t('moa.goalStrip.reverted')}` : ''}
        </div>
      ))}
    </div>
  );
}
