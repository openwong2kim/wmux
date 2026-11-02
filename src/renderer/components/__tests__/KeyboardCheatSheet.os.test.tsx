/**
 * Tests for KeyboardCheatSheet (T7).
 *
 * The repository's vitest config runs in `node` environment without a DOM
 * library installed (no jsdom / happy-dom / @testing-library/react), so we
 * test the cheat sheet via two complementary strategies:
 *   1. Pure helpers exported from KeyboardCheatSheet.tsx
 *      (buildShortcuts).
 *   2. React DOM Server's `renderToStaticMarkup` for snapshot-style
 *      assertions against the presentational `KeyboardCheatSheetView`
 *      component. Effects do NOT run in renderToStaticMarkup so behaviour
 *      driven by useEffect (timer ticks, visibilitychange listener) is
 *      validated by exercising the underlying logic directly: we drive
 *      the View with a controlled `progress` prop and verify the timer
 *      math via tick simulation.
 *
 * Mocks:
 *   - `useStore` is mocked so `cheatSheetDismissed` and
 *     `setCheatSheetDismissed` are observable.
 *   - `window.electronAPI.platform` is mocked per test (darwin vs win32).
 *   - i18n `t` is the real implementation (uses static maps, no async).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildShortcuts,
  KeyboardCheatSheetView,
  CHEAT_SHEET_DURATION_MS,
} from '../KeyboardCheatSheet';

// ─── Pure helper tests ────────────────────────────────────────────────────────

describe('buildShortcuts', () => {
  it('darwin entries use ⌘ for the OS-aware shortcuts', () => {
    const list = buildShortcuts('darwin');
    const split = list.find((e) => e.label === 'cheatSheet.splitHorizontal');
    const settings = list.find((e) => e.label === 'cheatSheet.openSettings');
    const newWs = list.find((e) => e.label === 'cheatSheet.newWorkspace');
    expect(split?.combo).toBe('⌘D');
    expect(settings?.combo).toBe('⌘,');
    expect(newWs?.combo).toBe('⌘N');
  });

  it('win32 entries use "Ctrl+" for the OS-aware shortcuts', () => {
    const list = buildShortcuts('win32');
    const split = list.find((e) => e.label === 'cheatSheet.splitHorizontal');
    const settings = list.find((e) => e.label === 'cheatSheet.openSettings');
    const newWs = list.find((e) => e.label === 'cheatSheet.newWorkspace');
    expect(split?.combo).toBe('Ctrl+D');
    expect(settings?.combo).toBe('Ctrl+,');
    expect(newWs?.combo).toBe('Ctrl+N');
  });

  it('tmux prefix is literal Ctrl+B on every platform (⌃B on macOS)', () => {
    const macList = buildShortcuts('darwin');
    const winList = buildShortcuts('win32');
    const macTmux = macList.find((e) => e.label === 'tmux prefix');
    const winTmux = winList.find((e) => e.label === 'tmux prefix');
    expect(macTmux?.combo).toBe('⌃B');
    expect(macTmux?.literal).toBe(true);
    expect(winTmux?.combo).toBe('Ctrl+B');
    expect(winTmux?.literal).toBe(true);
  });

  it('bookmark line is literal Ctrl+M on every platform (⌃M on macOS)', () => {
    const macList = buildShortcuts('darwin');
    const winList = buildShortcuts('win32');
    expect(macList.find((e) => e.label === 'Bookmark line')?.combo).toBe('⌃M');
    expect(winList.find((e) => e.label === 'Bookmark line')?.combo).toBe('Ctrl+M');
  });

  it('toggleSidebar is literal Ctrl+Shift+B on every platform (⌃⇧B on macOS)', () => {
    const macList = buildShortcuts('darwin');
    const winList = buildShortcuts('win32');
    expect(macList.find((e) => e.label === 'cheatSheet.toggleSidebar')?.combo).toBe('⌃⇧B');
    expect(winList.find((e) => e.label === 'cheatSheet.toggleSidebar')?.combo).toBe('Ctrl+Shift+B');
  });

  it('returns 12 shortcut entries', () => {
    expect(buildShortcuts('darwin').length).toBe(12);
    expect(buildShortcuts('win32').length).toBe(12);
  });

  it('includes the Maximize pane entry (the literal Ctrl+B prefix, then Z)', () => {
    const macList = buildShortcuts('darwin');
    const winList = buildShortcuts('win32');
    expect(macList.find((e) => e.label === 'Maximize pane')?.combo).toBe('⌃B Z');
    expect(winList.find((e) => e.label === 'Maximize pane')?.combo).toBe('Ctrl+B Z');
    expect(macList.find((e) => e.label === 'Maximize pane')?.literal).toBe(true);
  });

  it('includes the Ctrl+Shift+Arrow move-focus entry (literal Ctrl on every platform)', () => {
    const macList = buildShortcuts('darwin');
    const winList = buildShortcuts('win32');
    expect(macList.find((e) => e.label === 'Move focus')?.combo).toBe('⌃⇧Arrows');
    expect(winList.find((e) => e.label === 'Move focus')?.combo).toBe('Ctrl+Shift+Arrows');
  });

  it('includes the Alt+Up/Down workspace-switch entry', () => {
    const winList = buildShortcuts('win32');
    expect(winList.find((e) => e.label === 'Switch workspace')?.combo).toBe('Alt+↑ / Alt+↓');
    expect(buildShortcuts('darwin').find((e) => e.label === 'Switch workspace')?.combo).toBe('⌥↑ / ⌥↓');
  });

  it('cyclePane combo is literal "Ctrl+Tab" on every platform', () => {
    const macList = buildShortcuts('darwin');
    const winList = buildShortcuts('win32');
    expect(macList.find((e) => e.label === 'cheatSheet.cyclePane')?.combo).toBe('⌃Tab');
    expect(winList.find((e) => e.label === 'cheatSheet.cyclePane')?.combo).toBe('Ctrl+Tab');
  });
});

// ─── KeyboardCheatSheetView (renderToStaticMarkup) ────────────────────────────

const noop = () => {
  /* test stub */
};

