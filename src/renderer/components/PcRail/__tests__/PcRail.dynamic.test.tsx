// @vitest-environment jsdom
// The computer column: absent with no paired host; this computer first, then
// each host as a monogram; the selected computer shows no badge; offline and
// not-yet-checked hosts are muted; arrows rove; Shift+F10 opens a host's menu
// (Mute, Remote page, Pair again, access line); the global chord cycles.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import PcRail from '../PcRail';
import { LOCAL_PC_ID } from '../../../../shared/pcRail';
import type { PcRailWorkspaceRow } from '../../../../shared/pcRail';

let container: HTMLDivElement;
let root: Root;

function seed(): void {
  useStore.setState({
    pcRail: { activePcId: LOCAL_PC_ID, lastWorkspaceByPc: {}, mutedPcs: [] },
    pcRailHosts: [
      { id: 'h1', label: 'office-mac', allowInput: false },
      { id: 'h2', label: 'studio' },
    ],
    pcRailHostsLoaded: true,
    pcRailHostStatus: { h1: 'reachable', h2: 'reachable' },
    pcRailFeeds: {
      h1: {
        workspaces: [{ id: 'w1', name: 'api', panes: [{ sessionId: 's1', agentName: 'claude', agentStatus: 'awaiting_input' }] } as unknown as PcRailWorkspaceRow],
        fetchedAt: 1_000,
        failedTicks: 0,
      },
    },
    pcRailPending: {},
    pcRailCompleteSeenAt: {},
    pcRailHostSeen: {},
    sidebarPosition: 'left',
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  seed();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useStore.setState({ pcRailHosts: [], pcRailFeeds: {}, pcRailHostStatus: {} });
});

const icon = (id: string) => container.querySelector<HTMLButtonElement>(`[data-pc-id="${id}"]`)!;

describe('PcRail', () => {
  it('is not drawn while no computer is paired', async () => {
    useStore.setState({ pcRailHosts: [] });
    await act(async () => root.render(<PcRail />));
    expect(container.querySelector('[data-pc-rail]')).toBeNull();
  });

  it('lists this computer first, then monograms, with muted unchecked hosts', async () => {
    await act(async () => root.render(<PcRail />));
    const ids = [...container.querySelectorAll('[data-pc-id]')].map((el) => el.getAttribute('data-pc-id'));
    expect(ids).toEqual([LOCAL_PC_ID, 'h1', 'h2']);
    expect(icon('h1').textContent).toContain('OM');
    expect(icon('h1').getAttribute('data-pc-state')).toBe('online');
    // h2 has no list yet: never drawn online.
    expect(icon('h2').getAttribute('data-pc-state')).toBe('unchecked');
    expect(icon(LOCAL_PC_ID).getAttribute('aria-current')).toBe('true');
    expect(icon(LOCAL_PC_ID).tabIndex).toBe(0);
    expect(icon('h1').tabIndex).toBe(-1);
  });

  it('badges a host and keeps the badge when it is selected, until its rows are shown', async () => {
    await act(async () => root.render(<PcRail />));
    expect(icon('h1').querySelector('[data-pc-badge="needs-you"]')?.textContent).toBe('1');
    await act(async () => icon('h1').click());
    expect(useStore.getState().pcRail.activePcId).toBe('h1');
    expect(icon('h1').getAttribute('aria-current')).toBe('true');
    // Nothing lists h1's rows yet, so the badge is the only rendition.
    expect(icon('h1').querySelector('[data-pc-badge="needs-you"]')).not.toBeNull();
  });

  it('roves with arrows and opens the host menu on Shift+F10', async () => {
    await act(async () => root.render(<PcRail />));
    icon(LOCAL_PC_ID).focus();
    await act(async () => {
      icon(LOCAL_PC_ID).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(icon('h1'));
    await act(async () => {
      icon('h1').dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    });
    const actions = [...document.querySelectorAll('[data-pane-menu-action]')].map((el) => el.getAttribute('data-pane-menu-action'));
    expect(actions).toEqual(['mute', 'remote-page', 'pair-again']);
    const access = document.querySelector('[data-pc-access]')?.textContent ?? '';
    expect(access).toContain('View only');
    // The credential kind is unknown: both revoke paths, neither promised.
    expect(access).toContain('Paired devices');
    expect(access).toContain('--new-token');
    await act(async () => (document.querySelector('[data-pane-menu-action="mute"]') as HTMLButtonElement).click());
    expect(useStore.getState().pcRail.mutedPcs).toEqual(['h1']);
  });

  it('marks an offline host and a host that needs repair', async () => {
    useStore.setState({ pcRailHostStatus: { h1: 'unreachable', h2: 'needs-repair' } });
    await act(async () => root.render(<PcRail />));
    expect(icon('h1').getAttribute('data-pc-state')).toBe('offline');
    expect(icon('h1').title).toMatch(/last seen/);
    expect(icon('h2').querySelector('[data-pc-repair]')).not.toBeNull();
  });
});

describe('keyboard', () => {
  it('cycles computers on Shift+Alt+ArrowDown only while the column is shown', async () => {
    vi.resetModules();
    // Exercised through the pure pieces useKeyboard composes.
    const { pcShortcutAction, pcShortcutTarget } = await import('../pcRailModel');
    const { comboFromEvent } = await import('../../../../shared/keymap');
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true, altKey: true });
    const action = pcShortcutAction(comboFromEvent(e));
    expect(action).toBe('nextPc');
    expect(pcShortcutTarget(action!, ['h1', 'h2'], LOCAL_PC_ID)).toBe('h1');
  });
});
