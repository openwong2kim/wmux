// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 소스 레벨 회귀 잠금 + DOM 메커니즘 검증.
 *
 * wmux는 Menu.setApplicationMenu()를 호출하지 않아 Electron 기본 메뉴가 깔리고,
 * macOS에서는 Cmd+V가 NSMenu key equivalent로 처리되어 keydown의 preventDefault()로
 * 막을 수 없다. xterm.js는 terminal.element/textarea에 자기만의 네이티브 'paste'
 * 리스너를 직접 붙여두므로, 이 네이티브 paste가 wmux의 커스텀 비동기 IPC paste
 * 경로(pastePtyChunked)와 동시에 pty에 써서 붙여넣기 앞부분이 유실되는 레이스가
 * 생긴다(Windows는 단축키가 DOM keydown 흐름에 통합돼 있어 재현되지 않는다).
 *
 * 첫 버전은 native paste를 무조건 차단했는데, 팀 리뷰(Claude 패스)가 진짜 회귀를
 * 잡았다: 메뉴바 Edit>Paste를 마우스로 클릭하거나 VoiceOver/UI 자동화가 keydown 없이
 * 합성 paste 이벤트만 보내는 경로는 wmux의 keydown 핸들러가 전혀 안 돌기 때문에 xterm
 * 자체 파이프라인이 유일한 처리 경로인데, 무조건 차단하면 그 경로가 에러도 토스트도
 * 없이 조용히 무동작해진다. 그래서 Cmd+V/Ctrl+V/Ctrl+Shift+V 핸들러가 lastPasteKeydownAt
 * 타임스탬프를 찍고, blockNativePaste는 그 직후(NATIVE_PASTE_RACE_WINDOW_MS 이내)에만
 * "레이스 중"으로 보고 차단한다 — 그 밖의 native paste는 그대로 흘려보내 xterm 자체
 * 처리에 맡긴다.
 *
 * 실제 xterm Terminal + Electron 네이티브 메뉴 액셀러레이터는 jsdom으로 재현할 수
 * 없으므로, (1) 소스 레벨로 타임스탬프 찍기/윈도우 체크가 제자리에 있는지, (2) 그
 * 윈도우 판정 로직 자체(최근 keydown → 차단, 오래됨/없음 → 통과)는 순수 jsdom 이벤트로
 * 검증한다.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

describe('useTerminal blocks xterm native paste only when it races a keydown paste (source-level lock)', () => {
  const openIdx = SRC.indexOf('terminal.open(container)');
  const blockerIdx = SRC.indexOf('blockNativePaste');
  const cleanupIdx = SRC.lastIndexOf('blockNativePaste');
  const stampIndices = [...SRC.matchAll(/lastPasteKeydownAt = Date\.now\(\)/g)].map((m) => m.index ?? -1);

  it('locates terminal.open(container) and the blocker', () => {
    expect(openIdx).toBeGreaterThan(-1);
    expect(blockerIdx).toBeGreaterThan(-1);
  });

  it('registers the blocker on container AFTER terminal.open, in the capture phase', () => {
    expect(blockerIdx).toBeGreaterThan(openIdx);
    expect(SRC).toMatch(/container\.addEventListener\('paste', blockNativePaste, true\)/);
  });

  it('only blocks within the race window — does not unconditionally swallow every native paste', () => {
    expect(SRC).toMatch(
      /if\s*\(\s*Date\.now\(\)\s*-\s*lastPasteKeydownAt\s*>\s*NATIVE_PASTE_RACE_WINDOW_MS\s*\)\s*return;/,
    );
  });

  it('stamps lastPasteKeydownAt in all three keydown paste handlers (Cmd+V, Ctrl+V, Ctrl+Shift+V)', () => {
    // 3곳: isMac Cmd+V, Ctrl+V, Ctrl+Shift+V. 하나라도 빠지면 그 경로는 native paste와
    // 여전히 레이스한다.
    expect(stampIndices.length).toBe(3);
    stampIndices.forEach((idx) => expect(idx).toBeGreaterThan(blockerIdx));
  });

  it('disposes the blocker on unmount with the same capture flag', () => {
    expect(cleanupIdx).toBeGreaterThan(blockerIdx);
    expect(SRC).toMatch(/container\.removeEventListener\('paste', blockNativePaste, true\)/);
  });

  it('gates both the registration and the cleanup behind a macOS-only platform check', () => {
    // 리서치 2패스 확인: Windows/Linux는 액셀러레이터가 렌더러 우선 + preventDefault로
    // 억제되고 Electron paste role이 registerAccelerator:false라 레이스할 두 번째 네이티브
    // writer가 없다. Linux는 X11 middle-click PRIMARY paste 오검출 위험까지 있어, 가드는
    // macOS에서만 켜야 한다. isMac은 이 파일의 기존 관례(darwin 판별)를 그대로 쓴다.
    expect(SRC).toMatch(/const isMac = window\.electronAPI\?\.platform === 'darwin';/);
    expect(SRC).toMatch(/if\s*\(isMac\)\s*\{\s*container\.addEventListener\('paste', blockNativePaste, true\);\s*\}/);
    expect(SRC).toMatch(/if\s*\(isMac\)\s*\{\s*container\.removeEventListener\('paste', blockNativePaste, true\);\s*\}/);
  });
});

