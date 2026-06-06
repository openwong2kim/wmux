import type { BrowserWindow } from 'electron';
import { webContents } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import { ProfileManager } from '../../browser-session/ProfileManager';
import { PortAllocator } from '../../browser-session/PortAllocator';
import { HumanBehavior } from '../../browser-session/HumanBehavior';
import { WebviewCdpManager } from '../../browser-session/WebviewCdpManager';
import { BrowserCaptureManager } from '../../browser-session/BrowserCaptureManager';
import { validateResolvedNavigationUrl } from '../../security/navigationPolicy';

type GetWindow = () => BrowserWindow | null;

async function validateUrl(url: string, method: string): Promise<void> {
  const result = await validateResolvedNavigationUrl(url);
  if (!result.valid) {
    throw new Error(`${method}: ${result.reason}`);
  }
}

/**
 * Registers browser.* RPC handlers.
 *
 * All commands are delegated to the renderer process via IPC where the active
 * browser Surface's <webview> element executes the requested operation.
 */
// Singleton instances for session management within the main process
const profileManager = new ProfileManager();
const portAllocator = new PortAllocator();
const humanBehavior = new HumanBehavior();
// CDP event capture for browser_console / browser_network / browser_response_body
// in packaged builds (#106). Lazy: enables domains on first drain call.
const captureManager = new BrowserCaptureManager();

