// A detail-pane read: once per dependency (and per retry), keeping only the
// newest answer, and a failed read's line with Retry.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';

export type DetailAnswer<T> = { ok: true; value: T } | { ok: false; message: string; retryAt?: number };

/** Reads `load` once per `dep` (and per retry), keeping only the newest
 *  answer. A rate-limited answer reads again by itself at its retry time. */
export function useDetail<T>(load: () => Promise<DetailAnswer<T>>, dep: string) {
  const [state, setState] = useState<{ value: T | null; error: string | null; retryAt: number | null; loading: boolean }>(
    { value: null, error: null, retryAt: null, loading: true },
  );
  const [attempt, setAttempt] = useState(0);
  const req = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const mine = ++req.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    void loadRef.current().then((res) => {
      // Only the newest read for this item lands (its rate limit included).
      if (mine !== req.current) return;
      setState(res.ok
        ? { value: res.value, error: null, retryAt: null, loading: false }
        : { value: null, error: res.message, retryAt: res.retryAt ?? null, loading: false });
    });
    return () => { req.current++; };
  }, [dep, attempt]);
  useEffect(() => {
    if (state.retryAt === null) return;
    const id = window.setTimeout(() => setAttempt((n) => n + 1), Math.max(0, state.retryAt - Date.now()) + 500);
    return () => window.clearTimeout(id);
  }, [state.retryAt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

/** A failed detail read: why, and a Retry. */
export function DetailError({ label, error, retry }: { label: string; error: string; retry: () => void }): React.ReactElement {
  const t = useT();
  return (
    <div className="wmux-git-fresh break-words" role="status" data-git-detail-error>
      <span>{label}: {error}</span>
      <button type="button" className={`wmux-git-link-btn ${FOCUS_RING}`} onClick={retry} data-git-detail-retry>
        {t('git.list.retry')}
      </button>
    </div>
  );
}
