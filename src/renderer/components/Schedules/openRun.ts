import { useStore } from '../../stores';
import { createSurface, createWorkspace, createLeafPane } from '../../../shared/types';
import { activateLocalWorkspace } from '../../stores/slices/workspaceSlice';
import { applyAppRoute } from '../../stores/slices/uiSlice';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import { publishPaneCreated } from '../../events/publisher';
import { saveSessionNow } from '../../utils/sessionSaveBridge';
import { isLiveRun } from '../../stores/selectors/schedules';
import { t } from '../../i18n';

export type OpenRunOutcome = 'focused' | 'adopted' | 'gone' | 'details';

/**
 * Open a scheduled run's terminal. A run's session is born detached in the
 * daemon; the first open binds it to a pane in a NEW workspace named after
 * the schedule (a variant of adoptOrphanSession: the surface carries the
 * session id from birth, so useTerminal's reconnect path attaches instead of
 * spawning). A session some pane already shows is focused, never bound twice
 * — closing either surface would kill it under the other.
 *
 * A finished run, or one whose session is gone, opens its details instead.
 */
export async function openAutomationRun(runId: string, automationId?: string): Promise<OpenRunOutcome> {
  // A toast click can outrun the renderer's copy (fresh launch, reload):
  // pull once before deciding the run is unknown.
  if (!useStore.getState().automationRuns.some((r) => r.id === runId)) {
    await useStore.getState().refreshSchedules();
  }
  const st = useStore.getState();
  const run = st.automationRuns.find((r) => r.id === runId);
  const showDetails = (): OpenRunOutcome => {
    const target = run?.automationId ?? automationId;
    if (target) useStore.getState().openSchedulesView(target);
    return 'details';
  };
  if (!run || !run.ptyId || !isLiveRun(run)) return showDetails();
  const ptyId = run.ptyId;

  if (focusNotificationTarget(() => useStore.getState(), { ptyId })) {
    useStore.getState().closeSchedulesView();
    return 'focused';
  }

  // Fresh daemon truth, not the run record: the session may have ended since.
  let entry: { id: string; shell: string; cwd?: string } | undefined;
  try {
    const sessions = await window.electronAPI?.pty?.list?.();
    entry = sessions?.find((s) => s.id === ptyId);
  } catch {
    entry = undefined;
  }
  if (!entry) {
    useStore.getState().pushToast({ level: 'info', message: t('schedules.sessionGone') });
    showDetails();
    return 'gone';
  }
  // A pane may have claimed it while pty.list was in flight.
  if (focusNotificationTarget(() => useStore.getState(), { ptyId })) {
    useStore.getState().closeSchedulesView();
    return 'focused';
  }

  const automation = st.automations.find((a) => a.id === run.automationId);
  const name = automation?.name || t('schedules.title');
  const cwd = entry.cwd ?? automation?.action.cwd ?? '';
  const shell = entry.shell;
  let created: { wsId: string; paneId: string } | null = null;
  useStore.setState((state) => {
    // One producer: an empty root leaf committed on its own would let the
    // empty-leaf funnel spawn a shell before the bound surface lands.
    const ordinal = state.nextWorkspaceOrdinal ?? 1;
    const ws = createWorkspace(name, ordinal);
    const surface = { ...createSurface(ptyId, shell, cwd), title: name };
    const leaf = createLeafPane(surface, 1);
    ws.rootPane = leaf;
    ws.activePaneId = leaf.id;
    ws.nextPaneOrdinal = 2;
    state.nextWorkspaceOrdinal = ordinal + 1;
    state.workspaces.push(ws);
    if (state.sidebarNewAt) state.sidebarNewAt[ws.id] = Date.now();
    activateLocalWorkspace(state, ws.id);
    applyAppRoute(state, 'workspaces');
    created = { wsId: ws.id, paneId: leaf.id };
  });
  const done = created as { wsId: string; paneId: string } | null;
  if (done) {
    publishPaneCreated(done.wsId, done.paneId);
    saveSessionNow();
  }
  return 'adopted';
}
