// The data behind Moa's panel: every workspace's pending decision and the
// delegated work (WorkLinks). Both are main's; the panel re-reads on main's
// change signals instead of polling.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MoaPendingDecision } from '../../../../shared/moa';
import { deriveLinkState, type WorkLink, type WorkLinkFilter } from '../../../../shared/workLink';

export interface MoaDecisionsApi {
  decisions: () => Promise<{ decisions: MoaPendingDecision[] }>;
  onChanged?: (cb: () => void) => () => void;
}

export interface WorkLinksApi {
  list: (filter?: WorkLinkFilter) => Promise<WorkLink[]>;
  onChanged?: (cb: (ids: string[]) => void) => () => void;
}

const EMPTY_DECISIONS: MoaPendingDecision[] = [];
const EMPTY_LINKS: WorkLink[] = [];

/** Re-read on a change signal, coalescing a burst into one read. */
function useReread<T>(
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

/** How many task cards the panel shows; the rest is on the Git page. */
export const MOA_TASK_CARD_LIMIT = 20;

/** The cards to show: not abandoned, newest first, capped. */
export function selectTaskCards(links: readonly WorkLink[], pendingIds: ReadonlySet<string>): WorkLink[] {
  return links
    .map((link) => {
      // The stored state can lag the inputs it is derived from; derive it the
      // same way main does so a card never says "running" over a merged PR.
      const derived = deriveLinkState(link, link.decisionIds.some((id) => pendingIds.has(id)));
      if (derived.state === link.state && derived.reason === link.reason) return link;
      const next: WorkLink = { ...link, state: derived.state };
      if (derived.reason) next.reason = derived.reason;
      else delete next.reason;
      return next;
    })
    .filter((link) => link.state !== 'abandoned')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MOA_TASK_CARD_LIMIT);
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
