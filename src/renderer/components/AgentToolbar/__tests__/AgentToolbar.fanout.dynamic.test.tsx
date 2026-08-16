// @vitest-environment jsdom
//
// Dynamic test for Multi Task (fan-out) on a workspace card. Spawn must exist
// at zero agents — FanOutTrigger is not gated on the roster. ComposeHost
// portals FanOutDialog so it never mounts inside the sidebar scroller.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Stub the pty write path (only mount/toggle is verified — nothing is fired).
vi.mock('../inject', () => ({
  injectText: () => Promise.resolve(),
  quotePathsForPrompt: (paths: string[]) => paths.join(' '),
}));

import { useStore } from '../../../stores';
import FanOutTrigger from '../FanOutTrigger';
import ComposeHost from '../ComposeHost';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => useStore.setState({ toolbarPopover: null, fanOutWorkspaceId: null, agentToolbarEnabled: true }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(): void {
  act(() => root.render(createElement(
    'div',
    null,
    createElement(FanOutTrigger, { workspaceId: 'ws-empty', variant: 'start' }),
    createElement(ComposeHost),
  )));
}

const fanoutButton = (): HTMLButtonElement =>
  container.querySelector('[data-testid="fanout-button"]') as HTMLButtonElement;

describe('FanOutTrigger — empty-fleet spawn', () => {
  it('renders the fan-out button even with no active workspace (spawn a fleet from zero)', () => {
    mount();
    expect(fanoutButton()).not.toBeNull();
    expect(fanoutButton().getAttribute('data-fanout-kind')).toBe('start');
    expect(document.querySelector('[data-testid="fanout-dialog"]')).toBeNull();
  });

  it('toggles the FanOutDialog open and closed on click', () => {
    mount();
    act(() => {
      fanoutButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="fanout-dialog"]')).not.toBeNull();
    act(() => {
      fanoutButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="fanout-dialog"]')).toBeNull();
  });
});