export function registerBrowserRpc(router: RpcRouter, getWindow: GetWindow, webviewCdpManager: WebviewCdpManager): void {
  const getActivePartition = (): string => profileManager.getActiveProfile().partition;

  // Resolve the guest webview's WebContents for a CDP-backed handler, throwing a
  // method-tagged error if no target is registered or the WebContents is gone.
  // Shared by the #111 state handlers (cookies / resize / emulate) which all
  // drive the page over `wc.debugger.sendCommand`.
  const resolveWc = (surfaceId: string | undefined, method: string): Electron.WebContents => {
    const target = webviewCdpManager.getTarget(surfaceId);
    if (!target) throw new Error(`${method}: no webview target registered`);
    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error(`${method}: WebContents unavailable`);
    return wc;
  };

  // Tear down capture listeners whenever a surface's CDP session is unregistered.
  webviewCdpManager.setCaptureCleanup((webContentsId) => captureManager.drop(webContentsId));

  /**
   * browser.open
   * Opens a new browser surface in the active pane.
   * params: { url?: string }
   */
  router.register('browser.open', async (params) => {
    const url = typeof params['url'] === 'string' ? params['url'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    if (url) await validateUrl(url, 'browser.open');
    return sendToRenderer(getWindow, 'browser.open', {
      partition: getActivePartition(),
      ...(url && { url }),
      // workspaceId is dropped when absent; the renderer (useRpcBridge.ts) then
      // falls back to the UI-active workspace. The MCP path guarantees a non-empty
      // id via requireWorkspaceId (src/mcp/index.ts -> browser_open), so it never
      // hits that fallback. Any future NON-MCP caller of browser.open must likewise
      // pass an explicit workspaceId to avoid active-workspace misrouting.
      ...(workspaceId && { workspaceId }),
    });
  });

  /**
   * browser.close
   * Closes the browser panel.
   * params: { surfaceId?: string }
   */
  router.register('browser.close', (params) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    return sendToRenderer(getWindow, 'browser.close', {
      ...(surfaceId && { surfaceId }),
    });
  });

  /**
   * browser.navigate
   * Navigates the active browser Surface to the given URL.
   * Tries CDP direct navigation first, falls back to renderer bridge.
   * params: { url: string, surfaceId?: string }
   */
  router.register('browser.navigate', async (params) => {
    if (typeof params['url'] !== 'string' || params['url'].length === 0) {
      throw new Error('browser.navigate: missing required param "url"');
    }
    await validateUrl(params['url'], 'browser.navigate');
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    // Try CDP direct navigation first
    const target = webviewCdpManager.getTarget(surfaceId);
    if (target) {
      try {
        const wc = webContents.fromId(target.webContentsId);
        if (wc && !wc.isDestroyed()) {
          await wc.loadURL(params['url']);
          return { ok: true, url: params['url'] };
        }
      } catch (err) {
        console.warn('[browser.navigate] CDP fallback to renderer:', err);
      }
    }

    // Fallback to renderer bridge
    return sendToRenderer(getWindow, 'browser.navigate', {
      url: params['url'],
      ...(surfaceId && { surfaceId }),
    });
  });

  /**
   * browser.goBack
   * Navigate the active browser Surface back by one history entry.
   * params: { surfaceId?: string }
   */
  router.register('browser.goBack', async (params) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    const target = webviewCdpManager.getTarget(surfaceId);
    if (!target) throw new Error('browser.goBack: no webview target registered');

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.goBack: WebContents unavailable');

    const navigationHistory = (wc as Electron.WebContents & {
      navigationHistory?: {
        canGoBack?: () => boolean;
        goBack?: () => void;
      };
      canGoBack?: () => boolean;
      goBack?: () => void;
    }).navigationHistory;

    const canGoBack = navigationHistory?.canGoBack?.() ?? wc.canGoBack?.() ?? false;
    if (!canGoBack) {
      return { ok: false, reason: 'no history entry' };
    }

    if (navigationHistory?.goBack) {
      navigationHistory.goBack();
    } else {
      wc.goBack();
    }

    return { ok: true };
  });

  // ── Session handlers ────────────────────────────────────────────────────

  /**
   * browser.session.start
   * Start a browser session with an optional profile.
   * params: { profile?: string }
   */
  router.register('browser.session.start', async (params) => {
    const profileName = typeof params['profile'] === 'string' ? params['profile'] : 'default';
    let profile = profileManager.getProfile(profileName);
    if (!profile) {
      profile = profileManager.createProfile(profileName, true);
    }
    profileManager.setActiveProfile(profileName);
    await sendToRenderer(getWindow, 'browser.session.applyProfile', {
      partition: profile.partition,
    });
    const port = await portAllocator.allocate();
    return {
      profile: profile.name,
      partition: profile.partition,
      persistent: profile.persistent,
      port,
    };
  });

  /**
   * browser.session.stop
   * Stop the active browser session and release resources.
   */
  router.register('browser.session.stop', async () => {
    const port = portAllocator.getPort();
    if (port !== null) {
      portAllocator.release(port);
    }
    profileManager.setActiveProfile('default');
    await sendToRenderer(getWindow, 'browser.session.applyProfile', {
      partition: getActivePartition(),
    });
    return { stopped: true };
  });

  /**
   * browser.session.status
   * Return the active profile and CDP port information.
   */
  router.register('browser.session.status', async () => {
    const active = profileManager.getActiveProfile();
    const port = portAllocator.getPort();
    return {
      profile: active.name,
      partition: active.partition,
      persistent: active.persistent,
      port,
    };
  });

  /**
   * browser.session.list
   * Return all available profiles.
   */
  router.register('browser.session.list', async () => {
    const profiles = profileManager.listProfiles().map((p) => ({
      name: p.name,
      partition: p.partition,
      persistent: p.persistent,
    }));
    return { profiles };
  });

  // ── Human-like typing handler ─────────────────────────────────────────

  /**
   * browser.type.humanlike
   * Generate a human-like typing schedule for the given text.
   * The schedule (array of per-keystroke delays) is returned so that the
   * caller (e.g. Playwright MCP) can execute the actual key presses.
   * params: { text: string, selector?: string }
   */
  router.register('browser.type.humanlike', async (params) => {
    if (typeof params['text'] !== 'string' || params['text'].length === 0) {
      throw new Error('browser.type.humanlike: missing required param "text"');
    }
    const text: string = params['text'];
    const selector = typeof params['selector'] === 'string' ? params['selector'] : undefined;

    const delays = humanBehavior.generateTypingSchedule(text);
    const config = humanBehavior.getConfig();

    return {
      text,
      ...(selector && { selector }),
      delays,
      totalDuration: delays.reduce((sum, d) => sum + d, 0),
      config: {
        typingDelay: config.typingDelay,
      },
    };
  });

  /**
   * browser.cdp.info
   * Returns the CDP port and minimal target metadata required for Playwright attachment.
   * params: none
   */
  router.register('browser.cdp.info', async () => {
    let targets = webviewCdpManager.listTargets();

    // If no targets yet, wait briefly for in-flight registrations to complete.
    // This eliminates the race where MCP queries before registerWebview() finishes.
    if (targets.length === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      targets = webviewCdpManager.listTargets();
    }

    const cdpPort: number = webviewCdpManager.getCdpPort();

    // Expose the actual runtime URL of the main-window webContents (the app
    // shell) so the Playwright engine can recognize the shell by exact-match
    // instead of guessing from build-path shape. dev → http://localhost:..,
    // packaged → file:///.../.vite/renderer/main_window/index.html. The guest
    // <webview> is a separate webContents and never appears here. Suppress an
    // empty URL (window still mid-load) so the engine keeps any prior value.
    let shellUrl: string | undefined;
    try {
      const url = getWindow()?.webContents.getURL();
      if (url && url.length > 0) shellUrl = url;
    } catch { /* window destroyed — omit shellUrl */ }

    return {
      cdpPort,
      ...(shellUrl && { shellUrl }),
      targets: targets.map((t) => ({
        surfaceId: t.surfaceId,
        targetId: t.targetId,
      })),
    };
  });

  /**
   * browser.screenshot
   * Capture a screenshot of the webview.
   * params: { surfaceId?: string, fullPage?: boolean }
   */
  router.register('browser.screenshot', async (params) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const fullPage = params['fullPage'] === true;

    const target = webviewCdpManager.getTarget(surfaceId);
    if (!target) throw new Error('browser.screenshot: no webview target registered');

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.screenshot: WebContents unavailable');

    // Always use CDP Page.captureScreenshot (reliable, no timeout issues)
    const result = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      ...(fullPage && { captureBeyondViewport: true }),
    });
    return { data: (result as { data: string }).data };
  });

  /**
   * browser.evaluate
   * Execute JavaScript in the webview and return the result.
   * params: { expression: string, surfaceId?: string }
   */
  router.register('browser.evaluate', async (params) => {
    const expression = typeof params['expression'] === 'string' ? params['expression'] : '';
    if (!expression) throw new Error('browser.evaluate: missing "expression"');
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    const target = webviewCdpManager.getTarget(surfaceId);
    if (!target) throw new Error('browser.evaluate: no webview target registered');

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.evaluate: WebContents unavailable');

    // Use CDP Runtime.evaluate for reliable execution (executeJavaScript can fail silently)
    try {
      const cdpResult = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }) as { result: { value?: unknown; description?: string; type: string }; exceptionDetails?: { text: string; exception?: { description?: string } } };

      if (cdpResult.exceptionDetails) {
        const errMsg = cdpResult.exceptionDetails.exception?.description
          || cdpResult.exceptionDetails.text
          || 'Unknown script error';
        throw new Error(errMsg);
      }

      return { value: cdpResult.result?.value ?? null };
    } catch (err) {
      // Fallback to executeJavaScript
      try {
        const result = await wc.executeJavaScript(expression);
        return { value: result };
      } catch (fallbackErr) {
        throw new Error(`evaluate failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
      }
    }
  });

  /**
   * browser.console.get
   * Drain captured console messages for the webview (packaged-build fallback for
   * the MCP browser_console tool, #106). Capture is enabled lazily on first call.
   * params: { surfaceId?: string, clear?: boolean }
   */
  router.register('browser.console.get', async (params) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const clear = params['clear'] === true;

    const target = webviewCdpManager.getTarget(surfaceId);
    if (!target) throw new Error('browser.console.get: no webview target registered');

    const state = await captureManager.ensure(target.webContentsId);
    if (!state) throw new Error('browser.console.get: capture unavailable (webContents gone)');

    const entries = captureManager.getConsole(target.webContentsId);
    if (clear) captureManager.clearConsole(target.webContentsId);
    return { entries };
  });

  /**
   * browser.network.get
   * Drain captured network request summaries for the webview (#106). Bodies are
   * fetched separately via browser.responseBody.get to keep this payload small.
   * params: { surfaceId?: string, clear?: boolean }
   */
  router.register('browser.network.get', async (params) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const clear = params['clear'] === true;

    const target = webviewCdpManager.getTarget(surfaceId);
    if (!target) throw new Error('browser.network.get: no webview target registered');

    const state = await captureManager.ensure(target.webContentsId);
    if (!state) throw new Error('browser.network.get: capture unavailable (webContents gone)');

    const entries = captureManager.getNetwork(target.webContentsId);
    if (clear) captureManager.clearNetwork(target.webContentsId);
    return { entries };
  });

  /**
   * browser.responseBody.get
   * Return the last captured response body whose URL matches the glob (#106).
   * params: { surfaceId?: string, urlPattern: string }
   */
  router.register('browser.responseBody.get', async (params) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const urlPattern = typeof params['urlPattern'] === 'string' ? params['urlPattern'] : '';
    if (!urlPattern) throw new Error('browser.responseBody.get: missing "urlPattern"');

    const target = webviewCdpManager.getTarget(surfaceId);
    if (!target) throw new Error('browser.responseBody.get: no webview target registered');

    const state = await captureManager.ensure(target.webContentsId);
    if (!state) throw new Error('browser.responseBody.get: capture unavailable (webContents gone)');

    const body = captureManager.getResponseBody(target.webContentsId, urlPattern);
    return { body };
  });

  /**
   * browser.type.cdp
   * Type text into the currently focused element via CDP Input events.
   * This simulates real keyboard input, which works with React/controlled inputs.
   * params: { text: string, surfaceId?: string }
   */
  router.register('browser.type.cdp', async (params) => {
    const text = typeof params['text'] === 'string' ? params['text'] : '';
    if (!text) throw new Error('browser.type.cdp: missing "text"');
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    const target = webviewCdpManager.getTarget(surfaceId);
    if (!target) throw new Error('browser.type.cdp: no webview target registered');

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.type.cdp: WebContents unavailable');

    // Use Input.insertText for reliable text input (handles CJK, React inputs, etc.)
    await wc.debugger.sendCommand('Input.insertText', { text });
    return { ok: true, text };
  });

  /**
   * browser.click.cdp
   * Click at coordinates or on the focused element via CDP Input events.
   * params: { x?: number, y?: number, selector?: string, surfaceId?: string }
   */
  router.register('browser.click.cdp', async (params) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const selector = typeof params['selector'] === 'string' ? params['selector'] : undefined;

    const target = webviewCdpManager.getTarget(surfaceId);
    if (!target) throw new Error('browser.click.cdp: no webview target registered');

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.click.cdp: WebContents unavailable');

    let x = typeof params['x'] === 'number' ? params['x'] : 0;
    let y = typeof params['y'] === 'number' ? params['y'] : 0;

    if (selector) {
      // Scroll element into view and get its viewport coordinates.
      // Without scrollIntoView, off-screen elements return coordinates outside
      // the viewport bounds, causing CDP mouse events to miss the target.
      const coordResult = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`,
        returnByValue: true,
      }) as { result: { value: { x: number; y: number } | null } };

      const coords = coordResult.result?.value;
      if (!coords) throw new Error(`Element not found: ${selector}`);
      x = coords.x;
      y = coords.y;
    }

    // Simulate mouse click via CDP.
    // Dispatch mouseMoved first — some frameworks (React, Vue) require hover
    // state before a click registers (e.g. onClick handlers on hover-revealed elements).
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });

    return { ok: true, x, y };
  });

  /**
   * browser.press.cdp
   * Press a keyboard key via CDP Input events.
   * params: { key: string, surfaceId?: string }
   */
  router.register('browser.press.cdp', async (params) => {
    const key = typeof params['key'] === 'string' ? params['key'] : '';
    if (!key) throw new Error('browser.press.cdp: missing "key"');
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    const target = webviewCdpManager.getTarget(surfaceId);
    if (!target) throw new Error('browser.press.cdp: no webview target registered');

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.press.cdp: WebContents unavailable');

    // Map key names to CDP key descriptors
    const keyMap: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number }> = {
      'Enter': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      'Tab': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
      'Escape': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
      'Backspace': { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
      'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
      'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
      'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
      'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
    };

    const mapped = keyMap[key];
    if (mapped) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown', ...mapped,
      });
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp', ...mapped,
      });
    } else {
      // For text characters, use char event
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'char', text: key, unmodifiedText: key,
      });
    }

    return { ok: true, key };
  });

  /**
   * browser.cdp.target
   * Returns the CDP WebSocket URL for the active browser webview.
   * params: { surfaceId?: string }
   */
  router.register('browser.cdp.target', async (params) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    if (surfaceId) {
      try {
        const target = await webviewCdpManager.waitForTarget(surfaceId, 5000);
        return {
          targetId: target.targetId,
          surfaceId: target.surfaceId,
        };
      } catch {
        return { error: 'timeout waiting for webview CDP target' };
      }
    }

    const target = webviewCdpManager.getTarget();
    if (!target) return { error: 'no active browser webview' };

    return {
      targetId: target.targetId,
      surfaceId: target.surfaceId,
    };
  });

  // ── State handlers (packaged RPC fallback for browser_cookies / _resize /
  //    _emulate, #111). On packaged builds playwright-core cannot hand the guest
  //    <webview> back as a Playwright Page, so these tools fall through to CDP
  //    over the page debugger — the same route browser.evaluate already uses.
  //    browser_storage needs no handler here: it routes through browser.evaluate.

  /**
   * browser.cookies
   * Get, set, or clear cookies via CDP Network domain.
   *   - get:   { action:'get', urls?: string[] }   -> { cookies: Network.Cookie[] }
   *   - set:   { action:'set', cookies: CookieParam[] } (url defaulted to page URL
   *            for entries lacking both url and domain) -> { ok: true }
   *   - clear: { action:'clear' } -> { ok: true }
   * params: { action, urls?, cookies?, surfaceId? }
   * Sensitive-domain redaction stays in the MCP tool (state.ts), not here.
   */
  router.register('browser.cookies', async (params) => {
    const action = params['action'];
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const wc = resolveWc(surfaceId, 'browser.cookies');

    if (action === 'get') {
      const urls = Array.isArray(params['urls'])
        ? (params['urls'] as unknown[]).filter((u): u is string => typeof u === 'string')
        : [];
      let result: { cookies: unknown[] };
      if (urls.length > 0) {
        result = await wc.debugger.sendCommand('Network.getCookies', { urls }) as { cookies: unknown[] };
      } else {
        // Whole-context read. Network.getAllCookies is deprecated in newer CDP
        // but still present in Electron's Chromium; fall back to a urls-less
        // getCookies (current-page frames) if it has been removed.
        try {
          result = await wc.debugger.sendCommand('Network.getAllCookies') as { cookies: unknown[] };
        } catch {
          result = await wc.debugger.sendCommand('Network.getCookies', {}) as { cookies: unknown[] };
        }
      }
      return { cookies: result.cookies };
    }

    if (action === 'set') {
      const raw = Array.isArray(params['cookies']) ? params['cookies'] as Record<string, unknown>[] : [];
      if (raw.length === 0) throw new Error('browser.cookies set: no cookies provided');
      const pageUrl = (() => { try { return wc.getURL(); } catch { return undefined; } })();
      const cookies = raw.map((c) => {
        const hasDomain = typeof c['domain'] === 'string' && (c['domain'] as string).length > 0;
        const hasUrl = typeof c['url'] === 'string' && (c['url'] as string).length > 0;
        // CDP Network.setCookies requires url OR domain. Default missing ones to
        // the live page URL so a bare { name, value } still lands.
        return (!hasDomain && !hasUrl && pageUrl) ? { ...c, url: pageUrl } : c;
      });
      await wc.debugger.sendCommand('Network.setCookies', { cookies });
      return { ok: true };
    }

    if (action === 'clear') {
      await wc.debugger.sendCommand('Network.clearBrowserCookies');
      return { ok: true };
    }

    throw new Error(`browser.cookies: unknown action "${String(action)}"`);
  });

  /**
   * browser.resize
   * Override the viewport size via CDP Emulation.setDeviceMetricsOverride.
   * params: { width: number, height: number, surfaceId? }
   */
  router.register('browser.resize', async (params) => {
    const width = typeof params['width'] === 'number' ? params['width'] : NaN;
    const height = typeof params['height'] === 'number' ? params['height'] : NaN;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('browser.resize: width and height must be numbers');
    }
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const wc = resolveWc(surfaceId, 'browser.resize');
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 0, mobile: false,
    });
    return { ok: true, width, height };
  });

  /**
   * browser.emulate
   * Apply emulation settings via CDP. The MCP tool (state.ts) resolves any
   * device preset to deviceMetrics + userAgent before calling, so this handler
   * never needs playwright-core's device table. Returns the list of applied
   * settings (including the "credentials unsupported over CDP" note) so the tool
   * can render an identical summary in both transports.
   * params: {
   *   offline?, headers?, credentialsRequested?, geo?(|null), media?(|null),
   *   timezone?(|null), locale?(|null), deviceMetrics?, userAgent?, deviceReset?,
   *   surfaceId?
   * }
   */
  router.register('browser.emulate', async (params) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const wc = resolveWc(surfaceId, 'browser.emulate');
    const send = (method: string, p?: Record<string, unknown>): Promise<unknown> =>
      wc.debugger.sendCommand(method, p);
    const applied: string[] = [];

    if (typeof params['offline'] === 'boolean') {
      await send('Network.enable');
      await send('Network.emulateNetworkConditions', {
        offline: params['offline'], latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      applied.push(`offline=${params['offline']}`);
    }

    if (params['headers'] && typeof params['headers'] === 'object' && !Array.isArray(params['headers'])) {
      const headers = params['headers'] as Record<string, string>;
      await send('Network.enable');
      await send('Network.setExtraHTTPHeaders', { headers });
      applied.push(`headers=${Object.keys(headers).length} header(s)`);
    }

    if (params['credentialsRequested'] === true) {
      applied.push(
        'credentials=failed (HTTP credentials require a Playwright context and are not available over the CDP fallback. Use browser_emulate headers with a Base64-encoded Authorization header instead.)',
      );
    }

    if ('geo' in params) {
      const geo = params['geo'] as { latitude: number; longitude: number; accuracy?: number } | null;
      if (geo) {
        await send('Emulation.setGeolocationOverride', {
          latitude: geo.latitude, longitude: geo.longitude, accuracy: geo.accuracy ?? 100,
        });
        // Overriding the coordinates is not enough on its own: navigator.geolocation
        // stays blocked unless the page also holds the geolocation permission. The
        // Playwright path grants it explicitly (context.grantPermissions); mirror
        // that so the packaged fallback actually emulates location for the common
        // permission-gated flow. Browser.grantPermissions is a browser-target
        // command and may be unavailable on Electron's page-level debugger, so this
        // is best-effort — the coordinate override still applies if it throws.
        try {
          const origin = (() => {
            try { return new URL(wc.getURL()).origin; } catch { return undefined; }
          })();
          await send('Browser.grantPermissions', {
            ...(origin && origin !== 'null' ? { origin } : {}),
            permissions: ['geolocation'],
          });
        } catch {
          /* page-target debugger can't grant browser-level permissions; coords still set */
        }
        applied.push(`geo=${geo.latitude},${geo.longitude}`);
      } else {
        // Only clear the geolocation override, mirroring the Playwright path,
        // which leaves permissions untouched here. Browser.resetPermissions would
        // wipe every permission override for the whole browser context (all
        // origins), revoking grants this tool never made, so it is deliberately
        // not called — clearing the coordinate override is what actually stops
        // location emulation.
        await send('Emulation.clearGeolocationOverride');
        applied.push('geo=cleared');
      }
    }

    if ('media' in params) {
      const media = params['media'] as string | null;
      await send('Emulation.setEmulatedMedia',
        media ? { features: [{ name: 'prefers-color-scheme', value: media }] } : { features: [] });
      applied.push(media ? `colorScheme=${media}` : 'colorScheme=reset');
    }

    if ('timezone' in params) {
      const timezone = params['timezone'] as string | null;
      await send('Emulation.setTimezoneOverride', { timezoneId: timezone || '' });
      applied.push(timezone ? `timezone=${timezone}` : 'timezone=reset');
    }

    if ('locale' in params) {
      const locale = params['locale'] as string | null;
      await send('Emulation.setLocaleOverride', locale ? { locale } : {});
      applied.push(locale ? `locale=${locale}` : 'locale=reset');
    }

    if (params['deviceMetrics'] && typeof params['deviceMetrics'] === 'object') {
      const dm = params['deviceMetrics'] as { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean };
      await send('Emulation.setDeviceMetricsOverride', {
        width: dm.width, height: dm.height,
        deviceScaleFactor: dm.deviceScaleFactor ?? 0, mobile: dm.mobile ?? false,
      });
      if (typeof params['userAgent'] === 'string') {
        await send('Emulation.setUserAgentOverride', { userAgent: params['userAgent'] });
      }
      const label = typeof params['deviceLabel'] === 'string' ? params['deviceLabel'] : `${dm.width}x${dm.height}`;
      applied.push(`device=${label}`);
    } else if (params['deviceReset'] === true) {
      // Actually undo the preset over CDP: drop the device metrics override and
      // restore the real user agent. Without this, a packaged caller who switches
      // to a phone preset and then resets stays on the mobile UA/metrics for every
      // subsequent page. CDP has no "clear UA override" command, so re-apply the
      // WebContents' own UA to shed the mobile one set by the preset above.
      await send('Emulation.clearDeviceMetricsOverride');
      try {
        const ua = typeof wc.getUserAgent === 'function' ? wc.getUserAgent() : undefined;
        if (ua) await send('Emulation.setUserAgentOverride', { userAgent: ua });
      } catch {
        /* getUserAgent / UA override unavailable on this transport; metrics still cleared */
      }
      applied.push('device=reset (use browser_resize to set viewport)');
    }

    return { applied };
  });
}
