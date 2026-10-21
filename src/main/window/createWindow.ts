import { app, BrowserWindow, nativeTheme, powerMonitor, screen, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { platformChoice } from '../../shared/platform';
import { IPC } from '../../shared/constants';
import { attachPluginFrameNavigation } from '../plugins/pluginFrameNavigation';
import { PLUGIN_PAGE_CSP } from '../plugins/pluginProtocol';
import { PLUGIN_PROTOCOL_SCHEME } from '../../shared/pluginHost';
import { PREVIEW_PROTOCOL_SCHEME } from '../../shared/filePreview';
import { attachFlashFrameAutoClear } from './flashFrame';
import { windowDisplayedReporter } from './windowDisplayed';
import { initialWindowsAppearance, initialWindowsGlass, markWindowGlass, windowsGlassSupported, winWindowOptions } from './windowGlass';
import { revealWhenPainted } from './revealWhenPainted';
import { WINDOW_START_COLORS, startPolarity, startPolarityArg } from '../../shared/windowStartPaint';
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  loadWindowState,
  planRestore,
  saveWindowState,
  saveWindowStateSync,
  type RestorePlan,
  type WindowState,
} from './windowState';

// OS-aware window-icon extension. Mirrors tray.ts so the same generated asset
// set (icon.ico / icon.icns / icon.png) is used in both places.
const iconExt = platformChoice<string>({ win: 'ico', mac: 'icns', linux: 'png', default: 'png' });
const iconFile = `icon.${iconExt}`;

// 'wasm-unsafe-eval' (#1641): the inline-image addon decodes sixel and the
// iTerm2 image protocol's base64 with bundled WebAssembly, and Chromium
// refuses to compile WebAssembly under a bare `script-src 'self'`. It allows
// WebAssembly compilation only — eval() and new Function() stay blocked.
//
// wmux-preview: (#2150) is an image source for the preview tab and a fetch
// target for its PDF renderer, and nothing else: it is deliberately not a
// frame-src, so a served SVG or PDF never becomes a document.
export const MAIN_WINDOW_PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${PREVIEW_PROTOCOL_SCHEME}:`,
  `connect-src 'self' ${PREVIEW_PROTOCOL_SCHEME}:`,
  "font-src 'self'",
  `frame-src 'self' https: http: ${PLUGIN_PROTOCOL_SCHEME}:`,
].join('; ');

/** The session hook also sees plugin responses; preserve their isolated policy. */
export function productionResponseHeaders(url: string, headers: Record<string, string[]> = {}): Record<string, string[]> {
  const result = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'content-security-policy'));
  const existing = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'content-security-policy').flatMap(([, values]) => values);
  const policies = new URL(url).protocol === `${PLUGIN_PROTOCOL_SCHEME}:`
    ? [PLUGIN_PAGE_CSP] : [...existing, MAIN_WINDOW_PRODUCTION_CSP];
  return { ...result, 'Content-Security-Policy': policies };
}

/**
 * Load the main renderer (Vite dev server in development, packaged HTML file
 * in production) into an existing BrowserWindow.
 *
 * Exposed as a standalone export so the first-launch path in `app.on('ready')`
 * controls WHEN navigation starts: since S-A Step 1 it fires in parallel with
 * `DaemonRespawnController.bootstrap()` (the renderer leg is the longer one,
 * so the daemon spawn hides behind it). History: dda4c0c originally deferred
 * this until after bootstrap because a renderer mounting in LOCAL mode
 * (pty-N ids) while the IPC handler swap to DAEMON mode happened mid-mount
 * sent LOCAL-prefix ids into the DAEMON handler, which silently dropped them
 * inside `DaemonClient.writeToSession` ("first keystroke doesn't register"
 * on cold installs). That race is closed structurally today: the renderer's
 * first `daemon.whenReady()` parks in the get-ready-state resolver queue
 * until the bootstrap settles, and paneGate keeps every `pty.create` path
 * shut until the startup reconcile completes — ordering is no longer the
 * defense.
 */
/**
 * Normalize the Vite dev-server URL to the IPv4 loopback.
 *
 * electron-forge injects `MAIN_WINDOW_VITE_DEV_SERVER_URL` as
 * `http://localhost:5173/`, but the Vite server is pinned to `127.0.0.1` (see
 * `vite.renderer.config.ts`). On macOS `localhost` resolves to `::1` (IPv6)
 * first, so `loadURL('http://localhost:5173')` hits ERR_CONNECTION_REFUSED and
 * the window renders blank and flickers as Electron retries. Rewriting the
 * loopback host to `127.0.0.1` keeps the loaded URL on the same interface the
 * server actually listens on. Only `localhost` is rewritten (a `--host` override
 * or a real IP is left untouched). Returns the input unchanged in production
 * (undefined → the packaged `loadFile` path) or if the URL can't be parsed.
 */
