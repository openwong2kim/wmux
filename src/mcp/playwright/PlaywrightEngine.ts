import type { Browser, BrowserContext, Page, CDPSession } from 'playwright-core';
import { loadPlaywright } from './lazyPlaywright';
import { sendRpc } from '../wmux-client';
import { getConnectionScope } from '../connectionScope';
import { isMac } from '../../shared/platform';
import { formatMacosError, MACOS_ERRORS } from '../../shared/errors/macos';
import type { BrowserBackend } from '../../shared/browserBackend';
import { EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE } from '../../shared/browserBackend';
import {
  assertBrowserTargetScope,
  isWorkspaceScopeUnresolvedError,
  WorkspaceScopeUnresolvedError,
  WORKSPACE_SCOPE_UNRESOLVED_CODE,
  type BrowserTargetScope,
} from './browserScope';

export { WORKSPACE_SCOPE_UNRESOLVED_CODE } from './browserScope';

interface CdpTargetInfo {
  surfaceId: string;
  targetId: string;
  /**
   * Owning workspace id (#554). Present on mains that tag surfaces at CDP
   * register time; absent on older mains. Used to scope page selection to the
   * CALLING session's workspace so a read never returns another workspace's
   * page. See resolveCallerSurface().
   */
  workspaceId?: string;
}

interface CdpInfoResponse {
  /**
   * Present only when the main process authorizes this caller to attach to
   * Electron's CDP endpoint. Target metadata can still be returned without it.
   */
  cdpPort?: number;
  /**
   * The actual runtime URL of the main-window webContents (the app shell),
   * as reported by the main process. Optional: absent on older mains or when
   * the window is mid-load (empty URL is suppressed). When present it is the
   * authoritative shell identifier; when absent we fall back to the static
   * isElectronShellUrl() heuristic. See browser.cdp.info handler.
   */
  shellUrl?: string;
  /**
   * True when the main process filtered `targets` to the caller's workspace
   * (#580, Option 1). Distinguishes an empty scoped list ("caller owns no live
   * targets") from an older main that cannot scope at all — the leniency
   * fallback in resolveCallerSurface is gated on its ABSENCE.
   */
  targetsScoped?: boolean;
  /**
   * The workspace's browser backend (#517). 'external' means agent-driven opens
   * are delegated to the OS default browser and NO builtin webview target will
   * ever exist for this workspace — so a page-resolution miss is permanent, not
   * a race. Absent on older mains (treated as 'builtin' — the default — so
   * builtin behavior is byte-identical). The value itself is GLOBAL (one
   * main-side setting), merely reported on this per-workspace-scoped response.
   */
  workspaceBackend?: BrowserBackend;
  /**
   * Live-Chrome attach (Phase 3): the browser-level CDP WebSocket endpoint of
   * the user's own Chrome (from its DevToolsActivePort). Mutually exclusive
   * with cdpPort; when present, connect over it verbatim — there is no HTTP
   * /json surface behind it.
   */
  wsEndpoint?: string;
  targets: CdpTargetInfo[];
}

const MAX_CONNECT_RETRIES = 3;
const RETRY_DELAY_MS = 800;
const PAGE_FIND_RETRIES = 3;
const PAGE_FIND_DELAY_MS = 500;
const CDP_ATTACH_INFO_UNAVAILABLE_MESSAGE =
  '[PlaywrightEngine] browser.cdp.info did not disclose a usable CDP endpoint to this caller';

/**
 * Non-retryable inside the engine. Tools with a scoped RPC equivalent
 * deliberately convert this refusal into fallback via allowScopedRpcFallback;
 * tools that require a Playwright Page surface it because no equivalent
 * main-process operation exists.
 */
class CdpAttachInfoUnavailableError extends Error {
  constructor() {
    super(CDP_ATTACH_INFO_UNAVAILABLE_MESSAGE);
    this.name = 'CdpAttachInfoUnavailableError';
  }
}

/**
 * The contract error for "page selection cannot be scoped to the caller".
 *
 * Every workspace-routed sibling already fails closed on the SAME identity
 * miss: browser_open / browser_close throw from requireWorkspaceId
 * (src/mcp/index.ts), browser_tabs returns BROWSER_TABS_WORKSPACE_UNRESOLVED
 * (tools/navigation.ts), and the engine's own auto-open skips the RPC
 * (attemptAutoOpen). Page selection used to be the one path that stayed
 * lenient, and a lenient selection can only mean "any workspace's live guest"
 * — so it refuses too, and says why.
 *
 * `reason` names the specific miss (unresolved identity, cdp.info down, a main
 * too old to tag targets) so the caller can tell a transient failure from a
 * permanent one. Mirrors EXTERNAL_BACKEND_UNSUPPORTED's `CODE: prose` shape.
 */
