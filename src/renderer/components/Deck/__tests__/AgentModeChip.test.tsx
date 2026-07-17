// @vitest-environment jsdom
//
// AgentModeChip: reads the current mode on mount, renders it as a chip, and
// sets a new mode from the dropdown (optimistic + echo). Injected fake api so
// no preload/IPC is needed.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { AgentModeChip, type AgentModeApi } from '../AgentModeChip';
import type { AgentMode } from '../../../../main/deck/deckAutonomyStore';

const t = (k: string) => k; // identity — assert on keys

function render(ui: React.ReactElement): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    cleanup: () => { act(() => root.unmount()); container.remove(); },
  };
}

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fakeApi(initial: AgentMode): { api: AgentModeApi; sets: AgentMode[] } {
  const sets: AgentMode[] = [];
  return {
    sets,
    api: {
      get: async () => ({ mode: initial }),
      set: async (_ws, mode) => { sets.push(mode); return { ok: true, mode }; },
    },
  };
}

describe('AgentModeChip', () => {
  it('renders the current mode label after the initial read', async () => {
    const { api } = fakeApi('auto');
    const { container, cleanup } = render(<AgentModeChip api={api} workspaceId="ws-1" t={t} />);
    cleanups.push(cleanup);
    await flush();
    const chip = container.querySelector('[data-agent-mode-chip] button')!;
    expect(chip.textContent).toContain('deck.mode.auto');
  });

  it('opens the dropdown and sets a new mode (optimistic + persisted)', async () => {
    const { api, sets } = fakeApi('assist');
    const { container, cleanup } = render(<AgentModeChip api={api} workspaceId="ws-1" t={t} />);
    cleanups.push(cleanup);
    await flush();

    // open
    const chip = container.querySelector('[data-agent-mode-chip] > button') as HTMLButtonElement;
    act(() => chip.click());
    // pick 'off'
    const off = container.querySelector('[data-mode-option="off"]') as HTMLButtonElement;
    expect(off).toBeTruthy();
    await act(async () => { off.click(); await Promise.resolve(); });

    expect(sets).toEqual(['off']);
    // chip reflects the new mode; dropdown closed
    expect((container.querySelector('[data-agent-mode-chip] > button')!).textContent).toContain('deck.mode.off');
    expect(container.querySelector('[data-mode-option="off"]')).toBeNull();
  });

  it('renders nothing until the first read resolves (no label flash)', () => {
    const api: AgentModeApi = { get: () => new Promise(() => {}), set: async () => ({ ok: true }) };
    const { container, cleanup } = render(<AgentModeChip api={api} workspaceId="ws-1" t={t} />);
    cleanups.push(cleanup);
    expect(container.querySelector('[data-agent-mode-chip]')).toBeNull();
  });
});
