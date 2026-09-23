// @vitest-environment jsdom
//
// Fleet row verbs: each verb reaches the right store action / electronAPI call,
// keyboard shortcuts never fire while typing, remote rows expose Jump only and a
// running row cannot be messaged.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface } from '../../../../shared/types';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal', ...extra };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
function workspace(id: string, name: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name, rootPane, activePaneId };
}

let container: HTMLDivElement;
let root: Root;
const write = vi.fn();
const setLabel = vi.fn(async () => ({ ok: true }));
const stashPane = vi.fn(() => true);
const unstashPane = vi.fn(() => true);
const closePane = vi.fn();

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(React.createElement(FleetView)); });
}

async function flushRaf(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function row(ptyId: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-fleet-card][data-pty-id="${ptyId}"]`)!;
}

function key(element: Element, name: string): void {
  act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); });
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function openMenu(ptyId: string): HTMLElement[] {
  const trigger = row(ptyId).parentElement!.querySelector<HTMLButtonElement>('[data-fleet-row-trigger]')!;
  act(() => { trigger.click(); });
  return Array.from(document.body.querySelectorAll<HTMLElement>('[data-pane-menu-action]'));
}

beforeEach(() => {
  vi.useRealTimers();
  write.mockClear(); setLabel.mockClear(); stashPane.mockClear(); unstashPane.mockClear(); closePane.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write },
    metadata: { setLabel },
  };
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      fleetActiveTab: 'fleet',
      workspaces: [
        workspace('ws-1', 'alpha', leaf('p1', [surface('s1', 'pty-1', { title: 'alpha task' })]), 'p1'),
        workspace('ws-2', 'beta', leaf('p2', [surface('s2', 'pty-2', { title: 'beta task' })]), 'p2'),
        workspace('ws-r', 'remote proj', leaf('pr', [surface('rs-1', '', {
          surfaceType: 'remote-terminal', remoteHostId: 'host-1', remoteSessionId: 'rsession-9',
        })]), 'pr'),
      ],
      surfaceAgentStatus: { 'pty-1': 'complete' },
      surfaceAgent: { 'pty-2': { name: 'Claude Code', status: 'running' } },
      surfaceTurnOpenAt: { 'pty-2': Date.now() },
      agentClockMs: Date.now(),
      paneLabel: { p1: 'old label' },
      remoteWorkspaces: [{
        key: 'host-1:rw-1', hostId: 'host-1', hostLabel: 'office-mac', workspaceId: 'rw-1', name: 'proj',
        panes: [{ sessionId: 'rsession-9', shell: 'zsh', agentName: 'Codex', agentStatus: 'error' }],
      }] as unknown as ReturnType<typeof useStore.getState>['remoteWorkspaces'],
      stashPane,
      unstashPane,
      closePane,
    });
  });
});

afterEach(() => {
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
  document.body.innerHTML = '';
});

describe('FleetView — row verbs', () => {
  it('the ⋮ menu offers every verb on a local row, and Stash dispatches stashPane', async () => {
    mount();
    await flushRaf();
    const items = openMenu('pty-1');
    expect(items.map((el) => el.dataset.paneMenuAction)).toEqual(['jump', 'message', 'stash', 'label', 'close']);
    act(() => { items[2].click(); });
    expect(stashPane).toHaveBeenCalledWith('p1', 'ws-1');
  });

  it('a remote row shows Jump only, and the verb keys do nothing on it', async () => {
    mount();
    await flushRaf();
    const remote = container.querySelector<HTMLButtonElement>('[data-fleet-card][data-status="error"]:not([data-pty-id="pty-1"])')!;
    expect(remote.querySelector('[data-fleet-remote]')).not.toBeNull();
    const trigger = remote.parentElement!.querySelector<HTMLButtonElement>('[data-fleet-row-trigger]')!;
    act(() => { trigger.click(); });
    expect(Array.from(document.body.querySelectorAll<HTMLElement>('[data-pane-menu-action]')).map((el) => el.dataset.paneMenuAction))
      .toEqual(['jump']);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    act(() => remote.focus());
    key(remote, 's');
    key(remote, 'Backspace');
    expect(stashPane).not.toHaveBeenCalled();
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
  });

  it('a running row has Message disabled, in the menu and on the m key', async () => {
    mount();
    await flushRaf();
    const items = openMenu('pty-2');
    const message = items.find((el) => el.dataset.paneMenuAction === 'message')!;
    expect(message.getAttribute('aria-disabled')).toBe('true');
    act(() => { message.click(); });
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    act(() => row('pty-2').focus());
    key(row('pty-2'), 'm');
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
  });

  it('m opens the inline composer; Enter sends a bracketed paste to the pty', async () => {
    mount();
    await flushRaf();
    act(() => row('pty-1').focus());
    key(row('pty-1'), 'm');
    const input = container.querySelector<HTMLInputElement>('[data-fleet-editor="message"] input')!;
    expect(document.activeElement).toBe(input);
    type(input, 'run the tests');
    key(input, 'Enter');
    expect(write).toHaveBeenCalledWith('pty-1', expect.stringContaining('run the tests'));
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
  });

  it('l opens the label input prefilled; Enter calls metadata.setLabel', async () => {
    mount();
    await flushRaf();
    act(() => row('pty-1').focus());
    key(row('pty-1'), 'l');
    const input = container.querySelector<HTMLInputElement>('[data-fleet-editor="label"] input')!;
    expect(input.value).toBe('old label');
    type(input, ' release notes ');
    key(input, 'Enter');
    expect(setLabel).toHaveBeenCalledWith('p1', 'ws-1', 'release notes');
  });

  it('Backspace asks first: Cancel is focused by default, confirm calls closePane', async () => {
    mount();
    await flushRaf();
    act(() => row('pty-1').focus());
    key(row('pty-1'), 'Backspace');
    const cancel = container.querySelector<HTMLButtonElement>('[data-fleet-close-cancel]')!;
    expect(document.activeElement).toBe(cancel);
    act(() => { cancel.click(); });
    expect(closePane).not.toHaveBeenCalled();
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();

    act(() => row('pty-1').focus());
    key(row('pty-1'), 'Backspace');
    act(() => { container.querySelector<HTMLButtonElement>('[data-fleet-close-confirm]')!.click(); });
    expect(closePane).toHaveBeenCalledWith('p1', 'ws-1');
  });

  it('s and Backspace are ignored while typing in an input', async () => {
    mount();
    await flushRaf();
    const search = container.querySelector<HTMLInputElement>('input[type=search]')!;
    act(() => search.focus());
    key(search, 's');
    key(search, 'Backspace');
    act(() => row('pty-1').focus());
    key(row('pty-1'), 'm');
    const composer = container.querySelector<HTMLInputElement>('[data-fleet-editor="message"] input')!;
    key(composer, 's');
    key(composer, 'Backspace');
    expect(stashPane).not.toHaveBeenCalled();
    expect(container.querySelector('[data-fleet-editor="close"]')).toBeNull();
    expect(container.querySelector('[data-fleet-editor="message"]')).not.toBeNull();
  });

  it('Escape closes an open editor instead of the overlay', async () => {
    mount();
    await flushRaf();
    act(() => row('pty-1').focus());
    key(row('pty-1'), 'l');
    const input = container.querySelector<HTMLInputElement>('[data-fleet-editor="label"] input')!;
    act(() => { useStore.setState({ fleetViewVisible: true }); });
    key(input, 'Escape');
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
    expect(useStore.getState().fleetViewVisible).toBe(true);
    await flushRaf();
    expect(document.activeElement).toBe(row('pty-1'));
  });
});
