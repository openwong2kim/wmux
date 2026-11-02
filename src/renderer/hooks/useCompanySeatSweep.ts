// Company seat worktrees go once nothing uses them (main company/seatCleanup.ts).
// Main cannot see what this window is about to open again: the folders of
// live and stashed panes, which a daemon that just started has no session for
// yet, and of archived workspaces, which Restore reopens. So every sweep
// request carries them (the keep set). One sweep once the saved session is
// loaded, and one a few seconds after a workspace or an archived workspace
// goes (Close and Archive both remove the workspace), once its panes'
// sessions have exited.

import { useEffect } from 'react';
import { useStore } from '../stores';
import { t } from '../i18n';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import type { ArchivedWorkspace, Workspace } from '../../shared/types';

/** After a workspace goes, its panes' sessions are given this long to exit. */
export const COMPANY_SEAT_SWEEP_DEBOUNCE_MS = 3000;

/** Every folder a terminal here works in or will open in: each terminal
 *  surface of every workspace (stashed panes included), each pane still
 *  waiting for its first terminal (a seat just made, a workspace just
 *  restored), and each archived workspace's leaf folders. */
export function companySeatKeepSet(state: {
  workspaces: readonly Workspace[];
  archivedWorkspaces: readonly ArchivedWorkspace[];
  projectPaneSeed: Readonly<Record<string, { cwd?: string }>>;
}): string[] {
  const keep = new Set<string>();
  for (const ws of state.workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      for (const s of leaf.surfaces) {
        if ((s.surfaceType ?? 'terminal') === 'terminal' && s.cwd) keep.add(s.cwd);
      }
    }
  }
  for (const seed of Object.values(state.projectPaneSeed)) if (seed.cwd) keep.add(seed.cwd);
  for (const archived of state.archivedWorkspaces) {
    for (const cwd of archived.leafCwds ?? []) if (cwd) keep.add(cwd);
  }
  return [...keep];
}

const idsOf = (items: readonly { id: string }[]): Set<string> => new Set(items.map((i) => i.id));
const lostOne = (before: Set<string>, now: Set<string>): boolean => [...before].some((id) => !now.has(id));

/** Mounted once; `sessionLoaded`: the saved session is in the store (never
 *  on a failed load, whose keep set would miss every saved folder). */
export function useCompanySeatSweep(sessionLoaded: boolean): void {
  useEffect(() => {
    if (!sessionLoaded) return;
    const api = window.electronAPI?.workTask;
    if (!api?.sweepCompanySeats) return;
    let disposed = false;
    let toastedRun = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sweep = () => {
      api.sweepCompanySeats(companySeatKeepSet(useStore.getState())).then((res) => {
        // Requests that waited for the same sweep share its answer: one toast.
        if (disposed || !res.ok || res.removed === 0 || res.run <= toastedRun) return;
        toastedRun = res.run;
        useStore.getState().pushToast({ level: 'info', message: t('worktask.cleanup.seatSwept', { count: res.removed }) });
      }, (err: unknown) => console.warn('[company] seat sweep request failed:', err));
    };
    sweep();

    let live = idsOf(useStore.getState().workspaces);
    let archived = idsOf(useStore.getState().archivedWorkspaces);
    const unsubscribe = useStore.subscribe((state, prev) => {
      if (state.workspaces === prev.workspaces && state.archivedWorkspaces === prev.archivedWorkspaces) return;
      const nextLive = idsOf(state.workspaces);
      const nextArchived = idsOf(state.archivedWorkspaces);
      const gone = lostOne(live, nextLive) || lostOne(archived, nextArchived);
      live = nextLive;
      archived = nextArchived;
      if (!gone) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        sweep();
      }, COMPANY_SEAT_SWEEP_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [sessionLoaded]);
}