function renderView(overrides: Partial<Parameters<typeof KeyboardCheatSheetView>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(KeyboardCheatSheetView, {
      shortcuts: buildShortcuts('win32'),
      title: 'Keyboard shortcuts',
      dismissLabel: 'Dismiss',
      progress: 1,
      onDismiss: noop,
      onMouseEnter: noop,
      onMouseLeave: noop,
      onFocus: noop,
      onBlur: noop,
      translateLabel: (key: string) => key,
      ...overrides,
    }),
  );
}

describe('KeyboardCheatSheetView (renderToStaticMarkup)', () => {
  it('renders the title in an aria-labelled region', () => {
    const html = renderView({ title: 'Keyboard shortcuts' });
    expect(html).toContain('aria-label="Keyboard shortcuts"');
    expect(html).toContain('role="region"');
    expect(html).toContain('>Keyboard shortcuts<');
  });

  it('renders darwin shortcuts with ⌘ modifier', () => {
    const html = renderView({ shortcuts: buildShortcuts('darwin') });
    expect(html).toContain('⌘D');
    expect(html).toContain('⌘N');
    expect(html).toContain('⌘,');
    expect(html).toContain('⌘K');
  });

  it('renders win32 shortcuts with "Ctrl+" modifier', () => {
    const html = renderView({ shortcuts: buildShortcuts('win32') });
    expect(html).toContain('Ctrl+D');
    expect(html).toContain('Ctrl+N');
    expect(html).toContain('Ctrl+,');
    expect(html).toContain('Ctrl+K');
  });

  it('renders the literal Ctrl tmux prefix on darwin as ⌃B', () => {
    const html = renderView({ shortcuts: buildShortcuts('darwin') });
    // Even on darwin the tmux prefix is literal Ctrl, never ⌘.
    expect(html).toContain('⌃B');
    expect(html).toContain('tmux prefix');
  });

  it('renders the literal Ctrl+M bookmark on every platform', () => {
    const macHtml = renderView({ shortcuts: buildShortcuts('darwin') });
    const winHtml = renderView({ shortcuts: buildShortcuts('win32') });
    expect(macHtml).toContain('⌃M');
    expect(winHtml).toContain('Ctrl+M');
  });

  it('has no "Don\'t show again": it opens only when asked', () => {
    const html = renderView();
    expect(html).not.toContain('role="checkbox"');
    expect(html).not.toMatch(/show again/i);
  });

  it('renders the close button with proper aria-label', () => {
    const html = renderView({ dismissLabel: 'Dismiss' });
    expect(html).toContain('aria-label="Dismiss"');
    // A monochrome icon, not a text glyph (DESIGN.md: no glyphs in chrome).
    expect(html).not.toContain('✕');
  });

  it('renders the progress bar at full width when progress=1', () => {
    const html = renderView({ progress: 1 });
    // Progress bar div has style="width:100%;..." somewhere along with the
    // matching data-testid (attribute order is React's choice, so we just
    // verify the testid + width co-occur).
    expect(html).toMatch(/style="width:\s*100%/);
    expect(html).toContain('data-testid="keyboard-cheat-sheet-progress"');
  });

  it('renders the progress bar at 50% width when progress=0.5', () => {
    const html = renderView({ progress: 0.5 });
    expect(html).toMatch(/style="width:\s*50%/);
    expect(html).toContain('data-testid="keyboard-cheat-sheet-progress"');
  });

  it('clamps progress to the [0, 1] range', () => {
    expect(renderView({ progress: -1 })).toMatch(/style="width:\s*0%/);
    expect(renderView({ progress: 5 })).toMatch(/style="width:\s*100%/);
  });

  it('renders all 12 shortcut entries in the list', () => {
    const html = renderView({ shortcuts: buildShortcuts('win32') });
    // Each shortcut entry is rendered inside a <li>; count occurrences of the
    // opening <li tag inside the list to verify all 12 made it.
    // (`<li[\s>]`, not `<li`: the close icon's SVG <line>s would match too.)
    const liMatches = html.match(/<li[\s>]/g) ?? [];
    expect(liMatches.length).toBe(12);
  });
});

// ─── Countdown logic (timer math) ────────────────────────────────────────────

/**
 * Mirror of the tick logic inside the default export's setInterval callback.
 * We pull it out here so the timer math can be exercised without mounting a
 * React tree (which would require a DOM environment for useState/useEffect).
 */
function simulateTicks(
  startMs: number,
  ticks: number,
  tickMs: number,
  paused: () => boolean,
  onExpire: () => void,
): number {
  let remaining = startMs;
  for (let i = 0; i < ticks; i++) {
    if (paused()) continue;
    remaining -= tickMs;
    if (remaining <= 0) {
      onExpire();
      remaining = 0;
      break;
    }
  }
  return remaining;
}

describe('countdown tick logic', () => {
  let expireCount: number;
  // Plain function (not vi.fn) so the parameter type matches `() => void` cleanly
  // in vitest 4's stricter Mock typings.
  const onExpire = () => {
    expireCount += 1;
  };

  beforeEach(() => {
    expireCount = 0;
  });

  it('expires after CHEAT_SHEET_DURATION_MS / 100 ticks (300 ticks at 100ms each)', () => {
    const remaining = simulateTicks(
      CHEAT_SHEET_DURATION_MS,
      CHEAT_SHEET_DURATION_MS / 100,
      100,
      () => false,
      onExpire,
    );
    expect(remaining).toBe(0);
    expect(expireCount).toBe(1);
  });

  it('does not expire while paused (e.g., document hidden)', () => {
    let docHidden = true;
    const remaining = simulateTicks(
      CHEAT_SHEET_DURATION_MS,
      CHEAT_SHEET_DURATION_MS / 100, // 300 ticks — would normally finish
      100,
      () => docHidden,
      onExpire,
    );
    expect(expireCount).toBe(0);
    expect(remaining).toBe(CHEAT_SHEET_DURATION_MS);
    // Resume — finishes after another full duration of unpaused ticks.
    docHidden = false;
    const after = simulateTicks(
      remaining,
      CHEAT_SHEET_DURATION_MS / 100,
      100,
      () => docHidden,
      onExpire,
    );
    expect(after).toBe(0);
    expect(expireCount).toBe(1);
  });

  it('pauses while hovered, resumes on mouse leave', () => {
    let hovered = false;
    let remaining = simulateTicks(
      CHEAT_SHEET_DURATION_MS,
      100, // 10s of ticks
      100,
      () => hovered,
      onExpire,
    );
    expect(remaining).toBe(CHEAT_SHEET_DURATION_MS - 10_000);

    hovered = true;
    remaining = simulateTicks(remaining, 50, 100, () => hovered, onExpire);
    // Still 20s left because we were hovered the whole time.
    expect(remaining).toBe(CHEAT_SHEET_DURATION_MS - 10_000);

    hovered = false;
    remaining = simulateTicks(remaining, 200, 100, () => hovered, onExpire);
    expect(remaining).toBe(0);
    expect(expireCount).toBe(1);
  });

  it('CHEAT_SHEET_DURATION_MS is exactly 30_000 (30s) per spec', () => {
    expect(CHEAT_SHEET_DURATION_MS).toBe(30_000);
  });
});

// ─── Default export contract via mocked store ────────────────────────────────
//
// The default export reads `cheatSheetDismissed` from the Zustand store; if
// it's true, the component returns null (renders nothing).  We can verify
// this contract by mounting the default export with mocked store state,
// using renderToStaticMarkup (no effects run, but the early-return is
// evaluated synchronously during render).

describe('KeyboardCheatSheet default export — early return', () => {
  let originalElectronAPI: unknown;

  beforeEach(() => {
    originalElectronAPI = (globalThis as unknown as { window?: { electronAPI?: unknown } }).window
      ?.electronAPI;
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    if (typeof window !== 'undefined') {
      (window as unknown as { electronAPI?: unknown }).electronAPI = originalElectronAPI;
    }
  });

  it('renders nothing when cheatSheetDismissed === true', async () => {
    vi.resetModules();
    vi.doMock('../../stores', () => ({
      useStore: ((selector: (s: unknown) => unknown) =>
        selector({
          cheatSheetDismissed: true,
          setCheatSheetDismissed: vi.fn(),
          locale: 'en',
        })) as unknown,
    }));
    // Stub a minimal `window` so the platform lookup doesn't blow up.
    vi.stubGlobal('window', { electronAPI: { platform: 'win32' } });
    const mod = await import('../KeyboardCheatSheet');
    const html = renderToStaticMarkup(createElement(mod.default));
    expect(html).toBe('');
  });

  it('renders the overlay when cheatSheetDismissed === false', async () => {
    vi.resetModules();
    vi.doMock('../../stores', () => ({
      useStore: ((selector: (s: unknown) => unknown) =>
        selector({
          cheatSheetDismissed: false,
          setCheatSheetDismissed: vi.fn(),
          locale: 'en',
        })) as unknown,
    }));
    vi.stubGlobal('window', { electronAPI: { platform: 'win32' } });
    const mod = await import('../KeyboardCheatSheet');
    const html = renderToStaticMarkup(createElement(mod.default));
    expect(html).not.toBe('');
    expect(html).toContain('role="region"');
    expect(html).toContain('Ctrl+D'); // win32 shortcut visible
  });

  it('uses ⌘ on darwin when default-rendered', async () => {
    vi.resetModules();
    vi.doMock('../../stores', () => ({
      useStore: ((selector: (s: unknown) => unknown) =>
        selector({
          cheatSheetDismissed: false,
          setCheatSheetDismissed: vi.fn(),
          locale: 'en',
        })) as unknown,
    }));
    vi.stubGlobal('window', { electronAPI: { platform: 'darwin' } });
    const mod = await import('../KeyboardCheatSheet');
    const html = renderToStaticMarkup(createElement(mod.default));
    expect(html).toContain('⌘D');
    // tmux prefix still literal Ctrl.
    expect(html).toContain('⌃B');
  });

  // Force-show override (Ctrl+B ? prefix action). The selector branch must
  // re-render the overlay even when the user has permanently dismissed it,
  // and must continue to hide it when the override is off.
  it('renders the overlay when dismissed=true AND cheatSheetForceShown=true', async () => {
    vi.resetModules();
    vi.doMock('../../stores', () => ({
      useStore: ((selector: (s: unknown) => unknown) =>
        selector({
          cheatSheetDismissed: true,
          setCheatSheetDismissed: vi.fn(),
          cheatSheetForceShown: true,
          setCheatSheetForceShown: vi.fn(),
          locale: 'en',
        })) as unknown,
    }));
    vi.stubGlobal('window', { electronAPI: { platform: 'win32' } });
    const mod = await import('../KeyboardCheatSheet');
    const html = renderToStaticMarkup(createElement(mod.default));
    expect(html).not.toBe('');
    expect(html).toContain('role="region"');
  });

  it('renders nothing when dismissed=true AND cheatSheetForceShown=false', async () => {
    vi.resetModules();
    vi.doMock('../../stores', () => ({
      useStore: ((selector: (s: unknown) => unknown) =>
        selector({
          cheatSheetDismissed: true,
          setCheatSheetDismissed: vi.fn(),
          cheatSheetForceShown: false,
          setCheatSheetForceShown: vi.fn(),
          locale: 'en',
        })) as unknown,
    }));
    vi.stubGlobal('window', { electronAPI: { platform: 'win32' } });
    const mod = await import('../KeyboardCheatSheet');
    const html = renderToStaticMarkup(createElement(mod.default));
    expect(html).toBe('');
  });
});
