// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-level regression lock + DOM mechanism verification.
 *
 * wmux does not call Menu.setApplicationMenu(), so Electron default menu applies; on macOS
 * Cmd+V is handled as NSMenu key equivalent and cannot be blocked by keydown preventDefault().
 * xterm.js attaches its own native 'paste' listener on terminal.element/textarea, so when that
 * native paste races wmux custom async IPC paste (pastePtyChunked) writing to the same pty,
 * paste prefix is lost (Windows does not reproduce — shortcuts integrate in DOM keydown flow).
 *
 * First version blocked native paste unconditionally; team review (Claude pass) caught real
 * regression: Edit>Paste via menu or VoiceOver/UI automation sending synthetic paste without
 * keydown never runs wmux keydown handlers — xterm pipeline is the only path; unconditional
 * block silently broke it with no error or toast. So Cmd+V/Ctrl+V/Ctrl+Shift+V handlers stamp
 * lastPasteKeydownAt; blockNativePaste blocks only within NATIVE_PASTE_RACE_WINDOW_MS after —
 * other native paste flows to xterm handling.
 *
 * Real xterm Terminal + Electron native menu accelerators cannot be reproduced in jsdom, so:
 * (1) source-level check that timestamp/window logic is in place, (2) pure jsdom events verify
 * window logic itself (recent keydown → block, stale/none → pass).
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
    // Three sites: isMac Cmd+V, Ctrl+V, Ctrl+Shift+V. Missing any one still races native paste.
    expect(stampIndices.length).toBe(3);
    stampIndices.forEach((idx) => expect(idx).toBeGreaterThan(blockerIdx));
  });

  it('disposes the blocker on unmount with the same capture flag', () => {
    expect(cleanupIdx).toBeGreaterThan(blockerIdx);
    expect(SRC).toMatch(/container\.removeEventListener\('paste', blockNativePaste, true\)/);
  });

  it('gates both the registration and the cleanup behind a macOS-only platform check', () => {
    // Two-pass research: Windows/Linux accelerators are renderer-first + suppressible via
    // preventDefault; Electron paste role registerAccelerator:false — no second native writer.
    // Linux also has X11 middle-click PRIMARY paste false-positive risk — guard macOS only.
    // isMac uses existing convention here (darwin check).
    expect(SRC).toMatch(/const isMac = window\.electronAPI\?\.platform === 'darwin';/);
    expect(SRC).toMatch(/if\s*\(isMac\)\s*\{\s*container\.addEventListener\('paste', blockNativePaste, true\);\s*\}/);
    expect(SRC).toMatch(/if\s*\(isMac\)\s*\{\s*container\.removeEventListener\('paste', blockNativePaste, true\);\s*\}/);
  });
});

describe('windowed capture-phase blocker (DOM mechanism, mirrors the deployed logic)', () => {
  const NATIVE_PASTE_RACE_WINDOW_MS = 300;

  function setUp() {
    const container = document.createElement('div');
    const child = document.createElement('textarea'); // stands in for xterm hidden textarea
    container.appendChild(child);
    document.body.appendChild(container);

    const childListener = vi.fn(); // stands in for xterm native paste handler
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

    markKeydown(); // simulate Cmd+V keydown handler just ran
    dispatchPaste(); // native paste NSMenu key equivalent fires almost simultaneously

    expect(childListener).not.toHaveBeenCalled();
    cleanup();
  });

  it('lets a standalone native paste through when no keydown just fired (menu click / VoiceOver / automation)', () => {
    const { dispatchPaste, childListener, cleanup } = setUp();

    // Do not call markKeydown() — path without keydown like menu click or UI automation.
    // Team review regression: old unconditional-block version killed this case too.
    dispatchPaste();

    expect(childListener).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('lets a native paste through once the race window has elapsed since the last keydown', () => {
    const { markKeydown, dispatchPaste, childListener, cleanup } = setUp();

    markKeydown();
    vi.useFakeTimers();
    try {
      // Dispatch while still on fake clock after advanceTimersByTime —
      // calling useRealTimers() first restores real clock and loses elapsed time.
      vi.advanceTimersByTime(NATIVE_PASTE_RACE_WINDOW_MS + 1);
      dispatchPaste();
    } finally {
      vi.useRealTimers();
    }

    expect(childListener).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('never registers the blocker on non-macOS, so a native paste reaches xterm even mid-race', () => {
    // Mirror deployed logic: derive isMac from window.electronAPI.platform like source.
    // Off macOS, container listener is not attached, so native paste reaches child (xterm
    // textarea) even right after keydown (inside race window). Windows/Linux have no second
    // writer to race; Linux also has X11 middle-click PRIMARY paste false-positive risk.
    const w = window as unknown as { electronAPI?: { platform?: string } };
    const prev = w.electronAPI;
    w.electronAPI = { platform: 'win32' }; // non-macOS (same conclusion for Windows/Linux)
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
      const isMac = w.electronAPI?.platform === 'darwin'; // same derivation as source
      if (isMac) container.addEventListener('paste', blockNativePaste, true);

      lastPasteKeydownAt = Date.now(); // Ctrl+V just pressed = inside race window
      child.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));

      expect(isMac).toBe(false);
      expect(childListener).toHaveBeenCalledTimes(1); // no guard registered, passes through

      document.body.removeChild(container);
    } finally {
      w.electronAPI = prev;
    }
  });
});
