import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react';
import { useStore } from '../../stores';
import { tokenAttrs } from '../../themes';
import StatusBar from '../StatusBar/StatusBar';
import { workspaceChromeInTitlebar } from './railPageTitle';
import SidebarToggle from './SidebarToggle';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconPlus } from '../icons';
import PresetPicker from '../Sidebar/PresetPicker';
import { SIDEBAR_COMPACT_WIDTH } from '../../utils/sidebarLayout';
import { overlayColors } from '../../utils/titlebarOverlay';

/**
 * Bridge redesign — custom 40px titlebar (DESIGN.md "Titlebar").
 *
 * Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/shell/TitleBar.tsx), MIT License, Copyright (c) 2026 Nick
 *
 * The BrowserWindow is created with `titleBarStyle: 'hidden'` (+ Windows
 * `titleBarOverlay`), so this component IS the window's top edge:
 *   - the whole bar is a drag region (`-webkit-app-region: drag`); any
 *     interactive child must opt out with `no-drag` or clicks die silently.
 *   - the left segment is tinted `--bg-mantle` and width-matched to the
 *     workspace sidebar so the top-left corner reads as one continuous
 *     panel with the sidebar below it.
 *   - the right side reserves the native window-controls area via the
 *     `titlebar-area-*` CSS env vars (Windows overlay). On macOS the
 *     traffic lights sit top-left instead, so the LEFT edge reserves 72px.
 *   - bottom divider is an inset hairline (box-shadow), not a border, so the
 *     40px content box stays exact.
 */

/** Height shared with main's titleBarOverlay config (registerHandlers.ts). */
export const TITLEBAR_HEIGHT = 40;

// macOS 트래픽 라이트 예약 폭. macOS 26(Tahoe)에서 신호등이 커져 72px로는
// 로고가 초록 버튼에 겹친다(owner-reported 2026-07-18) — x=12 배치 기준
// 초록 끝 ~65px + 여백 15px.
export const MAC_TRAFFIC_LIGHT_RESERVE = 80;

/** Where the `wmux` wordmark starts, past the traffic-light reserve (or the
 *  window's left edge). One inset for the open and the collapsed segment, so
 *  the brand never moves when the sidebar toggles. */
export const BRAND_INSET = 12;

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
      // The overlay strip sits on the window frame: the colour it actually
      // paints, as hex (overlayColors). Skipped while unreadable (first paint).
      const colors = overlayColors();
      if (colors) send(colors);
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

/**
 * macOS: whether the window is in native fullscreen — the traffic lights are
 * hidden there, so the 72px left reserve must collapse (a fixed reserve in
 * fullscreen is exactly the "top chrome shifted right for no reason" bug).
 * Push (enter/leave-full-screen from main) + one mount-time pull for the
 * initial state; the VS Code/Hyper pattern — there is no reliable pure-
 * renderer fullscreen signal on mac.
 */
function useMacFullscreen(isMac: boolean): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!isMac) return;
    const api = window.electronAPI?.window;
    let alive = true;
    void api?.isFullScreen?.().then((fs: boolean) => {
      if (alive) setFullscreen(fs);
    }).catch(() => {
      /* mount-time pull is best-effort — the push listener corrects state */
    });
    const off = api?.onFullscreenChanged?.((fs: boolean) => setFullscreen(fs));
    return () => {
      alive = false;
      off?.();
    };
  }, [isMac]);
  return fullscreen;
}

/**
 * Mark <html data-fullscreen> while the window is in native fullscreen on any
 * platform, so the floating sheet can drop its frame margins and fill the
 * window. Same push + mount-time pull as useMacFullscreen.
 */
function useFullscreenAttribute(): void {
  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI?.window;
    const root = document.documentElement;
    const apply = (fs: boolean) => { if (fs) root.setAttribute('data-fullscreen', ''); else root.removeAttribute('data-fullscreen'); };
    let alive = true;
    void api?.isFullScreen?.().then((fs: boolean) => { if (alive) apply(fs); }).catch(() => {
      /* best-effort: the push listener corrects state */
    });
    const off = api?.onFullscreenChanged?.(apply);
    return () => { alive = false; off?.(); };
  }, []);
}

