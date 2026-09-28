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
    expect(row.querySelector('.ui-row-title .truncate')!.textContent).toBe('Smoke draft · Off · Weekdays 08:30');
    expect(row.textContent!.match(/Proposed/g)).toHaveLength(1);
    act(() => root.unmount());
    container.remove();
  });
});
