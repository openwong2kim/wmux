// @vitest-environment jsdom
//
// The real CommanderView send path: main's deck:send resolves only when the
// whole turn ends, but every refusal comes back at once. The composer must
// hear a refusal (and keep its draft) and must not wait for the turn.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommanderView } from '../CommanderView';
import { useStore } from '../../../stores';
import type { Pane, Workspace } from '../../../../shared/types';

vi.mock('../BrainTerminalEmbed', () => ({ __esModule: true, default: () => null }));
vi.mock('../DeckDecisionCard', () => ({ DeckDecisionCard: () => null }));
vi.mock('../DeckLedgerPanel', () => ({ DeckLedgerPanel: () => null }));

function ws(id: string): Workspace {
  const rootPane: Pane = { id: `${id}-p`, type: 'leaf', activeSurfaceId: '', surfaces: [] };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}

let container: HTMLDivElement;
let root: Root;
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  send = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = { deck: { send } };
  useStore.setState({ workspaces: [ws('ws-a')], activeWorkspaceId: 'ws-a' } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(CommanderView, { chatWorkspaceId: 'ws-a', viewedWorkspaceId: 'ws-a' })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function input(): HTMLTextAreaElement {
  return container.querySelector('[data-channel-composer-input]') as HTMLTextAreaElement;
}

async function type(text: string): Promise<void> {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

describe('CommanderView — the send verdict', () => {
  it('a refusal keeps the draft', async () => {
    send.mockResolvedValue({ ok: false, code: 'busy' });
    await type('check the release');
    await submit();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-a', text: 'check the release' });
    expect(input().value).toBe('check the release');
  });

  it('a turn still running counts as accepted after the grace period, and the draft clears', async () => {
    send.mockReturnValue(new Promise(() => undefined)); // the turn never ends here
    await type('check the release');
    await submit();
    expect(input().value).toBe('check the release');
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(input().value).toBe('');
  });
});