export default function Titlebar() {
  const t = useT();
  useFullscreenAttribute();
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const platform = rendererPlatform();
  const isMac = platform === 'darwin';
  const isWin = platform === 'win32';
  const macFullscreen = useMacFullscreen(isMac);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Anchor the preset dropdown UNDER the + button. Measured at open time
  // (the button's viewport rect), clamped so the 208px menu never overflows
  // the window — without this the picker's legacy sidebar anchor (`right-2`)
  // resolved against the full-width header and opened at the far right edge.
  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerLeft, setPickerLeft] = useState(8);
  const togglePicker = useCallback(() => {
    setPickerOpen((v) => {
      if (!v) {
        const r = plusBtnRef.current?.getBoundingClientRect();
        const menuWidth = 208; // w-52
        if (r) setPickerLeft(Math.max(8, Math.min(r.left, window.innerWidth - menuWidth - 8)));
      }
      return !v;
    });
  }, []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  // New workspace belongs to the Workspaces page, and only while the sidebar
  // is hidden: an open sidebar's header already carries it, and a rail page
  // hides it. The picker closes with its button.
  const showWorkspaceChrome = useStore(workspaceChromeInTitlebar);

  useTitleBarOverlaySync();

  // Sidebar is 240px expanded / 48px mini (Sidebar.tsx, MiniSidebar.tsx).
  // The mantle segment mirrors it only when the sidebar is docked left —
  // docked right there is no panel below the top-left corner to fuse with.
  const compactSegment = sidebarPosition === 'left' && !sidebarVisible;
  // Left collapsed, the 48px segment cannot hold the +; the rail's own + is
  // its home then (MiniSidebar).
  const showPlus = showWorkspaceChrome && !compactSegment;
  useEffect(() => { if (!showPlus) setPickerOpen(false); }, [showPlus]);
  // #1481 — the expanded width is the user's (drag handle, persisted).
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  // The icon rail (48px) always sits on the frame at the left; the open
  // sidebar follows it inside the sheet (+1px for the sheet's edge).
  const leftSegmentWidth = sidebarPosition === 'left' ? SIDEBAR_COMPACT_WIDTH + (sidebarVisible ? sidebarWidth + 1 : 0) : 0;

  // macOS 트래픽 라이트 예약: 세그먼트가 충분히 넓으면(확장 240px) 세그먼트
  // "안쪽" 패딩으로 품는다 — 헤더에 걸면 세그먼트 전체가 예약만큼 밀려 아래
  // 사이드바 경계와 어긋난다(owner-reported). 미니(48px)·세그먼트 없음일 때만
  // 기존처럼 헤더에 예약.
  const macReserve = isMac && !macFullscreen ? MAC_TRAFFIC_LIGHT_RESERVE : 0;
  const reserveInSegment = macReserve > 0 && leftSegmentWidth > macReserve;

  return (
    <header
      className="wmux-titlebar flex items-stretch shrink-0 select-none bg-[var(--bg-base)]"
      style={{
        height: TITLEBAR_HEIGHT,
        // Whole bar drags the window; interactive children opt out below.
        // (WebkitAppRegion is Electron-only, hence the cast.)
        WebkitAppRegion: 'drag',
        // Inset hairline instead of border-bottom — keeps 40px exact.
        boxShadow: 'inset 0 -1px 0 var(--stroke)',
        // Windows overlay: reserve exactly the native-controls strip the OS
        // draws over us. env() resolves to 0/100vw when no overlay exists.
        paddingRight: isWin
          ? 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))'
          : 0,
        // macOS traffic lights sit top-left (trafficLightPosition,
        // createWindow) — reserve MAC_TRAFFIC_LIGHT_RESERVE px for them,
        // EXCEPT in native fullscreen
        // where the lights are hidden and a fixed reserve just shifts the
        // whole top row right (owner-reported on mac). 세그먼트가 예약을
        // 품는 경우엔 헤더 예약 0 (위 reserveInSegment 참조).
        paddingLeft: reserveInSegment ? 0 : macReserve,
      } as CSSProperties}
      data-testid="titlebar"
      {...tokenAttrs('bgBase', 'bg')}
    >
      <div
        className={`wmux-titlebar-segment flex items-center shrink-0 gap-2 ${compactSegment ? 'pr-2' : 'pr-3'} overflow-hidden ${leftSegmentWidth ? 'bg-[var(--bg-mantle)]' : ''}`}
        style={{
          // Collapsed, the brand and the toggle outgrow the rail's 48px: the
          // segment takes their width instead (the look paints it transparent).
          width: compactSegment ? undefined : leftSegmentWidth || undefined,
          // The brand starts BRAND_INSET past the traffic lights, whether the
          // segment holds their reserve (open) or the header does (collapsed),
          // so it stays put when the sidebar toggles.
          paddingLeft: (reserveInSegment ? MAC_TRAFFIC_LIGHT_RESERVE : 0) + BRAND_INSET,
          // Fuse with the sidebar below via the same inset hairline seam.
          boxShadow: leftSegmentWidth ? 'inset -1px 0 0 var(--stroke)' : undefined,
        }}
        {...tokenAttrs('bgMantle', 'bg')}
      >
        <span className="text-[14px] font-semibold text-[var(--text-main)] tracking-tight" {...tokenAttrs('textMain', 'text')}>
          wmux
        </span>
        {/* Left to right: wmux, the sidebar toggle (the slot the + held: the
            segment's end while the sidebar is open), then the + when shown. */}
        <SidebarToggle className={compactSegment ? undefined : 'ml-auto'} />
        {showPlus && <button
          ref={plusBtnRef}
          type="button"
          onClick={togglePicker}
          className={`flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--hover-fill)] transition-colors duration-150 ${FOCUS_RING}`}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          title={t('sidebar.newWorkspaceTooltip')}
          aria-label={t('sidebar.newWorkspaceTooltip')}
          data-onboarding-target="add-workspace"
        >
          <IconPlus size={14} />
        </button>}
        {pickerOpen && showPlus && (
          <PresetPicker
            onClose={closePicker}
            anchorStyle={{ left: pickerLeft, top: TITLEBAR_HEIGHT + 4 }}
          />
        )}
      </div>
      {/* The status strip (P1.5) fills the rest of the bar: transient
          indicators on the left, the status/clock/settings cluster pinned
          against the native-controls reserve on the right. Its own flex-1
          gap remains the drag surface, with the search & command pill centred
          in it (the palette left the rail: it is not a page). */}
      <StatusBar />
    </header>
  );
}
