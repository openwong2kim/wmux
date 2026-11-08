import type { Browser, BrowserContext, Page, CDPSession } from 'playwright-core';
import { loadPlaywright } from './lazyPlaywright';
import { sendRpc } from '../wmux-client';
import { getConnectionScope } from '../connectionScope';
import { isMac } from '../../shared/platform';
import { formatMacosError, MACOS_ERRORS } from '../../shared/errors/macos';
import type { BrowserBackend } from '../../shared/browserBackend';
import { EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE } from '../../shared/browserBackend';
import { AgentWindowScopeError } from '../../shared/liveWriteScope';
import {
  assertBrowserTargetScope,
  isWorkspaceScopeUnresolvedError,
  WorkspaceScopeUnresolvedError,
  WORKSPACE_SCOPE_UNRESOLVED_CODE,
  browserCallRefusal,
  isProtectedScope,
  lastKnownProtection,
  rememberProtection,
  type BrowserTargetScope,
} from './browserScope';
import { BrowserPolicyError, POLICY_DENIED_CODE } from '../../shared/browserPolicy';
import { attachPageCapture } from './pageCapture';
import { trackRequestBaseline } from './actionSettle';
import { guardUnclaimedDownloads, isDownloadGuardArmed } from './downloadGuard';
import {
  attachModalTracking,
  modalScopeKey,
  rememberModalScope,
} from './modalState';
import { reassertUserAgentEmulation } from './ua-emulation';
import {
  getOpenerKey,
  openSurfaceForConnection,
  resolveDefaultSurface,
} from './surfaceRouting';
// Cycle-safe: automationLease reaches this module only inside function bodies.
import { currentBrowserOpSignal } from './automationLease';

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
  /**
   * Whether the CALLING connection opened this surface, as main recorded it.
   * Absent when nobody claims it — restored after a restart, opened by a
   * person, or opened before openers were recorded. Used by surfaceRouting to
   * keep an unsaid target on the caller's own surface.
   */
  opener?: 'mine' | 'other';
  /**
   * Live Chrome only: whether the calling workspace may WRITE to this tab
   * ('agent' = wmux opened it for this workspace, 'borrowed' = the user lent
   * it). Main seeds only those two kinds into this list, so a live target that
   * is ABSENT from it is one the agent may read but not drive.
   */
  owner?: 'agent' | 'borrowed' | 'user';
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
  /**
   * A dedicated Chrome on a debugging pipe: the relay's endpoint and the header
   * that lets this caller connect once (a one-time token). Present only when
   * asked for with `relay: true`, which ensureConnected does only when it is
   * about to connect. Never logged or kept past the connect.
   */
  relay?: CdpRelay;
  /** A dedicated Chrome on a debugging pipe, which this caller may reach through the relay. */
  piped?: boolean;
  /**
   * Live Chrome only: the write-scope policy in force (the agent-window
   * policy). 'agent' means writes are confined to the workspace's own tabs plus
   * lent ones; 'all' is the operator opt-out that restores full write exposure.
   * Absent on every other backend and on an older main — both read as "no gate
   * to apply here", which is correct: a dedicated instance can only address tabs
   * wmux opened.
   */
  liveWriteScope?: 'agent' | 'all';
  /**
   * The Chrome profile main resolved for THIS caller — its pane's own profile
   * when the pane is bound to one, else the workspace's. Absent on an older
   * main. Two panes of one workspace can resolve to two profiles, i.e. two
   * Chrome instances on two ports.
   */
  profile?: string;
  /** Protected pane: present (true) only for one. */
  protected?: boolean;
  /** The policy epoch the protected pane's connection is good for. */
  policyEpoch?: number;
  targets: CdpTargetInfo[];
}

/** A relay connect: where, and the one-time header that lets this connection in. */
interface CdpRelay {
  endpoint: string;
  headers: Record<string, string>;
}

function isRelay(value: unknown): value is CdpRelay {
  const relay = value as CdpRelay | null;
  return typeof relay?.endpoint === 'string'
    && typeof relay.headers === 'object' && relay.headers !== null
    && Object.values(relay.headers).every((v) => typeof v === 'string');
}

