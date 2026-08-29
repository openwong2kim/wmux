import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORPHAN_TTL_MS, RECORD_TTL_MS, type ChromeSurfaceRecord, type ChromeSurfaceStore } from './ChromeSurfaceStore';
import { CdpSocket } from './CdpSocket';

// ---------------------------------------------------------------------------
// 'chrome' backend (Phase 2): launch the user's installed Chrome with a
// DEDICATED profile directory and --remote-debugging-port, and let the MCP
// PlaywrightEngine drive it over the same connectOverCDP path it already
// uses. The dedicated user-data-dir keeps agent logins persistent while
// staying fully separate from the user's daily browser (ban-risk isolation),
// and is exempt from Chrome 136+'s default-profile CDP block.
//
// Tab ownership: only tabs wmux opened are addressable — openTab() mints a
// stable `chrome-<uuid>` surfaceId and records surfaceId → targetId, and
// listTargets() intersects that registry with Chrome's live /json/list.
// Manually opened tabs are invisible to agents. The surfaceId, not the CDP
// targetId, is what agents hold: Chrome replaces the target behind a tab on
// its own, so the targetId is mutable mapping state on the record (see
// ChromeSurfaceStore for the persistence + revival rules).
//
// Child lifecycle follows the BrokerSupervisor idiom: singleflight launch,
// error+exit double-fire guard, a disposed flag so app teardown can never
// race a relaunch. No auto-restart loop — a dead Chrome relaunches on the
// next demand.
// ---------------------------------------------------------------------------

// Port discovery: Chrome writes DevToolsActivePort (line 1 = port, line 2 =
// secret WS path) into the profile dir ONLY when launched with
// --remote-debugging-port=0 — a fixed port produces no file at all (measured
// on Chrome 151, #1064 dogfood). So we launch with port 0 and read the
// ephemeral port back out of the file. That retires the port-probe allocator
// AND is what makes crash-path adoption possible in the first place: the file
// adoptExisting() reads is now actually written by the instance it recovers.
// DevToolsActivePort appearance + /json/version readiness poll.
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 250;

// Tab-target watcher: Chrome 111+ exposes a `tab` target per browser tab, and
// a tab target's id does NOT change when Chrome swaps the page target inside
// it (the first-run sync flow does exactly that). So the tab target is the
// deterministic anchor for a surface, and the browser-session CDP socket tells
// us — via the tab session's auto-attach — which page currently lives behind
// it. Everything here is a REINFORCEMENT of the /json/list polling path, never
// a precondition: a browser that has no tab targets (Edge, older Chromium), a
// refused setDiscoverTargets, or a WS that will not open all degrade to one
// console.warn and the pre-watcher behavior.
const TARGET_WATCHER_ENV = 'WMUX_CHROME_TARGET_WATCHER';

export interface ChromeTargetInfo {
  /** Stable wmux identity handed to agents (`chrome-<uuid>` for dedicated
   *  instances). Live attach keeps surfaceId ≡ targetId — see LiveChromeClient. */
  surfaceId: string;
  /** Current CDP page target the surface maps to. Mutable across restarts. */
  targetId: string;
  workspaceId?: string;
  url: string;
  title: string;
}

/** What browser.cdp.info reports for a chrome-family client. Exactly one of
 *  the fields is set: dedicated instances expose an HTTP CDP port, the live
 *  attach exposes Chrome's secret browser WS endpoint. */
export interface ChromeBackendEndpoint {
  cdpPort?: number;
  wsEndpoint?: string;
}

/**
 * Surface the browser.rpc chrome branches drive. Implemented by
 * ChromeLauncher (dedicated spawned instance) and LiveChromeClient (attach to
 * the user's live Chrome — Phase 3).
 */
export interface ChromeBackendClient {
  endpoint(): Promise<ChromeBackendEndpoint>;
  /** Targets reported through browser.cdp.info (page-selection seed). Live
   *  seeds only wmux-opened tabs so a random user tab can never become the
   *  default pin. */
  cdpInfoTargets(workspaceId?: string): Promise<ChromeTargetInfo[]>;
  openTab(url: string, workspaceId?: string): Promise<{ surfaceId: string; targetId: string; url: string }>;
  listTargets(workspaceId?: string): Promise<ChromeTargetInfo[]>;
  closeSurface(surfaceId: string): Promise<boolean>;
  /** Real tab focus where the backend supports it (live attach). */
  selectSurface?(surfaceId: string): Promise<boolean>;
  hasSurface(surfaceId: string): boolean;
  dispose(): void;
}

/** Candidate binary paths per platform, first match wins. */
function discoverChromeBinary(): string | null {
  const envPath = process.env.WMUX_CHROME_PATH;
  if (envPath) return existsSync(envPath) ? envPath : null;

  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }
  if (process.platform === 'win32') {
    const roots = [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ].filter((r): r is string => !!r);
    const rels = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Chromium\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const root of roots) {
      for (const rel of rels) {
        const p = join(root, rel);
        if (existsSync(p)) return p;
      }
    }
    return null;
  }
  // Linux: rely on PATH-resolved names; spawn() resolves them.
  const candidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Seed the Chrome profile's display name so the agent window is identifiable
 * at a glance (profile chip top-right + profile switcher show "wmux · <name>").
 * Best-effort, pre-launch only, and never clobbers a name the USER set inside
 * Chrome (is_using_default_name === false without our marker semantics is
 * approximated by: only write when no name exists yet or the existing name is
 * one we wrote). Exported for unit tests.
 */
