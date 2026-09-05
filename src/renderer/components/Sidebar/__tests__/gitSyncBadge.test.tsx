// @vitest-environment jsdom
//
// The git signal row spends one colour per state, and amber is the sidebar's
// "something is running" hue. A dirty working tree is not something running —
// on a repo with 41 uncommitted files it was the loudest thing on the row and
// it never meant "look here". This pins the demotion: dirty is muted text.

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { GitSyncStatus } from '../../../../shared/types';
import { GitSyncBadge } from '../WorkspaceItem';

const mounted: Array<() => void> = [];

function render(ui: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function sync(over: Partial<GitSyncStatus>): GitSyncStatus {
  return { dirty: 0, ahead: 0, behind: 0, hasUpstream: true, ...over };
}

/** The spans inside the badge, in render order. */
function signals(container: HTMLElement): HTMLElement[] {
  const badge = container.querySelector('[data-git-signal]') as HTMLElement;
  return Array.from(badge.querySelectorAll('span')) as HTMLElement[];
}

afterEach(() => {
  while (mounted.length > 0) {
    try { mounted.pop()!(); } catch { /* already unmounted */ }
  }
});

describe('GitSyncBadge', () => {
  it('renders the dirty count as muted text, not amber', () => {
    const container = render(<GitSyncBadge sync={sync({ dirty: 41 })} />);
    const [dirty] = signals(container);
    expect(dirty.textContent).toBe('·41');
    expect(dirty.style.color).toBe('var(--text-muted)');
  });

  it('keeps ahead on the steel accent', () => {
    const container = render(<GitSyncBadge sync={sync({ ahead: 2 })} />);
    const [ahead] = signals(container);
    expect(ahead.textContent).toBe('↑2');
    expect(ahead.style.color).toBe('var(--accent-blue)');
  });

  it('keeps clean green and behind red', () => {
    const clean = signals(render(<GitSyncBadge sync={sync({})} />));
    expect(clean[0].textContent).toBe('●');
    expect(clean[0].style.color).toBe('var(--accent-green)');

    const behind = signals(render(<GitSyncBadge sync={sync({ behind: 3 })} />));
    expect(behind[0].textContent).toBe('↓3');
    expect(behind[0].style.color).toBe('var(--accent-red)');
  });
});
