/**
 * Scheduled runs — the renderer's copy of the daemon's automations and their
 * recent runs, plus the Schedules view's open/selection state.
 *
 * The daemon owns the store and the run state machine; this slice only mirrors
 * it. Two feeds keep it fresh: main's AUTOMATION_PUSH (live events and a full
 * snapshot on every daemon (re)connect) and the renderer's own pull on mount
 * (a reloaded renderer must not wait for the next reconnect). Transient UI
 * state — never persisted.
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Automation, AutomationRun } from '../../../shared/automation';
import type { AutomationPush } from '../../../main/automation/AutomationBridge';
import { t } from '../../i18n';
import { applyAppRoute, leaveAppRoute } from './uiSlice';

// A refresh answer can be older than run-changed events that landed while it
// was in flight. Each refresh takes a generation; only the newest applies, and
// runs upserted since it started win over the snapshot's copies.
let refreshGeneration = 0;
let upsertSeq = 0;
const runUpsertedAt = new Map<string, number>();

export interface SchedulesSlice {
  automations: Automation[];
  automationRuns: AutomationRun[];
  /** True once a daemon answered automation.list — gates the sidebar row. */
  schedulesAvailable: boolean;
  /** The last list read failed transiently; what is shown may be stale. */
  schedulesError: boolean;
  schedulesViewOpen: boolean;
  /** Automation shown in the detail pane of the Schedules view. */
  schedulesSelectedId: string | null;
  setAutomationSnapshot: (automations: Automation[], runs: AutomationRun[]) => void;
  applyAutomationPush: (push: AutomationPush) => void;
  refreshSchedules: () => Promise<void>;
  openSchedulesView: (automationId?: string | null) => void;
  closeSchedulesView: () => void;
  toggleSchedulesView: () => void;
  selectSchedule: (automationId: string | null) => void;
}

function upsertRun(runs: AutomationRun[], run: AutomationRun): AutomationRun[] {
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx === -1) return [...runs, run];
  const next = runs.slice();
  next[idx] = run;
  return next;
}

export const createSchedulesSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  SchedulesSlice
> = (set, get) => ({
  automations: [],
  automationRuns: [],
  schedulesAvailable: false,
  schedulesError: false,
  schedulesViewOpen: false,
  schedulesSelectedId: null,

  setAutomationSnapshot: (automations, runs) => set((state) => {
    state.automations = automations;
    state.automationRuns = runs;
    state.schedulesAvailable = true;
    state.schedulesError = false;
    if (state.schedulesSelectedId && !automations.some((a) => a.id === state.schedulesSelectedId)) {
      state.schedulesSelectedId = null;
    }
  }),

  applyAutomationPush: (push) => {
    if (push.kind === 'snapshot') {
      get().setAutomationSnapshot(push.automations, push.runs);
      return;
    }
    if (push.kind === 'attention') {
      // No OS toast could show these (main keeps them queued): say it in-app.
      for (const item of push.items) {
        const word = item.kind === 'proposed' ? t('schedules.toast.proposed')
          : item.kind === 'needs-regrant' ? t('schedules.toast.needsRegrant')
            : t('schedules.toast.grantRaised');
        get().pushToast({ level: 'info', message: `${item.automationName || t('schedules.title')} · ${word}` });
      }
      void get().refreshSchedules();
      return;
    }
    const ev = push.event;
    if (ev.type === 'run-changed') {
      runUpsertedAt.set(ev.run.id, ++upsertSeq);
      set((state) => {
        state.automationRuns = upsertRun(state.automationRuns, ev.run);
      });
      return;
    }
    // automations-changed / attention: the list moved (a draft arrived, a
    // grant changed, nextRunAt advanced) — re-pull it whole.
    void get().refreshSchedules();
  },

  refreshSchedules: async () => {
    const api = window.electronAPI?.automation;
    if (!api) return;
    const generation = ++refreshGeneration;
    const startSeq = upsertSeq;
    try {
      const [list, runs] = await Promise.all([api.list(), api.runs()]);
      if (generation !== refreshGeneration) return; // a newer refresh owns the state
      if (!list.available) {
        set((state) => { state.schedulesAvailable = false; });
        return;
      }
      if (list.error) {
        set((state) => { state.schedulesError = true; });
        return;
      }
      const newer = get().automationRuns.filter((r) => (runUpsertedAt.get(r.id) ?? 0) > startSeq);
      let merged = runs.runs;
      for (const run of newer) merged = upsertRun(merged, run);
      get().setAutomationSnapshot(list.automations, merged);
      runUpsertedAt.clear();
    } catch {
      // A stale preload or a torn-down window: keep what we have.
    }
  },

  // Schedules is a rail page; the route owns `schedulesViewOpen`.
  openSchedulesView: (automationId) => set((state) => {
    applyAppRoute(state, 'schedules');
    if (automationId !== undefined) state.schedulesSelectedId = automationId;
  }),

  closeSchedulesView: () => set((state) => {
    leaveAppRoute(state, 'schedules');
  }),

  toggleSchedulesView: () => set((state) => {
    applyAppRoute(state, state.appRoute === 'schedules' ? 'workspaces' : 'schedules');
  }),

  selectSchedule: (automationId) => set((state) => {
    state.schedulesSelectedId = automationId;
  }),
});
