// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import SchedulesView from '../SchedulesView';
import { automation } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('SchedulesView rows', () => {
  it('shows a draft as Proposed once — in the badge, not the title', () => {
    vi.stubGlobal('electronAPI', {});
    useStore.setState({
      automations: [automation({ name: 'Smoke draft', proposed: true, enabled: false })],
      automationRuns: [],
      schedulesSelectedId: null,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<SchedulesView />));
    const row = container.querySelector('[data-schedule-row="a1"]')!;
    expect(row.querySelector('.wmux-schedules-row-name .truncate')!.textContent).toBe('Smoke draft');
    expect(row.querySelector('.wmux-schedules-row-meta')!.textContent).toBe('Off · Weekdays 08:30');
    expect(row.querySelector('[data-off="true"]')).not.toBeNull();
    expect(row.textContent!.match(/Proposed/g)).toHaveLength(1);
    act(() => root.unmount());
    container.remove();
  });

  it('starts a composer pre-filled from a template on the empty page', () => {
    vi.stubGlobal('electronAPI', {});
    useStore.setState({ automations: [], automationRuns: [], schedulesSelectedId: null });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<SchedulesView />));
    const empty = container.querySelector('[data-schedules-empty]')!;
    expect(empty.textContent).toContain('Schedule a task');
    expect(empty.querySelectorAll('[data-schedule-template]')).toHaveLength(6);
    act(() => container.querySelector<HTMLButtonElement>('[data-schedule-template="depAudit"]')!.click());
    expect(container.querySelector('[data-schedules-empty]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-schedule-name]')!.value).toBe('Dependency audit');
    expect(container.querySelector<HTMLTextAreaElement>('[data-schedule-prompt]')!.value).toContain('dependencies');
    const chip = container.querySelector('[data-schedule-chip-schedule]')!.textContent!;
    expect(chip).toContain('Weekly');
    expect(chip).toContain('10:00');
    act(() => root.unmount());
    container.remove();
  });
});
