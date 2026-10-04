// @vitest-environment jsdom
//
// The right panel is always Moa: mounted through the real dock and store, the
// conversation stays pinned to the HQ while the active workspace changes, Moa
// off is one card, an install without an HQ keeps today's per-workspace chat,
// and the Diff panel's "ask" relay reaches Moa's brain.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ChannelDock from '../../../Channels/ChannelDock';
import { useStore } from '../../../../stores';
import type { MoaState } from '../../../../../shared/moa';
import type { Pane, Workspace } from '../../../../../shared/types';

// The embed attaches a real xterm to a daemon session; the layout is what is
// under test, so it is stubbed down to the element the panel places.
vi.mock('../../../Deck/BrainTerminalEmbed', () => ({
  __esModule: true,
  default: ({ ptyId }: { ptyId: string }) => createElement('div', { 'data-commander-brain-terminal': true, 'data-pty-id': ptyId }),
}));

let root: Root;
let host: HTMLDivElement;

const ws = (id: string): Workspace => ({
  id,
  name: `Name ${id}`,
  rootPane: { id: `${id}-p`, type: 'leaf', surfaces: [], activeSurfaceId: '' } as unknown as Pane,
  activePaneId: `${id}-p`,
});

const moa = (over: Partial<MoaState['hq']> & { enabled?: boolean } = {}): MoaState => ({
  config: { enabled: over.enabled ?? true, onboarded: true, level: 1, maxTurnsPerHour: 20, bubbles: true, reduceMotion: false, defaultReason: null },
  hq: { workspaceId: over.workspaceId === undefined ? 'ws-hq' : over.workspaceId, state: over.state ?? 'ok' },
  archive: { unacked: 0, total: 0 },
});

const cursor = { headOffset: 0, tailOffset: 10, fileSize: 10, mtimeMs: 1 };

function installApi() {
  const send = vi.fn(async () => ({ ok: true }));
  const resolve = vi.fn(async () => ({ ok: true }));
  const api = {
    deck: {
      send,
      wake: vi.fn(async () => ({ ok: true })),
      interrupt: vi.fn(async () => ({ ok: true })),
      decision: { resolve },
      moa: {
        decisions: vi.fn(async () => ({
          decisions: [{ workspaceId: 'ws-b', workspaceName: 'Bravo', decision: { id: 'd1', question: 'Merge now?', options: ['Merge'], context: '', raisedAt: 1 } }],
        })),
        onChanged: vi.fn(() => () => undefined),
        transcript: {
          status: vi.fn(async () => ({ available: true, reason: 'ok', agentSessionId: 's1' })),
          snapshot: vi.fn(async () => ({ events: [{ id: 'a1', kind: 'assistant_text', text: 'Moa here.', ts: 1, turnComplete: true }], cursor, hasMore: false, truncatedHead: false })),
          subscribe: vi.fn(async () => ({ available: true, reason: 'ok' })),
          unsubscribe: vi.fn(async () => undefined),
          onAppend: vi.fn(() => () => undefined),
        },
      },
    },
    workLinks: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => undefined) },
  };
  vi.stubGlobal('electronAPI', api);
  return { send, resolve };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useStore.setState({
    workspaces: [ws('ws-a'), ws('ws-b'), ws('ws-hq')],
    activeWorkspaceId: 'ws-a',
    activeDeckTab: 'commander',
    channelsTabVisible: false,
    brainPtyIds: { 'ws-hq': 'pty-hq', 'ws-a': 'pty-a', 'ws-b': 'pty-b' },
    brainThreads: {},
    pendingBrainPrompt: null,
    settingsInitialTab: null,
    moa: moa(),
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(ChannelDock)));
  // The chat is lazy: let its chunk and the first snapshot land.
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const terminalPty = () => [...host.querySelectorAll('[data-commander-brain-terminal]')].map((el) => el.getAttribute('data-pty-id'));

describe('right panel — Moa running', () => {
  it('pins the conversation to the HQ while the active workspace changes', async () => {
    const { send } = installApi();
    await render();
    const tab = host.querySelector('[data-deck-tab="commander"]')!;
    expect(tab.querySelector('.wmux-deck-tab-label')?.textContent).toBe('Moa');
    expect(tab.querySelector('[data-moa-mascot="needs-you"]')).not.toBeNull();
    // Bubbles over the HQ brain, not its terminal (the chat chunk is lazy).
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      expect(host.textContent).toContain('Moa here.');
    }, { timeout: 5000 });
    expect(terminalPty()).toEqual([]);

    const textarea = host.querySelector('[data-moa-chat] textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Status?');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-hq', text: 'Status?' }));

    // View as terminal: exactly one embed, of the HQ brain …
    await act(async () => { (host.querySelector('[data-moa-terminal-toggle]') as HTMLButtonElement).click(); });
    expect(terminalPty()).toEqual(['pty-hq']);
    // … and it stays the HQ's when the operator looks at another workspace.
    await act(async () => { useStore.setState({ activeWorkspaceId: 'ws-b' }); });
    expect(terminalPty()).toEqual(['pty-hq']);
  });

  it('answers a decision from Waiting on you in one click', async () => {
    const { resolve } = installApi();
    await render();
    expect(host.querySelector('[data-moa-waiting]')?.textContent).toContain('Bravo');
    await act(async () => { (host.querySelector('[data-moa-decision-option]') as HTMLButtonElement).click(); });
    expect(resolve).toHaveBeenCalledWith({ workspaceId: 'ws-b', id: 'd1', resolution: 'Merge' });
  });

  it('the Diff panel\'s question goes to Moa\'s brain', async () => {
    const { send } = installApi();
    await render();
    await act(async () => { useStore.getState().setPendingBrainPrompt('What does this hunk do?'); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-hq', text: 'What does this hunk do?' }));
    expect(useStore.getState().pendingBrainPrompt).toBeNull();
  });
});

describe('right panel — other Moa states', () => {
  it('Moa off: only a card, and it opens Settings › Moa', async () => {
    installApi();
    useStore.setState({ moa: moa({ enabled: false }) });
    await render();
    expect(host.querySelector('[data-moa-panel-card="off"]')).not.toBeNull();
    expect(host.querySelector('[data-commander-view]')).toBeNull();
    await act(async () => { (host.querySelector('[data-moa-open-settings]') as HTMLButtonElement).click(); });
    expect(useStore.getState().settingsInitialTab).toBe('moa');
  });

  it('an HQ not seen yet is a short checking card', async () => {
    installApi();
    useStore.setState({ moa: moa({ state: 'hq-unknown' }) });
    await render();
    expect(host.querySelector('[data-moa-panel-card="hq-unknown"]')).not.toBeNull();
    expect(host.querySelector('[data-commander-view]')).toBeNull();
  });

  it('no HQ: today\'s per-workspace chat is unchanged, plus a Set up Moa hint', async () => {
    installApi();
    useStore.setState({ moa: moa({ workspaceId: null, state: 'unset' }) });
    await render();
    expect(host.querySelector('[data-moa-setup-hint]')).not.toBeNull();
    const tab = host.querySelector('[data-deck-tab="commander"]')!;
    expect(tab.querySelector('[data-deck-tab-subtitle]')).toBeNull();
    // The conversation follows the active workspace, as before.
    expect(terminalPty()).toEqual(['pty-a']);
    await act(async () => { useStore.setState({ activeWorkspaceId: 'ws-b' }); });
    expect(terminalPty()).toEqual(['pty-b']);
    expect(host.querySelector('[data-moa-waiting]')).toBeNull();
  });
});
