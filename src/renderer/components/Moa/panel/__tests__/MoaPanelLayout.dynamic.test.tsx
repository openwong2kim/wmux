// @vitest-environment jsdom
//
// Moa's panel scrolls as ONE column: Waiting on you, then delegated work, then
// the chat, all inside the chat's own scroller. No card gets a height or a
// scroll of its own, and quick replies stack full width. Mounted through the
// real dock and store.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ChannelDock from '../../../Channels/ChannelDock';
import { useStore } from '../../../../stores';
import type { MoaState } from '../../../../../shared/moa';
import type { Pane, Workspace } from '../../../../../shared/types';

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

const moaState: MoaState = {
  config: { enabled: true, onboarded: true, level: 1, maxTurnsPerHour: 20, bubbles: true, reduceMotion: false, defaultReason: null },
  hq: { workspaceId: 'ws-hq', state: 'ok' },
  archive: { unacked: 0, total: 0 },
};

const cursor = { headOffset: 0, tailOffset: 10, fileSize: 10, mtimeMs: 1 };

function installApi() {
  vi.stubGlobal('electronAPI', {
    deck: {
      send: vi.fn(async () => ({ ok: true })),
      wake: vi.fn(async () => ({ ok: true })),
      interrupt: vi.fn(async () => ({ ok: true })),
      decision: { resolve: vi.fn(async () => ({ ok: true })) },
      moa: {
        decisions: vi.fn(async () => ({
          decisions: [{
            workspaceId: 'ws-b',
            workspaceName: 'Bravo',
            decision: {
              id: 'd1',
              question: 'Which branch should the release come from?',
              options: ['Cut it from main as it stands today', 'Wait for the open fix and cut tomorrow', 'Skip this release'],
              context: 'A long context line that must wrap instead of being clamped. '.repeat(6),
              raisedAt: 1,
            },
          }],
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
    workLinks: {
      list: vi.fn(async () => [{
        id: 'l1', origin: 'task', title: 'Fix the flaky login test', owner: { workspaceId: 'ws-b' },
        state: 'running', decisionIds: [], createdAt: 1, updatedAt: 2,
      }]),
      onChanged: vi.fn(() => () => undefined),
    },
  });
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
    brainPtyIds: { 'ws-hq': 'pty-hq' },
    brainThreads: {},
    pendingBrainPrompt: null,
    moa: moaState,
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  installApi();
  await act(async () => root.render(createElement(ChannelDock)));
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(host.textContent).toContain('Moa here.');
    expect(host.querySelector('[data-moa-task]')).not.toBeNull();
    expect(host.querySelector('[data-moa-decision]')).not.toBeNull();
  }, { timeout: 5000 });
}

const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('Moa panel — one column', () => {
  it('orders Waiting on you, delegated work, then the chat, all inside the chat scroller', async () => {
    await render();
    const scroller = host.querySelector('[data-moa-chat] .wmux-chat-viewport')!;
    const waiting = host.querySelector('[data-moa-waiting]')!;
    const tasks = host.querySelector('[data-moa-tasks]')!;
    const messages = host.querySelector('[data-moa-chat] .wmux-chat-messages')!;
    for (const el of [waiting, tasks, messages]) expect(scroller.contains(el)).toBe(true);
    expect(before(waiting, tasks)).toBe(true);
    expect(before(tasks, messages)).toBe(true);
    // No roster, no recovery notice, no control rows.
    expect(host.querySelector('[data-deck-fleet], [data-commander-recovery], [data-deck-quick-actions], [data-commander-report-rail-toggle]')).toBeNull();
  });

  it('no panel child scrolls or clips on its own: only the chat viewport scrolls', async () => {
    await render();
    const panel = host.querySelector('[data-commander-view]')!;
    const offenders = [...panel.querySelectorAll<HTMLElement>('*')].filter((el) => {
      if (el.classList.contains('wmux-chat-viewport')) return false;
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/(^|\s)(overflow(-[xy])?-(auto|scroll|hidden)|max-h-\S+|line-clamp-\S+)/.test(cls)) return true;
      const st = el.style;
      return ['auto', 'scroll', 'hidden'].includes(st.overflow || st.overflowY) || !!st.maxHeight;
    });
    expect(offenders.map((el) => el.outerHTML.slice(0, 120))).toEqual([]);
  });

  it('quick replies stack full width and wrap', async () => {
    await render();
    const group = host.querySelector('[data-moa-decision] [role="group"]')!;
    expect(group.className).toContain('flex-col');
    const buttons = [...group.querySelectorAll('[data-moa-decision-option]')];
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      expect(b.className).toContain('w-full');
      expect(b.className).toContain('!whitespace-normal');
    }
  });

  it('delegated work folds to its heading', async () => {
    await render();
    const toggle = host.querySelector('[data-moa-tasks-toggle]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect((host.querySelector('#moa-tasks-list') as HTMLElement).hidden).toBe(true);
    // The attribute alone loses to a display utility: the class must fold it too.
    expect((host.querySelector('#moa-tasks-list') as HTMLElement).classList.contains('flex')).toBe(false);
  });
});
