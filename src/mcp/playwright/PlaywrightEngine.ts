import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright-core';
import { sendRpc } from '../wmux-client';
import { isMac } from '../../shared/platform';
import { formatMacosError, MACOS_ERRORS } from '../../shared/errors/macos';

interface CdpTargetInfo {
  surfaceId: string;
  targetId: string;
}

interface CdpInfoResponse {
  cdpPort: number;
  /**
   * The actual runtime URL of the main-window webContents (the app shell),
   * as reported by the main process. Optional: absent on older mains or when
   * the window is mid-load (empty URL is suppressed). When present it is the
   * authoritative shell identifier; when absent we fall back to the static
   * isElectronShellUrl() heuristic. See browser.cdp.info handler.
   */
  shellUrl?: string;
  targets: CdpTargetInfo[];
}

const MAX_CONNECT_RETRIES = 3;
const RETRY_DELAY_MS = 800;
const PAGE_FIND_RETRIES = 3;
const PAGE_FIND_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true if the URL belongs to the Electron main renderer window
 * (the wmux app shell), which must never be mistaken for a guest <webview>
 * page when discovering the page to drive.
 *
 * Two shapes exist depending on build:
 *  - dev:       the Vite dev server, e.g. http://localhost:5173/ (or 127.0.0.1)
 *  - packaged:  loadFile() of the bundled renderer, i.e. a file:// URL ending
 *               in `.../renderer/main_window/index.html` (see
 *               src/main/window/createWindow.ts loadMainRenderer + the
 *               `main_window` renderer entry in forge.config.ts).
 *
 * The packaged file:// shell was previously NOT excluded, so getPage()'s
 * "first non-shell page" heuristic returned the app shell instead of the real
 * page DOM. We match ONLY the app's own renderer entry path so that a
 * legitimate user-opened file:// page (the thing being browsed) is still
 * reachable.
 */
export function isElectronShellUrl(url: string): boolean {
  if (
    url.startsWith('http://localhost:') ||
    url.startsWith('http://127.0.0.1:') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome://')
  ) {
    return true;
  }
  if (url.startsWith('file://')) {
    return isAppShellFileUrl(url);
  }
  return false;
}

/**
 * Matches the packaged app shell's renderer entry.
 *
 * The shell is loaded via `loadFile(path.join(__dirname, '../renderer/
 * main_window/index.html'))` (src/main/window/createWindow.ts). In a packaged
 * build `__dirname` is `.vite/build`, so the resulting file path always ends
 * with `.vite/renderer/main_window/index.html` (forge's `main_window`
 * renderer entry). asar packaging only prepends `.../app.asar/` to that, so
 * the `.vite/renderer/main_window/index.html` suffix is the stable, specific
 * identifier.
 *
 * We deliberately require the `.vite/renderer/` segment rather than just
 * `main_window/index.html`: a user could legitimately open their OWN project's
 * `file:///.../main_window/index.html` as the page being browsed, and that
 * must stay drivable. Only wmux's own build-output layout is excluded.
 */
function isAppShellFileUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Fall back to the raw URL minus any query/hash if URL parsing fails.
    pathname = url.split(/[?#]/)[0];
  }
  // Normalize Windows backslashes that may survive the raw-URL fallback.
  pathname = pathname.replace(/\\/g, '/');
  return /\.vite\/renderer\/main_window\/index\.html$/i.test(pathname);
}

/**
 * PlaywrightEngine -- singleton wrapper around playwright-core's Chromium CDP connection.
 *
 * Strategy: Connect to the Electron browser endpoint, then use CDP Target domain
 * to discover and attach to webview targets that aren't visible as regular pages.
 */
export class PlaywrightEngine {
  private static instance: PlaywrightEngine | null = null;

  private browser: Browser | null = null;
  private cdpPort: number | null = null;
  private playwrightFailed = false;
  /** Prevents repeated auto-open attempts within the same getPage call chain. */
  private autoOpenAttempted = false;
  /** Serializes getPage calls to prevent concurrent auto-open races. */
  private getPageLock: Promise<Page | null> | null = null;
  /**
   * Browser-level CDP session that owns the auto-attach subscription. Held
   * for the lifetime of `browser` and detached in `disconnect()`. Without
   * this, every reconnect would strand an auto-attach session inside
   * Playwright's internal connection map and leak memory over time.
   */
  private autoAttachSession: CDPSession | null = null;
  /**
   * The actual runtime URL of the app-shell main window, as reported by the
   * main process via browser.cdp.info (`shellUrl`). When set, this is the
   * authoritative way to recognize the shell page — exact-match against a
   * page's URL — so getPage() never has to guess from build-path shape.
   * Refreshed on every browser.cdp.info response and cleared on disconnect.
   */
  private shellUrl: string | null = null;

  private constructor() {}

