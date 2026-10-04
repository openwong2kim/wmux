// @vitest-environment jsdom
// Moa's titlebar icon and its bubble, against the real store with the deck
// bridge mocked: visibility and the panel toggle, the two triggers (a new
// decision, a finished delegation), one bubble at a time, the 6s collapse to
// the dot, the dot colours, bubbles off, Open / Later / Escape, and the
// transcript subscription handed back and forth with the panel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MoaTitlebarButton from '../MoaTitlebarButton';
import { MOA_BUBBLE_MS } from '../moaNotice';
import { useStore } from '../../../stores';
import { setLocale } from '../../../i18n';
import type { MoaPendingDecision, MoaState } from '../../../../shared/moa';
import type { WorkLink, WorkLinkState } from '../../../../shared/workLink';
import type { TranscriptAppendData } from '../../../../shared/transcript/turnEvents';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moa = (over: { enabled?: boolean; bubbles?: boolean } = {}): MoaState => ({
  config: {
    enabled: over.enabled ?? true,
    onboarded: true,
    level: 1,
    maxTurnsPerHour: 20,
    bubbles: over.bubbles ?? true,
    reduceMotion: false,
    defaultReason: null,
  },
  hq: { workspaceId: 'hq', state: 'ok' },
  archive: { unacked: 0, total: 0 },
});

const decision = (id: string, question: string, raisedAt = 1): MoaPendingDecision => ({
  workspaceId: 'ws-app',
  workspaceName: 'wmux-ios',
  decision: { id, question, options: [], context: '', raisedAt },
});

const link = (id: string, state: WorkLinkState, title = 'Fix the login bug'): WorkLink => ({
  id,
  origin: 'moa',
  title,
  owner: { workspaceId: 'ws-app' },
  state,
  decisionIds: [],
  createdAt: 1,
  updatedAt: 1,
});

let decisions: MoaPendingDecision[];
let links: Map<string, WorkLink>;
let moaChanged: (() => void) | null;
let linksChanged: ((ids: string[]) => void) | null;
let append: ((d: TranscriptAppendData) => void) | null;
let api: ReturnType<typeof makeApi>;