export function seedChromeProfileLabel(userDataDir: string, label: string): void {
  try {
    mkdirSync(userDataDir, { recursive: true });
    const statePath = join(userDataDir, 'Local State');
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    } catch {
      /* missing/corrupt → start fresh */
    }
    const profile = (state.profile ??= {}) as Record<string, unknown>;
    const infoCache = (profile.info_cache ??= {}) as Record<string, unknown>;
    const def = (infoCache.Default ??= {}) as Record<string, unknown>;
    const current = typeof def.name === 'string' ? def.name : undefined;
    // Respect a user-chosen name: overwrite only when unset or wmux-authored.
    if (current !== undefined && !current.startsWith('wmux · ')) return;
    if (current === label) return;
    def.name = label;
    def.is_using_default_name = false;
    writeFileSync(statePath, JSON.stringify(state));
  } catch (err) {
    console.warn('[ChromeLauncher] profile label seed failed (cosmetic):', err);
  }
}

export interface ChromeLauncherOptions {
  /** Env pin var; null disables (non-default profiles — one pin cannot serve
   *  N instances). A pinned launch keeps the fixed port; note Chrome then
   *  writes no DevToolsActivePort, so adoption probes the pin directly. */
  portEnvVar?: string | null;
  /** Profile display name seeded into Local State pre-launch (window chip). */
  profileLabel?: string;
  /** Which profile's records this launcher owns in the surface store. */
  profileName?: string;
  /** Persistence for surface records. Omitted → in-memory only (tests, and
   *  any wiring that predates the store). */
  surfaceStore?: ChromeSurfaceStore;
}

/** Mint a stable surface id. Mirrors shared/types.ts `generateId('chrome')`;
 *  kept local so main's browser-session layer does not pull in the shared
 *  types barrel (and everything it drags along) for one line. */
function newSurfaceId(): string {
  return `chrome-${randomUUID()}`;
}

/** The slice of CDP's TargetInfo the watcher reads. */
interface WatchedTargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
  title?: string;
}

function watchedTargetInfo(params: Record<string, unknown>): WatchedTargetInfo | undefined {
  const info = params.targetInfo;
  return info && typeof info === 'object' ? (info as WatchedTargetInfo) : undefined;
}

export class ChromeLauncher implements ChromeBackendClient {
  private child: ChildProcess | null = null;
  private cdpPort = 0;
  private launching: Promise<number> | null = null;
  private disposed = false;
  private readonly portEnvVar: string | null;
  /** wmux-opened tabs, keyed by the stable surfaceId agents hold. */
  private readonly surfaces = new Map<string, ChromeSurfaceRecord>();
  /** Reverse index: current CDP targetId → surfaceId. */
  private readonly byTargetId = new Map<string, string>();
  /** Reverse index: stable CDP tab-target anchor → surfaceId. */
  private readonly byTabTargetId = new Map<string, string>();
  /** True once the persisted records for this profile have been merged in. */
  private restored = false;

  // ── Tab-target watcher state (all of it optional; see TARGET_WATCHER_ENV) ──
  private watcher: CdpSocket | null = null;
  private watcherStarting: Promise<void> | null = null;
  /** Bumped by every close/start so a superseded startup can bail out. */
  private watcherGeneration = 0;
  /** Tab attaches in flight, so two events cannot double-attach one tab. */
  private readonly attachingTabs = new Set<string>();
  /** Latched after a failure so every openTab does not re-pay the connect
   *  timeout. Cleared when the child goes away (the next launch retries). */
  private watcherFailed = false;
  private browserWsEndpoint: string | null = null;
  /** tab targetId → the flattened session we attached to it. */
  private readonly tabSessions = new Map<string, string>();
  /** Reverse of tabSessions, for detach bookkeeping. */
  private readonly sessionTabs = new Map<string, string>();
  /** Live tab ↔ page topology, tracked for EVERY tab the watcher sees (not
   *  just wmux-owned ones) so openTab can resolve its anchor immediately even
   *  when the attach event beat the HTTP response. */
  private readonly tabToPage = new Map<string, string>();
  private readonly pageToTab = new Map<string, string>();

  private readonly profileLabel: string | undefined;
  private readonly profileName: string;
  private readonly surfaceStore: ChromeSurfaceStore | undefined;

  constructor(private readonly userDataDir: string, opts?: ChromeLauncherOptions) {
    this.profileLabel = opts?.profileLabel;
    this.portEnvVar = opts?.portEnvVar === undefined ? 'WMUX_CHROME_CDP_PORT' : opts.portEnvVar;
    this.profileName = opts?.profileName ?? DEFAULT_CHROME_PROFILE;
    this.surfaceStore = opts?.surfaceStore;
  }

