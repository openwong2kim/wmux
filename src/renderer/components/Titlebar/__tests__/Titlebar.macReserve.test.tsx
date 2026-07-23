// @vitest-environment jsdom
//
// macOS traffic-light reserve placement contract (owner-reported 2026-07-17):
// When the sidebar is left-docked + expanded (240px), reserve must be the mantle segment's
// inner padding — putting it on the header shifts the whole segment by the reserve amount
// and misaligns with the sidebar boundary below (240px). Only when the segment is narrower
// than the reserve (mini 48px, none) does the header absorb the reserve.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import Titlebar, { MAC_TRAFFIC_LIGHT_RESERVE } from '../Titlebar';
import { useStore } from '../../../stores';

vi.mock('../../StatusBar/StatusBar', () => ({ default: () => null }));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    window: {
      isFullScreen: vi.fn(() => Promise.resolve(false)),
      onFullscreenChanged: vi.fn(() => vi.fn()),
    },
  };
});

function render(): { header: HTMLElement; segment: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Titlebar />));
  const header = container.querySelector('[data-testid="titlebar"]') as HTMLElement;
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    header,
    segment: header.firstElementChild as HTMLElement,
    cleanup: cleanups[cleanups.length - 1],
  };
}

describe('Titlebar macOS traffic-light reserve', () => {
  it('expanded sidebar (240px): reserve goes into segment inner padding, header is 0', () => {
    act(() => useStore.setState({ sidebarPosition: 'left', sidebarVisible: true }));
    const { header, segment } = render();
    expect(header.style.paddingLeft).toBe('0px');
    expect(segment.style.paddingLeft).toBe(`${MAC_TRAFFIC_LIGHT_RESERVE}px`);
    expect(segment.style.width).toBe('240px');
  });

  it('mini sidebar (48px): segment narrower than reserve so header wins reserve', () => {
    act(() => useStore.setState({ sidebarPosition: 'left', sidebarVisible: false }));
    const { header, segment } = render();
    expect(header.style.paddingLeft).toBe(`${MAC_TRAFFIC_LIGHT_RESERVE}px`);
    expect(segment.style.paddingLeft).toBe('');
  });
});
