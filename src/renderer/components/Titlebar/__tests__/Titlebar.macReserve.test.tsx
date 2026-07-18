// @vitest-environment jsdom
//
// macOS 트래픽 라이트 72px 예약 위치 계약 (owner-reported 2026-07-17):
// 사이드바가 왼쪽 도킹 + 확장(240px)일 때 예약은 mantle 세그먼트 "안쪽"
// 패딩이어야 한다 — 헤더에 걸면 세그먼트 전체가 72px 밀려 아래 사이드바
// 경계(240px)와 어긋난다. 세그먼트가 예약보다 좁을 때(미니 48px·없음)만
// 헤더가 예약을 진다.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import Titlebar from '../Titlebar';
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
  it('확장 사이드바(240px): 예약이 세그먼트 안쪽 패딩으로 들어가고 헤더는 0', () => {
    act(() => useStore.setState({ sidebarPosition: 'left', sidebarVisible: true }));
    const { header, segment } = render();
    expect(header.style.paddingLeft).toBe('0px');
    expect(segment.style.paddingLeft).toBe('72px');
    expect(segment.style.width).toBe('240px');
  });

  it('미니 사이드바(48px): 세그먼트가 예약보다 좁으니 헤더가 72px 예약을 진다', () => {
    act(() => useStore.setState({ sidebarPosition: 'left', sidebarVisible: false }));
    const { header, segment } = render();
    expect(header.style.paddingLeft).toBe('72px');
    expect(segment.style.paddingLeft).toBe('');
  });
});
