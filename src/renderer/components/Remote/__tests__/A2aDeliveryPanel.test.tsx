// @vitest-environment jsdom
//
// Cross-PC delivery rows of the Remote page's Needs you block: remote work
// held for a person, and a PC whose certificate changed. Pure views, rendered
// with a stub `t`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement, type ReactElement } from 'react';
import type { Task } from '../../../../shared/types';
import { A2aHeldRow, A2aIdentityRow, type A2aHeldRowProps, type A2aIdentityRowProps } from '../A2aDeliveryPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

const roots: Root[] = [];
function render(ui: ReactElement): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(createElement('ul', null, ui)));
  roots.push(root);
  return el;
}
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = '';
});

function heldTask(held: string): Task {
  return {
    id: `rt-${'a'.repeat(32)}`,
    kind: 'task',
    status: { state: 'submitted', timestamp: '' },
    history: [],
    metadata: {
      title: 'review',
      from: { workspaceId: 'remote:l1', name: 'DESK/API/codex' },
      to: { workspaceId: 'ws-b', name: 'B', paneId: 'p' },
      remote: { v: 1, linkId: 'l1', hostId: 'h', messageId: 'm', direction: 'inbound', delivered: false, held },
    },
  } as unknown as Task;
}

function heldProps(task: Task, over: Partial<A2aHeldRowProps> = {}): A2aHeldRowProps {
  return { task, now: Date.now(), busy: false, onRetry: () => undefined, onReject: () => undefined, t, ...over };
}

describe('A2aHeldRow', () => {
  it('quotes the held work with its PC and reason; deliver and send back call back, Moa holds offer no deliver', () => {
    const onRetry = vi.fn();
    const onReject = vi.fn();
    const el = render(createElement(A2aHeldRow, heldProps(heldTask('occupant-changed'), { onRetry, onReject })));
    expect(el.textContent).toContain('remotePage.needs.heldTitle(DESK)');
    expect(el.textContent).toContain('“review”');
    expect(el.querySelector('[data-testid="a2a-delivery-reason"]')?.textContent).toBe('a2aDelivery.reason.occupant-changed');
    act(() => (el.querySelector('[data-testid="a2a-delivery-retry"]') as HTMLButtonElement).click());
    expect(onRetry).toHaveBeenCalledOnce();
    act(() => (el.querySelector('[data-testid="a2a-delivery-reject"]') as HTMLButtonElement).click());
    expect(onReject).toHaveBeenCalledOnce();
    // Nothing on this row is the page's primary.
    expect(el.querySelector('.ui-btn-primary')).toBeNull();

    const brain = render(createElement(A2aHeldRow, heldProps(heldTask('brain-delivery-pending'))));
    expect(brain.querySelector('[data-testid="a2a-delivery-retry"]')).toBeNull();
  });
});

function identityProps(over: Partial<A2aIdentityRowProps> = {}): A2aIdentityRowProps {
  return {
    hostId: 'h-1', name: 'DESK', links: 2, confirming: false, busy: false,
    onPairAgain: () => undefined, onAskRemove: () => undefined, onCancelRemove: () => undefined, onRemove: () => undefined, t, ...over,
  };
}

describe('A2aIdentityRow', () => {
  it('warns, says how many links removing it ends, and offers Pair again and a two-step Remove', () => {
    const onPairAgain = vi.fn();
    const onAskRemove = vi.fn();
    const el = render(createElement(A2aIdentityRow, identityProps({ onPairAgain, onAskRemove })));
    expect(el.textContent).toContain('a2aDelivery.identityChanged');
    expect(el.querySelector('[data-testid="a2a-identity-links"]')?.textContent).toBe('remotePage.needs.endsLinks(2)');
    act(() => (el.querySelector('[data-testid="a2a-identity-pair-again"]') as HTMLButtonElement).click());
    expect(onPairAgain).toHaveBeenCalledOnce();
    act(() => [...el.querySelectorAll('button')].find((b) => b.textContent === 'remotePage.remove')!.click());
    expect(onAskRemove).toHaveBeenCalledOnce();

    const onRemove = vi.fn();
    const confirm = render(createElement(A2aIdentityRow, identityProps({ links: 0, confirming: true, onRemove })));
    expect(confirm.querySelector('[data-testid="a2a-identity-links"]')).toBeNull();
    act(() => (confirm.querySelector('.ui-btn-danger') as HTMLButtonElement).click());
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
