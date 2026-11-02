// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import ScheduleDetail from '../ScheduleDetail';
import { automation, run } from './fixtures';
import { createLeafPane, createSurface, createWorkspace } from '../../../../shared/types';

let container: HTMLDivElement;
let root: Root;
const snapshot = vi.fn(async () => ({ text: 'status: someone@example.com' }));

beforeEach(() => {
  snapshot.mockClear();
  vi.stubGlobal('electronAPI', { automation: { snapshot } });
  useStore.setState({
    automations: [automation()],
    automationRuns: [run({ id: 'r1', state: 'completed', hasSnapshot: true, startedAt: 1, endedAt: 2 })],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ScheduleDetail output snapshot', () => {
  it('keeps a finished run\'s output collapsed until asked for', async () => {
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    expect(container.querySelector('[data-run-output]')).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('example.com');
    const toggle = container.querySelector<HTMLButtonElement>('[data-run-output-toggle]')!;
    expect(toggle.textContent).toBe('Show output');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(container.querySelector('[data-run-output]')!.textContent).toContain('example.com');
    expect(toggle.textContent).toBe('Hide output');
  });

  it('never offers a test run for an unreviewed draft', async () => {
    const draft = automation({ proposed: true, enabled: false });
    await act(async () => root.render(<ScheduleDetail automation={draft} accounts={[]} onEdit={vi.fn()} />));
    expect(container.querySelector('[data-schedule-test-run]')).toBeNull();
  });

  it('explains how to recover from a blocked first-run screen', async () => {
    useStore.setState({ automationRuns: [run({ id: 'r2', state: 'failed', reason: 'first_run_blocked' })] });
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    expect(container.querySelector('[data-run-first-run-hint]')!.textContent)
      .toBe('Open the folder once in a terminal and trust it in Claude, then run again.');
  });

  it('says a skip only waits on the previous run\'s open session (#2065)', async () => {
    useStore.setState({ automationRuns: [run({ id: 'r3', state: 'skipped', reason: 'overlap', detail: 'previous_session_open' })] });
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    expect(container.querySelector('[data-run-row="r3"]')!.textContent).toContain("previous run's session still open");
    expect(container.textContent).not.toContain('previous run still going');
    expect(container.querySelector('[data-run-session-open-hint]')!.textContent)
      .toBe('The previous run finished, but its session stays open for up to 10 minutes in case it asked something, so this run was skipped. It closes by itself; run again after that.');
  });

  it('a run held after a temporary provider error reads as waiting, and its final failure says it was retried', async () => {
    useStore.setState({ automationRuns: [
      run({ id: 'rw', state: 'running', ptyId: 'auto-rw', retryAt: Date.now() + 4 * 60_000 + 30_000 }),
      run({ id: 'rf', state: 'failed', reason: 'agent_error', detail: 'retried_once' }),
    ] });
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    const held = container.querySelector('[data-run-row="rw"]')?.textContent;
    expect(held).toContain('Waiting: retrying after a temporary provider error (in 5m)');
    expect(held).not.toContain('Failed');
    expect(container.querySelector('[data-run-row="rf"]')?.textContent).toContain('agent error again after one retry');
  });

  it('a plain overlap keeps its words and no session note', async () => {
    useStore.setState({ automationRuns: [run({ id: 'r4', state: 'skipped', reason: 'overlap' })] });
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    expect(container.querySelector('[data-run-row="r4"]')!.textContent).toContain('previous run still going');
    expect(container.querySelector('[data-run-session-open-hint]')).toBeNull();
  });

  it('Run now that the overlap rule skipped does not say it started (#2065)', async () => {
    const skipped = run({ id: 'r5', state: 'skipped', reason: 'overlap', detail: 'previous_session_open', trigger: 'manual' });
    const runNow = vi.fn(async () => ({ ok: true, run: skipped }));
    vi.stubGlobal('electronAPI', { automation: { snapshot, runNow, list: vi.fn(async () => ({ automations: [], available: true })), runs: vi.fn(async () => ({ runs: [] })) } });
    useStore.setState({ toasts: [] });
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-schedule-test-run]')!.click());
    expect(runNow).toHaveBeenCalledWith('a1', 'manual');
    const toasts = useStore.getState().toasts;
    expect(toasts.map((x) => x.message)).toContain("Not started: previous run's session still open.");
    expect(toasts.map((x) => x.message)).not.toContain('Run started.');
    expect(toasts.find((x) => x.message.startsWith('Not started'))?.level).toBe('warn');
  });

  it('Run now refused by a lingering session offers to end it, Cancel focused and doing nothing (#2065)', async () => {
    const skipped = run({ id: 'r7', state: 'skipped', reason: 'overlap', detail: 'previous_session_open', trigger: 'manual' });
    const lingeringSession = { runId: 'r-prev', ptyId: 'auto-r-prev', endedAt: Date.now() };
    const runNow = vi.fn(async () => ({ ok: true, run: skipped, lingeringSession }));
    vi.stubGlobal('electronAPI', { automation: { snapshot, runNow, list: vi.fn(async () => ({ automations: [], available: true })), runs: vi.fn(async () => ({ runs: [] })) } });
    useStore.setState({ toasts: [] });
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    expect(container.querySelector('[data-schedule-end-session]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-schedule-test-run]')!.click());
    const offer = container.querySelector('[data-schedule-end-session="r-prev"]')!;
    expect(offer.textContent).toContain('auto-r-prev');
    expect(offer.textContent).toContain('Not started');
    const cancel = container.querySelector<HTMLButtonElement>('[data-schedule-end-session-cancel]')!;
    expect(document.activeElement).toBe(cancel);
    expect(container.querySelector('[data-schedule-end-session-confirm]')!.textContent).toBe('End session and start');
    await act(async () => cancel.click());
    expect(container.querySelector('[data-schedule-end-session]')).toBeNull();
    expect(runNow).toHaveBeenCalledTimes(1);
  });

  it('confirming the offer asks to end that run\'s session and start (#2065)', async () => {
    const skipped = run({ id: 'r8', state: 'skipped', reason: 'overlap', detail: 'previous_session_open', trigger: 'manual' });
    const runNow = vi.fn()
      .mockResolvedValueOnce({ ok: true, run: skipped, lingeringSession: { runId: 'r-prev', ptyId: 'auto-r-prev', endedAt: Date.now() } })
      .mockResolvedValueOnce({ ok: true, run: run({ id: 'r9', state: 'launching', trigger: 'manual' }) });
    vi.stubGlobal('electronAPI', { automation: { snapshot, runNow, list: vi.fn(async () => ({ automations: [], available: true })), runs: vi.fn(async () => ({ runs: [] })) } });
    useStore.setState({ toasts: [] });
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-schedule-test-run]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-schedule-end-session-confirm]')!.click());
    expect(runNow).toHaveBeenLastCalledWith('a1', 'manual', 'r-prev');
    expect(container.querySelector('[data-schedule-end-session]')).toBeNull();
    expect(useStore.getState().toasts.map((x) => x.message)).toEqual(['Run started.']);
  });

  const offerShown = async (runNow: ReturnType<typeof vi.fn>) => {
    vi.stubGlobal('electronAPI', { automation: { snapshot, runNow, list: vi.fn(async () => ({ automations: [], available: true })), runs: vi.fn(async () => ({ runs: useStore.getState().automationRuns })) } });
    useStore.setState({ toasts: [] });
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-schedule-test-run]')!.click());
  };
  const skippedForSession = () => ({ ok: true, run: run({ id: 'r10', state: 'skipped', reason: 'overlap', detail: 'previous_session_open', trigger: 'manual' }), lingeringSession: { runId: 'r-prev', ptyId: 'auto-r-prev', endedAt: Date.now() } });

  it('the offer names when the previous run finished, and goes once its session ends or a pane shows it (#2065)', async () => {
    const finishedAt = new Date(2026, 9, 22, 9, 41).getTime();
    useStore.setState({ automationRuns: [run({ id: 'r-prev', state: 'completed', ptyId: 'auto-r-prev', startedAt: new Date(2026, 9, 22, 7, 5).getTime(), endedAt: finishedAt })] });
    await offerShown(vi.fn(async () => ({ ...skippedForSession(), lingeringSession: { runId: 'r-prev', ptyId: 'auto-r-prev', endedAt: finishedAt } })));
    const offer = container.querySelector('[data-schedule-end-session="r-prev"]')!;
    expect(offer.textContent).toContain('09:41');
    expect(offer.textContent).not.toContain('07:05');
    // The session ended on its own: the run's record drops its ptyId.
    await act(async () => useStore.setState({ automationRuns: [run({ id: 'r-prev', state: 'completed', endedAt: finishedAt })] }));
    expect(container.querySelector('[data-schedule-end-session]')).toBeNull();

    // Handed over: a pane now shows the session.
    useStore.setState({ automationRuns: [run({ id: 'r-prev', state: 'completed', ptyId: 'auto-r-prev', endedAt: finishedAt })] });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-schedule-test-run]')!.click());
    expect(container.querySelector('[data-schedule-end-session="r-prev"]')).not.toBeNull();
    const ws = createWorkspace('Nightly', 1);
    ws.rootPane = createLeafPane(createSurface('auto-r-prev', 'zsh', '/tmp'), 1);
    await act(async () => useStore.setState({ workspaces: [...useStore.getState().workspaces, ws] }));
    expect(container.querySelector('[data-schedule-end-session]')).toBeNull();
    await act(async () => useStore.setState({ workspaces: useStore.getState().workspaces.filter((w) => w.id !== ws.id) }));
  });

  it('Cancel is disabled while ending the session is in flight (#2065)', async () => {
    let release: (v: unknown) => void = () => undefined;
    const runNow = vi.fn()
      .mockResolvedValueOnce(skippedForSession())
      .mockReturnValueOnce(new Promise((r) => { release = r; }));
    await offerShown(runNow);
    const cancel = container.querySelector<HTMLButtonElement>('[data-schedule-end-session-cancel]')!;
    expect(cancel.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-schedule-end-session-confirm]')!.click());
    expect(cancel.disabled).toBe(true);
    await act(async () => release({ ok: true, run: run({ id: 'r11', state: 'launching', trigger: 'manual' }) }));
    expect(container.querySelector('[data-schedule-end-session]')).toBeNull();
  });

  it('Run now that launched still says it started', async () => {
    const runNow = vi.fn(async () => ({ ok: true, run: run({ id: 'r6', state: 'launching', trigger: 'manual' }) }));
    vi.stubGlobal('electronAPI', { automation: { snapshot, runNow, list: vi.fn(async () => ({ automations: [], available: true })), runs: vi.fn(async () => ({ runs: [] })) } });
    useStore.setState({ toasts: [] });
    await act(async () => root.render(<ScheduleDetail automation={automation()} accounts={[]} onEdit={vi.fn()} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-schedule-test-run]')!.click());
    expect(useStore.getState().toasts.map((x) => x.message)).toContain('Run started.');
  });

  it('says the runs stay skipped when Grant again is declined', async () => {
    const grant = vi.fn(async () => ({ ok: false, error: 'cancelled' }));
    vi.stubGlobal('electronAPI', { automation: { snapshot, grant, list: vi.fn(async () => ({ automations: [], available: false })), runs: vi.fn(async () => ({ runs: [] })) } });
    useStore.setState({ toasts: [] });
    const reset = automation({ permission: { mode: 'bypass', grantedRevision: 1 } });
    await act(async () => root.render(<ScheduleDetail automation={reset} accounts={[]} onEdit={vi.fn()} />));
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Grant again')!;
    await act(async () => button.click());
    expect(grant).toHaveBeenCalledWith('a1', 'bypass', undefined);
    expect(useStore.getState().toasts.map((x) => x.message))
      .toContain("Full access was not granted; this schedule's runs are skipped until you grant it again.");
  });
});
