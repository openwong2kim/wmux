import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react';
import { useStore } from '../../stores';
import { tokenAttrs } from '../../themes';
import StatusBar from '../StatusBar/StatusBar';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconPlus } from '../icons';
import PresetPicker from '../Sidebar/PresetPicker';

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

export default function Titlebar() {
  const t = useT();
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

  useTitleBarOverlaySync();

  // Sidebar is 240px expanded / 48px mini (Sidebar.tsx, MiniSidebar.tsx).
  // The mantle segment mirrors it only when the sidebar is docked left —
  // docked right there is no panel below the top-left corner to fuse with.
  const leftSegmentWidth = sidebarPosition === 'left' ? (sidebarVisible ? 240 : 48) : 0;

  // macOS 트래픽 라이트 예약(72px): 세그먼트가 충분히 넓으면(확장 240px) 세그먼트
  // "안쪽" 패딩으로 품는다 — 헤더에 걸면 세그먼트 전체가 72px 밀려 아래
  // 사이드바 경계와 어긋난다(owner-reported). 미니(48px)·세그먼트 없음일 때만
  // 기존처럼 헤더에 예약.
  const macReserve = isMac && !macFullscreen ? 72 : 0;
  const reserveInSegment = macReserve > 0 && leftSegmentWidth > macReserve;

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
        // macOS traffic lights sit top-left (trafficLightPosition,
        // createWindow) — reserve 72px for them, EXCEPT in native fullscreen
        // where the lights are hidden and a fixed reserve just shifts the
        // whole top row right (owner-reported on mac). 세그먼트가 예약을
        // 품는 경우엔 헤더 예약 0 (위 reserveInSegment 참조).
        paddingLeft: reserveInSegment ? 0 : macReserve,
      } as CSSProperties}
      data-testid="titlebar"
      {...tokenAttrs('bgBase', 'bg')}
    >
      <div
        className={`flex items-center gap-2 px-3 overflow-hidden ${leftSegmentWidth ? 'bg-[var(--bg-mantle)]' : ''}`}
        style={{
          width: leftSegmentWidth || undefined,
          // 트래픽 라이트를 세그먼트 안에 품을 때는 px-3 대신 72px 안쪽 패딩.
          paddingLeft: reserveInSegment ? 72 : undefined,
          // Fuse with the sidebar below via the same inset hairline seam.
          boxShadow: leftSegmentWidth ? 'inset -1px 0 0 var(--border-soft)' : undefined,
        }}
        {...tokenAttrs('bgMantle', 'bg')}
      >
        <span className="text-sm font-bold text-[var(--text-main)] tracking-widest font-mono" {...tokenAttrs('textMain', 'text')}>
          WMUX
        </span>
        <button
          ref={plusBtnRef}
          type="button"
          onClick={togglePicker}
          className={`flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-muted)] hover:text-[var(--accent-green)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ml-auto ${FOCUS_RING}`}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          title={t('sidebar.newWorkspaceTooltip')}
          aria-label={t('sidebar.newWorkspaceTooltip')}
          data-onboarding-target="add-workspace"
        >
          <IconPlus size={14} />
        </button>
        {pickerOpen && (
          <PresetPicker
            onClose={closePicker}
            anchorStyle={{ left: pickerLeft, top: TITLEBAR_HEIGHT + 4 }}
          />
        )}
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
