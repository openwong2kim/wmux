// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import SchedulesView from '../SchedulesView';

afterEach(() => vi.unstubAllGlobals());

describe('SchedulesView focus', () => {
  it('moves focus in on open and back to the opener on close', () => {
    vi.stubGlobal('electronAPI', {});
    useStore.setState({ automations: [], automationRuns: [], schedulesSelectedId: null });
    const opener = document.createElement('button');
    opener.setAttribute('data-sidebar-nav', 'schedules');
    document.body.appendChild(opener);
    opener.focus();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<SchedulesView />));
    expect(document.activeElement?.tagName).toBe('H2');
    act(() => root.unmount());
    expect(document.activeElement).toBe(opener);
    container.remove();
    opener.remove();
  });
});
