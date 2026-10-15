// @vitest-environment jsdom
// On the Bots page toasts drop from the top, below the titlebar and the
// page's 44px header band, so a persistent one never covers the header's
// controls (the narrow layout's workers button, #2231).
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useStore } from '../../../stores';
import ToastContainer from '../ToastContainer';
import { TITLEBAR_HEIGHT } from '../../Titlebar/Titlebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
  act(() => useStore.setState({ toasts: [], appRoute: 'workspaces' } as never));
});

async function render(route: string): Promise<HTMLElement> {
  act(() => useStore.setState({ appRoute: route } as never));
  act(() => { useStore.getState().pushToast({ message: 'New: something', level: 'info', persist: true }); });
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<ToastContainer />); });
  return host.querySelector('[data-toast-edge]') as HTMLElement;
}

describe('ToastContainer placement', () => {
  it('on the Bots page: from the top, under the titlebar and the 44px header band', async () => {
    const stack = await render('bots');
    expect(stack.getAttribute('data-toast-edge')).toBe('top');
    const top = Number(/top-\[(\d+)px\]/.exec(stack.className)?.[1]);
    expect(top).toBeGreaterThanOrEqual(TITLEBAR_HEIGHT + 44);
  });

  it('elsewhere: at the bottom', async () => {
    const stack = await render('workspaces');
    expect(stack.getAttribute('data-toast-edge')).toBe('bottom');
  });
});
