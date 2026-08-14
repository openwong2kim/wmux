// @vitest-environment jsdom
//
// Collapsed-deck rail contract (owner decision 2026-08-14). The rail IS the
// way back into the deck — the labeled Agent/Git/Channels/web rows at the foot
// of the workspace sidebar are gone — so each glyph has to open the deck onto
// its own tab, not merely un-collapse it.

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import DeckMiniRail from '../DeckMiniRail';
import { useStore } from '../../../stores';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<DeckMiniRail />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function press(container: HTMLElement, rail: string): void {
  const btn = container.querySelector(`[data-deck-rail="${rail}"]`) as HTMLButtonElement;
  expect(btn).toBeTruthy();
  act(() => btn.click());
}

describe('DeckMiniRail', () => {
  it('opens the deck on the pressed tab', () => {
    useStore.setState({ channelDockVisible: false, activeDeckTab: 'commander' });

    const container = render();
    press(container, 'git');

    const s = useStore.getState();
    expect(s.channelDockVisible).toBe(true);
    expect(s.activeDeckTab).toBe('git');
  });

  it('turns the Channels tab on when its glyph is pressed', () => {
    // The tab defaults to OFF (human channel UI is a Settings opt-in), so
    // opening the deck on it without flipping it would show an empty pane.
    useStore.setState({
      channelDockVisible: false,
      activeDeckTab: 'commander',
      channelsTabVisible: false,
    });

    const container = render();
    press(container, 'channels');

    const s = useStore.getState();
    expect(s.channelDockVisible).toBe(true);
    expect(s.activeDeckTab).toBe('channels');
    expect(s.channelsTabVisible).toBe(true);
  });

  it('reopens the last active tab from the expand chevron', () => {
    useStore.setState({ channelDockVisible: false, activeDeckTab: 'git' });

    const container = render();
    const expand = container.querySelector('[data-deck-expand]') as HTMLButtonElement;
    act(() => expand.click());

    const s = useStore.getState();
    expect(s.channelDockVisible).toBe(true);
    expect(s.activeDeckTab).toBe('git');
  });

  it('expanding never turns the frozen Channels tab on by itself', () => {
    // A session persisted before the Settings opt-in existed can hold
    // activeDeckTab:'channels' with channelsTabVisible:false. Plain "expand"
    // is not a request for channels, so it must fall back instead of
    // enabling the frozen UI behind the user's back.
    useStore.setState({
      channelDockVisible: false,
      activeDeckTab: 'channels',
      channelsTabVisible: false,
    });

    const container = render();
    act(() => (container.querySelector('[data-deck-expand]') as HTMLButtonElement).click());

    const s = useStore.getState();
    expect(s.channelDockVisible).toBe(true);
    expect(s.channelsTabVisible).toBe(false);
    expect(s.activeDeckTab).toBe('commander');
  });

  it('marks the tab the deck will return to, and announces counts', () => {
    useStore.setState({
      channelDockVisible: false,
      activeDeckTab: 'git',
      channelUnread: { a: 4 },
    });

    const container = render();
    expect(
      (container.querySelector('[data-deck-rail="git"]') as HTMLElement).getAttribute('data-last-active'),
    ).toBe('true');
    expect(
      (container.querySelector('[data-deck-rail="commander"]') as HTMLElement).getAttribute('data-last-active'),
    ).toBeNull();
    // The badge is aria-hidden, so the count has to be in the name.
    expect(
      (container.querySelector('[data-deck-rail="channels"]') as HTMLElement).getAttribute('aria-label'),
    ).toContain('4 unread');
  });

  it('badges unread channels on the Channels glyph only when there is unread', () => {
    useStore.setState({ channelDockVisible: false, channelUnread: {} });
    expect(render().querySelector('[data-deck-rail-unread]')).toBeNull();

    useStore.setState({ channelUnread: { a: 2, b: 1 } });
    const badge = render().querySelector('[data-deck-rail-unread]');
    expect(badge?.textContent).toBe('3');
  });
});
