// @vitest-environment jsdom
//
// The rendered half of the accessible-name contract. chromeAccessibleNames.test
// scans the source (it reaches branches a mount never would); this one proves
// the thing actually comes out of React with a name on it, for the two chrome
// surfaces that mount without the Electron preload: the deck's header strip and
// the toggle that opens it. The titlebar and the sidebar rows pull in the store,
// the preload and xterm, so they stay with the source scan.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../stores';
import { DeckTabs } from '../Deck/DeckTabs';
import DeckToggle from '../Deck/DeckToggle';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    useStore.setState({
      channelDockVisible: false,
      sidebarPosition: 'left',
      channelUnread: {},
      workspaces: [],
    });
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * What a screen reader would announce: the explicit label if there is one,
 * otherwise the visible text with `aria-hidden` decoration removed — which is
 * how a glyph-only button ends up announcing nothing at all.
 */
function accessibleName(btn: HTMLButtonElement): string {
  const explicit = btn.getAttribute('aria-label');
  if (explicit) return explicit.trim();
  const clone = btn.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (clone.textContent ?? '').trim();
}

/** A name made only of punctuation ("✕", "→") is not a name. */
const isReadable = (name: string): boolean => /[\p{L}\p{N}]/u.test(name);

describe('chrome accessible names — rendered', () => {
  it('names every button in the deck header strip', () => {
    act(() => {
      root.render(
        createElement(DeckTabs, {
          active: 'commander',
          onSelect: vi.fn(),
          showChannels: true,
          channelsUnread: 3,
          t: (key: string) => key,
        }),
      );
    });
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    const unnamed = buttons.filter((b) => !isReadable(accessibleName(b)));
    expect(unnamed.map((b) => b.outerHTML.slice(0, 80))).toEqual([]);
  });

  it('names the deck toggle, and carries its signal into the name', () => {
    act(() => root.render(createElement(DeckToggle)));
    const quiet = container.querySelector('[data-deck-toggle]') as HTMLButtonElement;
    expect(quiet.getAttribute('data-deck-signal')).toBe('false');
    const quietName = accessibleName(quiet);
    expect(isReadable(quietName)).toBe(true);

    act(() => useStore.setState({ channelUnread: { general: 2 } }));
    const loud = container.querySelector('[data-deck-toggle]') as HTMLButtonElement;
    expect(loud.getAttribute('data-deck-signal')).toBe('true');
    // The red dot is aria-hidden decoration, so the signal has to reach the
    // name or a screen-reader user is told only "Expand dock" while a sighted
    // one can see there is a reason to press it.
    const loudName = accessibleName(loud);
    expect(loudName.startsWith(quietName)).toBe(true);
    expect(loudName.length).toBeGreaterThan(quietName.length);
  });
});
