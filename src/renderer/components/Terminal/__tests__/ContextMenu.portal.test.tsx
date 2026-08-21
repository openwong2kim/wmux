// @vitest-environment jsdom
//
// Issue #957 — the terminal context menu renders through a portal.
//
// This is the load-bearing half of containing the pane's stacking context. The
// menu is the only thing left inside a pane that has to out-z its siblings to
// be seen, so as long as it is a DESCENDANT of the pane, giving the pane root
// `isolation: isolate` would trap it under any later-DOM sibling pane. Pinning
// the portal here means a refactor that quietly puts it back inside the tree
// fails in this file rather than in a screenshot months later.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../hooks/useT', () => ({ useT: () => (k: string) => k }));

import ContextMenu from '../ContextMenu';

const noop = vi.fn();

function baseProps() {
  return {
    x: 40,
    y: 60,
    hasSelection: true,
    selectedText: 'hello',
    linkUrl: null,
    onCopy: noop,
    onPaste: noop,
    onOpenLink: noop,
    onCopyLink: noop,
    onClose: noop,
  };
}

describe('ContextMenu portal (#957)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    // Stand in for the pane root: the menu is rendered from inside it, and the
    // point of the portal is that the DOM node does not land here.
    host.setAttribute('data-wmux-pane-root', 'pane-1');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function menuEl(): HTMLElement | null {
    return document.querySelector('.fixed.min-w-\\[168px\\]');
  }

  it('mounts on document.body, not inside the pane that rendered it', () => {
    act(() => { root.render(<ContextMenu {...baseProps()} />); });

    const el = menuEl();
    expect(el).not.toBeNull();
    // The pane subtree must not contain it...
    expect(host.contains(el)).toBe(false);
    // ...and body must be its parent, so no pane ancestor can clip it, apply a
    // transform that would re-base its `position: fixed`, or out-stack it.
    expect(el?.parentElement).toBe(document.body);
  });

  it('keeps the viewport coordinates it was given', () => {
    act(() => { root.render(<ContextMenu {...baseProps()} />); });

    const el = menuEl() as HTMLElement;
    // Portalling must be behaviour-neutral for placement: the menu was already
    // `position: fixed` against the viewport, so the same x/y has to land in
    // the same place. jsdom reports 0-size rects, so the clamp is inert here
    // and these are the raw props.
    expect(el.style.left).toBe('40px');
    expect(el.style.top).toBe('60px');
  });

  it('unmounts cleanly from body', () => {
    act(() => { root.render(<ContextMenu {...baseProps()} />); });
    expect(menuEl()).not.toBeNull();

    act(() => { root.render(<></>); });
    expect(menuEl()).toBeNull();
  });
});
