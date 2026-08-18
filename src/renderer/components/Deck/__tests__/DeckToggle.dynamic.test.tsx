// @vitest-environment jsdom
//
// The collapsed deck no longer renders anything on the window's edge, so this
// one button is the entire way back. What it has to get right: it must flip
// the deck, its arrow must point at what pressing it does, and it must carry
// the signal the rail's per-tab badges used to carry — otherwise collapsing
// the deck means never learning a channel went unread.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import DeckToggle, { deckHasSignal } from '../DeckToggle';

let container: HTMLDivElement;
let root: Root;

const btn = () => container.querySelector('[data-deck-toggle]') as HTMLButtonElement;
const dot = () => container.querySelector('[data-deck-toggle-dot]');

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

const mount = () => act(() => root.render(createElement(DeckToggle)));

describe('deckHasSignal', () => {
  it('is a boolean, not a total — unread and dirty are different things', () => {
    expect(deckHasSignal(0, 0)).toBe(false);
    expect(deckHasSignal(3, 0)).toBe(true);
    expect(deckHasSignal(0, 2)).toBe(true);
    expect(deckHasSignal(3, 2)).toBe(true);
  });
});

describe('DeckToggle', () => {
  it('opens the deck when collapsed', () => {
    mount();
    act(() => { btn().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useStore.getState().channelDockVisible).toBe(true);
  });

  it('closes the deck when open', () => {
    act(() => { useStore.setState({ channelDockVisible: true }); });
    mount();
    act(() => { btn().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useStore.getState().channelDockVisible).toBe(false);
  });

  it('points its arrow at what pressing it does', () => {
    // Deck on the right (sidebar left): collapsed « pulls it out, open » pushes
    // it back to the edge.
    mount();
    expect(btn().textContent).toContain('«');
    act(() => { useStore.setState({ channelDockVisible: true }); });
    expect(btn().textContent).toContain('»');
  });

  it('mirrors when the deck sits on the left edge', () => {
    act(() => { useStore.setState({ sidebarPosition: 'right' }); });
    mount();
    expect(btn().textContent).toContain('»');
  });

  it('shows no dot at zero — no dead gauges', () => {
    mount();
    expect(dot()).toBeNull();
    expect(btn().getAttribute('data-deck-signal')).toBe('false');
  });

  it('shows a dot when a channel is unread', () => {
    act(() => { useStore.setState({ channelUnread: { 'c-1': 3 } }); });
    mount();
    expect(dot()).not.toBeNull();
  });

  it('shows a dot when a workspace is dirty', () => {
    act(() => {
      useStore.setState({
        workspaces: [{ id: 'ws-1', metadata: { gitSync: { dirty: 2 } } }] as never,
      });
    });
    mount();
    expect(dot()).not.toBeNull();
  });

  it('drops the dot once the deck is open — its contents are on screen', () => {
    act(() => {
      useStore.setState({ channelUnread: { 'c-1': 3 }, channelDockVisible: true });
    });
    mount();
    expect(dot()).toBeNull();
  });
});
