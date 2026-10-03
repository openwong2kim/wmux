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
      appRoute: 'workspaces',
    });
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = () => act(() => root.render(createElement(DeckToggle)));

describe('deckHasSignal', () => {
  it('is a boolean, lit only by unread channels', () => {
    expect(deckHasSignal(0)).toBe(false);
    expect(deckHasSignal(3)).toBe(true);
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

  it('is an icon named for its panel, exposing its open state and controlled region', () => {
    mount();
    // Icon only: the panel's name lives in the tooltip and accessible name.
    expect(btn().textContent?.trim()).toBe('');
    expect(btn().getAttribute('title')).toBe('Show tools panel');
    expect(btn().getAttribute('aria-label')).toBe('Show tools panel');
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(btn().hasAttribute('aria-controls')).toBe(false);
    act(() => { btn().click(); });
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(btn().getAttribute('aria-controls')).toBe('wmux-tools-panel');
    expect(btn().getAttribute('aria-label')).toBe('Hide tools panel');
  });

  it('shows the actual panel side when the sidebar is moved', () => {
    mount();
    expect(btn().getAttribute('data-panel-side')).toBe('right');
    act(() => { useStore.setState({ sidebarPosition: 'right' }); });
    expect(btn().getAttribute('data-panel-side')).toBe('left');
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

  it('shows no dot for a dirty workspace — Git lives in the sidebar, not the deck', () => {
    act(() => {
      useStore.setState({
        workspaces: [{ id: 'ws-1', metadata: { gitSync: { dirty: 2 } } }] as never,
      });
    });
    mount();
    expect(dot()).toBeNull();
  });

  it('drops the dot once the deck is open — its contents are on screen', () => {
    act(() => {
      useStore.setState({ channelUnread: { 'c-1': 3 }, channelDockVisible: true });
    });
    mount();
    expect(dot()).toBeNull();
  });

  it('from another page it reads closed and opens the dock on the Workspaces page', () => {
    act(() => { useStore.setState({ channelDockVisible: true, appRoute: 'fleet' }); });
    mount();
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    act(() => { btn().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useStore.getState().appRoute).toBe('workspaces');
    expect(useStore.getState().channelDockVisible).toBe(true);
    expect(btn().getAttribute('aria-expanded')).toBe('true');
  });
});