  /** True when this launcher opened (and still tracks) the given surface. */
  hasSurface(surfaceId: string): boolean {
    return this.surfaces.has(surfaceId);
  }

  /** The record behind a surface, for the registry's cross-profile close
   *  fallback (workspace ownership is checked there, not here). */
  recordFor(surfaceId: string): ChromeSurfaceRecord | undefined {
    return this.surfaces.get(surfaceId);
  }

  // ── Surface bookkeeping ───────────────────────────────────────────────────

  /** Publish the current snapshot. `immediate` for structural changes
   *  (open/close/dispose); the debounced path absorbs lastSeenAt churn. */
  private persist(immediate = false): void {
    if (!this.surfaceStore) return;
    const snapshot = [...this.surfaces.values()];
    if (immediate) void this.surfaceStore.saveNow(this.profileName, snapshot).catch(() => undefined);
    else this.surfaceStore.save(this.profileName, snapshot);
  }

  private bind(record: ChromeSurfaceRecord, targetId: string): void {
    if (record.targetId && record.targetId !== targetId) this.byTargetId.delete(record.targetId);
    record.targetId = targetId;
    delete record.missingSince;
    record.lastSeenAt = Date.now();
    this.byTargetId.set(targetId, record.surfaceId);
  }

  private forget(surfaceId: string): void {
    const record = this.surfaces.get(surfaceId);
    if (!record) return;
    if (record.targetId) this.byTargetId.delete(record.targetId);
    if (record.tabTargetId) this.byTabTargetId.delete(record.tabTargetId);
    this.surfaces.delete(surfaceId);
  }

  // ── Tab-target watcher ────────────────────────────────────────────────────

  /** Kill switch: WMUX_CHROME_TARGET_WATCHER=0 never opens the socket. */
  private watcherEnabled(): boolean {
    return process.env[TARGET_WATCHER_ENV] !== '0';
  }

  /** Give up on the watcher, loudly but once. Everything the launcher does
   *  keeps working without it — that is the whole contract. */
  private watcherDown(reason: string, err?: unknown): void {
    this.closeWatcher();
    if (this.watcherFailed) return;
    this.watcherFailed = true;
    console.warn(
      `[ChromeLauncher] tab-target watcher unavailable (${reason}); staying on /json/list polling`,
      err ?? '',
    );
  }

  private closeWatcher(): void {
    this.watcherGeneration++;
    this.watcher?.close();
    this.watcher = null;
    this.browserWsEndpoint = null;
    this.tabSessions.clear();
    this.sessionTabs.clear();
    this.tabToPage.clear();
    this.pageToTab.clear();
  }

  /**
   * Open the browser-session CDP socket and subscribe to target lifecycle.
   * Lazy (first openTab / first anchored revival), singleflight, and it never
   * rejects: a failure latches the watcher off and leaves the launcher on the
   * pre-watcher path.
   */
  private async ensureTargetWatcher(): Promise<void> {
    if (this.disposed || this.watcherFailed || !this.watcherEnabled()) return;
    if (this.watcher?.isOpen()) return;
    if (this.watcherStarting) return this.watcherStarting;
    this.watcherStarting = this.startTargetWatcher()
      .catch((err) => this.watcherDown('startup failed', err))
      .finally(() => {
        this.watcherStarting = null;
      });
    return this.watcherStarting;
  }

