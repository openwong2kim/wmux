// Fleet's ticket sources: every workspace's pending decision, the delegated
// work (WorkLinks) and the To hand out list. All are main's; Fleet re-reads on
// main's change signals instead of polling.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HandOutEntry } from '../../../shared/handOut';
import type { MoaPendingDecision } from '../../../shared/moa';
import type { WorkLink, WorkLinkFilter } from '../../../shared/workLink';

export interface MoaDecisionsApi {
  decisions: () => Promise<{ decisions: MoaPendingDecision[] }>;
  onChanged?: (cb: () => void) => () => void;
}

export interface WorkLinksApi {
  list: (filter?: WorkLinkFilter) => Promise<WorkLink[]>;
  onChanged?: (cb: (ids: string[]) => void) => () => void;
}

export interface HandOutApi {
  list: () => Promise<HandOutEntry[]>;
  onChanged?: (cb: () => void) => () => void;
}

const EMPTY_DECISIONS: MoaPendingDecision[] = [];
const EMPTY_LINKS: WorkLink[] = [];
const EMPTY_HAND_OUT: HandOutEntry[] = [];

/** Re-read on a change signal, coalescing a burst into one read. */
export function useReread<T>(
  read: (() => Promise<T>) | null,
  subscribe: ((cb: () => void) => () => void) | null,
  initial: T,
): { value: T; refresh: () => void } {
  const [value, setValue] = useState<T>(initial);
  const seq = useRef(0);
  const refresh = useCallback(() => {
    if (!read) return;
    const mine = ++seq.current;
    read()
      .then((v) => { if (mine === seq.current) setValue(v); })
      .catch(() => { /* main gone: keep the last answer */ });
  }, [read]);
  useEffect(() => {
    if (!read) { setValue(initial); return undefined; }
    refresh();
    if (!subscribe) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
      seq.current++;
      off();
    };
    // `initial` is a module constant at every call site, so not a dependency.
  }, [read, subscribe, refresh]);
  return { value, refresh };
}

const defaultDecisionsApi = (): MoaDecisionsApi | undefined => {
  const moa = window.electronAPI?.deck?.moa;
  return moa?.decisions ? { decisions: moa.decisions, onChanged: moa.onChanged } : undefined;
};

/** Every workspace's pending decision, oldest first. Off → empty. */
export function useMoaDecisions(enabled: boolean, api: MoaDecisionsApi | undefined = defaultDecisionsApi()) {
  const decisionsFn = api?.decisions;
  const onChanged = api?.onChanged;
  const read = useCallback(
    () => decisionsFn!().then((r) =>
      [...(r?.decisions ?? [])].sort((a, b) => a.decision.raisedAt - b.decision.raisedAt)),
    [decisionsFn],
  );
  const { value, refresh } = useReread<MoaPendingDecision[]>(
    enabled && decisionsFn ? read : null,
    enabled && onChanged ? onChanged : null,
    EMPTY_DECISIONS,
  );
  return { decisions: value, refresh };
}

const defaultLinksApi = (): WorkLinksApi | undefined => window.electronAPI?.workLinks;

/** Delegated work, as stored. Off → empty. */
export function useWorkLinks(enabled: boolean, api: WorkLinksApi | undefined = defaultLinksApi()) {
  const listFn = api?.list;
  const onChanged = api?.onChanged;
  const read = useCallback(() => listFn!({}).then((r) => (Array.isArray(r) ? r : [])), [listFn]);
  const subscribe = useCallback(
    (cb: () => void) => onChanged!(() => cb()),
    [onChanged],
  );
  const { value } = useReread<WorkLink[]>(
    enabled && listFn ? read : null,
    enabled && onChanged ? subscribe : null,
    EMPTY_LINKS,
  );
  return value;
}

const defaultHandOutApi = (): HandOutApi | undefined => window.electronAPI?.handOut;

/** The To hand out items nobody has yet (state open), newest first. Off → empty. */
export function useHandOutItems(enabled: boolean, api: HandOutApi | undefined = defaultHandOutApi()): HandOutEntry[] {
  const listFn = api?.list;
  const onChanged = api?.onChanged;
  const read = useCallback(() => listFn!().then((r) => (Array.isArray(r) ? r : [])), [listFn]);
  const { value } = useReread<HandOutEntry[]>(
    enabled && listFn ? read : null,
    enabled && onChanged ? onChanged : null,
    EMPTY_HAND_OUT,
  );
  return useMemo(
    () => value.filter((item) => item.state === 'open').sort((a, b) => b.createdAt - a.createdAt),
    [value],
  );
}
