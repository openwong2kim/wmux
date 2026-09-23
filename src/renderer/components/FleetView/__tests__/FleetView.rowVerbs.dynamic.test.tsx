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
function branch(id: string, children: Pane[]): Pane {
  return { id, type: 'branch', direction: 'horizontal', children };
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
const dispose = vi.fn();

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
  write.mockClear(); setLabel.mockClear(); stashPane.mockClear(); unstashPane.mockClear(); closePane.mockClear(); dispose.mockClear();
  setLabel.mockImplementation(async () => ({ ok: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write, dispose },
    metadata: { setLabel },
  };
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      fleetActiveTab: 'fleet',
      workspaces: [
        // p1 has a sibling, so it is closable; ws-3's p3 is a workspace root.
        workspace('ws-1', 'alpha', branch('b1', [
          leaf('p1', [surface('s1', 'pty-1', { title: 'alpha task' })]),
          leaf('p1b', [surface('s1b', 'pty-1b', { title: 'alpha shell' })]),
        ]), 'p1'),
        workspace('ws-3', 'gamma', leaf('p3', [surface('s3', 'pty-3', { title: 'gamma task' })]), 'p3'),
        workspace('ws-4', 'delta', branch('b4', [
          leaf('p4', [surface('s4', 'pty-4', { title: 'delta task' })]),
          leaf('p4b', [surface('s4b', 'pty-4b', { title: 'delta shell' })]),
        ]), 'p4'),
        workspace('ws-2', 'beta', leaf('p2', [surface('s2', 'pty-2', { title: 'beta task' })]), 'p2'),
        workspace('ws-r', 'remote proj', leaf('pr', [surface('rs-1', '', {
          surfaceType: 'remote-terminal', remoteHostId: 'host-1', remoteSessionId: 'rsession-9',
        })]), 'pr'),
      ],
      surfaceAgentStatus: { 'pty-1': 'complete', 'pty-3': 'complete', 'pty-4': 'awaiting_input' },
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

  it('a failed setLabel surfaces an error toast', async () => {
    setLabel.mockImplementation(async () => { throw new Error('ipc down'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mount();
    await flushRaf();
    act(() => row('pty-1').focus());
    key(row('pty-1'), 'l');
    const input = container.querySelector<HTMLInputElement>('[data-fleet-editor="label"] input')!;
    type(input, 'x');
    key(input, 'Enter');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(useStore.getState().toasts.some((toast) => toast.level === 'error' && toast.message === 'Could not save the pane label')).toBe(true);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
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
    // The pane's pty is disposed first, like every other close path.
    expect(dispose).toHaveBeenCalledWith('pty-1');
    expect(dispose).not.toHaveBeenCalledWith('pty-1b');
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(closePane.mock.invocationCallOrder[0]);
  });

  it('a workspace root pane cannot be closed from Fleet: disabled with a reason, no confirm', async () => {
    mount();
    await flushRaf();
    const items = openMenu('pty-3');
    const close = items.find((el) => el.dataset.paneMenuAction === 'close')!;
    expect(close.getAttribute('aria-disabled')).toBe('true');
    expect(close.getAttribute('title')).toContain('Close the workspace instead');
    act(() => { close.click(); });
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    act(() => row('pty-3').focus());
    key(row('pty-3'), 'Backspace');
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
    expect(closePane).not.toHaveBeenCalled();
  });

  it('awaiting_input with no question is a permission prompt: Message is disabled', async () => {
    mount();
    await flushRaf();
    const message = openMenu('pty-4').find((el) => el.dataset.paneMenuAction === 'message')!;
    expect(message.getAttribute('aria-disabled')).toBe('true');
    expect(message.getAttribute('title')).toBe('Answer the permission prompt in the terminal');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    act(() => row('pty-4').focus());
    key(row('pty-4'), 'm');
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
  });

  it('awaiting_input WITH a question can be messaged', async () => {
    act(() => { useStore.setState({ surfacePendingQuestion: { 'pty-4': 'Which branch?' } }); });
    mount();
    await flushRaf();
    act(() => row('pty-4').focus());
    key(row('pty-4'), 'm');
    expect(container.querySelector('[data-fleet-editor="message"]')).not.toBeNull();
  });

  it('Message is disabled while hook activity is fresh, or while a plain shell runs a command', async () => {
    act(() => { useStore.setState({ surfaceActivityAt: { 'pty-1': Date.now() }, agentClockMs: Date.now() }); });
    mount();
    await flushRaf();
    act(() => row('pty-1').focus());
    key(row('pty-1'), 'm');
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
    act(() => { useStore.setState({ surfaceActivityAt: {}, commandRunningByPtyId: { 'pty-1': true } }); });
    await flushRaf();
    act(() => row('pty-1').focus());
    key(row('pty-1'), 'm');
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
    const message = openMenu('pty-1').find((el) => el.dataset.paneMenuAction === 'message')!;
    expect(message.getAttribute('title')).toBe('Available once the turn finishes');
  });

  it('drops an open editor when its row leaves the visible list', async () => {
    mount();
    await flushRaf();
    act(() => row('pty-1').focus());
    key(row('pty-1'), 'l');
    expect(container.querySelector('[data-fleet-editor="label"]')).not.toBeNull();
    // pty-1 finishes being "complete" and drops into the collapsed Idle row.
    act(() => { useStore.setState({ surfaceAgentStatus: { 'pty-3': 'complete', 'pty-4': 'awaiting_input' } }); });
    await flushRaf();
    expect(row('pty-1')).toBeNull();
    expect(container.querySelector('[data-fleet-editor]')).toBeNull();
  });

  it('a background tab awaiting input: the row shows its question and Message writes to that tab', async () => {
    act(() => {
      useStore.setState({
        workspaces: [workspace('ws-5', 'tabs', branch('b5', [
          { id: 'p5', type: 'leaf', activeSurfaceId: 's5a', surfaces: [
            surface('s5a', 'pty-5a', { title: 'front tab' }),
            surface('s5b', 'pty-5b', { title: 'back tab' }),
          ] },
          leaf('p5x', [surface('s5x', 'pty-5x')]),
        ]), 'p5')],
        surfaceAgentStatus: {},
        surfacePendingQuestion: { 'pty-5b': 'Which region?' },
      });
    });
    mount();
    await flushRaf();
    const r = row('pty-5a');
    expect(r.dataset.status).toBe('awaiting_input');
    expect(r.querySelector('.wmux-fleet-detail')?.textContent).toBe('Which region?');
    act(() => r.focus());
    key(r, 'm');
    const input = container.querySelector<HTMLInputElement>('[data-fleet-editor="message"] input')!;
    type(input, 'eu-west-1');
    key(input, 'Enter');
    expect(write).toHaveBeenCalledWith('pty-5b', expect.stringContaining('eu-west-1'));
    expect(write).not.toHaveBeenCalledWith('pty-5a', expect.anything());
  });

  it('jumping to that row activates the background tab that needs you', async () => {
    act(() => {
      useStore.setState({
        workspaces: [workspace('ws-5', 'tabs', branch('b5', [
          { id: 'p5', type: 'leaf', activeSurfaceId: 's5a', surfaces: [
            surface('s5a', 'pty-5a', { title: 'front tab' }),
            surface('s5b', 'pty-5b', { title: 'back tab' }),
          ] },
          leaf('p5x', [surface('s5x', 'pty-5x')]),
        ]), 'p5')],
        activeWorkspaceId: 'ws-5',
        surfaceAgentStatus: {},
        surfacePendingQuestion: { 'pty-5b': 'Which region?' },
      });
    });
    mount();
    await flushRaf();
    act(() => { row('pty-5a').click(); });
    const leafP5 = (useStore.getState().workspaces[0].rootPane as { children: Pane[] }).children[0] as Pane & { activeSurfaceId: string };
    expect(leafP5.activeSurfaceId).toBe('s5b');
  });

  it('re-checks at submit: a pane that started a turn while the composer was open is not messaged', async () => {
    mount();
    await flushRaf();
    act(() => row('pty-1').focus());
    key(row('pty-1'), 'm');
    const input = container.querySelector<HTMLInputElement>('[data-fleet-editor="message"] input')!;
    type(input, 'late message');
    act(() => { useStore.setState({ surfaceTurnOpenAt: { 'pty-1': Date.now() } }); });
    key(input, 'Enter');
    // Scoped to pty-1: an earlier test's delayed Enter (submitBracketedPasteToPty
    // sends '\r' on a timer) can land on its own pty while this test runs.
    expect(write.mock.calls.filter(([pty]) => pty === 'pty-1')).toEqual([]);
    // …and the refused text went nowhere else either.
    expect(write.mock.calls.some(([, data]) => String(data).includes('late message'))).toBe(false);
    expect(useStore.getState().toasts.some((toast) => toast.message.startsWith('Not sent'))).toBe(true);
  });

  it('Escape with the ⋮ menu open closes only the menu', async () => {
    mount();
    await flushRaf();
    act(() => { useStore.setState({ fleetViewVisible: true }); });
    const items = openMenu('pty-1');
    act(() => items[0].focus());
    key(items[0], 'Escape');
    expect(document.body.querySelector('[data-pane-actions-menu]')).toBeNull();
    expect(useStore.getState().fleetViewVisible).toBe(true);
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