export function normalizeDevServerUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function loadMainRenderer(mainWindow: BrowserWindow): void {
  const devUrl = normalizeDevServerUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

/**
 * Create the main BrowserWindow with all wmux-specific webPreferences,
 * security hardening, and event wiring.
 *
 * Pass `opts.deferLoad: true` to skip the renderer navigation. The caller
 * MUST then call `loadMainRenderer(window)` itself once its window wiring
 * (console relay, recovery hooks) is attached — see `loadMainRenderer` for
 * the load-timing rationale. The macOS `app.on('activate')` re-open path
 * leaves `deferLoad` unset because the daemon is already healthy by the
 * time activate fires.
 */
/** How long the window must sit still before its placement is written (#1362).
 *  Drag and resize fire continuously; one write per gesture is enough. */
const WINDOW_STATE_SAVE_DEBOUNCE_MS = 300;

/**
 * Record the window's placement on move/resize (debounced) and on close.
 *
 * `getNormalBounds()` — never `getBounds()` — so a window closed while
 * maximized or fullscreen still remembers the size to restore down to.
 */
function attachWindowStatePersistence(win: BrowserWindow): void {
  const snapshot = (): WindowState => ({
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
  });

  let timer: NodeJS.Timeout | null = null;
  // Once the close snapshot is written it is final: a debounced write that
  // fires afterwards would resurrect a stale placement.
  let sealed = false;
  const stop = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (): void => {
    if (sealed) return;
    // A minimized window reports isMaximized() === false and a normal-looking
    // rectangle on Windows/Linux — saving then silently forgets that the user
    // left it maximized. Keep the last good snapshot instead.
    if (win.isMinimized()) return;
    stop();
    timer = setTimeout(() => {
      timer = null;
      if (sealed || win.isDestroyed() || win.isMinimized()) return;
      void saveWindowState(snapshot()).catch(() => {
        // Placement is a convenience; a failed write must not surface.
      });
    }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
  };

  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  // Restoring fullscreen flips isFullScreen() only once the transition lands,
  // so the flag has to be re-read when these fire, not just on resize.
  win.on('enter-full-screen', schedule);
  win.on('leave-full-screen', schedule);

  win.on('close', () => {
    stop();
    sealed = true;
    try {
      saveWindowStateSync(snapshot());
    } catch {
      // Never block the close on a placement write.
    }
  });
  // A window destroyed without a `close` (renderer crash, forced teardown)
  // must not leave the debounce timer holding the event loop.
  win.on('closed', stop);
}

export function createWindow(
  opts: { deferLoad?: boolean; windowGlass?: unknown; windowGlassEffective?: unknown; windowAppearance?: unknown } = {},
): BrowserWindow {
  // Windows window glass (windowGlass.ts): acrylic on Windows 11 22H2+ unless
  // the persisted level is Off or the window was last shown opaque for its
  // theme; the renderer switches it at runtime after.
  const winGlass = initialWindowsGlass(
    windowsGlassSupported(process.platform, os.release()),
    opts.windowGlass,
    opts.windowGlassEffective,
  );
  // The acrylic's tone follows the app appearance; set it before the window
  // exists, not when the renderer loads, so the first frames match the theme.
  const bootAppearance = process.platform === 'win32' ? initialWindowsAppearance(winGlass, opts.windowAppearance) : null;
  if (bootAppearance) nativeTheme.themeSource = bootAppearance;
  // The saved theme's polarity, for what the window paints before the
  // renderer applies the theme (shared/windowStartPaint.ts).
  const polarity = startPolarity(opts.windowAppearance);
  // #1362 — restore the placement the user left the window in. Off-screen or
  // corrupt saved state yields an empty plan and the 1280x800 default.
  let plan: RestorePlan = { maximized: false, fullScreen: false };
  try {
    plan = planRestore(
      loadWindowState(),
      screen.getAllDisplays().map((d) => d.workArea),
    );
  } catch {
    // Placement is a convenience; never let it block the window from opening.
  }

  const mainWindow = new BrowserWindow({
    width: plan.bounds?.width ?? DEFAULT_WINDOW_SIZE.width,
    height: plan.bounds?.height ?? DEFAULT_WINDOW_SIZE.height,
    ...(plan.bounds ? { x: plan.bounds.x, y: plan.bounds.y } : {}),
    ...(plan.fullScreen ? { fullscreen: true } : {}),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: 'wmux',
    // Resolve via app.isPackaged (mirrors tray.ts) — not NODE_ENV, which isn't
    // reliably set and could send an unpackaged build to the packaged path.
    icon: app.isPackaged
      ? path.join(process.resourcesPath, iconFile)
      : path.join(__dirname, '../../assets', iconFile),
    // Bridge redesign chrome (DESIGN.md "Window: frame and sheet"). The default-frame +
    // visible File/Edit menu strip was the #1 "web page in an OS window"
    // offender. The renderer draws a 40px custom titlebar (Titlebar.tsx);
    // the OS keeps drawing its own window controls:
    //   - Windows: titleBarOverlay → native, snap-layout-capable min/max/close
    //     drawn over the custom bar. Colors follow the theme via the
    //     window:setTitleBarOverlay IPC (registerHandlers.ts).
    //   - macOS: 'hidden' keeps the traffic lights, nudged to center in 40px.
    //   - Linux: keep the native frame (titleBarStyle is ignored there; a
    //     frameless window would lose drag/resize with no replacement).
    // The menu bar is hidden, not removed — Alt still reveals it on demand and
    // the accelerators keep working. Which accelerators those are is no longer
    // Electron's call: main/menu/appMenu.ts installs wmux's own menu before the
    // first window (#818). Before that, the default menu's roles owned
    // Cmd+Shift+R, Cmd+W, and the zoom keys, and silently beat the renderer to
    // them on macOS.
    autoHideMenuBar: true,
    // Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/shell/TitleBar.tsx), MIT License, Copyright (c) 2026 Nick
    ...platformChoice<Partial<Electron.BrowserWindowConstructorOptions>>({
      // The overlay strip sits on the window frame, so the opaque window
      // starts it in the default (Tint) theme's frame colour, --frame-bg
      // #121015 — the renderer re-pushes the live theme's painted frame colour
      // on boot/theme-change via window:setTitleBarOverlay (overlayColors()).
      // The first paint uses the same colour so the controls never sit on a
      // different shade before the renderer paints. With glass the strip, the
      // background and the material are the acrylic set instead
      // (winWindowOptions in windowGlass.ts).
      win: winWindowOptions(winGlass, polarity),
      mac: {
        titleBarStyle: 'hidden',
        // Centered in the 40px bar: macTrafficLightPosition(1) in uiZoom.ts.
        trafficLightPosition: { x: 12, y: 13 },
        // Window glass. Adapted from MonoCode (hardbeat920/monocode@6bd432ca,
        // src-tauri/src/macos.rs), MIT License, Copyright (c) 2026 Nick: a
        // behind-window material under a transparent window. The page decides
        // what shows through — once the app's appearance matches the theme the
        // renderer sets `data-glass` and tints only the frame and the sidebar
        // (globals.css); the panes and terminals stay opaque. The material
        // also covers the first frame, so there is no white flash before the
        // renderer paints.
        vibrancy: 'sidebar',
        visualEffectState: 'active',
        backgroundColor: '#00000000',
      },
      default: {
        // The saved polarity's start colour, the one the page paints before
        // its theme is set, so a light theme does not start dark (#2512).
        backgroundColor: WINDOW_START_COLORS[polarity].background,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // The preload paints the page in this polarity until the theme is set.
      additionalArguments: [startPolarityArg(polarity)],
    },
  });

  // Fullscreen is requested through the constructor (above) — calling
  // setFullScreen() on a window that has not been shown yet is unreliable
  // across platforms. Maximize has no constructor option. It also shows a
  // hidden window, so a window built hidden (the opaque Windows one) is
  // maximized when it is revealed instead.
  const maximize = !plan.fullScreen && plan.maximized;
  if (mainWindow.isVisible()) {
    if (maximize) mainWindow.maximize();
  } else {
    revealWhenPainted(mainWindow, { maximize });
  }
  if (process.platform === 'win32') markWindowGlass(mainWindow, winGlass);
  attachWindowStatePersistence(mainWindow);

  // macOS: native fullscreen hides the traffic lights, so the renderer's
  // titlebar must drop its 72px left reserve (and restore it on exit) — the
  // enter/leave-full-screen → push pattern VS Code and Hyper use (there is
  // no reliable renderer-side signal for this on mac). Registered on all
  // platforms; the renderer only consults it when isMac.
  const pushFullscreen = (fullscreen: boolean): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.WINDOW_FULLSCREEN_CHANGED, { fullscreen });
    }
  };
  mainWindow.on('enter-full-screen', () => pushFullscreen(true));
  mainWindow.on('leave-full-screen', () => pushFullscreen(false));
  // A maximized window has square corners on Windows, so the sheet drops its
  // margin and radius there (DESIGN.md "Window: frame and sheet").
  const pushMaximized = (maximized: boolean): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.WINDOW_MAXIMIZED_CHANGED, { maximized });
    }
  };
  mainWindow.on('maximize', () => pushMaximized(true));
  mainWindow.on('unmaximize', () => pushMaximized(false));

  // #882 — "is anyone looking at this window" (minimized / hidden to tray /
  // screen locked), pushed on the same window-event → renderer pattern. The
  // renderer folds it into the #766 viewer-visibility report, which on Windows
  // had no working window term at all: `document.visibilityState` never
  // reports hidden there, not even for a minimized window. Rationale and the
  // deliberate exclusion of plain blur live in window/windowDisplayed.ts.
  windowDisplayedReporter.attach(mainWindow, { powerMonitor });

  // UI zoom (#822) is now renderer-driven: the persisted factor lives in the
  // renderer store and is pushed via the window:setUiScale IPC on hydration
  // and on Settings changes. See src/renderer/components/Layout/AppLayout.tsx.

  attachPluginFrameNavigation(mainWindow.webContents);

  if (!opts.deferLoad) {
    loadMainRenderer(mainWindow);
  }

  // CSP header — production only.
  // In development, Vite serves scripts from localhost with inline module
  // loaders and eval-based HMR, which are incompatible with strict CSP.
  // We only enforce CSP in production builds.
  // 'unsafe-inline' in style-src is required because Tailwind CSS and xterm.js
  // inject inline styles at runtime; removing it breaks UI rendering.
  //
  // #582: The dev-only "Insecure Content-Security-Policy" warning is suppressed
  // via ELECTRON_DISABLE_SECURITY_WARNINGS — but that is now set at the very
  // top of the main entry (src/main/index.ts), before this function runs, so
  // the override is live before the first renderer navigates. Vite's HMR
  // requires unsafe-eval, so any dev CSP we set would still trip the warning;
  // the production CSP below is strict (no unsafe-eval), so this is dev-only
  // noise reduction, not a security trade-off.
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: productionResponseHeaders(details.url, details.responseHeaders),
      });
    });
  }

  // Harden webview security: strip preload, enforce contextIsolation
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload;
    delete (webPreferences as Record<string, unknown>)['preloadURL'];
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // Ensure web security (same-origin policy) is not accidentally disabled
    (webPreferences as Record<string, unknown>)['webSecurity'] = true;
    // A previewed HTML page (main/preview/previewHtml.ts) is untrusted: it may
    // not spam alert()/confirm() modals over the app.
    if (typeof params.partition === 'string' && params.partition.startsWith('preview-html')) {
      (webPreferences as Record<string, unknown>)['disableDialogs'] = true;
    }
  });

  // Block all navigations except dev server — prevents file drag opening in
  // window. Compare against the SAME normalized (127.0.0.1) URL the renderer was
  // loaded from, else the dev server's own HMR/router navigations would be
  // treated as external and blocked.
  const devUrl = normalizeDevServerUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (devUrl && url.startsWith(devUrl)) return;
    event.preventDefault();
  });

  // Block all window.open() calls by default.
  // External URLs (http/https) are opened in the user's default browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // T6 Notification System Expansion — clear any active taskbar attention
  // flash when the user focuses the window. The renderer is therefore not
  // required to send a matching `flashFrame(false)` after the user reacts.
  attachFlashFrameAutoClear(mainWindow);

  return mainWindow;
}
