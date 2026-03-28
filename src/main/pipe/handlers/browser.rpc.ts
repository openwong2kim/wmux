import type { BrowserWindow } from 'electron';
import { webContents } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import { ProfileManager } from '../../browser-session/ProfileManager';
import { PortAllocator } from '../../browser-session/PortAllocator';
import { HumanBehavior } from '../../browser-session/HumanBehavior';
import { WebviewCdpManager } from '../../browser-session/WebviewCdpManager';
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

export function registerBrowserRpc(router: RpcRouter, getWindow: GetWindow, webviewCdpManager: WebviewCdpManager): void {
  const getActivePartition = (): string => profileManager.getActiveProfile().partition;

  /**
   * browser.open
   * Opens a new browser surface in the active pane.
   * params: { url?: string }
   */
  router.register('browser.open', async (params) => {
    const url = typeof params['url'] === 'string' ? params['url'] : undefined;
    if (url) await validateUrl(url, 'browser.open');
    return sendToRenderer(getWindow, 'browser.open', {
      partition: getActivePartition(),
      ...(url && { url }),
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
    return {
      cdpPort,
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
}
