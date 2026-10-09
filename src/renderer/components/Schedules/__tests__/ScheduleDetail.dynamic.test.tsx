// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import ScheduleDetail from '../ScheduleDetail';
import { automation, run } from './fixtures';

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
      .toContain("Bypass was not granted; this schedule's runs are skipped until you grant it again.");
  });
});
