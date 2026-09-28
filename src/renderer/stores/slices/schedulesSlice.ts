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

export interface SchedulesSlice {
  automations: Automation[];
  automationRuns: AutomationRun[];
  /** True once a daemon answered automation.list — gates the sidebar row. */
  schedulesAvailable: boolean;
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
  schedulesViewOpen: false,
  schedulesSelectedId: null,

  setAutomationSnapshot: (automations, runs) => set((state) => {
    state.automations = automations;
    state.automationRuns = runs;
    state.schedulesAvailable = true;
    if (state.schedulesSelectedId && !automations.some((a) => a.id === state.schedulesSelectedId)) {
      state.schedulesSelectedId = null;
    }
  }),

  applyAutomationPush: (push) => {
    if (push.kind === 'snapshot') {
      get().setAutomationSnapshot(push.automations, push.runs);
      return;
    }
    const ev = push.event;
    if (ev.type === 'run-changed') {
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
    try {
      const [list, runs] = await Promise.all([api.list(), api.runs()]);
      if (!list.available) {
        set((state) => { state.schedulesAvailable = false; });
        return;
      }
      get().setAutomationSnapshot(list.automations, runs.runs);
    } catch {
      // A stale preload or a torn-down window: keep what we have.
    }
  },

  openSchedulesView: (automationId) => set((state) => {
    state.schedulesViewOpen = true;
    if (automationId !== undefined) state.schedulesSelectedId = automationId;
  }),

  closeSchedulesView: () => set((state) => {
    state.schedulesViewOpen = false;
  }),

  toggleSchedulesView: () => set((state) => {
    state.schedulesViewOpen = !state.schedulesViewOpen;
  }),

  selectSchedule: (automationId) => set((state) => {
    state.schedulesSelectedId = automationId;
  }),
});