  static getInstance(): PlaywrightEngine {
    if (!PlaywrightEngine.instance) {
      PlaywrightEngine.instance = new PlaywrightEngine();
    }
    return PlaywrightEngine.instance;
  }

  /**
   * Update the cached app-shell URL from a browser.cdp.info response. Ignores
   * empty/missing values so a window that is still mid-load (empty getURL())
   * doesn't clobber a previously-known good shell URL.
   */
  private cacheShellUrl(info: CdpInfoResponse): void {
    if (info.shellUrl && info.shellUrl.length > 0) {
      this.shellUrl = info.shellUrl;
    }
  }

  /**
   * Returns true if `url` is the wmux app shell (the main renderer window),
   * which must never be returned as the page-to-drive.
   *
   * Primary signal: exact-match against the runtime shell URL reported by the
   * main process (this.shellUrl). This reflects the real loaded document, so
   * it is immune to build-tool/forge path changes.
   *
   * Defense-in-depth fallback: when the runtime URL hasn't been obtained yet
   * (older main, or a mid-load race), fall back to the static
   * isElectronShellUrl() heuristic so a shell page is still never mistaken
   * for the guest webview.
   */
  private isShellPage(url: string): boolean {
    if (this.shellUrl && url === this.shellUrl) return true;
    return isElectronShellUrl(url);
  }