function makeApi() {
  return {
    deck: {
      moa: {
        decisions: vi.fn(async () => ({ decisions })),
        onChanged: (cb: () => void) => { moaChanged = cb; return () => { moaChanged = null; }; },
        transcript: {
          onAppend: (cb: (d: TranscriptAppendData) => void) => { append = cb; return () => { append = null; }; },
          subscribe: vi.fn(async () => ({})),
          unsubscribe: vi.fn(async () => undefined),
        },
      },
    },
    workLinks: {
      list: vi.fn(async () => [...links.values()]),
      get: vi.fn(async (id: string) => links.get(id) ?? null),
      onChanged: (cb: (ids: string[]) => void) => { linksChanged = cb; return () => { linksChanged = null; }; },
    },
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
async function mount() {
  act(() => root.render(<MoaTitlebarButton />));
  await flush();
}
async function raise(next: MoaPendingDecision[]) {
  decisions = next;
  moaChanged?.();
  await flush();
}
async function finish(id: string, title?: string) {
  links.set(id, link(id, 'done', title));
  linksChanged?.([id]);
  await flush();
}
const button = () => document.querySelector<HTMLButtonElement>('[data-moa-titlebar]');
const bubbles = () => document.querySelectorAll('[data-moa-bubble]');
const bubble = () => document.querySelector<HTMLElement>('[data-moa-bubble]');
const dot = () => button()!.getAttribute('data-moa-dot');
const live = () => document.querySelector('[data-moa-live]')!.textContent;
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  setLocale('en');
  decisions = [];
  links = new Map([['l1', link('l1', 'running')]]);
  moaChanged = null;
  linksChanged = null;
  append = null;
  api = makeApi();
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  useStore.setState({ moa: moa(), channelDockVisible: false, appRoute: 'workspaces', activeDeckTab: 'channels' } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  useStore.setState({ moa: null, channelDockVisible: false, channelUnread: {}, channelsTabVisible: false } as never);
});

describe('Moa titlebar icon', () => {
  it('is drawn only while Moa is on', async () => {
    useStore.setState({ moa: moa({ enabled: false }) } as never);
    await mount();
    expect(button()).toBeNull();
    act(() => useStore.setState({ moa: moa() } as never));
    await flush();
    expect(button()).not.toBeNull();
    expect(button()!.querySelector('[data-moa-mascot]')!.getAttribute('width')).toBe('20');
  });

  it('opens and closes the right panel, named for what it does', async () => {
    await mount();
    expect(button()!.getAttribute('aria-label')).toBe('Moa');
    expect(button()!.getAttribute('aria-expanded')).toBe('false');
    act(() => button()!.click());
    expect(useStore.getState().channelDockVisible).toBe(true);
    expect(useStore.getState().activeDeckTab).toBe('commander');
    expect(button()!.getAttribute('aria-expanded')).toBe('true');
    act(() => button()!.click());
    expect(useStore.getState().channelDockVisible).toBe(false);
  });

  it('brings the Workspaces page forward when opened from another page', async () => {
    useStore.setState({ appRoute: 'settings' } as never);
    await mount();
    act(() => button()!.click());
    expect(useStore.getState().appRoute).toBe('workspaces');
    expect(useStore.getState().channelDockVisible).toBe(true);
  });
});

// DeckToggle steps aside while Moa is on, so this button carries its dot for
// unread channels (only once the Channels tab is opted in).
describe('Moa titlebar icon — unread channels', () => {
  it('shows the channel dot and names it while the panel is closed', async () => {
    useStore.setState({ channelsTabVisible: true, channelUnread: { c1: 2, c2: 1 } } as never);
    await mount();
    expect(dot()).toBe('channels');
    expect(button()!.querySelector('[data-moa-titlebar-dot="channels"]')).not.toBeNull();
    expect(button()!.getAttribute('aria-label')).toBe('Moa — 3 unread in channels');
    act(() => button()!.click());
    expect(dot()).toBe('none');
  });

  it('ignores channel unread while the Channels tab is not opted in', async () => {
    useStore.setState({ channelsTabVisible: false, channelUnread: { c1: 2 } } as never);
    await mount();
    expect(dot()).toBe('none');
    expect(button()!.getAttribute('aria-label')).toBe('Moa');
  });

  it('a waiting decision keeps the dot yellow, and the name lists both', async () => {
    useStore.setState({ channelsTabVisible: true, channelUnread: { c1: 1 } } as never);
    decisions = [decision('d0', 'Old question?')];
    await mount();
    expect(dot()).toBe('waiting');
    const mark = button()!.querySelector<HTMLElement>('[data-moa-titlebar-dot]')!;
    expect(mark.style.background).toBe('var(--accent-yellow)');
    expect(button()!.getAttribute('aria-label')).toBe('Moa — 1 decision waiting on you, 1 unread in channels');
  });
});

describe('Moa bubble', () => {
  it('stays quiet for decisions already pending at startup, but shows the yellow dot', async () => {
    decisions = [decision('d0', 'Old question?')];
    await mount();
    expect(bubble()).toBeNull();
    expect(dot()).toBe('waiting');
    expect(button()!.getAttribute('aria-label')).toBe('Moa — 1 decision waiting on you');
  });

  it('pops for a new decision and announces it politely without taking focus', async () => {
    await mount();
    const before = document.activeElement;
    await raise([decision('d1', 'Show "output on hold" in the app?')]);
    expect(bubble()!.getAttribute('data-moa-bubble')).toBe('decision');
    expect(bubble()!.textContent).toContain('Moa · needs you');
    expect(bubble()!.textContent).toContain('wmux-ios is waiting on a decision. Show "output on hold" in the app?');
    expect(live()).toBe('Moa · needs you. wmux-ios is waiting on a decision. Show "output on hold" in the app?');
    expect(document.querySelector('[data-moa-live]')!.getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(before);
  });

  it('pops for a finished delegation, then leaves a grey dot', async () => {
    await mount();
    await finish('l1');
    expect(bubble()!.getAttribute('data-moa-bubble')).toBe('done');
    expect(bubble()!.textContent).toContain('Fix the login bug is done.');
    tick(MOA_BUBBLE_MS);
    expect(bubble()).toBeNull();
    expect(dot()).toBe('reply');
  });

  it('does not pop for a link that is not done, or was already done', async () => {
    links.set('l2', link('l2', 'done'));
    await mount();
    linksChanged?.(['l2']);
    await flush();
    expect(bubble()).toBeNull();
    links.set('l1', link('l1', 'review'));
    linksChanged?.(['l1']);
    await flush();
    expect(bubble()).toBeNull();
  });

  it('collapses to the dot after 6 seconds', async () => {
    await mount();
    await raise([decision('d1', 'Ship it?')]);
    tick(MOA_BUBBLE_MS - 1);
    expect(bubble()).not.toBeNull();
    tick(1);
    expect(bubble()).toBeNull();
    expect(dot()).toBe('waiting');
    expect(button()!.querySelector('[data-moa-titlebar-dot]')!.getAttribute('style')).toContain('--accent-yellow');
  });

  it('shows one bubble at a time: the newest decision replaces the last, a finished task never displaces a decision', async () => {
    await mount();
    await raise([decision('d1', 'First?', 1)]);
    await raise([decision('d1', 'First?', 1), decision('d2', 'Second?', 2)]);
    expect(bubbles()).toHaveLength(1);
    expect(bubble()!.textContent).toContain('Second?');
    await finish('l1');
    expect(bubbles()).toHaveLength(1);
    expect(bubble()!.getAttribute('data-moa-bubble')).toBe('decision');
  });

  it('a decision replaces a showing finished-task bubble', async () => {
    await mount();
    await finish('l1');
    await raise([decision('d1', 'Merge now?')]);
    expect(bubbles()).toHaveLength(1);
    expect(bubble()!.getAttribute('data-moa-bubble')).toBe('decision');
  });

  it('with bubbles off, shows dots only', async () => {
    useStore.setState({ moa: moa({ bubbles: false }) } as never);
    await mount();
    await raise([decision('d1', 'Ship it?')]);
    expect(bubble()).toBeNull();
    expect(dot()).toBe('waiting');
    await raise([]);
    await finish('l1');
    expect(bubble()).toBeNull();
    expect(dot()).toBe('reply');
  });

  it('never pops while the panel is on screen', async () => {
    useStore.setState({ channelDockVisible: true } as never);
    await mount();
    await raise([decision('d1', 'Ship it?')]);
    expect(bubble()).toBeNull();
    expect(dot()).toBe('none');
  });

  it('Open opens the panel and clears the bubble', async () => {
    await mount();
    await raise([decision('d1', 'Ship it?')]);
    act(() => document.querySelector<HTMLButtonElement>('[data-moa-bubble-open]')!.click());
    expect(useStore.getState().channelDockVisible).toBe(true);
    expect(bubble()).toBeNull();
  });

  it('Later collapses to the dot', async () => {
    await mount();
    await raise([decision('d1', 'Ship it?')]);
    act(() => document.querySelector<HTMLButtonElement>('[data-moa-bubble-later]')!.click());
    expect(bubble()).toBeNull();
    expect(useStore.getState().channelDockVisible).toBe(false);
    expect(dot()).toBe('waiting');
  });

  it('Escape collapses like Later, without consuming the key', async () => {
    await mount();
    await raise([decision('d1', 'Ship it?')]);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(ev); });
    expect(bubble()).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
    expect(dot()).toBe('waiting');
  });

  it('a decision answered elsewhere takes its bubble and the yellow dot with it', async () => {
    await mount();
    await raise([decision('d1', 'Ship it?')]);
    await raise([]);
    expect(bubble()).toBeNull();
    expect(dot()).toBe('none');
  });
});

