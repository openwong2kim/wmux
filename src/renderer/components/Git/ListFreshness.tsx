// The line over a Git page list that says how fresh it is: "Updated 2m ago",
// or, when the last read failed, that the list is from earlier, with Retry.
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { relTime, useMinuteTick } from './useGitList';

/** HH:MM, local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ListFreshness({ fetchedAt, error, retryAt, onRetry }: {
  fetchedAt: number | null;
  error: string | null;
  retryAt: number | null;
  onRetry: () => void;
}): React.ReactElement | null {
  const t = useT();
  useMinuteTick();
  if (retryAt !== null) {
    return (
      <div className="wmux-git-fresh" role="status" data-git-list-rate-limited>
        {t('git.issues.rateLimited', { time: clockTime(retryAt) })}
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="wmux-git-fresh" role="status" data-git-list-stale title={error}>
        <span>
          {fetchedAt === null
            ? t('git.list.failed')
            : Date.now() - fetchedAt < 60_000
              ? t('git.list.staleNow')
              : t('git.list.staleSince', { age: relTime(fetchedAt, t) })}
        </span>
        <button type="button" className={`wmux-git-link-btn ${FOCUS_RING}`} onClick={onRetry} data-git-list-retry>
          {t('git.list.retry')}
        </button>
      </div>
    );
  }
  if (fetchedAt === null) return null;
  const justNow = Date.now() - fetchedAt < 60_000;
  return (
    <div className="wmux-git-fresh" data-git-list-fresh>
      {justNow ? t('git.list.updatedNow') : t('git.list.updated', { age: relTime(fetchedAt, t) })}
    </div>
  );
}