function workspaceScopeUnresolved(reason: string): Error {
  // Log as well as throw so direct engine consumers retain a clear refusal
  // reason even when a tool later renders the error into MCP result content.
  console.error(`[PlaywrightEngine] Page selection refused — ${reason}`);
  return new WorkspaceScopeUnresolvedError(
    `cannot determine which workspace this session owns (${reason}), ` +
      `so browser page selection cannot be scoped to it. Refusing rather than driving another workspace's browser. ` +
      `Make sure you are running inside a wmux terminal workspace.`,
  );
}

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
  /** Fast-fail latch, keyed by selection context (#554). A page-discovery
   *  failure in one workspace must not block reads in another. */
  private playwrightFailed = new Set<string>();
  /** Auto-open attempts, keyed by selection context (#554). Auto-open is a
   *  per-workspace decision, so a single shared boolean would let one
   *  workspace's auto-open suppress another workspace's own. */
  private autoOpenAttempted = new Set<string>();
  /** In-flight getPage promises, keyed by selection context (#554). A single
   *  shared lock returned one caller's page (or auto-open) to a concurrent
   *  caller in a DIFFERENT workspace — a cross-workspace read. Keying by
   *  context serializes same-context calls while isolating different ones. */
  private getPageLocks = new Map<string, Promise<Page | null>>();
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
  /**
   * The caller workspace's browser backend, captured from the most recent
   * browser.cdp.info response (#517). 'external' means the workspace delegates
   * agent opens to the OS browser and owns no builtin webview target, so a
   * page-resolution miss must fail with the shared contract error instead of
   * looping through retries/auto-open that can never succeed. undefined until a
   * cdp.info response is seen; absent-in-response is treated as 'builtin'.
   * NOTE: the backend setting is GLOBAL today (one main-side value, not
   * per-workspace) — a single field on this singleton engine is correct. If a
   * per-workspace backend ever ships, this must become per-context state.
   */
  private workspaceBackend: BrowserBackend | undefined = undefined;
  /**
   * Resolves the calling session's workspace id when a caller has not already
   * supplied one. Wired by src/mcp/index.ts to requireWorkspaceId(). Browser
   * tool handlers resolve once before acquiring a lease and pass that id into
   * getPage(); direct engine callers use this fallback. null means no resolver
   * is wired, in which case selection/auto-open fails closed.
   */
  private workspaceIdResolver: (() => Promise<string>) | null = null;

  private constructor() {}

  setWorkspaceIdResolver(resolver: () => Promise<string>): void {
    this.workspaceIdResolver = resolver;
  }

  static getInstance(): PlaywrightEngine {
    // Broker mode (connectionScope.ts): each hosted connection gets its OWN
    // engine so two panes driving two browser sessions cannot bleed CDP
    // state, auto-open scope, or the shell-URL cache into each other. The
    // nine tool modules keep calling getInstance() unchanged — the scope,
    // when active, redirects them to the per-connection instance.
    const scope = getConnectionScope();
    if (scope) {
      if (!scope.playwright) scope.playwright = new PlaywrightEngine();
      return scope.playwright as PlaywrightEngine;
    }
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
    // A 'chrome' response never carries a shellUrl (there is no app shell in
    // the dedicated instance). Drop any value learned before a builtin→chrome
    // flip so a stale exact-match can't hide a chrome tab at that URL.
    if (info.workspaceBackend === 'chrome') {
      this.shellUrl = null;
    }
    // Capture the backend marker alongside the shell URL (#517): every
    // browser.cdp.info response flows through here, so this is the single point
    // where the marker reaches the engine regardless of which finder made the
    // call. Only overwrite when the field is present — an older main that omits
    // it must not clobber a value learned from a scoped response.
    if (info.workspaceBackend) {
      this.workspaceBackend = info.workspaceBackend;
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
    // Chrome backend: the CDP endpoint is a real Chrome — there is no app
    // shell to exclude, and the localhost heuristics below would misclassify
    // the user's own dev-server tabs as the shell.
    if (this.workspaceBackend === 'chrome') return false;
    if (this.shellUrl && url === this.shellUrl) return true;
    return isElectronShellUrl(url);
  }

  /**
   * Resolve the Playwright Page for an explicitly pinned CDP target (codex
   * P2, PR #528): two panes can share a URL (duplicated tabs, default
   * new-browser URL), so URL equality alone can hand back the WRONG guest
   * while the lease is held for the requested one.
   *
   * Client-side Page objects expose no targetId, so every candidate pays for
   * one Target.getTargetInfo round-trip over a throwaway CDP session. URL
   * equality alone is insufficient even when unique: our own newly attached
   * page may not have materialized yet while a foreign workspace already has
   * the same URL. A target that cannot be proven → null.
   */
  private async matchPinnedPage(pages: Page[], targetId: string, url: string): Promise<Page | null> {
    const byUrl = pages.filter((p) => p.url() === url);
    const candidates = byUrl.length > 0 ? byUrl : pages;
    for (const p of candidates) {
      try {
        const session = await p.context().newCDPSession(p);
        try {
          const { targetInfo } = (await session.send('Target.getTargetInfo')) as {
            targetInfo: { targetId: string };
          };
          if (targetInfo?.targetId === targetId) return p;
        } finally {
          await session.detach().catch(() => { /* best-effort */ });
        }
      } catch {
        /* page may be mid-navigation or gone — try the next candidate */
      }
    }
    return null;
  }

  async connect(cdpPortOrWsEndpoint: number | string): Promise<void> {
    // Ports build the HTTP endpoint (dedicated instances, Electron); a ws://
    // string (live-Chrome attach) passes through verbatim — connectOverCDP
    // accepts both. The short-circuit keys on the resolved endpoint.
    const isPort = typeof cdpPortOrWsEndpoint === 'number';
    const endpoint = isPort ? `http://localhost:${cdpPortOrWsEndpoint}` : cdpPortOrWsEndpoint;
    const samePort = isPort && this.cdpPort === cdpPortOrWsEndpoint;
    const sameWs = !isPort && this.cdpPort === null && this.connectedEndpoint === endpoint;
    if (this.browser && (samePort || sameWs) && this.browser.isConnected()) {
      return;
    }
    await this.disconnect();
    // B0: first real use — initialize playwright-core's module graph now.
    const { chromium } = loadPlaywright();
    this.browser = await chromium.connectOverCDP(endpoint);
    // cdpPort stays null on ws connections: findViaJsonEndpoint (HTTP /json)
    // has no surface to talk to there and is gated on this.cdpPort.
    this.cdpPort = isPort ? cdpPortOrWsEndpoint : null;
    this.connectedEndpoint = endpoint;
    console.error(`[PlaywrightEngine] Connected to CDP at ${isPort ? `port ${cdpPortOrWsEndpoint}` : 'ws endpoint'}`);

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
    this.connectedEndpoint = null;
    this.autoAttachSession = null;
    // Drop the cached shell URL — a reconnect may target a different window
    // (different port) whose shell URL must be re-fetched, not reused.
    this.shellUrl = null;
    // Drop the cached backend marker for the same reason — it is re-learned
    // from the next cdp.info response (#517).
    this.workspaceBackend = undefined;
    this.connectedWorkspaceId = undefined;
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

  /** Workspace whose cdp.info produced the current connection. Per-workspace
   *  Chrome profiles (Phase 2.5) mean different workspaces can resolve to
   *  DIFFERENT ports — a live connection for A must not be reused for B. */
  private connectedWorkspaceId: string | undefined;
  /** Resolved endpoint of the live connection (http URL or ws URL). */
  private connectedEndpoint: string | null = null;

  async ensureConnected(workspaceId?: string): Promise<void> {
    if (
      this.browser?.isConnected() &&
      (workspaceId === undefined || this.connectedWorkspaceId === undefined || this.connectedWorkspaceId === workspaceId)
    ) {
      return;
    }

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
      try {
        const info = (await sendRpc(
          'browser.cdp.info',
          workspaceId ? { workspaceId } : {},
        )) as CdpInfoResponse;
        this.cacheShellUrl(info);
        // Live-Chrome attach reports a ws endpoint instead of a port.
        if (typeof info.wsEndpoint === 'string' && info.wsEndpoint.startsWith('ws')) {
          await this.connect(info.wsEndpoint);
          this.connectedWorkspaceId = workspaceId;
          return;
        }
        if (
          typeof info.cdpPort !== 'number'
          || !Number.isInteger(info.cdpPort)
          || info.cdpPort <= 0
          || info.cdpPort > 65_535
        ) {
          // Absence is an authorization/configuration decision, not a transient
          // connection failure. Retrying cannot make this response disclose the
          // endpoint and would hide the useful cause behind retry exhaustion.
          throw new CdpAttachInfoUnavailableError();
        }
        await this.connect(info.cdpPort);
        this.connectedWorkspaceId = workspaceId;
        return;
      } catch (err) {
        if (err instanceof CdpAttachInfoUnavailableError) throw err;
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
   *
   * `workspaceId`, when supplied by the tool layer, is the already-verified id
   * reused by its lease and fallback RPCs (#695). This avoids a second identity
   * lookup and also scopes explicit-surface discovery on the main side.
   */
  private async getPage(surfaceId?: string, workspaceId?: string): Promise<Page | null> {
    // Resolve the selection context (which workspace/surface this call targets)
    // BEFORE consulting any shared state, so the lock, fast-fail latch, and
    // auto-open latch are all scoped to THIS caller's workspace and can never
    // bleed into another's (#554). Context resolution needs only the control
    // RPC (browser.cdp.info); the CDP browser connection happens in
    // _getPageImpl as before.
    const ctx = await this.resolveSelectionContext(surfaceId, workspaceId);

    // External-backend contract (#517): the caller's workspace delegates opens
    // to the OS browser and owns no builtin webview target (callerHasNoSurface,
    // i.e. resolveCallerSurface returned kind:'none' with zero scoped targets).
    // No target will EVER appear, so the retry/auto-open/wait loops below are
    // pointless — fail immediately with the shared contract error instead of
    // the generic target-miss that sends agents into retry loops. Gated on an
    // explicit 'external' marker, so builtin (and older mains that omit it)
    // are byte-identical. Deliberately NOT applied when the caller pinned an
    // explicit surfaceId or when a live builtin target exists (mixed mode):
    // resolveSelectionContext only sets callerHasNoSurface on the scoped-empty
    // path, so a manually-opened builtin pane still resolves normally.
    if (ctx.callerHasNoSurface && this.workspaceBackend === 'external') {
      throw new Error(EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE);
    }

    // Fast-fail if page discovery already failed for this context.
    if (this.playwrightFailed.has(ctx.key)) return null;

    // Serialize concurrent calls for the SAME context (prevents duplicate
    // auto-open); a different context gets its own promise, never this one's.
    const inflight = this.getPageLocks.get(ctx.key);
    if (inflight) return inflight;
    const p = this._getPageImpl(ctx);
    this.getPageLocks.set(ctx.key, p);
    try {
      return await p;
    } finally {
      this.getPageLocks.delete(ctx.key);
    }
  }

  /**
   * Scope-required entry point for MCP browser tools (#695). Keeping the
   * verified workspace and optional surface in one required object makes a
   * dropped workspaceId a compile error at every tool call site.
   */
  async getPageForScope(scope: BrowserTargetScope): Promise<Page | null> {
    assertBrowserTargetScope(scope);
    return this.getPage(scope.surfaceId, scope.workspaceId);
  }

  /**
   * Resolve the surface owned by the CALLING session's workspace (#554).
   *
   * Read tools (browser_snapshot / browser_evaluate / browser_extract_*) take
   * an OPTIONAL surfaceId; when the caller omits it — the common case — page
   * selection must still be scoped to the caller's workspace, mirroring the
   * write path (browser.open / navigate) which already routes by the caller's
   * resolved workspace. Otherwise, with two live browser surfaces, an agent in
   * workspace A can read workspace B's page.
   *
   *  - { kind: 'surface', surfaceId } — caller's workspace owns a live surface;
   *    scope selection to it.
   *  - { kind: 'none' } — identity resolved but the caller's workspace owns no
   *    surface. Callers must NOT fall back to another workspace's page.
   *
   * There is no third, lenient outcome. Every path that cannot PROVE which
   * surface belongs to the caller throws WORKSPACE_SCOPE_UNRESOLVED: a
   * selection made without that proof reaches any workspace's live guest
   * (findViaTargetDomain's `targets[0]`, and the "first non-shell page"
   * heuristic), which is exactly what scoping exists to prevent. Identity can
   * legitimately be unresolvable for a well-behaved agent — a sandboxed Codex
   * cannot walk its own process tree — so this is not a spoofing question and
   * the #113 same-user ceiling does not cover it.
   */
  private async resolveCallerSurface(resolvedWorkspaceId?: string): Promise<
    | { kind: 'surface'; surfaceId: string; workspaceId: string }
    | { kind: 'none'; workspaceId: string }
  > {
    let workspaceId = resolvedWorkspaceId;
    if (workspaceId === undefined) {
      if (!this.workspaceIdResolver) throw workspaceScopeUnresolved('no workspace resolver wired');
      try {
        workspaceId = await this.workspaceIdResolver();
      } catch (err) {
        throw workspaceScopeUnresolved(
          `workspace identity unresolved: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!workspaceId) throw workspaceScopeUnresolved('workspace identity resolved to an empty id');

    let info: CdpInfoResponse;
    try {
      // Pass our resolved workspace so main filters `targets` server-side
      // (#580, Option 1). The response then carries only our own targets.
      info = (await sendRpc('browser.cdp.info', { workspaceId })) as CdpInfoResponse;
    } catch (err) {
      throw workspaceScopeUnresolved(
        `browser.cdp.info unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.cacheShellUrl(info);

    // A main that honored the scope request marks the response `targetsScoped`.
    // Then an empty list unambiguously means "we own no live target" (kind:
    // 'none'), and a present one is already ours — no client-side filter needed.
    if (info.targetsScoped) {
      const own = info.targets[0];
      return own
        ? { kind: 'surface', surfaceId: own.surfaceId, workspaceId }
        : { kind: 'none', workspaceId };
    }

    // Legacy path: an older main ignored the param and returned every target.
    //
    // An EMPTY list from such a main is unambiguous no matter who it belongs to
    // — there is no live guest anywhere — so it is 'none' (auto-open our own),
    // which is what the old leniency was really protecting: a single-workspace
    // setup with nothing to cross into.
    if (info.targets.length === 0) return { kind: 'none', workspaceId };

    // Targets exist but if NONE carry a workspaceId we cannot scope at all —
    // and an unscopeable selection is a cross-workspace selection, so refuse.
    // Matches how browser_tabs reports a main too old to scope
    // (BROWSER_TABS_UNSUPPORTED) rather than falling back to something
    // workspace-blind.
    const anyTagged = info.targets.some(
      (t) => typeof t.workspaceId === 'string' && t.workspaceId.length > 0,
    );
    if (!anyTagged) {
      throw workspaceScopeUnresolved(
        'the connected wmux main does not tag browser targets with a workspace',
      );
    }

    const own = info.targets.find((t) => t.workspaceId === workspaceId);
    if (own) return { kind: 'surface', surfaceId: own.surfaceId, workspaceId };
    return { kind: 'none', workspaceId };
  }

  /**
   * Resolve the page-selection context for a getPage() call and derive a
   * stable KEY for it (#554 — CodeRabbit). Everything that used to be
   * singleton-scoped — the in-flight lock, the auto-open latch, the
   * fast-fail latch — is now keyed by this context so a call from one
   * workspace can never share an in-flight page, an auto-open decision, or a
   * failure state with a DIFFERENT workspace. Concurrent calls that genuinely
   * target the same surface/workspace still share (and serialize) under one key.
   */
  private async resolveSelectionContext(
    explicitSurfaceId?: string,
    workspaceId?: string,
  ): Promise<{ key: string; surfaceId?: string; callerHasNoSurface: boolean; workspaceId?: string }> {
    if (explicitSurfaceId) {
      return {
        key: workspaceId ? `ws:${workspaceId}:surf:${explicitSurfaceId}` : `surf:${explicitSurfaceId}`,
        surfaceId: explicitSurfaceId,
        callerHasNoSurface: false,
        ...(workspaceId && { workspaceId }),
      };
    }
    const owned = await this.resolveCallerSurface(workspaceId);
    if (owned.kind === 'surface') {
      return { key: `ws:${owned.workspaceId}`, surfaceId: owned.surfaceId, callerHasNoSurface: false, workspaceId: owned.workspaceId };
    }
    return { key: `ws:${owned.workspaceId}`, surfaceId: undefined, callerHasNoSurface: true, workspaceId: owned.workspaceId };
  }

  private async _getPageImpl(
    ctx: { key: string; surfaceId?: string; callerHasNoSurface: boolean; workspaceId?: string },
  ): Promise<Page | null> {

    await this.ensureConnected(ctx.workspaceId);

    // Selection is scoped to the caller's workspace (#554), resolved by
    // getPage() -> resolveSelectionContext(). `surfaceId` set = pin to that
    // surface; `callerHasNoSurface` = the caller's workspace owns none, so the
    // workspace-blind fallbacks must be skipped and we auto-open its own.
    let surfaceId = ctx.surfaceId;
    let callerHasNoSurface = ctx.callerHasNoSurface;
    // A surfaceId returned by our own workspace-scoped browser.open is already
    // proven even when a legacy main cannot tag its subsequent cdp.info entry.
    let surfaceProvenByAutoOpen = false;

    for (let attempt = 1; attempt <= PAGE_FIND_RETRIES; attempt++) {
      try {
        // Strategies 1-3 locate an EXISTING page. When the caller's workspace
        // is known to own no surface (#554), every one of them can only return
        // a DIFFERENT workspace's page, so skip straight to auto-open.
        if (!callerHasNoSurface) {
        // Strategy 1 (was 2): positive identification via the registered
        // targetId from WebviewCdpManager. This is the authoritative match —
        // it pins the exact guest webview by id — so it runs FIRST, before the
        // negative "any non-shell page" heuristic, to avoid ever returning the
        // shell when the shell happens to slip past URL classification.
        if (this.browser) {
          const page = await this.findViaTargetDomain(
            surfaceId,
            ctx.workspaceId,
            surfaceProvenByAutoOpen,
          );
          if (page) return page;
        }

        // Strategy 2 (was 1): fall back to the first existing page that isn't
        // the app shell. Used when positive targetId matching didn't yield a
        // page (e.g. target not registered yet). isShellPage() prefers the
        // runtime shell URL and falls back to the static heuristic.
        //
        // Strict surface targeting (#517): when the caller pinned an explicit
        // surfaceId, this heuristic is SKIPPED — returning "some other guest"
        // would silently drive surface B while the automation lease (and the
        // caller's intent) points at surface A.
        //
        // Since resolveCallerSurface fails closed there is no longer a context
        // with NO surfaceId and callerHasNoSurface=false — that combination was
        // only produced by the old lenient 'unscoped' outcome — so this
        // workspace-blind pick is unreachable. Kept as the last line of defense
        // if a future context shape reintroduces it.
        if (!surfaceId) {
          const allPages = this.getAllPages();
          console.error(`[PlaywrightEngine] Attempt ${attempt}: ${allPages.length} pages in ${this.browser?.contexts().length ?? 0} contexts`);

          const safePage = allPages.find((p) => !this.isShellPage(p.url()));
          if (safePage) {
            console.error(`[PlaywrightEngine] Found page via contexts: ${safePage.url()}`);
            return safePage;
          }
        }

        // Strategy 3: Use /json endpoint + match registered targets
        if (this.cdpPort) {
          const page = await this.findViaJsonEndpoint(
            surfaceId,
            ctx.workspaceId,
            surfaceProvenByAutoOpen,
          );
          if (page) return page;
        }
        } // end !callerHasNoSurface

        // Strategy 4: No browser surface exists — auto-open one via RPC.
        // This eliminates the requirement for callers to call browser_open
        // first. Skipped for an explicitly pinned surfaceId (codex P3, PR
        // #528): a fresh surface gets a DIFFERENT id, so the pinned lookup
        // would still fail while the user is left with an unexpected pane.
        if (attempt === 1 && !this.autoOpenAttempted.has(ctx.key) && !surfaceId) {
          console.error('[PlaywrightEngine] No page found — auto-opening browser surface');
          try {
            const opened = await this.attemptAutoOpen(ctx.workspaceId);
            if (opened) {
              // Latch (per context) only once the RPC actually went out, so a
              // fail-closed skip (no resolver / unresolved identity) leaves a
              // later call free to retry instead of spending the one-shot
              // attempt — and one workspace's auto-open never blocks another's.
              this.autoOpenAttempted.add(ctx.key);
              // Wait for the webview to register its CDP target
              await sleep(2000);
              await this.disconnect();
              await this.ensureConnected(ctx.workspaceId);
              // Pin the surface we just opened (#554) — otherwise
              // callerHasNoSurface keeps skipping Strategies 1-3 and the new
              // page is never found.
              //
              // Take it from browser.open's own reply rather than re-deriving
              // it. Re-deriving went through resolveCallerSurface(), which on a
              // main too old to tag targets THROWS — and that main is exactly
              // the one whose empty target list sent us down this branch. The
              // throw landed in the catch below, callerHasNoSurface stayed
              // true, and the auto-open opened a panel whose page could never
              // be returned. We asked for this surface, so no proof is owed.
              if (callerHasNoSurface) {
                if (opened.surfaceId) {
                  surfaceId = opened.surfaceId;
                  callerHasNoSurface = false;
                  surfaceProvenByAutoOpen = true;
                } else {
                  // A main that did not name the surface. Fall back to
                  // re-deriving. Scope refusals stay terminal; ordinary
                  // discovery failures continue through the normal retry path.
                  try {
                    const owned = await this.resolveCallerSurface(ctx.workspaceId);
                    if (owned.kind === 'surface') {
                      surfaceId = owned.surfaceId;
                      callerHasNoSurface = false;
                    }
                  } catch (resolveErr) {
                    if (isWorkspaceScopeUnresolvedError(resolveErr)) throw resolveErr;
                    console.error(
                      '[PlaywrightEngine] Could not pin the auto-opened surface:',
                      resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
                    );
                  }
                }
              }
              continue; // retry page discovery
            }
          } catch (openErr) {
            if (isWorkspaceScopeUnresolvedError(openErr)) throw openErr;
            console.error('[PlaywrightEngine] Auto-open failed:', openErr instanceof Error ? openErr.message : String(openErr));
          }
        }

        if (attempt < PAGE_FIND_RETRIES) {
          console.error(`[PlaywrightEngine] No page found, reconnecting... (${attempt}/${PAGE_FIND_RETRIES})`);
          await sleep(PAGE_FIND_DELAY_MS);
          await this.disconnect();
          await this.ensureConnected(ctx.workspaceId);
        }
      } catch (err) {
        if (isWorkspaceScopeUnresolvedError(err)) throw err;
        if (err instanceof CdpAttachInfoUnavailableError) throw err;
        console.error(
          `[PlaywrightEngine] getPage attempt ${attempt} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt < PAGE_FIND_RETRIES) {
          await sleep(PAGE_FIND_DELAY_MS);
          await this.disconnect();
          await this.ensureConnected(ctx.workspaceId);
        }
      }
    }

    console.error('[PlaywrightEngine] No webview page found after all retries — marking as temporarily failed');
    this.playwrightFailed.add(ctx.key);
    // Auto-reset after 10s so subsequent browser.open calls get a fresh chance.
    // Without this, one early failure permanently blocks this context's page
    // discovery. Scoped to ctx.key so one workspace's failure never blocks
    // another's (#554).
    setTimeout(() => { this.playwrightFailed.delete(ctx.key); this.autoOpenAttempted.delete(ctx.key); }, 10_000);
    return null;
  }

  /**
   * Issue the auto-open browser.open RPC, pinned to the calling session's
   * workspace. Fails closed: when no resolver is wired or identity cannot be
   * resolved, NO RPC is sent (returns false) — a workspace-less browser.open
   * would let the renderer fall back to the UI-active workspace (#190). The
   * caller then proceeds to the normal "no page" retry/error path, surfacing
   * the existing "Call browser_open first" guidance to the user.
   */
  /**
   * @returns the surface that was opened (`surfaceId` absent if the reply did
   *   not name one), or null when the attempt was skipped fail-closed.
   *
   * The surfaceId matters: it is the ONE selection this engine can make without
   * having to prove anything, because we are the ones who just asked for it.
   */
  private async attemptAutoOpen(resolvedWorkspaceId?: string): Promise<{ surfaceId?: string } | null> {
    let workspaceId = resolvedWorkspaceId;
    if (workspaceId === undefined) {
      if (!this.workspaceIdResolver) {
        console.error('[PlaywrightEngine] Auto-open skipped: no workspace resolver wired');
        return null;
      }
      try {
        workspaceId = await this.workspaceIdResolver();
      } catch (err) {
        console.error(
          '[PlaywrightEngine] Auto-open skipped: workspace identity unresolved:',
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    }
    if (!workspaceId) {
      console.error('[PlaywrightEngine] Auto-open skipped: empty workspace id');
      return null;
    }
    const reply = (await sendRpc('browser.open', { workspaceId })) as { surfaceId?: unknown } | undefined;
    const surfaceId = typeof reply?.surfaceId === 'string' && reply.surfaceId ? reply.surfaceId : undefined;
    return surfaceId ? { surfaceId } : {};
  }

  /**
   * Use CDP Target domain to discover webview targets and create a page for them.
   */
  private async findViaTargetDomain(
    surfaceId?: string,
    workspaceId?: string,
    surfaceProvenByAutoOpen = false,
  ): Promise<Page | null> {
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

        // Get registered wmux targets for matching, scoped to the caller's
        // workspace when known so the no-surfaceId fallback (info.targets[0])
        // can never resolve to another workspace's guest (#580, Option 1).
        // getPage now always arrives with either a surfaceId or a resolved
        // workspaceId (fail-closed scoping), so the unscoped `{}` call and the
        // `targets[0]` pick below are reachable only from a direct call.
        const info = (await sendRpc(
          'browser.cdp.info',
          workspaceId ? { workspaceId } : {},
        )) as CdpInfoResponse;
        this.cacheShellUrl(info);
        const wmuxTarget = this.selectRegisteredTarget(
          info,
          surfaceId,
          workspaceId,
          surfaceProvenByAutoOpen,
        );

        // Find the webview target — match by targetId from WebviewCdpManager
        let webviewTarget = wmuxTarget
          ? targetInfos.find((t) => t.targetId === wmuxTarget.targetId)
          : undefined;

        // Fallback: find any page target that isn't the Electron shell.
        // Strict surface targeting (#517): only when NO explicit surfaceId was
        // requested — an explicit surface must match by targetId or fail.
        if (!webviewTarget && !surfaceId) {
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

        // Strict surface targeting (#517): with an explicit surfaceId, match
        // the attached page by the pinned targetId (URL only as an unambiguous
        // fallback) instead of "any non-shell page".
        const matchedPage = surfaceId
          ? await this.matchPinnedPage(newPages, webviewTarget.targetId, webviewTarget.url)
          : newPages.find((p) => !this.isShellPage(p.url()));
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
      if (isWorkspaceScopeUnresolvedError(err)) throw err;
      console.error('[PlaywrightEngine] findViaTargetDomain error:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Use the /json HTTP endpoint to find webview targets and attach via CDP.
   */
  private async findViaJsonEndpoint(
    surfaceId?: string,
    workspaceId?: string,
    surfaceProvenByAutoOpen = false,
  ): Promise<Page | null> {
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

      // Get registered wmux targets, scoped to the caller's workspace when
      // known so the no-surfaceId fallback can't cross workspaces (#580).
      const info = (await sendRpc(
        'browser.cdp.info',
        workspaceId ? { workspaceId } : {},
      )) as CdpInfoResponse;
      this.cacheShellUrl(info);
      const wmuxTarget = this.selectRegisteredTarget(
        info,
        surfaceId,
        workspaceId,
        surfaceProvenByAutoOpen,
      );

      // Find the webview in /json
      let jsonTarget = wmuxTarget
        ? targets.find((t) => t.id === wmuxTarget.targetId)
        : undefined;

      // Strict surface targeting (#517): the any-non-shell fallback only runs
      // when no explicit surfaceId was requested.
      if (!jsonTarget && !surfaceId) {
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

        // Strict surface targeting (#517): pinned surface matches by targetId
        // (URL only when unambiguous) — never "any non-shell page".
        const matchedPage = surfaceId
          ? await this.matchPinnedPage(pages, jsonTarget.id, jsonTarget.url)
          : pages.find((p) => !this.isShellPage(p.url()));
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
      if (isWorkspaceScopeUnresolvedError(err)) throw err;
      console.error('[PlaywrightEngine] findViaJsonEndpoint error:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Select a registered target without trusting an older main to have honored
   * the workspace filter. Current mains mark scoped responses explicitly;
   * legacy responses must carry target ownership tags or selection is refused.
   */
  private selectRegisteredTarget(
    info: CdpInfoResponse,
    surfaceId?: string,
    workspaceId?: string,
    surfaceProvenByAutoOpen = false,
  ): CdpTargetInfo | undefined {
    if (!workspaceId || info.targetsScoped) {
      return surfaceId
        ? info.targets.find((target) => target.surfaceId === surfaceId)
        : info.targets[0];
    }

    if (surfaceId) {
      const target = info.targets.find((candidate) => candidate.surfaceId === surfaceId);
      if (!target) return undefined;
      if (!target.workspaceId && surfaceProvenByAutoOpen) return target;
      if (!target.workspaceId) {
        throw workspaceScopeUnresolved(
          'the connected wmux main does not tag the requested browser target with a workspace',
        );
      }
      if (target.workspaceId !== workspaceId) {
        throw workspaceScopeUnresolved(
          'the requested browser surface is not owned by the calling workspace',
        );
      }
      return target;
    }

    const own = info.targets.find((target) => target.workspaceId === workspaceId);
    if (own || info.targets.length === 0) return own;
    const anyTagged = info.targets.some(
      (target) => typeof target.workspaceId === 'string' && target.workspaceId.length > 0,
    );
    if (!anyTagged) {
      throw workspaceScopeUnresolved(
        'the connected wmux main does not tag browser targets with a workspace',
      );
    }
    return undefined;
  }

  async getBrowser(): Promise<Browser | null> {
    await this.ensureConnected();
    return this.browser;
  }
}
