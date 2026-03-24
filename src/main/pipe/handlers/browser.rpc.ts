import type { BrowserWindow } from 'electron';
import { webContents } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import { ProfileManager } from '../../browser-session/ProfileManager';
import { PortAllocator } from '../../browser-session/PortAllocator';
import { HumanBehavior } from '../../browser-session/HumanBehavior';
import { WebviewCdpManager } from '../../browser-session/WebviewCdpManager';
import { validateNavigationUrl } from '../../../shared/types';

type GetWindow = () => BrowserWindow | null;

function validateUrl(url: string, method: string): void {
  const result = validateNavigationUrl(url);
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
  /**
   * browser.open
   * Opens a new browser surface in the active pane.
   * params: { url?: string }
   */
  router.register('browser.open', (params) => {
    const url = typeof params['url'] === 'string' ? params['url'] : undefined;
    if (url) validateUrl(url, 'browser.open');
    return sendToRenderer(getWindow, 'browser.open', {
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
    validateUrl(params['url'], 'browser.navigate');
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

  // ── Session handlers ────────────────────────────────────────────────────

  /**
   * browser.session.start
   * Start a browser session with an optional profile.
   * params: { profile?: string }
   */
  // TODO: Wire profile partition to renderer webview — currently data-only stub
  router.register('browser.session.start', async (params) => {
    const profileName = typeof params['profile'] === 'string' ? params['profile'] : 'default';
    let profile = profileManager.getProfile(profileName);
    if (!profile) {
      profile = profileManager.createProfile(profileName, true);
    }
    profileManager.setActiveProfile(profileName);
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
  // TODO: Wire profile partition to renderer webview — currently data-only stub
  router.register('browser.session.stop', async () => {
    const port = portAllocator.getPort();
    if (port !== null) {
      portAllocator.release(port);
    }
    profileManager.setActiveProfile('default');
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
   * Returns the CDP port and all registered webview targets.
   * params: none
   */
  router.register('browser.cdp.info', async () => {
    const targets = webviewCdpManager.listTargets().map((t) => ({
      surfaceId: t.surfaceId,
      webContentsId: t.webContentsId,
      targetId: t.targetId,
      wsUrl: t.wsUrl,
    }));
    const cdpPort: number = webviewCdpManager.getCdpPort();
    return { cdpPort, targets };
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
          webSocketDebuggerUrl: target.wsUrl,
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
      webSocketDebuggerUrl: target.wsUrl,
      targetId: target.targetId,
      surfaceId: target.surfaceId,
    };
  });
}
