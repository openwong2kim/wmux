import { useEffect, type CSSProperties } from 'react';
import { useStore } from '../../stores';
import { tokenAttrs } from '../../themes';
import StatusBar from '../StatusBar/StatusBar';

/**
 * Bridge redesign — custom 36px titlebar (DESIGN.md "Window Chrome").
 *
 * The BrowserWindow is created with `titleBarStyle: 'hidden'` (+ Windows
 * `titleBarOverlay`), so this component IS the window's top edge:
 *   - the whole bar is a drag region (`-webkit-app-region: drag`); any
 *     interactive child must opt out with `no-drag` or clicks die silently
 *     (Warp shipped without a drag region and ate weeks of bug reports —
 *     DESIGN.md references).
 *   - the left segment is tinted `--bg-mantle` and width-matched to the
 *     workspace sidebar so the top-left corner reads as one continuous
 *     panel with the sidebar below it (orca cue).
 *   - the right side reserves the native window-controls area via the
 *     `titlebar-area-*` CSS env vars (Windows overlay). On macOS the
 *     traffic lights sit top-left instead, so the LEFT edge reserves 72px.
 *   - bottom divider is an inset hairline (box-shadow), not a border, so the
 *     36px content box stays exact.
 */

/** Height shared with main's titleBarOverlay config (registerHandlers.ts). */
export const TITLEBAR_HEIGHT = 36;

// Lazy + guarded platform read: module-level `window` access crashes node-env
// test imports, and electronAPI may be absent under jsdom (see the
// electronAPI?.platform optional-chain lesson from the fix-sprint).
function rendererPlatform(): NodeJS.Platform | undefined {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.platform;
}

/**
 * Keep the native Windows window controls (titleBarOverlay) styled to the
 * active theme. Reads the resolved CSS vars off <html> and pushes them to
 * main whenever the theme changes — either via the data-theme attribute
 * (built-in themes) or inline style vars (custom theme editor).
 */
function useTitleBarOverlaySync(): void {
  useEffect(() => {
    if (rendererPlatform() !== 'win32') return;
    const send = window.electronAPI?.window?.setTitleBarOverlay;
    if (!send) return;
    const push = () => {
      const cs = getComputedStyle(document.documentElement);
      // MUST be --bg-base: the overlay strip sits on the titlebar's right,
      // which is bgBase — pushing bgMantle (the left-segment tint) made the
      // window buttons read as a mismatched block (owner-reported on light).
      const color = cs.getPropertyValue('--bg-base').trim();
      const symbolColor = cs.getPropertyValue('--text-sub').trim();
      // Main validates #RGB/#RRGGBB; skip empty reads during first paint.
      if (color && symbolColor) send({ color, symbolColor });
    };
    push();
    const mo = new MutationObserver(push);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    return () => mo.disconnect();
  }, []);
}

export default function Titlebar() {
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const platform = rendererPlatform();
  const isMac = platform === 'darwin';
  const isWin = platform === 'win32';

  useTitleBarOverlaySync();

  // Sidebar is 240px expanded / 48px mini (Sidebar.tsx, MiniSidebar.tsx).
  // The mantle segment mirrors it only when the sidebar is docked left —
  // docked right there is no panel below the top-left corner to fuse with.
  const leftSegmentWidth = sidebarPosition === 'left' ? (sidebarVisible ? 240 : 48) : 0;

  return (
    <header
      className="flex items-stretch shrink-0 select-none bg-[var(--bg-base)]"
      style={{
        height: TITLEBAR_HEIGHT,
        // Whole bar drags the window; interactive children opt out below.
        // (WebkitAppRegion is Electron-only, hence the cast.)
        WebkitAppRegion: 'drag',
        // Inset hairline instead of border-bottom — keeps 36px exact.
        boxShadow: 'inset 0 -1px 0 var(--border-soft)',
        // Windows overlay: reserve exactly the native-controls strip the OS
        // draws over us. env() resolves to 0/100vw when no overlay exists.
        paddingRight: isWin
          ? 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))'
          : 0,
        // macOS traffic lights sit top-left (trafficLightPosition, createWindow).
        paddingLeft: isMac ? 72 : 0,
      } as CSSProperties}
      data-testid="titlebar"
      {...tokenAttrs('bgBase', 'bg')}
    >
      <div
        className={`flex items-center gap-2 px-3 overflow-hidden ${leftSegmentWidth ? 'bg-[var(--bg-mantle)]' : ''}`}
        style={{
          width: leftSegmentWidth || undefined,
          // Fuse with the sidebar below via the same inset hairline seam.
          boxShadow: leftSegmentWidth ? 'inset -1px 0 0 var(--border-soft)' : undefined,
        }}
        {...tokenAttrs('bgMantle', 'bg')}
      >
        <div
          aria-hidden
          className="grid place-items-center rounded shrink-0 text-[10px] font-extrabold text-[var(--accent-blue)] bg-[var(--bg-surface)]"
          style={{ width: 15, height: 15, border: '1px solid var(--border-soft)' }}
          {...tokenAttrs('accent', 'text')}
        >
          w
        </div>
        {/* Mark only — the sidebar header right below already says WMUX, and
            the workspace name lives at the status strip's far left (its
            original status-row spot). Owner call: no duplicated wordmarks. */}
      </div>
      {/* The status strip (P1.5) fills the rest of the bar: transient
          indicators on the left, the status/clock/settings cluster pinned
          against the native-controls reserve on the right. Its own flex-1
          gap remains the drag surface. Deliberately no search box here
          (owner decision, DESIGN.md) — ⌘K stays a shortcut. */}
      <StatusBar />
    </header>
  );
}
