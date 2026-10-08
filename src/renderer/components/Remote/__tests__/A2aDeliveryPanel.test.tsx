// @vitest-environment jsdom
//
// Cross-PC delivery on the Remote page: each paired PC's connection state and
// the remote work held for a person. Pure view, rendered with a stub `t`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import type { A2aRemoteHostStatus } from '../../../../shared/rpc';
import type { Task } from '../../../../shared/types';
import { A2aDeliveryView, type A2aDeliveryViewProps } from '../A2aDeliveryPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

const roots: Root[] = [];
function render(props: Partial<A2aDeliveryViewProps>): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const full: A2aDeliveryViewProps = { hosts: [], held: [], busy: null, error: null, onRetry: () => undefined, onReject: () => undefined, t, ...props };
  act(() => root.render(createElement(A2aDeliveryView, full)));
  roots.push(root);
  return el;
}
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = '';
});

const host = (o: Partial<A2aRemoteHostStatus>): A2aRemoteHostStatus => ({
  hostId: '11111111-1111-4111-8111-111111111111', name: 'DESK', role: 'joiner', state: 'connected', pending: 0, ...o,
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

describe('A2aDeliveryView', () => {
  it('draws nothing with no PC and nothing held', () => {
    expect(render({}).innerHTML).toBe('');
  });

  it('shows each PC state, the certificate-changed note and messages waiting for a reconnect', () => {
    const el = render({
      hosts: [
        host({ hostId: 'h-1', state: 'connected' }),
        host({ hostId: 'h-2', state: 'disconnected', pending: 2 }),
        host({ hostId: 'h-3', state: 'identity-changed' }),
      ],
    });
    expect([...el.querySelectorAll('[data-state]')].map((b) => b.getAttribute('data-state'))).toEqual(['connected', 'disconnected', 'identity-changed']);
    expect(el.querySelector('[data-host-id="h-2"] [data-testid="a2a-delivery-pending"]')?.textContent).toBe('a2aDelivery.waiting(2)');
    expect(el.querySelector('[data-host-id="h-3"] [data-testid="a2a-delivery-identity"]')).not.toBeNull();
  });

  it('lists held work with its reason; retry and reject call back, Moa holds offer no retry', () => {
    const onRetry = vi.fn();
    const onReject = vi.fn();
    const el = render({ held: [heldTask('occupant-changed')], onRetry, onReject });
    expect(el.querySelector('[data-testid="a2a-delivery-reason"]')?.textContent).toBe('a2aDelivery.reason.occupant-changed');
    act(() => (el.querySelector('[data-testid="a2a-delivery-retry"]') as HTMLButtonElement).click());
    expect(onRetry).toHaveBeenCalledWith(`rt-${'a'.repeat(32)}`);
    const reject = [...el.querySelectorAll('button')].find((b) => b.textContent === 'a2aDelivery.reject')!;
    act(() => reject.click());
    expect(onReject).toHaveBeenCalledTimes(1);

    const brain = render({ held: [heldTask('brain-delivery-pending')] });
    expect(brain.querySelector('[data-testid="a2a-delivery-retry"]')).toBeNull();
  });
});