  private async startTargetWatcher(): Promise<void> {
    if (this.cdpPort <= 0) return; // nothing running yet; a later demand retries
    const version = (await this.fetchJson('/json/version')) as { webSocketDebuggerUrl?: string };
    const endpoint = version?.webSocketDebuggerUrl;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('ws')) {
      this.watcherDown('no browser webSocketDebuggerUrl on /json/version');
      return;
    }
    this.closeWatcher();
    if (this.disposed) return;
    const generation = ++this.watcherGeneration;
    const socket = new CdpSocket(
      () => {
        const url = this.browserWsEndpoint;
        if (!url) throw new Error('ChromeLauncher: no browser CDP endpoint');
        return url;
      },
      { label: 'ChromeLauncher watcher' },
    );
    /** True once a newer start (or a close) superseded this one. */
    const stale = (): boolean => {
      if (this.watcherGeneration === generation) return false;
      socket.close();
      return true;
    };
    this.browserWsEndpoint = endpoint;
    this.watcher = socket;
    this.subscribeTargetEvents(socket);
    try {
      await socket.send('Target.setDiscoverTargets', {
        discover: true,
        filter: [{ type: 'tab' }, { type: 'page' }],
      });
    } catch {
      if (stale()) return;
      // `filter` (and the `tab` type itself) is Chrome 111+. Plain discovery
      // still gets us page events on older Chromium/Edge; there is simply no
      // anchor to hang a surface on there.
      await socket.send('Target.setDiscoverTargets', { discover: true });
    }
    if (stale()) return;
    await this.syncTabAnchors();
  }

  private subscribeTargetEvents(socket: CdpSocket): void {
    socket.on('Target.targetCreated', (params) => {
      const info = watchedTargetInfo(params);
      if (info?.type === 'tab' && info.targetId) void this.attachTab(info.targetId);
    });

    // The succession signal. `sessionId` here is the PARENT session the event
    // arrived on — the tab session we attached — while params.targetInfo is
    // the page now living inside that tab.
    socket.on('Target.attachedToTarget', (params, sessionId) => {
      const info = watchedTargetInfo(params);
      if (!info?.targetId || info.type !== 'page') return;
      const tabTargetId = sessionId ? this.sessionTabs.get(sessionId) : undefined;
      if (!tabTargetId) return; // not a tab session of ours (e.g. the tab attach itself)
      this.noteTabPage(tabTargetId, info.targetId, info.url, info.title);
    });

    socket.on('Target.detachedFromTarget', (params, parentSessionId) => {
      const gone = typeof params.sessionId === 'string' ? params.sessionId : undefined;
      if (!gone) return;
      const detachedTab = this.sessionTabs.get(gone);
      if (detachedTab) {
        // The tab session itself went away; syncTabAnchors re-attaches later.
        this.sessionTabs.delete(gone);
        this.tabSessions.delete(detachedTab);
        return;
      }
      const tabTargetId = parentSessionId ? this.sessionTabs.get(parentSessionId) : undefined;
      if (!tabTargetId) return;
      // A page inside a tracked tab detached. The record stays bound to the
      // dying targetId on purpose — listTargets already withholds it, and the
      // successor's attachedToTarget re-binds; only the topology is stale.
      this.unlinkTab(tabTargetId);
    });

    socket.on('Target.targetDestroyed', (params) => {
      const targetId = typeof params.targetId === 'string' ? params.targetId : undefined;
      if (!targetId) return;
      const session = this.tabSessions.get(targetId);
      if (session) {
        this.tabSessions.delete(targetId);
        this.sessionTabs.delete(session);
      }
      if (this.tabToPage.has(targetId)) this.unlinkTab(targetId);
      const pagesTab = this.pageToTab.get(targetId);
      if (pagesTab !== undefined) {
        this.pageToTab.delete(targetId);
        if (this.tabToPage.get(pagesTab) === targetId) this.tabToPage.delete(pagesTab);
      }
      const surfaceId = this.byTabTargetId.get(targetId);
      // A destroyed PAGE proves nothing (that is the bug this PR fixes); a
      // destroyed anchor TAB is confirmed death — no orphan grace needed.
      if (!surfaceId) return;
      this.forget(surfaceId);
      this.persist(true);
    });

    socket.on('Target.targetInfoChanged', (params) => {
      const info = watchedTargetInfo(params);
      if (!info?.targetId || info.type !== 'page') return;
      const record = this.recordForTarget(info.targetId);
      if (!record) return;
      if (typeof info.url === 'string' && info.url) record.url = info.url;
      if (typeof info.title === 'string') record.title = info.title;
      record.lastSeenAt = Date.now();
      this.persist();
    });
  }

  private recordForTarget(targetId: string): ChromeSurfaceRecord | undefined {
    const surfaceId = this.byTargetId.get(targetId);
    return surfaceId ? this.surfaces.get(surfaceId) : undefined;
  }

  private unlinkTab(tabTargetId: string): void {
    const page = this.tabToPage.get(tabTargetId);
    if (page === undefined) return;
    this.tabToPage.delete(tabTargetId);
    this.pageToTab.delete(page);
  }

  /** Attach to a tab target and auto-attach its page, so the CURRENT page —
   *  and every replacement Chrome makes later — announces itself. */
  private async attachTab(tabTargetId: string): Promise<void> {
    const socket = this.watcher;
    if (!socket || this.tabSessions.has(tabTargetId) || this.attachingTabs.has(tabTargetId)) return;
    this.attachingTabs.add(tabTargetId);
    try {
      const res = (await socket.send('Target.attachToTarget', { targetId: tabTargetId, flatten: true })) as {
        sessionId?: string;
      };
      const sessionId = res?.sessionId;
      if (!sessionId || this.watcher !== socket) return;
      this.tabSessions.set(tabTargetId, sessionId);
      this.sessionTabs.set(sessionId, tabTargetId);
      await socket.send(
        'Target.setAutoAttach',
        { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
        sessionId,
      );
    } catch {
      // One unattachable tab (closed between the event and the attach, or a
      // browser that has no tab targets) is not a watcher failure.
    } finally {
      this.attachingTabs.delete(tabTargetId);
    }
  }

  /** Enumerate live tab targets and attach to the ones we do not track yet. */
  private async syncTabAnchors(): Promise<void> {
    const socket = this.watcher;
    if (!socket) return;
    let infos: WatchedTargetInfo[];
    try {
      infos = await this.getTabTargets(socket);
    } catch {
      return; // fail-open: no anchors resolved this round
    }
    for (const info of infos) {
      if (info.targetId) await this.attachTab(info.targetId);
    }
  }

  private async getTabTargets(socket: CdpSocket): Promise<WatchedTargetInfo[]> {
    const read = async (params: Record<string, unknown>): Promise<WatchedTargetInfo[]> =>
      ((await socket.send('Target.getTargets', params)) as { targetInfos?: WatchedTargetInfo[] })?.targetInfos ?? [];
    let infos: WatchedTargetInfo[];
    try {
      infos = await read({ filter: [{ type: 'tab' }] });
    } catch {
      infos = await read({}); // the `filter` argument predates Chrome 111
    }
    return infos.filter((t) => t.type === 'tab');
  }

  /**
   * Record a tab ↔ page pairing. When the tab anchors one of our surfaces,
   * re-bind that surface to the page now behind it — the deterministic
   * succession signal a /json/list miss can never give us.
   */
  private noteTabPage(tabTargetId: string, pageTargetId: string, url?: string, title?: string): void {
    const previous = this.tabToPage.get(tabTargetId);
    if (previous && previous !== pageTargetId) this.pageToTab.delete(previous);
    this.tabToPage.set(tabTargetId, pageTargetId);
    this.pageToTab.set(pageTargetId, tabTargetId);

    const anchored = this.byTabTargetId.get(tabTargetId);
    if (!anchored) {
      // First sighting of a tab that already holds one of our pages: adopt it
      // as that surface's anchor. This is how an opened tab gets its anchor
      // when the attach event beats openTab's bookkeeping.
      const owner = this.recordForTarget(pageTargetId);
      if (!owner || owner.tabTargetId) return; // a tab wmux does not own
      owner.tabTargetId = tabTargetId;
      this.byTabTargetId.set(tabTargetId, owner.surfaceId);
      this.persist(true);
      return;
    }
    const record = this.surfaces.get(anchored);
    if (!record) {
      this.byTabTargetId.delete(tabTargetId);
      return;
    }
    if (record.targetId === pageTargetId) {
      delete record.missingSince;
      return;
    }
    this.bind(record, pageTargetId);
    if (url) record.url = url;
    if (title !== undefined) record.title = title;
    this.persist();
  }

  /** Point a fresh record at its tab anchor, resolving the live topology
   *  first when the attach event has not landed yet. */
  private async anchorTab(record: ChromeSurfaceRecord): Promise<void> {
    if (!this.watcher || record.tabTargetId || !record.targetId) return;
    if (this.linkAnchor(record)) return;
    await this.syncTabAnchors();
    this.linkAnchor(record);
  }

  private linkAnchor(record: ChromeSurfaceRecord): boolean {
    if (record.tabTargetId) return true;
    const tab = record.targetId ? this.pageToTab.get(record.targetId) : undefined;
    if (!tab) return false;
    record.tabTargetId = tab;
    this.byTabTargetId.set(tab, record.surfaceId);
    return true;
  }

  /**
   * Revival rule ① (ChromeSurfaceStore's header): a restored record whose tab
   * anchor is still alive re-binds to whatever page sits in that tab NOW —
   * even though its own targetId died when Chrome swapped the page.
   */
  private async reviveByTabAnchor(): Promise<void> {
    const anchored = [...this.surfaces.values()].filter((r): r is ChromeSurfaceRecord & { tabTargetId: string } =>
      typeof r.tabTargetId === 'string',
    );
    if (anchored.length === 0) return;
    for (const record of anchored) this.byTabTargetId.set(record.tabTargetId, record.surfaceId);
    await this.ensureTargetWatcher();
    if (!this.watcher) return;
    // syncTabAnchors' attaches re-bind through noteTabPage already; this sweep
    // catches tabs attached before the index above existed.
    let changed = false;
    for (const record of anchored) {
      const page = this.tabToPage.get(record.tabTargetId);
      if (!page) continue;
      if (record.targetId === page) {
        delete record.missingSince;
        continue;
      }
      this.bind(record, page);
      changed = true;
    }
    if (changed) this.persist(true);
  }

  /** Dedicated instances expose the HTTP CDP port (launching on demand). */
  async endpoint(): Promise<ChromeBackendEndpoint> {
    return { cdpPort: await this.ensureRunning() };
  }

  /** Registry-scoped tabs seed page selection for dedicated instances. */
  cdpInfoTargets(workspaceId?: string): Promise<ChromeTargetInfo[]> {
    return this.listTargets(workspaceId);
  }

  /** True when a CDP endpoint is established (spawned child or adopted
   *  previous-session instance; liveness is re-verified on demand). */
  isRunning(): boolean {
    return this.cdpPort > 0;
  }

  /**
   * Launch Chrome if needed and resolve its CDP port. Singleflight: parallel
   * first calls share one launch. A dead child relaunches here on demand.
   */
  async ensureRunning(): Promise<number> {
    if (this.disposed) throw new Error('ChromeLauncher: disposed (app is quitting)');
    if (this.isRunning()) {
      // Cheap liveness check — the process object survives a crash until the
      // exit handler runs; /json/version is the truth.
      try {
        await this.fetchJson('/json/version');
        return this.cdpPort;
      } catch {
        this.onChildGone();
      }
    }
    if (this.launching) return this.launching;
    this.launching = this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  /** Env-pinned fixed port ('default' profile only), validated. */
  private pinnedPort(): number | null {
    if (!this.portEnvVar) return null;
    const raw = process.env[this.portEnvVar];
    if (!raw) return null;
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`ChromeLauncher: ${this.portEnvVar}=${raw} is not a valid port`);
    }
    return port;
  }

  /** DevToolsActivePort in the profile dir. `raw` is kept for freshness
   *  comparison: the secret /devtools/browser/<uuid> on line 2 is new every
   *  boot, so byte-identical content means "same (old) instance". */
  private readPortFile(): { raw: string; port: number } | null {
    let raw: string;
    try {
      raw = readFileSync(join(this.userDataDir, 'DevToolsActivePort'), 'utf8');
    } catch {
      return null;
    }
    const port = parseInt(raw.split('\n')[0]?.trim() ?? '', 10);
    if (Number.isNaN(port) || port <= 0 || port > 65535) return null;
    return { raw, port };
  }

  /**
   * Adopt a still-running instance from a previous wmux session (crash path).
   * Spawning again over an occupied profile dir just exits on the
   * SingletonLock, so if a recorded endpoint still answers, reuse it. Two
   * sources: the DevToolsActivePort file (port-0 launches write it), and the
   * env-pinned port (pinned launches write no file — probe the pin itself).
   */
  private async adoptExisting(): Promise<number | null> {
    const candidates: number[] = [];
    const file = this.readPortFile();
    if (file) candidates.push(file.port);
    const pinned = this.pinnedPort();
    if (pinned !== null && !candidates.includes(pinned)) candidates.push(pinned);
    for (const port of candidates) {
      this.cdpPort = port;
      try {
        await this.fetchJson('/json/version');
        // No child handle for an adopted instance — dispose() can only close
        // tabs we open; the process outlives us like it outlived its spawner.
        this.child = null;
        console.warn(`[ChromeLauncher] adopted existing Chrome on port ${port} (previous session's instance)`);
        // The adopted Chrome is the SAME instance that held the persisted
        // tabs, so revival rule ② applies: any record whose targetId is still
        // in /json/list re-binds to its live page. Rule ① then covers the
        // records whose page was swapped while wmux was away: their tab anchor
        // outlived the swap.
        await this.restoreFromStore();
        await this.reviveByTabAnchor();
        return port;
      } catch {
        this.cdpPort = 0;
      }
    }
    return null;
  }

  /**
   * Merge the profile's persisted records back in, re-binding the ones whose
   * targetId Chrome still reports (revival rule ②). Records that do not match
   * are kept but left UNBOUND — never revived by URL (see ChromeSurfaceStore's
   * header for why) — so they can still age out through the orphan TTL and an
   * agent gets an explicit miss rather than a look-alike page.
   */
  private async restoreFromStore(): Promise<void> {
    if (!this.surfaceStore || this.restored) return;
    this.restored = true;
    const persisted = this.surfaceStore.listForProfile(this.profileName);
    if (persisted.length === 0) return;
    let liveIds = new Set<string>();
    try {
      const live = (await this.fetchJson('/json/list')) as Array<{ id: string; type: string }>;
      liveIds = new Set(live.filter((t) => t.type === 'page').map((t) => t.id));
    } catch {
      /* no list → nothing re-binds; records stay unbound */
    }
    const now = Date.now();
    for (const record of persisted) {
      if (this.surfaces.has(record.surfaceId)) continue; // this session wins
      if (record.tabTargetId) this.byTabTargetId.set(record.tabTargetId, record.surfaceId);
      if (record.targetId && liveIds.has(record.targetId)) {
        delete record.missingSince;
        record.lastSeenAt = now;
        this.byTargetId.set(record.targetId, record.surfaceId);
      } else {
        record.targetId = null;
        record.missingSince ??= now;
      }
      this.surfaces.set(record.surfaceId, record);
    }
    this.persist(true);
  }

  private async launch(): Promise<number> {
    const adopted = await this.adoptExisting();
    if (adopted !== null) return adopted;

    const binary = discoverChromeBinary();
    if (!binary) {
      throw new Error(
        'CHROME_BACKEND_NO_BINARY: no Chrome/Chromium/Edge installation found. ' +
          'Install Google Chrome or set WMUX_CHROME_PATH to a browser binary.',
      );
    }

    const pinned = this.pinnedPort();
    // Port 0 (the normal path): Chrome picks an ephemeral port and records it
    // in DevToolsActivePort. The file may still hold the PREVIOUS instance's
    // endpoint (already probed dead by adoptExisting above) — snapshot it so
    // the fresh write is recognized by content, not mere existence.
    const stale = pinned === null ? this.readPortFile() : null;

    if (this.profileLabel) seedChromeProfileLabel(this.userDataDir, this.profileLabel);

    const child = spawn(
      binary,
      [
        `--user-data-dir=${this.userDataDir}`,
        `--remote-debugging-port=${pinned ?? 0}`,
        // connectOverCDP's websocket handshake (Chrome 111+ origin check).
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { stdio: 'ignore' },
    );

    // BrokerSupervisor idiom: a failed spawn emits BOTH 'error' and 'exit' —
    // route them through one handler so state resets exactly once.
    let gone = false;
    const onGone = () => {
      if (gone) return;
      gone = true;
      if (this.child === child) this.onChildGone();
    };
    child.on('error', onGone);
    child.on('exit', onGone);

    this.child = child;

    // Resolve the port (pinned, or the fresh DevToolsActivePort write), then
    // poll /json/version until the endpoint answers.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (gone) throw new Error('ChromeLauncher: Chrome exited during startup');
      let candidate = pinned;
      if (candidate === null) {
        const fresh = this.readPortFile();
        candidate = fresh && fresh.raw !== stale?.raw ? fresh.port : null;
      }
      if (candidate !== null) {
        this.cdpPort = candidate;
        try {
          await this.fetchJson('/json/version');
          // A REAL spawn (adoption already failed above) means this profile's
          // previous Chrome is gone and every tab it held with it. Neither
          // revival rule can hold, so the persisted records are dropped rather
          // than left to linger as permanently unbound handles.
          this.restored = true;
          this.surfaces.clear();
          this.byTargetId.clear();
          this.byTabTargetId.clear();
          void this.surfaceStore?.dropProfile(this.profileName).catch(() => undefined);
          return candidate;
        } catch {
          this.cdpPort = 0;
        }
      }
      if (Date.now() > deadline) {
        // Kill the half-started child; a later demand may retry cleanly.
        try {
          child.kill();
        } catch { /* already gone */ }
        this.onChildGone();
        throw new Error('ChromeLauncher: CDP endpoint did not become ready in time');
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }

  private onChildGone(): void {
    this.child = null;
    this.cdpPort = 0;
    // Records SURVIVE a dead Chrome — the surfaceId an agent holds must not
    // become a dangling reference just because the browser went away. They go
    // unbound instead, and re-bind through adoptExisting()'s /json/list pass
    // if the same tabs are still there.
    for (const record of this.surfaces.values()) record.targetId = null;
    this.byTargetId.clear();
    // The watcher's socket died with Chrome (and its tab sessions with it).
    // The anchors on the records survive — that is what the next launch's
    // revival pass matches against — so only the transport is torn down, and
    // the failure latch resets so the next launch may re-arm.
    this.closeWatcher();
    this.watcherFailed = false;
    this.persist(true);
  }

  /** Open a tab and record it under a freshly minted stable surfaceId. */
  async openTab(url: string, workspaceId?: string): Promise<{ surfaceId: string; targetId: string; url: string }> {
    await this.ensureRunning();
    // Arm the anchor watcher before the tab exists so its targetCreated is
    // seen. Never throws — a launcher without a watcher still opens tabs.
    await this.ensureTargetWatcher();
    // Chrome 111+ requires PUT for /json/new.
    const created = (await this.fetchJson(`/json/new?${encodeURIComponent(url)}`, 'PUT')) as {
      id?: string;
      url?: string;
    };
    if (!created?.id) throw new Error('ChromeLauncher: /json/new returned no target id');
    const now = Date.now();
    const record: ChromeSurfaceRecord = {
      surfaceId: newSurfaceId(),
      targetId: created.id,
      ...(workspaceId !== undefined && { workspaceId }),
      url: created.url ?? url,
      createdAt: now,
      lastSeenAt: now,
    };
    this.surfaces.set(record.surfaceId, record);
    this.byTargetId.set(created.id, record.surfaceId);
    await this.anchorTab(record);
    this.persist(true);
    return { surfaceId: record.surfaceId, targetId: created.id, url: record.url };
  }

  /**
   * wmux-opened tabs still alive in Chrome, optionally filtered to one
   * workspace.
   *
   * A targetId that is missing from /json/list is NOT proof the surface is
   * gone — Chrome swaps the target behind a tab on its own. So a miss only
   * withholds the record from the result and stamps `missingSince`; the record
   * is forgotten once it has been missing for ORPHAN_TTL_MS. A returning
   * targetId clears the stamp.
   */
  async listTargets(workspaceId?: string): Promise<ChromeTargetInfo[]> {
    if (!this.isRunning()) return [];
    let live: Array<{ id: string; url: string; title: string; type: string }>;
    try {
      live = (await this.fetchJson('/json/list')) as typeof live;
    } catch {
      return [];
    }
    const liveById = new Map(live.filter((t) => t.type === 'page').map((t) => [t.id, t]));
    const now = Date.now();
    const out: ChromeTargetInfo[] = [];
    let structural = false;
    for (const record of [...this.surfaces.values()]) {
      const t = record.targetId ? liveById.get(record.targetId) : undefined;
      if (!t) {
        record.missingSince ??= now;
        if (now - record.missingSince > ORPHAN_TTL_MS || now - record.lastSeenAt > RECORD_TTL_MS) {
          this.forget(record.surfaceId);
          structural = true;
        }
        continue;
      }
      delete record.missingSince;
      record.lastSeenAt = now;
      record.url = t.url;
      record.title = t.title;
      if (workspaceId !== undefined && record.workspaceId !== undefined && record.workspaceId !== workspaceId) {
        continue;
      }
      out.push({
        surfaceId: record.surfaceId,
        targetId: record.targetId as string,
        ...(record.workspaceId !== undefined && { workspaceId: record.workspaceId }),
        url: t.url,
        title: t.title,
      });
    }
    this.persist(structural);
    return out;
  }

  async closeSurface(surfaceId: string): Promise<boolean> {
    const record = this.surfaces.get(surfaceId);
    if (!record) return false;
    if (record.targetId) {
      if (!this.isRunning()) return false;
      try {
        await this.fetchJson(`/json/close/${record.targetId}`);
      } catch {
        return false;
      }
    }
    // An unbound record has no live tab to close; dropping it is the whole
    // close, and it must succeed so the agent can retire the handle.
    this.forget(surfaceId);
    this.persist(true);
    return true;
  }

  /** Kill the child. Terminal: later demands throw (app teardown only). */
  dispose(): void {
    this.disposed = true;
    const child = this.child;
    this.onChildGone();
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }

  private async fetchJson(path: string, method: 'GET' | 'PUT' = 'GET'): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${this.cdpPort}${path}`, { method });
    if (!res.ok) throw new Error(`ChromeLauncher: ${path} → HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // /json/close answers with plain text ("Target is closing").
      return text;
    }
  }
}