  async connect(cdpPort: number): Promise<void> {
    if (this.browser && this.cdpPort === cdpPort && this.browser.isConnected()) {
      return;
    }
    await this.disconnect();
    this.browser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`);
    this.cdpPort = cdpPort;
    console.error(`[PlaywrightEngine] Connected to CDP on port ${cdpPort}`);

    // Enable auto-attach so Electron webview targets become discoverable as Playwright pages.
    // Without this, <webview> tags in Electron are separate renderer processes that
    // don't appear in browser.contexts().pages().
    try {
      const session = await this.browser.newBrowserCDPSession();
      await session.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      this.autoAttachSession = session;
      console.error(`[PlaywrightEngine] Auto-attach enabled`);
    } catch (err) {
      console.error('[PlaywrightEngine] setAutoAttach warning:', err instanceof Error ? err.message : String(err));
    }
  }

  async disconnect(): Promise<void> {
    const b = this.browser;
    const s = this.autoAttachSession;
    this.browser = null;
    this.cdpPort = null;
    this.autoAttachSession = null;
    // Drop the cached shell URL — a reconnect may target a different window
    // (different port) whose shell URL must be re-fetched, not reused.
    this.shellUrl = null;
    if (s) {
      await s.detach().catch(() => { /* session may already be gone */ });
    }
    if (b) {
      try {
        await b.close();
      } catch { /* browser may already be gone */ }
      console.error('[PlaywrightEngine] Disconnected');
    }
  }

  async ensureConnected(): Promise<void> {
    if (this.browser?.isConnected()) return;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
      try {
        const info = (await sendRpc('browser.cdp.info')) as CdpInfoResponse;
        this.cacheShellUrl(info);
        await this.connect(info.cdpPort);
        return;
      } catch (err) {
        lastError = err;
        console.error(
          `[PlaywrightEngine] Connection attempt ${attempt}/${MAX_CONNECT_RETRIES} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt < MAX_CONNECT_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    // macOS Gatekeeper can quarantine the runtime-downloaded Chromium binary
    // (allow-jit entitlement + un-notarized cache combo). The exact error
    // wording varies across playwright-core versions, so trigger on any
    // failure-after-all-retries when the message hints at chromium/launch/
    // executable problems. Print the catalog entry once to stderr (logged
    // only — does not change the throw below or any retry behavior).
    if (isMac && lastError) {
      const msg = (lastError instanceof Error ? lastError.message : String(lastError)).toLowerCase();
      if (
        msg.includes('chromium') ||
        msg.includes('executable') ||
        msg.includes('launch') ||
        msg.includes('gatekeeper') ||
        msg.includes('quarantine')
      ) {
        console.error('\n' + formatMacosError(MACOS_ERRORS.playwrightChromiumQuarantine));
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
   * Find a webview page using multiple strategies:
   * 1. Check existing Playwright pages (works if webview is in a discoverable context)
   * 2. Use CDP Target domain to find and attach to webview targets directly
   * 3. Fetch /json endpoint for target discovery
   * 4. Auto-open a browser surface via RPC if none exists (so callers don't
   *    need to know about browser_open ordering)
   */
  async getPage(surfaceId?: string): Promise<Page | null> {
    // Fast-fail if Playwright has already failed to find webview pages.
    if (this.playwrightFailed) return null;

    // Serialize concurrent calls to prevent multiple auto-open races
    if (this.getPageLock) {
      return this.getPageLock;
    }
    this.getPageLock = this._getPageImpl(surfaceId);
    try {
      return await this.getPageLock;
    } finally {
      this.getPageLock = null;
    }
  }

  private async _getPageImpl(surfaceId?: string): Promise<Page | null> {

    await this.ensureConnected();

    for (let attempt = 1; attempt <= PAGE_FIND_RETRIES; attempt++) {
      try {
        // Strategy 1 (was 2): positive identification via the registered
        // targetId from WebviewCdpManager. This is the authoritative match —
        // it pins the exact guest webview by id — so it runs FIRST, before the
        // negative "any non-shell page" heuristic, to avoid ever returning the
        // shell when the shell happens to slip past URL classification.
        if (this.browser) {
          const page = await this.findViaTargetDomain(surfaceId);
          if (page) return page;
        }

        // Strategy 2 (was 1): fall back to the first existing page that isn't
        // the app shell. Used when positive targetId matching didn't yield a
        // page (e.g. target not registered yet). isShellPage() prefers the
        // runtime shell URL and falls back to the static heuristic.
        const allPages = this.getAllPages();
        console.error(`[PlaywrightEngine] Attempt ${attempt}: ${allPages.length} pages in ${this.browser?.contexts().length ?? 0} contexts`);

        const safePage = allPages.find((p) => !this.isShellPage(p.url()));
        if (safePage) {
          console.error(`[PlaywrightEngine] Found page via contexts: ${safePage.url()}`);
          return safePage;
        }

        // Strategy 3: Use /json endpoint + match registered targets
        if (this.cdpPort) {
          const page = await this.findViaJsonEndpoint(surfaceId);
          if (page) return page;
        }

        // Strategy 4: No browser surface exists — auto-open one via RPC.
        // This eliminates the requirement for callers to call browser_open first.
        if (attempt === 1 && !this.autoOpenAttempted) {
          console.error('[PlaywrightEngine] No page found — auto-opening browser surface');
          this.autoOpenAttempted = true;
          try {
            await sendRpc('browser.open', {});
            // Wait for the webview to register its CDP target
            await sleep(2000);
            await this.disconnect();
            await this.ensureConnected();
            continue; // retry page discovery
          } catch (openErr) {
            console.error('[PlaywrightEngine] Auto-open failed:', openErr instanceof Error ? openErr.message : String(openErr));
          }
        }

        if (attempt < PAGE_FIND_RETRIES) {
          console.error(`[PlaywrightEngine] No page found, reconnecting... (${attempt}/${PAGE_FIND_RETRIES})`);
          await sleep(PAGE_FIND_DELAY_MS);
          await this.disconnect();
          await this.ensureConnected();
        }
      } catch (err) {
        console.error(
          `[PlaywrightEngine] getPage attempt ${attempt} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt < PAGE_FIND_RETRIES) {
          await sleep(PAGE_FIND_DELAY_MS);
          await this.disconnect();
          await this.ensureConnected();
        }
      }
    }

    console.error('[PlaywrightEngine] No webview page found after all retries — marking as temporarily failed');
    this.playwrightFailed = true;
    // Auto-reset after 10s so subsequent browser.open calls get a fresh chance.
    // Without this, one early failure permanently blocks all Playwright page discovery.
    setTimeout(() => { this.playwrightFailed = false; this.autoOpenAttempted = false; }, 10_000);
    return null;
  }

  /**
   * Use CDP Target domain to discover webview targets and create a page for them.
   */
  private async findViaTargetDomain(surfaceId?: string): Promise<Page | null> {
    if (!this.browser) return null;

    try {
      // Get the default context's first page to create a CDP session
      const defaultContext = this.browser.contexts()[0];
      if (!defaultContext) {
        console.error('[PlaywrightEngine] No default context available');
        return null;
      }

      let cdpSession: CDPSession;
      const existingPages = defaultContext.pages();
      if (existingPages.length > 0) {
        cdpSession = await existingPages[0].context().newCDPSession(existingPages[0]);
      } else {
        cdpSession = await this.browser.newBrowserCDPSession();
      }

      try {
        // Get all targets
        const { targetInfos } = await cdpSession.send('Target.getTargets') as {
          targetInfos: Array<{
            targetId: string;
            type: string;
            title: string;
            url: string;
            attached: boolean;
            browserContextId?: string;
          }>;
        };

        console.error(`[PlaywrightEngine] CDP targets: ${targetInfos.map(t => `${t.type}:${t.url.substring(0, 40)}`).join(', ')}`);

        // Get registered wmux targets for matching
        const info = (await sendRpc('browser.cdp.info')) as CdpInfoResponse;
        this.cacheShellUrl(info);
        const wmuxTarget = surfaceId
          ? info.targets.find((t) => t.surfaceId === surfaceId)
          : info.targets[0];

        // Find the webview target — match by targetId from WebviewCdpManager
        let webviewTarget = wmuxTarget
          ? targetInfos.find((t) => t.targetId === wmuxTarget.targetId)
          : undefined;

        // Fallback: find any page target that isn't the Electron shell
        if (!webviewTarget) {
          webviewTarget = targetInfos.find(
            (t) => t.type === 'page' && !this.isShellPage(t.url) && t.url !== 'about:blank',
          );
        }

        if (!webviewTarget) {
          console.error('[PlaywrightEngine] No webview target found in Target.getTargets');
          return null;
        }

        console.error(`[PlaywrightEngine] Found webview target: ${webviewTarget.targetId} url=${webviewTarget.url}`);

        // Try to attach to the target and get a page
        // Attach with flatten:true creates a session in the current connection
        if (!webviewTarget.attached) {
          await cdpSession.send('Target.attachToTarget', {
            targetId: webviewTarget.targetId,
            flatten: true,
          });
          console.error(`[PlaywrightEngine] Attached to target ${webviewTarget.targetId}`);
        }

        // After attaching, check if new pages appeared
        await sleep(500);
        const newPages = this.getAllPages();
        console.error(`[PlaywrightEngine] After attach: ${newPages.length} pages`);

        const matchedPage = newPages.find((p) => !this.isShellPage(p.url()));
        if (matchedPage) {
          console.error(`[PlaywrightEngine] Found page after attach: ${matchedPage.url()}`);
          return matchedPage;
        }

        // If pages still empty, try creating a new CDP connection specifically to the webview
        // by reconnecting — this forces Playwright to re-discover all targets
        console.error('[PlaywrightEngine] Attach did not create a page, will retry with reconnect');
        return null;
      } finally {
        // Detach the probe session so it doesn't accumulate in Playwright's
        // internal session map across repeated getPage() calls.
        await cdpSession.detach().catch(() => { /* best-effort */ });
      }
    } catch (err) {
      console.error('[PlaywrightEngine] findViaTargetDomain error:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Use the /json HTTP endpoint to find webview targets and attach via CDP.
   */
  private async findViaJsonEndpoint(surfaceId?: string): Promise<Page | null> {
    if (!this.cdpPort || !this.browser) return null;

    try {
      const resp = await fetch(`http://127.0.0.1:${this.cdpPort}/json`);
      const targets = (await resp.json()) as Array<{
        id: string;
        url: string;
        type: string;
        title: string;
        webSocketDebuggerUrl?: string;
      }>;

      console.error(`[PlaywrightEngine] /json targets: ${targets.map(t => `${t.type}:${t.url.substring(0, 40)}`).join(', ')}`);

      // Get registered wmux targets
      const info = (await sendRpc('browser.cdp.info')) as CdpInfoResponse;
      this.cacheShellUrl(info);
      const wmuxTarget = surfaceId
        ? info.targets.find((t) => t.surfaceId === surfaceId)
        : info.targets[0];

      // Find the webview in /json
      let jsonTarget = wmuxTarget
        ? targets.find((t) => t.id === wmuxTarget.targetId)
        : undefined;

      if (!jsonTarget) {
        jsonTarget = targets.find(
          (t) => t.type === 'page' && !this.isShellPage(t.url) && t.url !== 'about:blank',
        );
      }

      if (!jsonTarget) {
        console.error('[PlaywrightEngine] No webview found in /json');
        return null;
      }

      console.error(`[PlaywrightEngine] Found target in /json: ${jsonTarget.id} url=${jsonTarget.url}`);

      // Attach to the target via browser-level CDP session (don't disconnect!)
      // Auto-attach is already enabled by connect() on this.autoAttachSession —
      // re-issuing Target.setAutoAttach here would just register another probe
      // session and leak on every retry.
      const session = await this.browser.newBrowserCDPSession();
      try {
        // Explicitly attach to the discovered target
        await session.send('Target.attachToTarget', {
          targetId: jsonTarget.id,
          flatten: true,
        });

        console.error(`[PlaywrightEngine] Attached to target ${jsonTarget.id} via /json`);

        // Brief wait for Playwright to process the attached target
        await sleep(200);

        const pages = this.getAllPages();
        console.error(`[PlaywrightEngine] After /json attach: ${pages.length} pages`);

        const matchedPage = pages.find((p) => !this.isShellPage(p.url()));
        if (matchedPage) {
          console.error(`[PlaywrightEngine] Found page via /json attach: ${matchedPage.url()}`);
          return matchedPage;
        }
      } catch (attachErr) {
        console.error(`[PlaywrightEngine] /json attach failed: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`);
      } finally {
        await session.detach().catch(() => { /* best-effort */ });
      }

      return null;
    } catch (err) {
      console.error('[PlaywrightEngine] findViaJsonEndpoint error:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async getBrowser(): Promise<Browser | null> {
    await this.ensureConnected();
    return this.browser;
  }
}