describe('Moa reply dot', () => {
  it('a new assistant message marks a grey dot; opening the panel clears it', async () => {
    await mount();
    act(() => append!({ seq: 1, events: [{ id: 'u1', kind: 'user_text', text: 'hi' }], cursor: {} as never }));
    expect(dot()).toBe('none');
    act(() => append!({ seq: 2, events: [{ id: 'a1', kind: 'assistant_text', text: 'Done.' }], cursor: {} as never }));
    expect(dot()).toBe('reply');
    expect(bubble()).toBeNull();
    expect(button()!.getAttribute('aria-label')).toBe('Moa — new reply');
    expect(button()!.querySelector('[data-moa-titlebar-dot]')!.getAttribute('style')).toContain('--text-muted');
    act(() => button()!.click());
    act(() => useStore.setState({ channelDockVisible: false } as never));
    expect(dot()).toBe('none');
  });

  it('holds the transcript subscription only while the panel is not mounted', async () => {
    await mount();
    expect(api.deck.moa.transcript.subscribe).toHaveBeenCalledTimes(1);
    act(() => useStore.setState({ channelDockVisible: true } as never));
    expect(api.deck.moa.transcript.unsubscribe).toHaveBeenCalledTimes(1);
    act(() => useStore.setState({ channelDockVisible: false } as never));
    expect(api.deck.moa.transcript.subscribe).toHaveBeenCalledTimes(2);
  });

  it('ignores a reset push: it re-sends history, not a new message', async () => {
    await mount();
    act(() => append!({ seq: 1, reset: true, events: [{ id: 'a0', kind: 'assistant_text', text: 'Earlier.' }], cursor: {} as never }));
    expect(dot()).toBe('none');
  });

  it('subscribes again when the HQ changes (main drops the old subscription)', async () => {
    await mount();
    expect(api.deck.moa.transcript.subscribe).toHaveBeenCalledTimes(1);
    act(() => useStore.setState({ moa: { ...moa(), hq: { workspaceId: 'hq2', state: 'ok' } } } as never));
    expect(api.deck.moa.transcript.unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.deck.moa.transcript.subscribe).toHaveBeenCalledTimes(2);
  });

  it('survives a bridge without the Moa notice methods', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { deck: { moa: {} } };
    await mount();
    expect(button()).not.toBeNull();
    expect(dot()).toBe('none');
  });
});