// ---------------------------------------------------------------------------
// Registry: one launcher per named profile (Phase 2.5). A workspace's
// automation resolves through its binding ('default' when unbound), so
// workspace 1 can drive a Chrome signed into account A while workspace 2
// drives account B — separate user-data-dirs, separate instances, separate
// CDP ports (each instance picks its own ephemeral port via port 0).
// ---------------------------------------------------------------------------

import { join as joinPath } from 'node:path';
import { validateBrowserProfileName } from './ProfileManager';
import { DEFAULT_CHROME_PROFILE, LIVE_CHROME_PROFILE, type ChromeProfileStore } from './ChromeProfileStore';
import { LiveChromeClient } from './LiveChromeClient';

export class ChromeLauncherRegistry {
  private readonly launchers = new Map<string, ChromeBackendClient>();
  private live: LiveChromeClient | null = null;

  constructor(
    private readonly opts: {
      /** 'default' keeps the pre-registry dir so existing logins survive. */
      defaultDir: string;
      /** Named profiles live under <profilesDir>/<name>. */
      profilesDir: string;
      store: Pick<ChromeProfileStore, 'profileFor'>;
      /** Persistence for stable surface ids. Optional — omitted keeps the
       *  pre-store in-memory behavior (older wirings, unit tests). */
      surfaceStore?: ChromeSurfaceStore;
    },
  ) {}

