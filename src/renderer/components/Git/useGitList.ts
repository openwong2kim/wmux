// One Git page list (pull requests or issues) read through gh: when it reads,
// and what it remembers between reads.
//
// When: once for a new key (repo + filter), unless the list is lazy (another
// repo in All repos), which waits until it is first shown; every 30s while it
// polls, is shown, the Git page is the page on screen and the window is
// visible; and on the page's refresh (forced past main's cache).
// What: the last good answer stays on screen when a read fails or is rate
// limited, with when it was fetched, so the list can say how fresh it is and
// offer a retry. A gate (gh missing, signed out, another host) replaces it.
// Every answer checks a generation that hiding the window bumps; an answer
// dropped while hidden is read again when the window is shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { GhGate } from './GhGateNotice';

export const LIST_POLL_MS = 30_000;

export type ListAnswer<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'gate'; gate: GhGate }
  | { ok: false; kind: 'rate'; retryAt: number }
  | { ok: false; kind: 'error'; message: string };

export interface GitListState<T> {
  /** The last good answer for this key, or null before one. */
  data: T | null;
  gate: GhGate | null;
  /** The last read failed; `data` (if any) is older than that read. */
  error: string | null;
  /** GitHub's rate limit: reads resume at this time. */
  retryAt: number | null;
  /** When `data` was read. */
  fetchedAt: number | null;
  /** No answer yet for this key. */
  loading: boolean;
}

const EMPTY = <T,>(): GitListState<T> => ({ data: null, gate: null, error: null, retryAt: null, fetchedAt: null, loading: true });

export function useGitList<T>({ listKey, read, shown, poll, lazy, refreshKey }: {
  /** repo + filter; null reads nothing. */
  listKey: string | null;
  read: (force: boolean) => Promise<ListAnswer<T>>;
  /** The list is on screen (its tab / group is open). */
  shown: boolean;
  poll: boolean;
  lazy: boolean;
  refreshKey: number;
}): GitListState<T> & { reload: (force?: boolean) => void } {
  const [state, setState] = useState<GitListState<T>>(EMPTY);
  const gen = useRef(0);
  const keyRef = useRef(listKey);
  keyRef.current = listKey;
  const readRef = useRef(read);
  readRef.current = read;
  // The key being read: a second read of it waits, another key does not.
  const inFlight = useRef<string | null>(null);
  const dropped = useRef(false);

  const load = useCallback(async (force = false) => {
    const key = keyRef.current;
    if (!key || inFlight.current === key) return;
    inFlight.current = key;
    const g = gen.current;
    try {
      const res = await readRef.current(force);
      if (keyRef.current !== key) return;
      if (g !== gen.current) {
        dropped.current = true;
        return;
      }
      setState((s) => {
        if (res.ok) return { data: res.data, gate: null, error: null, retryAt: null, fetchedAt: Date.now(), loading: false };
        if (res.kind === 'gate') return { ...EMPTY<T>(), gate: res.gate, loading: false };
        if (res.kind === 'rate') return { ...s, gate: null, retryAt: res.retryAt, error: null, loading: false };
        return { ...s, gate: null, error: res.message, retryAt: null, loading: false };
      });
    } finally {
      if (inFlight.current === key) inFlight.current = null;
    }
  }, []);

  // A new key starts over: one read, unless lazy and never shown.
  const everShown = useRef(shown);
  if (shown) everShown.current = true;
  useEffect(() => {
    setState(EMPTY);
    dropped.current = false;
    if (!listKey || (lazy && !everShown.current)) return;
    void load();
  }, [listKey, load]);
  useEffect(() => () => { gen.current++; }, []);

  // A lazy list reads the first time it is shown.
  const lazyRead = useRef<string | null>(null);
  useEffect(() => {
    if (!lazy || !shown || !listKey || lazyRead.current === listKey) return;
    lazyRead.current = listKey;
    void load();
  }, [lazy, shown, listKey, load]);

  const onGitPage = useStore((s) => s.appRoute === 'git');
  const [windowShown, setWindowShown] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => {
      if (document.hidden) gen.current++;
      setWindowShown(!document.hidden);
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  // Shown again: re-read an answer that was dropped while hidden.
  useEffect(() => {
    if (!windowShown || !dropped.current) return;
    dropped.current = false;
    void load();
  }, [windowShown, load]);

  const polling = poll && shown && !!listKey && onGitPage && windowShown;
  useEffect(() => {
    if (!polling) return;
    void load();
    const id = window.setInterval(() => void load(), LIST_POLL_MS);
    return () => window.clearInterval(id);
  }, [polling, load]);

  // The page's refresh: a forced read past main's TTL (never past its breaker).
  const seenRefresh = useRef(refreshKey);
  useEffect(() => {
    if (seenRefresh.current === refreshKey) return;
    seenRefresh.current = refreshKey;
    if (!lazy || everShown.current) void load(true);
  }, [refreshKey, lazy, load]);

  const reload = useCallback((force = true) => { void load(force); }, [load]);
  return { ...state, reload };
}

/** "now" / "5m" / "3h" / "2d" since an ISO time or epoch ms; '' when unknown. */
export function relTime(at: string | number | null, t: (k: string) => string): string {
  if (at === null || at === '') return '';
  const ms = Date.now() - (typeof at === 'number' ? at : Date.parse(at));
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t('git.justNow') || 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Re-render every minute so relative times stay honest on a list that does not poll. */
export function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
}
