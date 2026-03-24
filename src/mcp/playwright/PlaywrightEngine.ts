import { chromium, type Browser, type Page } from 'playwright-core';
import { sendRpc } from '../wmux-client';

interface CdpTargetInfo {
  surfaceId: string;
  webContentsId: number;
  targetId: string;
  wsUrl: string;
}

interface CdpInfoResponse {
  cdpPort: number;
  targets: CdpTargetInfo[];
}

const MAX_CONNECT_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const PAGE_FIND_RETRIES = 5;
const PAGE_FIND_DELAY_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PlaywrightEngine -- singleton wrapper around playwright-core's Chromium CDP connection.
 *
 * Connects DIRECTLY to webview targets via their WebSocket debugger URL,
 * rather than the main Electron CDP port. This is necessary because Electron
 * <webview> tags run in separate guest processes that are invisible to
 * the main process's connectOverCDP context.
 */
export class PlaywrightEngine {
  private static instance: PlaywrightEngine | null = null;

  private browser: Browser | null = null;
  private connectedWsUrl: string | null = null;
  private cdpPort: number | null = null;

  private constructor() {}

  static getInstance(): PlaywrightEngine {
    if (!PlaywrightEngine.instance) {
      PlaywrightEngine.instance = new PlaywrightEngine();
    }
    return PlaywrightEngine.instance;
  }

  /**
   * Connect to a specific webview target via its WebSocket URL.
   */
  private async connectToWebview(wsUrl: string): Promise<void> {
    if (this.browser && this.connectedWsUrl === wsUrl && this.browser.isConnected()) {
      return;
    }
    await this.disconnect();
    this.browser = await chromium.connectOverCDP(wsUrl);
    this.connectedWsUrl = wsUrl;
    console.log(`[PlaywrightEngine] Connected to webview via ${wsUrl.substring(0, 60)}...`);
  }

  /**
   * Connect to the main Electron CDP endpoint (fallback).
   */
  async connect(cdpPort: number): Promise<void> {
    if (this.browser && this.cdpPort === cdpPort && this.browser.isConnected()) {
      return;
    }
    await this.disconnect();
    this.browser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`);
    this.cdpPort = cdpPort;
    console.log(`[PlaywrightEngine] Connected to CDP on port ${cdpPort}`);
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      this.browser = null;
      this.cdpPort = null;
      this.connectedWsUrl = null;
      console.log('[PlaywrightEngine] Disconnected');
    }
  }

  /**
   * Ensure connected to a webview target.
   * Fetches registered targets from WebviewCdpManager and connects
   * directly to the webview's WebSocket URL.
   */
  async ensureConnected(surfaceId?: string): Promise<void> {
    // If already connected, check if it's still valid
    if (this.browser?.isConnected()) return;

    for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
      try {
        const info = (await sendRpc('browser.cdp.info')) as CdpInfoResponse;
        this.cdpPort = info.cdpPort;

        // Find the target to connect to
        const target = surfaceId
          ? info.targets.find((t) => t.surfaceId === surfaceId)
          : info.targets[0];

        if (target?.wsUrl) {
          // Connect directly to the webview's WebSocket URL
          await this.connectToWebview(target.wsUrl);
        } else {
          // No webview targets yet — connect to main CDP as fallback
          await this.connect(info.cdpPort);
        }
        return;
      } catch (err) {
        console.warn(
          `[PlaywrightEngine] Connection attempt ${attempt}/${MAX_CONNECT_RETRIES} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt < MAX_CONNECT_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    throw new Error(`[PlaywrightEngine] Failed to connect after ${MAX_CONNECT_RETRIES} attempts`);
  }

  /**
   * Collect all Playwright Page objects from all contexts.
   */
  private getAllPages(): Page[] {
    if (!this.browser || !this.browser.isConnected()) return [];
    const pages: Page[] = [];
    for (const ctx of this.browser.contexts()) {
      pages.push(...ctx.pages());
    }
    return pages;
  }

  /**
   * Get a Page matching the given surfaceId.
   *
   * Connects directly to the webview's WebSocket URL for reliable page discovery.
   * Includes retry logic for webviews that are still initializing.
   */
  async getPage(surfaceId?: string): Promise<Page | null> {
    for (let attempt = 1; attempt <= PAGE_FIND_RETRIES; attempt++) {
      try {
        // Fetch current target info
        const info = (await sendRpc('browser.cdp.info')) as CdpInfoResponse;
        this.cdpPort = info.cdpPort;

        const target = surfaceId
          ? info.targets.find((t) => t.surfaceId === surfaceId)
          : info.targets[0];

        if (!target) {
          if (attempt < PAGE_FIND_RETRIES) {
            console.log(
              `[PlaywrightEngine] No CDP targets registered yet, retry ${attempt}/${PAGE_FIND_RETRIES}...`,
            );
            await sleep(PAGE_FIND_DELAY_MS);
            continue;
          }
          return null;
        }

        if (!target.wsUrl) {
          console.warn('[PlaywrightEngine] Target has no wsUrl:', target.surfaceId);
          return null;
        }

        // Connect directly to the webview target
        // Reconnect if targeting a different webview than currently connected
        if (this.connectedWsUrl !== target.wsUrl || !this.browser?.isConnected()) {
          await this.connectToWebview(target.wsUrl);
        }

        // Get pages from this webview's context
        const pages = this.getAllPages();
        if (pages.length > 0) {
          return pages[0];
        }

        // Pages might not be ready yet — retry
        if (attempt < PAGE_FIND_RETRIES) {
          console.log(
            `[PlaywrightEngine] Connected but no pages yet, retry ${attempt}/${PAGE_FIND_RETRIES}...`,
          );
          await sleep(PAGE_FIND_DELAY_MS);
          // Force reconnect on next attempt
          await this.disconnect();
        }
      } catch (err) {
        console.warn(
          `[PlaywrightEngine] getPage attempt ${attempt} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt < PAGE_FIND_RETRIES) {
          await sleep(PAGE_FIND_DELAY_MS);
          await this.disconnect();
        }
      }
    }

    console.warn('[PlaywrightEngine] No webview page found after all retries');
    return null;
  }

  async getBrowser(): Promise<Browser | null> {
    await this.ensureConnected();
    return this.browser;
  }
}