  forProfile(name: string): ChromeBackendClient {
    validateBrowserProfileName(name); // re-validate at the interpolation site
    // Reserved live profile: attach to the user's own Chrome, never spawn.
    if (name === LIVE_CHROME_PROFILE) {
      this.live ??= new LiveChromeClient();
      return this.live;
    }
    const existing = this.launchers.get(name);
    if (existing) return existing;

    const launcher = new ChromeLauncher(
      name === DEFAULT_CHROME_PROFILE ? this.opts.defaultDir : joinPath(this.opts.profilesDir, name),
      {
        portEnvVar: name === DEFAULT_CHROME_PROFILE ? 'WMUX_CHROME_CDP_PORT' : null,
        // Window chip reads "wmux · <profile>" so the agent Chrome (and which
        // account-profile it is) is identifiable at a glance.
        profileLabel: `wmux · ${name}`,
        profileName: name,
        ...(this.opts.surfaceStore && { surfaceStore: this.opts.surfaceStore }),
      },
    );
    this.launchers.set(name, launcher);
    return launcher;
  }

  /** The launcher a workspace's automation runs against (binding ?? default). */
  forWorkspace(workspaceId: string | undefined): ChromeBackendClient {
    return this.forProfile(this.opts.store.profileFor(workspaceId));
  }

  /**
   * Which launcher owns a surface, and which workspace it belongs to (the
   * browser.close cross-profile fallback). A caller's workspace may be bound
   * to profile A while the surface it names was opened under profile B —
   * browser.close checks the returned workspaceId against the caller's scope
   * before acting, so this lookup discloses ownership, it does not grant it.
   */
  ownerOfSurface(surfaceId: string): { workspaceId?: string; client: ChromeBackendClient } | null {
    for (const launcher of this.launchers.values()) {
      if (!launcher.hasSurface(surfaceId)) continue;
      const workspaceId =
        launcher instanceof ChromeLauncher ? launcher.recordFor(surfaceId)?.workspaceId : undefined;
      return { ...(workspaceId !== undefined && { workspaceId }), client: launcher };
    }
    return null;
  }

  disposeAll(): void {
    for (const launcher of this.launchers.values()) launcher.dispose();
    this.launchers.clear();
    // Socket close only — never touches the user's Chrome process.
    this.live?.dispose();
    this.live = null;
  }
}