const MAX_CONNECT_RETRIES = 3;
const RETRY_DELAY_MS = 800;
const PAGE_FIND_RETRIES = 3;
const PAGE_FIND_DELAY_MS = 500;
/** The longest a lookup waits for Playwright to produce the Page of a target it attached. */
const POST_ATTACH_PAGE_WAIT_MS = 500;
/** The same, after the /json fallback's explicit attach. */
const JSON_ATTACH_PAGE_WAIT_MS = 200;
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
  /**
   * The CDP target id each Page was proven to be (matchPinnedPage's
   * Target.getTargetInfo probe). A Page's target never changes, so the next
   * pinned lookup takes a proven Page without probing again. Keyed weakly by
   * the Page itself: a closed Page or a dropped connection's Pages need no
   * clearing, and only a probe ever fills it, never a URL heuristic.
   */
  private targetOfPage = new WeakMap<Page, string>();
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

  private constructor() { /* a singleton: getInstance() */ }

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
    // Same rule for the live write-scope marker: only a present value moves it.
    // It is the ONE signal that tells this lane it is on Live Chrome and has a
    // gate to apply — wsEndpoint cannot serve, because main withholds that from
    // callers it will not hand an attach primitive to, and "withheld" would then
    // read as "no policy".
    if (info.liveWriteScope) {
      this.liveWriteScope = info.liveWriteScope;
    }
    if (typeof info.profile === 'string') this.mainReportsProfile = true;
  }

  /** The live write-scope policy as main last reported it. undefined until a
   *  cdp.info response has said, and on every non-live backend. */
  private liveWriteScope: 'agent' | 'all' | undefined;

  /**
   * Is this workspace on Live Chrome with writes confined to the agent window?
   *
   * For a tool whose mutation is not per-tab at all — a cookie write lands on
   * the whole browser profile, every tab and site — the per-tab ownership gate
   * proves nothing, so the tool asks this instead and refuses outright. Asked
   * fresh (one cdp.info round trip) because the policy is the operator's and
   * can have moved since it was cached; an unreachable main keeps the last
   * answer, which on a fresh engine is "not live".
   */
  async isLiveWriteConfined(workspaceId: string): Promise<boolean> {
    try {
      const info = (await sendRpc('browser.cdp.info', { workspaceId })) as CdpInfoResponse;
      this.cacheShellUrl(info);
    } catch {
      /* keep the cached answer */
    }
    return this.liveWriteScope === 'agent';
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
    // A Page already proven to be this target is returned without a probe.
    const proven = pages.find((p) => this.targetOfPage.get(p) === targetId);
    if (proven) return proven;
    const byUrl = pages.filter((p) => p.url() === url);
    const candidates = byUrl.length > 0 ? byUrl : pages;
    for (const p of candidates) {
      try {
        const session = await p.context().newCDPSession(p);
        try {
          const { targetInfo } = (await session.send('Target.getTargetInfo')) as {
            targetInfo: { targetId: string };
          };
          if (targetInfo?.targetId === targetId) {
            this.targetOfPage.set(p, targetId);
            return p;
          }
        } finally {
          await session.detach().catch(() => { /* best-effort */ });
        }
      } catch {
        /* page may be mid-navigation or gone — try the next candidate */
      }
    }
    return null;
  }

  async connect(cdpPortOrWsEndpoint: number | string | CdpRelay): Promise<void> {
    // Ports build the HTTP endpoint (dedicated instances, Electron); a ws://
    // string (live-Chrome attach) passes through verbatim — connectOverCDP
    // accepts both. The short-circuit keys on the resolved endpoint. A relay
    // connect never short-circuits: one relay endpoint serves every Chrome on
    // a pipe, so it can't tell them apart; ensureConnected decided to connect.
    const relay = typeof cdpPortOrWsEndpoint === 'object' ? cdpPortOrWsEndpoint : null;
    const isPort = typeof cdpPortOrWsEndpoint === 'number';
    const endpoint = relay ? relay.endpoint : isPort ? `http://localhost:${cdpPortOrWsEndpoint}` : (cdpPortOrWsEndpoint as string);
    const samePort = isPort && this.cdpPort === cdpPortOrWsEndpoint;
    const sameWs = !isPort && !relay && this.cdpPort === null && this.connectedEndpoint === endpoint;
    if (this.browser && (samePort || sameWs) && this.browser.isConnected()) {
      return;
    }
    await this.disconnect();
    // B0: first real use — initialize playwright-core's module graph now.
    const { chromium } = loadPlaywright();
    const browser = await this.connectOverCdp(chromium, endpoint, isPort ? (cdpPortOrWsEndpoint as number) : null, relay?.headers);
    // The user may have stopped this op while the attach was in flight; the
    // Stop's disconnect ran before there was a browser to drop. Do not keep
    // a connection the stopped op would go on to drive.
    const opSignal = currentBrowserOpSignal();
    if (opSignal?.aborted) {
      await browser.close().catch(() => { /* already gone */ });
      opSignal.throwIfAborted();
    }
    this.browser = browser;
    // cdpPort stays null on ws connections: findViaJsonEndpoint (HTTP /json)
    // has no surface to talk to there and is gated on this.cdpPort.
    this.cdpPort = isPort ? (cdpPortOrWsEndpoint as number) : null;
    this.connectedEndpoint = endpoint;
    console.error(`[PlaywrightEngine] Connected to CDP at ${isPort ? `port ${cdpPortOrWsEndpoint}` : relay ? 'the pipe relay' : 'ws endpoint'}`);

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

  /** Close URL of the blank tab connectOverCdp opened to attach through. */
  private bootstrapTabCloseUrl: string | null = null;

  /**
   * A Chrome with every window closed but the app still running (the macOS
   * default) has no browser context, and connectOverCDP refuses it with
   * "Browser context management is not supported". For a port endpoint (a
   * dedicated wmux Chrome) open one blank tab to attach through; the caller
   * closes it with closeBootstrapTab() once the attach is complete (a
   * protected pane's download deny needs the context too). A live connection
   * keeps working with no window. A ws endpoint is the user's own Chrome,
   * which wmux does not open windows in.
   */
  private async connectOverCdp(
    chromium: ReturnType<typeof loadPlaywright>['chromium'],
    endpoint: string,
    cdpPort: number | null,
    headers?: Record<string, string>,
  ): Promise<Browser> {
    try {
      return await (headers ? chromium.connectOverCDP(endpoint, { headers }) : chromium.connectOverCDP(endpoint));
    } catch (err) {
      if (cdpPort === null || !/Browser context management is not supported/.test(String(err))) throw err;
    }
    // Chrome 111+ requires PUT for /json/new.
    const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
    const bootstrap = (await resp.json()) as { id?: string };
    if (bootstrap?.id) this.bootstrapTabCloseUrl = `http://127.0.0.1:${cdpPort}/json/close/${bootstrap.id}`;
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (err) {
      await this.closeBootstrapTab();
      throw err;
    }
  }

  private async closeBootstrapTab(): Promise<void> {
    const url = this.bootstrapTabCloseUrl;
    this.bootstrapTabCloseUrl = null;
    if (url) await fetch(url).catch(() => { /* already gone */ });
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
    // Re-learned from the next cdp.info response, like the backend marker. A
    // stale 'agent' would gate a builtin session; a stale 'all' would un-gate a
    // live one, which is the direction that matters.
    this.liveWriteScope = undefined;
    this.connectedWorkspaceId = undefined;
    this.connectedProfile = undefined;
    this.connectedPolicyEpoch = undefined;
    this.downloadDenySession = null;
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
  /** Chrome profile whose cdp.info produced the current connection (undefined
   *  on a main that reports none). With the workspace it is the reuse key. */
  private connectedProfile: string | undefined;
  /** Whether main has ever reported `profile`. Not cleared on disconnect: it
   *  describes main, not the connection. */
  private mainReportsProfile = false;
  /** Protected pane: the policy epoch the live connection was made under
   *  (undefined = an unprotected connection). */
  private connectedPolicyEpoch: number | undefined;

  /** Protected pane: the session holding this connection's download deny. */
  private downloadDenySession: CDPSession | null = null;

  /**
   * Protected pane: deny downloads on this connection's browser. Playwright's
   * own attach sets the default context to allowAndName, undoing any deny set
   * before it; main's download guard cancels whatever still begins. The
   * session stays attached for the connection's life: Chrome drops a download
   * setting when the session that made it detaches.
   */
  private async denyDownloads(): Promise<void> {
    if (!this.browser) return;
    const session = await this.browser.newBrowserCDPSession();
    this.downloadDenySession = session;
    await session.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  }

  async ensureConnected(workspaceId?: string): Promise<void> {
    // The user stopped this op's tab (automationLease): no connection is made
    // or reused for it, so a body that outlived its refusal cannot act again.
    const opSignal = currentBrowserOpSignal();
    opSignal?.throwIfAborted();
    const reusable =
      this.browser?.isConnected() === true &&
      (workspaceId === undefined || this.connectedWorkspaceId === undefined || this.connectedWorkspaceId === workspaceId);
    // A main that reports profiles can rebind this pane to another profile —
    // another Chrome, another port — at any moment, and only cdp.info can say
    // so. One round trip per call buys that; an older main keeps the free path.
    if (reusable && (workspaceId === undefined || !this.mainReportsProfile)) {
      return;
    }

    let lastError: unknown = null;
    // A relay token is minted on every call that asks for one: ask only when
    // about to connect. A live connection's check asks without, and asks again
    // only if it has to reconnect to a Chrome on the pipe.
    let askRelay = !reusable;
    for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
      try {
        const info = (await sendRpc(
          'browser.cdp.info',
          { ...(workspaceId && { workspaceId }), ...(askRelay && { relay: true }) },
        )) as CdpInfoResponse;
        this.cacheShellUrl(info);
        const profile = typeof info.profile === 'string' ? info.profile : undefined;
        const policyEpoch = info.protected === true ? (info.policyEpoch ?? -1) : undefined;
        if (workspaceId && info.protected === true) {
          // This operation was authorized as unprotected (or ran on that answer
          // after its own authorization failed), but the pane is protected now:
          // nothing may run on that stale answer.
          const wasUnprotected = lastKnownProtection(workspaceId) === false;
          rememberProtection(workspaceId, true);
          if (wasUnprotected) {
            throw new BrowserPolicyError(
              POLICY_DENIED_CODE,
              "this pane's browser became protected while the call was starting, so nothing was done. Retry the call once.",
            );
          }
        }
        // Same (workspace, profile, policy epoch): keep the live connection.
        if (reusable && profile === this.connectedProfile && policyEpoch === this.connectedPolicyEpoch) return;
        // A Chrome on the pipe: ask again for a token, and decide on that
        // answer, which may name another profile.
        if (!askRelay && info.piped === true) {
          askRelay = true;
          attempt--;
          continue;
        }
        // The profile moved, or a protected pane's policy changed: drop the old
        // browser and every Page cached on it, even if the endpoint looks the
        // same, so nothing keeps driving under the previous terms.
        if (
          this.browser
          && (profile !== this.connectedProfile || policyEpoch !== this.connectedPolicyEpoch)
        ) {
          await this.disconnect();
        }
        // A Chrome on the pipe is reached through the relay, with this call's token.
        if (isRelay(info.relay)) {
          await this.connect({ endpoint: info.relay.endpoint, headers: info.relay.headers });
          this.connectedWorkspaceId = workspaceId;
          this.connectedProfile = profile;
          this.connectedPolicyEpoch = policyEpoch;
          if (policyEpoch !== undefined) await this.denyDownloads();
          return;
        }
        // Live-Chrome attach reports a ws endpoint instead of a port.
        if (typeof info.wsEndpoint === 'string' && info.wsEndpoint.startsWith('ws')) {
          await this.connect(info.wsEndpoint);
          this.connectedWorkspaceId = workspaceId;
          this.connectedProfile = profile;
          this.connectedPolicyEpoch = policyEpoch;
          if (policyEpoch !== undefined) await this.denyDownloads();
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
        this.connectedProfile = profile;
        this.connectedPolicyEpoch = policyEpoch;
        try {
          if (policyEpoch !== undefined) await this.denyDownloads();
        } finally {
          await this.closeBootstrapTab();
        }
        return;
      } catch (err) {
        if (err instanceof CdpAttachInfoUnavailableError) throw err;
        opSignal?.throwIfAborted();
        // A refusal, like the one above: retrying cannot change main's answer.
        const refusal = browserCallRefusal(err);
        if (refusal) throw refusal;
        // The profile check itself failed. A rebind may have landed in the same
        // moment, so the live connection cannot be proven to be this pane's
        // account any more: drop it, and let the retry (or the call) decide.
        if (reusable && this.browser) await this.disconnect();
        lastError = err;
        console.error(
          `[PlaywrightEngine] Connection attempt ${attempt}/${MAX_CONNECT_RETRIES} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt < MAX_CONNECT_RETRIES) {
          await sleep(RETRY_DELAY_MS);
          opSignal?.throwIfAborted();
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
   * Find the Page of a target just attached: match the pages there are now,
   * then each Page that appears after, until one matches, `boundMs` has passed,
   * or the connection drops. Replaces a fixed wait after an attach: a Page
   * that already exists is returned at once. Each Page is matched once:
   * listening starts after the first match, and any Page that appeared during
   * it is matched next, before any wait. The bound ends with one last look,
   * which also covers a Page in a context created during the wait.
   *
   * Strict surface targeting (#517): with an explicit surfaceId, the Page must
   * be proven to be `targetId` (URL only narrows the candidates); without one,
   * any non-shell Page.
   */
  private async waitForAttachedPage(
    surfaceId: string | undefined,
    targetId: string,
    url: string,
    boundMs: number,
  ): Promise<{ page: Page | null; pageCount: number }> {
    const browser = this.browser;
    let pageCount = 0;
    if (!browser) return { page: null, pageCount };
    const deadline = Date.now() + boundMs;
    const seen = new Set<Page>();
    const matchNew = async (): Promise<Page | null> => {
      const all = this.getAllPages();
      pageCount = all.length;
      const fresh = all.filter((p) => !seen.has(p));
      for (const p of fresh) seen.add(p);
      if (fresh.length === 0) return null;
      return surfaceId
        ? this.matchPinnedPage(fresh, targetId, url)
        : fresh.find((p) => !this.isShellPage(p.url())) ?? null;
    };
    const dropped = () => this.browser !== browser || !browser.isConnected();

    const first = await matchNew();
    if (first || dropped()) return { page: first, pageCount };
    let changed = false;
    let wake: (() => void) | null = null;
    const onChange = () => {
      changed = true;
      wake?.();
    };
    const contexts = browser.contexts();
    for (const c of contexts) c.on('page', onChange);
    browser.on('disconnected', onChange);
    try {
      for (;;) {
        changed = false;
        const page = await matchNew();
        if (page || dropped()) return { page, pageCount };
        const left = deadline - Date.now();
        if (left <= 0) return { page: null, pageCount };
        if (changed) continue;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, left);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
      }
    } finally {
      for (const c of contexts) c.off('page', onChange);
      browser.off('disconnected', onChange);
    }
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
  private async getPage(
    surfaceId?: string,
    workspaceId?: string,
    knownNoSurface?: boolean,
  ): Promise<Page | null> {
    // A stopped op resolves no page at all (see ensureConnected).
    currentBrowserOpSignal()?.throwIfAborted();
    // Resolve the selection context (which workspace/surface this call targets)
    // BEFORE consulting any shared state, so the lock, fast-fail latch, and
    // auto-open latch are all scoped to THIS caller's workspace and can never
    // bleed into another's (#554). Context resolution needs only the control
    // RPC (browser.cdp.info); the CDP browser connection happens in
    // _getPageImpl as before.
    const ctx = await this.resolveSelectionContext(surfaceId, workspaceId, knownNoSurface);

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
    // Either way the page comes back after an await, during which the user
    // may have stopped this op: a stopped op gets the refusal, not the page —
    // also when it joined another call's discovery.
    const inflight = this.getPageLocks.get(ctx.key);
    if (inflight) {
      const joined = await inflight;
      currentBrowserOpSignal()?.throwIfAborted();
      return joined;
    }
    const p = this._getPageImpl(ctx);
    this.getPageLocks.set(ctx.key, p);
    try {
      const page = await p;
      currentBrowserOpSignal()?.throwIfAborted();
      return page;
    } finally {
      this.getPageLocks.delete(ctx.key);
    }
  }

  /**
   * Scope-required entry point for MCP browser tools (#695). Keeping the
   * verified workspace and optional surface in one required object makes a
   * dropped workspaceId a compile error at every tool call site.
   */
  async getPageForScope(
    scope: BrowserTargetScope,
    // Live Chrome confines WRITES to the agent's own tabs plus lent ones, and
    // this lane drives many of them (fill / select / upload / type) straight
    // over CDP without main ever seeing the call — so the gate has to run here
    // too. Default 'read' keeps every existing call site byte-identical; a
    // mutating tool passes 'write' explicitly.
    opts: { intent?: 'read' | 'write' } = {},
  ): Promise<Page | null> {
    assertBrowserTargetScope(scope);
    const page = await this.getPage(scope.surfaceId, scope.workspaceId, scope.noSurface === true);
    if (page && opts.intent === 'write') {
      await this.assertLiveWriteAllowed(page, scope);
      // Records dialogs for the [modal] note. Behaviour-neutral: each one is
      // still answered at once the way Playwright answers it unattended.
      attachModalTracking(page, modalScopeKey(scope.workspaceId, scope.surfaceId));
    } else if (page) {
      rememberModalScope(page, modalScopeKey(scope.workspaceId, scope.surfaceId));
    }
    // The page's own request rhythm, so a later action's settle can tell a
    // poll from what the action caused. Passive; started on first resolution
    // so the history exists before the first click.
    if (page) trackRequestBaseline(page);
    // Chrome backend: main's webContents-side lifecycle capture cannot see
    // these tabs, so mirror navigations/closes engine-side (dogfood P1 — the
    // #1063 inline events went silent under 'chrome').
    if (page && this.workspaceBackend === 'chrome') {
      this.attachLifecycleMirror(page, scope.workspaceId, scope.surfaceId);
    }
    // Unprotected pane: a tab the agent drives (a write) and holds — opened
    // for this workspace or lent by the user — gets the download guard: a
    // download no download tool claimed is cancelled and deleted. Never a tab
    // the agent only read, and never a user's own tab, whose downloads are the
    // user's. A protected pane is never armed: its browser denies downloads,
    // and main lets the approved one through. Asked once per page.
    if (
      page && this.workspaceBackend === 'chrome' && opts.intent === 'write'
      && !isProtectedScope(scope) && !isDownloadGuardArmed(page)
      && (await this.agentHoldsTab(page, scope.workspaceId))
    ) {
      guardUnclaimedDownloads(page);
    }
    // Console/network capture starts HERE — the first time a page is resolved
    // (open / navigate / attach) — not on the first browser_console call
    // (#1081). What a page logs while loading is exactly what an agent reaches
    // for after something looked wrong, and a buffer that starts at the read
    // call has already missed it. Idempotent per Page.
    //
    // Skipped for 'builtin': main's webContents capture covers those guests
    // from attach and the tools read that one, so a second buffer here would
    // collect (and retain response bodies for) something nothing reads. The
    // tools still attach lazily if they ever fall back to this transport.
    if (page && this.workspaceBackend !== 'builtin') {
      attachPageCapture(page);
    }
    // Last, after every throwaway CDP session this resolution opened has
    // detached again. Chromium keeps the emulated `navigator.platform` as a
    // page-wide setting, and a detaching session clears it whether or not it
    // ever set one — so the id probes above (Target.getTargetInfo on each
    // candidate, the target listing) were themselves undoing the platform half
    // of an active device preset, one tool call after it was applied. This is
    // the single door every browser tool comes through, which makes it the one
    // place a re-send covers them all. A no-op when nothing is emulated.
    if (page) await reassertUserAgentEmulation(page);
    return page;
  }

  /**
   * Refuse a write to a live tab this workspace does not own.
   *
   * Ownership is asked of MAIN, never decided here: main holds the map of which
   * tabs wmux opened and which the user lent, and browser.cdp.info reports
   * exactly those two kinds for the calling workspace. So a resolved target that
   * is absent from that list is a tab the agent may read and must not drive -
   * including a tab another workspace opened, which from here is indistinguish-
   * able from the user's own, and should be.
   *
   * Only ever runs on live (the marker is absent elsewhere), and only for a
   * write. A failure to READ the answer is a refusal: an ownership check that
   * cannot be made is not a check.
   *
   * Cost, accepted rather than hidden: one cdp.info round trip plus a throwaway
   * CDP session per gated write (and main answers it with a Target.getTargets of
   * its own). A cached owned-id set would remove that, and would then have to be
   * invalidated on every borrow, return, open and close, in a process that does
   * not see most of them — a cache that goes stale in the permissive direction
   * here hands an agent a tab the user took back. Measured need first, cache
   * second.
   */
  private async assertLiveWriteAllowed(page: Page, scope: BrowserTargetScope): Promise<void> {
    if (this.liveWriteScope !== 'agent') return;
    // The label stands in for a method name: this lane covers a dozen mutating
    // tools, and naming the wrong one would be worse than naming none.
    const label = 'this tool call';
    // No pinned surface and no readable target id leaves nothing to name, so the
    // hint tells the agent where ids come from instead of inventing one.
    const unknownId = scope.surfaceId ?? '<id from browser_tabs list>';
    const targetId = await this.targetIdOf(page);
    if (!targetId) throw new AgentWindowScopeError(label, unknownId);
    let info: CdpInfoResponse;
    try {
      info = (await sendRpc('browser.cdp.info', { workspaceId: scope.workspaceId })) as CdpInfoResponse;
    } catch (err) {
      throw browserCallRefusal(err) ?? new AgentWindowScopeError(label, targetId);
    }
    this.cacheShellUrl(info);
    // The policy can have been switched to 'all' since the value was cached;
    // this response is the current one, so honour it rather than the memory.
    if (info.liveWriteScope !== 'agent') return;
    const row = info.targets.find((t) => t.targetId === targetId || t.surfaceId === targetId);
    if (row && row.owner !== 'user') return;
    throw new AgentWindowScopeError(label, targetId);
  }

  /**
   * Whether main lists this tab as one the workspace holds: wmux opened it
   * for the workspace, or the user lent it (live rows carry owner 'agent' /
   * 'borrowed'; a dedicated Chrome lists only the tabs wmux opened). A user's
   * own tab is absent or 'user'. False when it cannot be told.
   */
  private async agentHoldsTab(page: Page, workspaceId: string): Promise<boolean> {
    const targetId = await this.targetIdOf(page);
    if (!targetId) return false;
    try {
      const info = (await sendRpc('browser.cdp.info', { workspaceId })) as CdpInfoResponse;
      const row = info.targets?.find((t) => t.targetId === targetId || t.surfaceId === targetId);
      return !!row && row.owner !== 'user';
    } catch {
      return false;
    }
  }

  /** A Page's CDP target id, over a throwaway session (client-side Pages expose
   *  none). null when the page is gone or will not answer. */
  private async targetIdOf(page: Page): Promise<string | null> {
    try {
      const session = await page.context().newCDPSession(page);
      try {
        const { targetInfo } = (await session.send('Target.getTargetInfo')) as {
          targetInfo?: { targetId?: string };
        };
        return typeof targetInfo?.targetId === 'string' ? targetInfo.targetId : null;
      } finally {
        await session.detach().catch(() => { /* best-effort */ });
      }
    } catch {
      return null;
    }
  }

  /** Backend marker for tool-side path choices; resolves via one cdp.info
   *  call when not yet learned (no connect attempt, so cheap on builtin). */
  async resolveWorkspaceBackend(workspaceId?: string): Promise<BrowserBackend | undefined> {
    if (this.workspaceBackend) return this.workspaceBackend;
    try {
      const info = (await sendRpc(
        'browser.cdp.info',
        workspaceId ? { workspaceId } : {},
      )) as CdpInfoResponse;
      this.cacheShellUrl(info);
    } catch {
      /* older main / cdp disabled — caller treats as builtin */
    }
    return this.workspaceBackend;
  }

  /**
   * Whether `workspaceId`'s browser is an unprotected pane on the Chrome
   * backend, asked of main afresh (one cdp.info, which also starts that
   * Chrome). Such a pane opens a tab on about:blank and loads the URL through
   * a handed-out Page, so the download guard is armed before the first
   * navigation. Throws when it cannot be told, so the caller refuses rather
   * than opening the URL unguarded — except main's "CDP remote debugging is
   * unavailable", which only its non-Chrome branch answers (Chrome is checked
   * first), so it is a confirmed non-Chrome pane.
   */
  async isUnprotectedChrome(workspaceId: string): Promise<boolean> {
    let info: CdpInfoResponse;
    try {
      info = (await sendRpc('browser.cdp.info', { workspaceId })) as CdpInfoResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/CDP remote debugging is unavailable/.test(message)) return false;
      throw new Error(`wmux could not tell whether this pane's browser is protected (${message})`);
    }
    this.cacheShellUrl(info);
    return info.workspaceBackend === 'chrome' && info.protected !== true;
  }

  getWorkspaceBackend(): BrowserBackend | undefined {
    return this.workspaceBackend;
  }

  // ── Chrome-backend lifecycle mirror (engine-side) ─────────────────────────

  private readonly mirroredPages = new WeakSet<Page>();
  private readonly localLifecycle = new Map<string, Array<{ type: 'navigated' | 'loaded' | 'closed'; url?: string; ts: number }>>();

  private lifecycleKey(workspaceId?: string, surfaceId?: string): string {
    return `ws:${workspaceId ?? ''}:surf:${surfaceId ?? ''}`;
  }

  private pushLocalLifecycle(key: string, entry: { type: 'navigated' | 'loaded' | 'closed'; url?: string; ts: number }): void {
    const q = this.localLifecycle.get(key) ?? [];
    const last = q[q.length - 1];
    if (entry.type === 'navigated' && last?.type === 'navigated' && last.url === entry.url) return;
    q.push(entry);
    if (q.length > 20) q.splice(0, q.length - 20);
    this.localLifecycle.set(key, q);
  }

  private attachLifecycleMirror(page: Page, workspaceId?: string, surfaceId?: string): void {
    if (this.mirroredPages.has(page)) return;
    this.mirroredPages.add(page);
    const key = this.lifecycleKey(workspaceId, surfaceId);
    page.on('framenavigated', (frame) => {
      try {
        if (frame !== page.mainFrame()) return;
        this.pushLocalLifecycle(key, { type: 'navigated', url: frame.url(), ts: Date.now() });
      } catch { /* page torn down mid-event */ }
    });
    page.on('close', () => {
      this.pushLocalLifecycle(key, { type: 'closed', ts: Date.now() });
    });
  }

  /** Destructive drain of engine-side lifecycle events (chrome backend). */
  drainLocalLifecycle(workspaceId?: string, surfaceId?: string): Array<{ type: 'navigated' | 'loaded' | 'closed'; url?: string; ts: number }> {
    const key = this.lifecycleKey(workspaceId, surfaceId);
    const q = this.localLifecycle.get(key);
    if (!q || q.length === 0) return [];
    this.localLifecycle.delete(key);
    return q;
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

    // One router for both entry points (surfaceRouting): the tool layer
    // resolves the default before it takes a lease, and a direct engine call
    // lands here — they must not be able to disagree about which surface a
    // caller that named none is on.
    let resolved: { kind: 'surface'; surfaceId: string } | { kind: 'none' };
    try {
      resolved = await resolveDefaultSurface(workspaceId, {
        // The response is the only place shellUrl and the backend marker
        // arrive, so the router hands it back rather than making this a second
        // round trip.
        onInfo: (info) => this.cacheShellUrl(info as CdpInfoResponse),
      });
    } catch (err) {
      // Re-raise the router's refusal in this engine's own words: the message
      // carries the remedy an agent reads, and it is logged on the way out.
      if (isWorkspaceScopeUnresolvedError(err)) {
        const reason = (err as Error).message.replace(
          new RegExp(`^${WORKSPACE_SCOPE_UNRESOLVED_CODE}:\\s*`),
          '',
        );
        throw workspaceScopeUnresolved(reason);
      }
      throw err;
    }
    return resolved.kind === 'surface'
      ? { kind: 'surface', surfaceId: resolved.surfaceId, workspaceId }
      : { kind: 'none', workspaceId };
  }

  /**
   * The MOST RECENTLY opened surface of a target list, never the oldest.
   * Still the tie-breaker inside selectRegisteredTarget; the default target of
   * a call that named no surfaceId is decided one level up, per connection
   * (surfaceRouting), because "newest in the workspace" is another agent's tab
   * as often as it is the caller's. listTargets() on both backends preserves
   * creation order — the managers iterate their surface Map in insertion order —
   * so the last entry a workspace owns is the newest. Picking targets[0] (the
   * oldest) silently drove a leftover tab from a previous run: `browser_tabs new`
   * returned a surfaceId, yet a follow-up call that omitted it hit the stale tab
   * instead, with a snapshot that looked perfectly normal (live dogfood caught
   * it). `ownedBy` narrows to the caller's own workspace on a legacy unscoped
   * response; a scoped response is already the caller's, so it is omitted there.
   * (Manual last-index instead of Array.findLast: this file compiles under the
   * ES2020 MCP tsconfig, whose lib predates findLast.)
   */
  private newestTarget(
    targets: readonly CdpTargetInfo[],
    ownedBy?: string,
  ): CdpTargetInfo | undefined {
    const pool = ownedBy ? targets.filter((t) => t.workspaceId === ownedBy) : targets;
    return pool.length ? pool[pool.length - 1] : undefined;
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
    knownNoSurface?: boolean,
  ): Promise<{ key: string; surfaceId?: string; callerHasNoSurface: boolean; workspaceId?: string }> {
    if (explicitSurfaceId) {
      return {
        key: workspaceId ? `ws:${workspaceId}:surf:${explicitSurfaceId}` : `surf:${explicitSurfaceId}`,
        surfaceId: explicitSurfaceId,
        callerHasNoSurface: false,
        ...(workspaceId && { workspaceId }),
      };
    }
    // The tool layer already resolved this caller to "nothing of mine exists"
    // and said so. Re-asking would repeat a control-plane round trip that on
    // an empty workspace costs main's full registration grace — twice per
    // call, for the same answer.
    if (knownNoSurface && workspaceId) {
      return { key: this.contextKey(workspaceId), surfaceId: undefined, callerHasNoSurface: true, workspaceId };
    }
    const owned = await this.resolveCallerSurface(workspaceId);
    if (owned.kind === 'surface') {
      return {
        key: `ws:${owned.workspaceId}:surf:${owned.surfaceId}`,
        surfaceId: owned.surfaceId,
        callerHasNoSurface: false,
        workspaceId: owned.workspaceId,
      };
    }
    return {
      key: this.contextKey(owned.workspaceId),
      surfaceId: undefined,
      callerHasNoSurface: true,
      workspaceId: owned.workspaceId,
    };
  }

  /**
   * The key for "this connection, in this workspace, with no surface yet".
   *
   * Per CONNECTION, not per workspace. The in-flight lock, the fast-fail latch
   * and the auto-open latch all hang off this key, and two connections sharing
   * one meant B could be handed A's in-flight page promise, A's discovery
   * failure fast-failed B for ten seconds, and A's one-shot auto-open
   * suppressed B's — the same "two agents, one default" confusion this routing
   * exists to end, one layer down. A resolved surface needs no such marker:
   * the surface id already distinguishes them.
   */
  private contextKey(workspaceId?: string): string {
    return `ws:${workspaceId ?? ''}:conn:${getOpenerKey()}`;
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

    const opSignal = currentBrowserOpSignal();
    for (let attempt = 1; attempt <= PAGE_FIND_RETRIES; attempt++) {
      opSignal?.throwIfAborted();
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
                    if (browserCallRefusal(resolveErr)) throw browserCallRefusal(resolveErr);
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
            if (browserCallRefusal(openErr)) throw browserCallRefusal(openErr);
            console.error('[PlaywrightEngine] Auto-open failed:', openErr instanceof Error ? openErr.message : String(openErr));
          }
        }

        if (attempt < PAGE_FIND_RETRIES) {
          console.error(`[PlaywrightEngine] No page found, reconnecting... (${attempt}/${PAGE_FIND_RETRIES})`);
          await sleep(PAGE_FIND_DELAY_MS);
          opSignal?.throwIfAborted();
          await this.disconnect();
          await this.ensureConnected(ctx.workspaceId);
        }
      } catch (err) {
        if (isWorkspaceScopeUnresolvedError(err)) throw err;
        if (err instanceof CdpAttachInfoUnavailableError) throw err;
        // Stopped by the user: the failure in hand is the dropped connection,
        // and the retry below would reconnect to the tab they stopped.
        opSignal?.throwIfAborted();
        if (browserCallRefusal(err)) throw browserCallRefusal(err);
        console.error(
          `[PlaywrightEngine] getPage attempt ${attempt} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt < PAGE_FIND_RETRIES) {
          await sleep(PAGE_FIND_DELAY_MS);
          opSignal?.throwIfAborted();
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
   * Open a surface for the caller, pinned to the calling session's workspace.
   * Fails closed: when no resolver is wired or identity cannot be resolved, NO
   * RPC is sent (returns null) — a workspace-less open would let the renderer
   * fall back to the UI-active workspace (#190). The caller then proceeds to
   * the normal "no page" retry/error path, surfacing the existing "Call
   * browser_open first" guidance to the user.
   *
   * `browser.tabs new`, not `browser.open`: on the builtin backend an open
   * REUSES the workspace's first browser surface when one exists, which is how
   * an auto-open for agent B used to hand back agent A's tab. `new` always
   * creates, on every backend, so the surface this returns is the caller's own.
   * An older main without the tabs method falls back to the open path.
   *
   * @returns the surface that was opened (`surfaceId` absent if the reply did
   *   not name one), or null when the attempt was skipped fail-closed.
   *
   * The surfaceId matters: it is the ONE selection this engine can make without
   * having to prove anything, because we are the ones who just asked for it —
   * and it becomes this connection's pin, so the calls that follow stay on it.
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
    // One open for both lanes (surfaceRouting): this one, and the RPC lane's
    // own fallback (d) in browserScope. It pins what it opens.
    const surfaceId = (await openSurfaceForConnection(workspaceId)) ?? undefined;
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

        // Live-Chrome attach: browser_tabs exposes EVERY live tab by design —
        // the workspace's 'live' binding is the grant — so a pinned surfaceId
        // may name a pre-existing user tab that the wmux-opened registry above
        // cannot know. Match Chrome's own target list directly. Deliberately
        // NOT extended to dedicated chrome instances: there the registry match
        // is what keeps workspace B from pinning workspace A's tab on a shared
        // profile. Keyed on liveWriteScope, which main sends for Live Chrome
        // only: a dedicated Chrome on a debugging pipe has a wsEndpoint too.
        if (!webviewTarget && surfaceId && typeof info.wsEndpoint === 'string' && info.liveWriteScope !== undefined) {
          webviewTarget = targetInfos.find(
            (t) => t.type === 'page' && t.targetId === surfaceId,
          );
        }

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

        // The Page may exist already (a target Playwright attached itself, or
        // one proven on an earlier call, which matches without a probe) or
        // appear shortly after the attach (see waitForAttachedPage).
        const { page: matchedPage, pageCount } = await this.waitForAttachedPage(
          surfaceId,
          webviewTarget.targetId,
          webviewTarget.url,
          POST_ATTACH_PAGE_WAIT_MS,
        );
        console.error(`[PlaywrightEngine] After attach: ${pageCount} pages`);
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
      if (browserCallRefusal(err)) throw browserCallRefusal(err);
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

        // Give Playwright a little time to process the attached target.
        const { page: matchedPage, pageCount } = await this.waitForAttachedPage(
          surfaceId,
          jsonTarget.id,
          jsonTarget.url,
          JSON_ATTACH_PAGE_WAIT_MS,
        );
        console.error(`[PlaywrightEngine] After /json attach: ${pageCount} pages`);
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
      if (browserCallRefusal(err)) throw browserCallRefusal(err);
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
        : this.newestTarget(info.targets);
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

    const own = this.newestTarget(info.targets, workspaceId);
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