describe('windowed capture-phase blocker (DOM mechanism, mirrors the deployed logic)', () => {
  const NATIVE_PASTE_RACE_WINDOW_MS = 300;

  function setUp() {
    const container = document.createElement('div');
    const child = document.createElement('textarea'); // xterm의 hidden textarea 역할
    container.appendChild(child);
    document.body.appendChild(container);

    const childListener = vi.fn(); // xterm 자체 paste 핸들러 역할
    child.addEventListener('paste', childListener);

    let lastPasteKeydownAt = 0;
    const blockNativePaste = (e: Event): void => {
      if (Date.now() - lastPasteKeydownAt > NATIVE_PASTE_RACE_WINDOW_MS) return;
      e.preventDefault();
      e.stopPropagation();
    };
    container.addEventListener('paste', blockNativePaste, true);

    return {
      container,
      childListener,
      markKeydown: () => { lastPasteKeydownAt = Date.now(); },
      dispatchPaste: () => child.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true })),
      cleanup: () => document.body.removeChild(container),
    };
  }

  it('blocks a native paste that follows a keydown-triggered paste within the race window', () => {
    const { markKeydown, dispatchPaste, childListener, cleanup } = setUp();

    markKeydown(); // Cmd+V keydown handler가 방금 실행됨을 시뮬레이션
    dispatchPaste(); // NSMenu key equivalent가 거의 동시에 쏘는 native paste

    expect(childListener).not.toHaveBeenCalled();
    cleanup();
  });

  it('lets a standalone native paste through when no keydown just fired (menu click / VoiceOver / automation)', () => {
    const { dispatchPaste, childListener, cleanup } = setUp();

    // markKeydown()을 아예 안 부름 — 메뉴바 마우스 클릭이나 UI 자동화처럼 keydown이
    // 없는 경로. 팀 리뷰가 잡은 회귀: 예전 무조건-차단 버전은 이 케이스도 죽였다.
    dispatchPaste();

    expect(childListener).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('lets a native paste through once the race window has elapsed since the last keydown', () => {
    const { markKeydown, dispatchPaste, childListener, cleanup } = setUp();

    markKeydown();
    vi.useFakeTimers();
    try {
      // advanceTimersByTime 이후에도 fake clock 상태에서 dispatch해야 한다 —
      // useRealTimers()를 먼저 부르면 진짜 시계로 되돌아가 경과 시간이 사라진다.
      vi.advanceTimersByTime(NATIVE_PASTE_RACE_WINDOW_MS + 1);
      dispatchPaste();
    } finally {
      vi.useRealTimers();
    }

    expect(childListener).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('never registers the blocker on non-macOS, so a native paste reaches xterm even mid-race', () => {
    // 배포 로직 미러: 소스와 똑같이 window.electronAPI.platform으로 isMac을 도출한다.
    // 비-macOS면 container 리스너를 아예 안 붙이므로, keydown 직후(레이스 창 안)라도
    // native paste가 그대로 자식(xterm textarea)까지 도달한다. Windows/Linux엔 레이스할
    // 두 번째 writer가 없고, Linux는 X11 middle-click PRIMARY paste 오검출 위험까지 있다.
    const w = window as unknown as { electronAPI?: { platform?: string } };
    const prev = w.electronAPI;
    w.electronAPI = { platform: 'win32' }; // 비-macOS (Windows/Linux 동일 결론)
    try {
      const container = document.createElement('div');
      const child = document.createElement('textarea');
      container.appendChild(child);
      document.body.appendChild(container);

      const childListener = vi.fn();
      child.addEventListener('paste', childListener);

      let lastPasteKeydownAt = 0;
      const blockNativePaste = (e: Event): void => {
        if (Date.now() - lastPasteKeydownAt > NATIVE_PASTE_RACE_WINDOW_MS) return;
        e.preventDefault();
        e.stopPropagation();
      };
      const isMac = w.electronAPI?.platform === 'darwin'; // 소스와 동일한 도출식
      if (isMac) container.addEventListener('paste', blockNativePaste, true);

      lastPasteKeydownAt = Date.now(); // Ctrl+V가 방금 눌림 = 레이스 창 안
      child.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));

      expect(isMac).toBe(false);
      expect(childListener).toHaveBeenCalledTimes(1); // 가드가 없으니 그대로 통과
      document.body.removeChild(container);
    } finally {
      w.electronAPI = prev;
    }
  });
});
