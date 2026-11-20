import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ORPHAN_TTL_MS, RECORD_TTL_MS, type ChromeSurfaceRecord, type ChromeSurfaceStore } from './ChromeSurfaceStore';
import type { CdpConnection } from './CdpSocket';
import type { Readable, Writable } from 'node:stream';
import { pipeTransport, portTransport, type ChromeTransport } from './ChromeTransport';
import { CDP_PIPE_COMMAND_TIMEOUT_MS, CdpPipeMux, type CallerIdentity, type ClientRef } from './CdpPipeMux';
import { ProtectedPipePolicy, SCHEME_NOT_ALLOWED, appLaunchUrl, protectedUrlAllowed } from './ProtectedPipePolicy';
import { CdpPipeRelay, type RelayGrant, type RelayRoute } from './CdpPipeRelay';
import { browserPathOf, isRecordedBrowser, recordedBrowserPath } from './devToolsActivePort';
import { cdpTargetGrantEnabled, recordVisibleTo } from './CdpTargetOwnership';
import { DownloadRelayPolicy, makeDownloadRelayDir, removeDownloadRelayDir } from './DownloadRelayPolicy';
import { ProtectedProxy, protectedChromeArgs } from './ProtectedProxy';
import { BlockedHostLog } from './BlockedHostLog';
import { surfaceOpeners } from './SurfaceOpeners';
import type { HostMatcher } from '../../shared/browserHostPolicy';
import type { BlockedHost } from '../../shared/browserPolicy';
import type { LiveTabOwner } from '../../shared/liveWriteScope';
import type { LentLiveTab } from '../../shared/browserAgentControl';
import { CHROME_START_CEILING_MS } from '../../shared/chromeStart';

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
/**
 * How long a launch waits on a Chrome that is still running but not yet
 * listening. Its first start after the install was replaced (an update, a
 * fresh machine) reads ~450 MB from a cold disk before it says anything: on
 * the GitHub Ubuntu image 20261101 that took 8-14 s, past READY_TIMEOUT_MS,
 * where the same start with its files cached took under 2 s. A Chrome that
 * exited fails at once, as before. RPCs that may start it wait longer
 * (CHROME_START_RPC_TIMEOUT_MS).
 */
const READY_STARTING_MS = CHROME_START_CEILING_MS;
const READY_POLL_MS = 250;
/** Chrome's stderr kept for a failed start's message (characters, the newest). */
const STARTUP_STDERR_TAIL = 4096;
/** How long a failed start waits for the rest of stderr after Chrome exited. */
const STDERR_END_WAIT_MS = 500;

/**
 * What Chrome last said on stderr, for a failed start's message: its last few
 * non-empty lines, one line each, with each of `homes` written as `~` (the
 * message reaches logs and agents). A refused start is often only said there:
 * "DevTools remote debugging requires a non-default data directory" leaves the
 * pipe silent and writes no DevToolsActivePort, which otherwise reads as a
 * timeout.
 */
export function chromeSaid(stderr: string, homes: string[] = [], lines = 3, max = 400): string | null {
  let said = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-lines).join(' | ');
  if (!said) return null;
  said = maskHomes(said, homes);
  // Cut by code points, so a character outside the BMP is never split.
  const chars = Array.from(said);
  return chars.length > max ? `…${chars.slice(-max).join('')}` : said;
}

/**
 * Each home folder as `~`, in its backslash, forward-slash and JSON-escaped
 * spellings, and only where the path ends there (so `C:\Users\ann` never eats
 * the start of `C:\Users\anna`). A root-like home (`/`, `C:\`) is skipped.
 * Case-insensitive on Windows only.
 */
function maskHomes(text: string, homes: string[]): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const spellings = new Set<string>();
  for (const raw of homes) {
    const home = raw.replace(/[\\/]+$/, '');
    if (/^([A-Za-z]:)?[\\/]*$/.test(home)) continue;
    spellings.add(home);
    spellings.add(home.replace(/\\/g, '/'));
    spellings.add(home.replace(/\\/g, '\\\\'));
  }
  const ordered = [...spellings].sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return text;
  const pattern = new RegExp(`(${ordered.map(escape).join('|')})(?=[\\\\/\\s"'\`)\\]:;,|]|$)`, process.platform === 'win32' ? 'gi' : 'g');
  return text.replace(pattern, '~');
}
/**
 * Pipe mode: liveness checks that must fail in a row before the launcher lets
 * a Chrome go, and so stops it (one on a pipe can't be found again). Each check
 * waits CDP_PIPE_COMMAND_TIMEOUT_MS (10 s), and checks that overlap count once.
 * A hung Chrome is let go at the third failed check, within 30 s of checks
 * (they run on demand, one per call that needs the browser); it is then sent
 * SIGTERM, SIGKILL PIPE_KILL_GRACE_MS later, and the next launch waits up to
 * PIPE_KILL_WAIT_MS more for it to exit: 35 s from the first failed check to a
 * new start, or a launch error if it never exits.
 */
const PIPE_MISSES_BEFORE_STOP = 3;
/** A let-go pipe Chrome's time between SIGTERM and SIGKILL. */
export const PIPE_KILL_GRACE_MS = 2_000;
/** How long a launch waits for a let-go pipe Chrome to exit after SIGKILL. */
export const PIPE_KILL_WAIT_MS = 3_000;
/** A check that took this much longer than its timeout spanned a sleep (or a stalled main), and doesn't count. */
const PIPE_SLEEP_SLACK_MS = 5_000;
/** How long a Chrome asked to quit through Browser.close gets before a signal. */
export const QUIT_GRACE_MS = 3_000;
/** How long a fresh launch waits for session restore to settle its tabs. */
const RESTORE_SETTLE_MS = 2_000;
/** How often a protected profile's download guard re-asserts deny. */
const DOWNLOAD_DENY_REASSERT_MS = 250;
/** Why a launch probe ended (main/browser-session/ChromeLauncher.ts verifyProxyRoute). */
type ProbeOutcome = 'routed' | 'navigation-failed' | 'tab-gone' | 'no-tab' | 'no-answer' | 'cdp-error';

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

/** Whether dedicated launchers may run their tab-target watcher (and so attach page sessions). */
export function chromeTargetWatcherEnabled(): boolean {
  return process.env[TARGET_WATCHER_ENV] !== '0';
}

/**
 * Whether `WMUX_CHROME_TRANSPORT=pipe` puts every profile on the debugging
 * pipe (fds 3 and 4). A launch's own transport is transportFor's.
 */
export function chromeTransportKind(): 'port' | 'pipe' {
  return process.env.WMUX_CHROME_TRANSPORT === 'pipe' ? 'pipe' : 'port';
}

/** The transport one launch uses, and whether a protected profile runs on the port. */
export interface ChromeTransportChoice {
  kind: 'port' | 'pipe';
  /** A protected profile on the port: a client of the port reaches Chrome without the pipe's rules. */
  weaker: boolean;
}

/**
 * The transport for a launch under `plan` (null: unprotected).
 *  - A protected profile runs on the pipe. Only `protectedPortAllowed` (the
 *    operator's setting) puts it on the port; the environment alone never does,
 *    and `WMUX_CHROME_TRANSPORT=pipe` keeps it on the pipe even then.
 *  - An unprotected profile runs on the port, or on the pipe with
 *    `WMUX_CHROME_TRANSPORT=pipe`. Unset, `auto` and `port` all mean this
 *    split.
 */
export function transportFor(plan: ChromeProtectionPlan | null, protectedPortAllowed = false): ChromeTransportChoice {
  const pipeForAll = process.env.WMUX_CHROME_TRANSPORT === 'pipe';
  const kind: 'port' | 'pipe' = pipeForAll ? 'pipe' : plan && !protectedPortAllowed ? 'pipe' : 'port';
  return { kind, weaker: !!plan && kind === 'port' };
}

/** How status shows a transport. */
export function transportLabel(choice: ChromeTransportChoice): 'pipe' | 'port' | 'port (weaker)' {
  return choice.kind === 'pipe' ? 'pipe' : choice.weaker ? 'port (weaker)' : 'port';
}

export interface ChromeTargetInfo {
  /** Stable wmux identity handed to agents (`chrome-<uuid>` for dedicated
   *  instances). Live attach keeps surfaceId ≡ targetId — see LiveChromeClient. */
  surfaceId: string;
  /** Current CDP page target the surface maps to. Mutable across restarts. */
  targetId: string;
  workspaceId?: string;
  url: string;
  title: string;
  /**
   * Who may write to this tab, from the ASKING workspace's point of view (live
   * attach only — see LiveWriteScopeApi). Absent on dedicated instances, where
   * every addressable tab is one wmux opened and therefore agent-owned.
   */
  owner?: LiveTabOwner;
}

/** What browser.cdp.info reports for a chrome-family client. Exactly one of
 *  the fields is set: dedicated instances expose an HTTP CDP port, the live
 *  attach exposes Chrome's secret browser WS endpoint, and a dedicated
 *  instance on a debugging pipe is reached through the relay (relayGrant). */
export interface ChromeBackendEndpoint {
  cdpPort?: number;
  wsEndpoint?: string;
  piped?: true;
}

/**
 * The relay every Chrome on a debugging pipe is served through, made on the
 * first token asked for and closed on quit (disposeAll).
 */
let pipeRelay: CdpPipeRelay | null = null;

async function closePipeRelay(): Promise<void> {
  const relay = pipeRelay;
  pipeRelay = null;
  await relay?.close();
}

/**
 * Tests: serve pipe Chromes through `relay` (one on a temp root of the test's
 * own, so nothing the test starts looks in a temp dir another wmux uses), or
 * back to the default with null. The relay it replaces is closed.
 */
export async function setPipeRelayForTests(relay: CdpPipeRelay | null): Promise<void> {
  const previous = pipeRelay;
  pipeRelay = relay;
  if (previous && previous !== relay) await previous.close();
}

/**
 * Surface the browser.rpc chrome branches drive. Implemented by
 * ChromeLauncher (dedicated spawned instance) and LiveChromeClient (attach to
 * the user's live Chrome — Phase 3).
 */
/**
 * The live-attach write-scope surface (the agent-window policy).
 *
 * Present ONLY on LiveChromeClient, and its presence is how browser.rpc tells
 * the two chrome clients apart: a dedicated instance can address nothing but
 * tabs wmux opened, so there is no user tab there to protect. Every method is
 * synchronous bookkeeping over in-memory maps — asking the human is the RPC
 * layer's job, and the answer arrives back here through settleBorrow.
 */
export interface LiveWriteScopeApi {
  /** Exact ownership: 'agent' only for the workspace recorded against the tab. */
  ownerOf(surfaceId: string, workspaceId: string | undefined): LiveTabOwner;
  /** Reserve the prompt slot for one tab. false = one is already pending. */
  beginBorrow(surfaceId: string, workspaceId: string): boolean;
  /** Release the slot, recording the grant when the user allowed it. */
  settleBorrow(surfaceId: string, workspaceId: string, granted: boolean): void;
  /** Hand a lent tab back. false when this workspace held no grant on it. */
  returnBorrow(surfaceId: string, workspaceId: string): boolean;
  /** Drop one workspace's grants, or every grant when called with nothing. */
  clearBorrows(workspaceId?: string): void;
  /** The Chrome window this workspace's tabs were last seen in. Advisory. */
  agentWindowFor(workspaceId: string | undefined): number | undefined;
}

/**
 * A flattened CDP session on the page behind one wmux-opened tab, over the
 * client's own browser socket (no second connection). Dead for good once
 * Chrome detaches it, the socket goes away, or Chrome swaps the page behind
 * the tab: `send` then rejects with a `ChromePageSessionError('gone')`, and
 * the next `pageSession()` attaches afresh.
 */
export interface ChromePageSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** An event on this session only, until the returned function is called. */
  on?(method: string, handler: (params: Record<string, unknown>) => void): () => void;
}

/**
 * A tab one of a launcher's tabs opened (target=_blank, window.open, a popup),
 * now a surface of its own in its opener's workspace.
 */
export interface ChromeOpenedSurface {
  /** The surface whose page opened it. */
  openerSurfaceId: string;
  surfaceId: string;
  /** The opener's workspace; absent when the opener has none. */
  workspaceId?: string;
  /** Its URL when Chrome created it, usually empty until its first page commits. */
  url: string;
}

/**
 * A CDP session of its own on the page behind one wmux-opened tab, for a
 * screencast: attached fresh (never shared or cached), with its own events.
 * It ends when Chrome detaches it (the tab closed, or Chrome swapped the page
 * behind the tab), when the browser socket goes away, or on `detach()`; each
 * `on` handler is removed then, and `onClosed` listeners run once.
 */
export interface ChromeStreamSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** An event on this session only. */
  on(method: string, handler: (params: Record<string, unknown>) => void): void;
  onClosed(listener: () => void): void;
  readonly closed: boolean;
  detach(): Promise<void>;
}

/** Why a page session could not be had: the tab is not there, or no socket is. */
export class ChromePageSessionError extends Error {
  constructor(public readonly reason: 'gone' | 'unavailable', message: string) {
    super(message);
  }
}

export interface ChromeBackendClient {
  endpoint(): Promise<ChromeBackendEndpoint>;
  /** Dedicated instances on a debugging pipe (endpoint() said `piped`): a relay token for `identity`. */
  relayGrant?(identity: CallerIdentity): Promise<RelayGrant>;
  /** Targets reported through browser.cdp.info (page-selection seed). Live
   *  seeds only wmux-opened tabs so a random user tab can never become the
   *  default pin. */
  cdpInfoTargets(workspaceId?: string): Promise<ChromeTargetInfo[]>;
  openTab(url: string, workspaceId?: string): Promise<{ surfaceId: string; targetId: string; url: string }>;
  listTargets(workspaceId?: string): Promise<ChromeTargetInfo[]>;
  closeSurface(surfaceId: string): Promise<boolean>;
  /** Real tab focus where the backend supports it (live attach). */
  selectSurface?(surfaceId: string): Promise<boolean>;
  /** Un-minimize the window holding a surface (dedicated instances; a person's explicit ask only). */
  restoreWindow?(surfaceId: string): Promise<void>;
  hasSurface(surfaceId: string): boolean;
  /** Dedicated instances only: a CDP session on one wmux-opened tab's page.
   *  Never launches Chrome. Absent on Live Chrome. */
  pageSession?(surfaceId: string): Promise<ChromePageSession>;
  /** False when pageSession cannot work here: the tab watcher is off or failed. */
  canPageSession?(): boolean;
  /** Dedicated instances only: an uncached session for a screencast (ChromeStreamSession). */
  streamSession?(surfaceId: string): Promise<ChromeStreamSession>;
  /** Dedicated instances: the record behind a wmux-opened surface (its workspace). */
  recordFor?(surfaceId: string): ChromeSurfaceRecord | undefined;
  /** Dedicated instances only: told each tab a wmux-opened tab opens; returns the unsubscribe. */
  onSurfaceOpened?(listener: (opened: ChromeOpenedSurface) => void): () => void;
  /** Dedicated instances: whether a Chrome is bound now (never launches one). */
  isRunning?(): boolean;
  /**
   * Dedicated instances, for the phone preview only: the current page of each
   * tab wmux holds no record of (another CDP client or a person opened it),
   * under an id of its own (`chrome-x-…`). Never in listTargets,
   * cdpInfoTargets, recordFor, the surface store or the pipe's grants. Starts
   * the tab watcher while Chrome runs; never launches Chrome.
   */
  outsideTabs?(opts?: { waitForPairing?: boolean }): Promise<ChromeTargetInfo[]>;
  /** Whether an outside id still names an open tab that has no record. */
  hasOutside?(id: string): boolean;
  /** pageSession for an outside id. */
  outsidePageSession?(id: string): Promise<ChromePageSession>;
  /** streamSession for an outside id. */
  outsideStreamSession?(id: string): Promise<ChromeStreamSession>;
  /** selectSurface for an outside id. */
  selectOutside?(id: string): Promise<boolean>;
  /** Detach every outside page and stream session this launcher holds, and refuse the attaches still in flight. */
  releaseOutside?(): void;
  /** Live attach only: the agent-window write policy. Absent = dedicated. */
  readonly writeScope?: LiveWriteScopeApi;
  dispose(): void | Promise<void>;
}

/** Whether `binary` is Microsoft Edge (Windows, macOS or Linux spelling). */
export function isEdgeBinary(binary: string): boolean {
  const name = binary.split(/[\\/]/).pop() ?? '';
  // Windows ships every channel as msedge.exe; macOS and Linux name the channel.
  return /^(msedge(\.exe)?|microsoft edge( beta| dev| canary)?|microsoft-edge(-stable|-beta|-dev|-canary)?)$/i.test(name);
}

/**
 * Flags every Edge wmux starts gets, dedicated and protected profiles alike.
 * On a PC signed in with a Microsoft or work account, Edge signs a fresh
 * profile in by itself and opens an edge://sync-confirmation-dialog/ target
 * that Target.closeTarget cannot close. The agent's browser must never sign in
 * to or sync with the user's account: msImplicitSignin stops the sign-in, and
 * --disable-sync stops a profile signed in before this from syncing.
 */
export function edgeArgs(binary: string): string[] {
  return isEdgeBinary(binary) ? ['--disable-features=msImplicitSignin', '--disable-sync'] : [];
}

/**
 * One `--disable-features` switch holding every feature the list disables, at
 * the place of the first: Chromium honours only one of several such switches.
 */
export function mergeDisableFeatures(args: string[]): string[] {
  const prefix = '--disable-features=';
  const features: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith(prefix)) continue;
    for (const f of arg.slice(prefix.length).split(',')) if (f && !features.includes(f)) features.push(f);
  }
  let placed = false;
  const out: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith(prefix)) out.push(arg);
    else if (!placed) {
      placed = true;
      if (features.length) out.push(prefix + features.join(','));
    }
  }
  return out;
}

/** A map that tells `changed` of every entry set or removed (main's target registry, for grants). */
class NotifyingMap<K, V> extends Map<K, V> {
  constructor(private readonly changed: () => void) {
    super();
  }

  override set(key: K, value: V): this {
    const same = this.has(key) && this.get(key) === value;
    super.set(key, value);
    if (!same) this.changed?.();
    return this;
  }

  override delete(key: K): boolean {
    const removed = super.delete(key);
    if (removed) this.changed();
    return removed;
  }

  override clear(): void {
    const had = this.size > 0;
    super.clear();
    if (had) this.changed();
  }
}

/** Candidate binary paths per platform, first match wins. Exported for the runtime suites. */
export function discoverChromeBinary(): string | null {
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
  /**
   * Protected panes: whether this profile must run behind main's filtering
   * proxy right now, and with which policy. Asked on every ensureRunning, so a
   * change restarts Chrome under (or out from under) the proxy. Absent or null
   * = legacy: the launch, adoption and arguments are exactly as before.
   */
  protection?: () => ChromeProtectionPlan | null;
  /** Test seam: extra Chrome flags (e.g. --headless=new). */
  extraArgs?: string[];
  /** Test seam: how long the launch waits for the proxy probe. */
  proxyProbeTimeoutMs?: number;
  /** The user's download folder: where, with grants, a download no client asked for lands. Absent: those are cancelled. */
  downloadsDir?: () => string | null;
  /**
   * The operator's setting that puts a protected profile on the DevTools port
   * (BrowserBackendStore.protectedPortTransport). Read per launch.
   */
  protectedPortAllowed?: () => boolean;
}

/** With grants on an unprotected profile (C3b): main's own folder, rules and session for the default context's downloads. */
interface DownloadRelay {
  readonly policy: DownloadRelayPolicy;
  readonly dir: string;
  session: CdpConnection | null;
  /** Settles once main's session holds the behaviour; rejects when it could not. No grant is handed out before. */
  ready: Promise<void>;
}

const DOWNLOAD_RELAY_NOT_READY = 'ChromeLauncher: the download relay could not be armed';

/** How a protected profile is enforced (see ProtectedProxy). */
export interface ChromeProtectionPlan {
  /** The policy as it is now; read per request. */
  matcher: () => HostMatcher;
  /** Test seam: where an allowed host:port connects. */
  resolve?: (host: string, port: number) => { host: string; port: number };
  /** Test seam: every proxy decision. */
  onDecision?: (d: { host: string; port: number; allowed: boolean; kind: string }) => void;
}

/**
 * The consent service's handle on a protected profile's download guard
 * (dangerousActionConsent.ts). `claim` installs the one function that may keep
 * a download the guard would otherwise cancel; null while another holds it.
 */
export interface ConsentDownloadGuard {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** `reassert`: called on the guard's re-assert tick while this claim holds, in place of the guard's own deny. */
  claim(claimant: (params: Record<string, unknown>) => boolean, reassert?: () => Promise<unknown>): (() => void) | null;
  onProgress(listener: (params: Record<string, unknown>) => void): () => void;
  /** Called once when this guard goes away (socket dropped, Chrome gone). */
  onClose(listener: () => void): () => void;
}

/** A protected profile could not be brought up under its enforcement. */
export const PROTECTION_NOT_READY = 'policy_denied: the protected browser could not be started under its site policy';

/** PROTECTION_NOT_READY with its cause for the reader; the message still starts with the constant. */
export function protectionNotReady(cause: string): Error {
  return new Error(`${PROTECTION_NOT_READY} (${cause})`);
}

/**
 * PROTECTION_NOT_READY as the caller has always seen it, with the launch step
 * that failed and what went wrong attached as its `cause`, and logged once.
 */
export function notReadyAt(profile: string, site: string, error?: unknown): Error {
  const why = error instanceof Error ? error.message : error === undefined ? 'no detail' : String(error);
  console.warn(`[ChromeLauncher] ${profile}: protected start not ready at ${site}: ${why}`);
  return new Error(PROTECTION_NOT_READY, { cause: { site, ...(error !== undefined && { error }) } });
}

function isProtectionNotReady(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(PROTECTION_NOT_READY);
}

/** Flags that would open a debugging port; never passed to a protected Chrome on the pipe. */
const PORT_FLAG = /^--remote-(debugging-port|debugging-address|allow-origins)(=|$)/;

/**
 * Turn chrome://inspect's "Allow remote debugging for this browser instance"
 * off in the profile's Local State before a protected launch: Chrome keeps it
 * across restarts (devtools.remote_debugging.user-enabled), and with it on it
 * starts a debugging server at launch.
 *  - No file: nothing to turn off.
 *  - A file that can't be read throws (the launch reports PROTECTION_NOT_READY):
 *    its setting is unknown.
 *  - A file that doesn't parse is left as it is: Chrome can't read it either,
 *    so it starts from default local state, where the setting is off.
 *  - The rewrite keeps the file's mode, and a failed rename leaves no temp file.
 */
export function clearRemoteDebuggingToggle(userDataDir: string): void {
  const file = join(userDataDir, 'Local State');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  let state: { devtools?: { remote_debugging?: Record<string, unknown> } };
  try {
    state = JSON.parse(text) as typeof state;
  } catch {
    return;
  }
  const remote = state?.devtools?.remote_debugging;
  if (!remote || typeof remote !== 'object' || !('user-enabled' in remote)) return;
  delete remote['user-enabled'];
  const tmp = `${file}.wmux-tmp`;
  writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: statSync(file).mode & 0o777 });
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch { /* already gone */ }
    throw err;
  }
}

/**
 * Whether a Chrome that exited during startup handed its start to another
 * Chrome already running on the profile (Chrome's process singleton): a
 * windowed one exits 0 after handing it over, a headless one 21 (profile in
 * use), and on POSIX the profile's SingletonLock names the other process.
 */
function handedOff(child: ChildProcess, userDataDir: string): boolean {
  if (child.exitCode === 0 || child.exitCode === 21) return true;
  try {
    const owner = readlinkSync(join(userDataDir, 'SingletonLock'));
    const pid = Number(owner.slice(owner.lastIndexOf('-') + 1));
    return Number.isInteger(pid) && pid > 0 && pid !== child.pid;
  } catch {
    return false;
  }
}

/** The cause shown when a protected start was handed to a Chrome already on the profile. */
const HANDED_OFF = 'another Chrome is still running on this profile and took the start over; close it and try again';

/** The download guard's deny for one browser context, with its download events on the guard's session. */
const contextDeny = (browserContextId: string) => ({ behavior: 'deny', browserContextId, eventsEnabled: true });

/** Mint a stable surface id. Mirrors shared/types.ts `generateId('chrome')`;
 *  kept local so main's browser-session layer does not pull in the shared
 *  types barrel (and everything it drags along) for one line. */
function newSurfaceId(): string {
  return `chrome-${randomUUID()}`;
}

/** The id an outside tab (ChromeLauncher.outsideTabs) gets: a `chrome-` surface no record can hold. */
export const OUTSIDE_ID_PREFIX = 'chrome-x-';

/** How long outsideTabs waits for Chrome to name the pages behind tabs the watcher just attached. */
export const OUTSIDE_PAIRING_WAIT_MS = 2_000;

/** How long outsideTabs waits for openTab calls still creating their tab, before it leaves new tabs out. */
export const OUTSIDE_OPENING_WAIT_MS = 1_000;

/** Whether every promise settled within `ms` (they never reject). */
function settledWithin(pending: Array<Promise<void>>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    (timer as { unref?: () => void }).unref?.();
    void Promise.all(pending).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Tabs one tab may open in a minute and still be adopted. */
export const OPENED_PER_OPENER_PER_MINUTE = 20;
/** Tabs one workspace's tabs may open in a minute and still be adopted. */
export const OPENED_PER_WORKSPACE_PER_MINUTE = 40;
/** Tabs all of one launcher's tabs may open in a minute and still be adopted: every unbound workspace shares a profile. */
export const OPENED_PER_MINUTE = 120;
/** Adopted tabs one tab's opened tabs may hold open at once. */
export const OPENED_OPEN_PER_OPENER = 30;
/** Adopted tabs one workspace may hold open at once. */
export const OPENED_OPEN_PER_WORKSPACE = 50;
const OPENED_WINDOW_MS = 60_000;
/** The launcher-wide key of the adoption windows; the others start with `tab:` or `ws:`. */
const ALL_OPENERS = '*';

/** The adoption limits' key for a workspace (a tab with none shares the key of the others with none). */
function workspaceKey(workspaceId: string | undefined): string {
  return `ws:${workspaceId ?? ''}`;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

/** Resolves true once `child` exits, or false after `ms`. */
function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, ms);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

/** A cleanup request's bound, cut short when `stop` fires. */
function boundedBy(stop?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(RESTORE_SETTLE_MS);
  return stop ? AbortSignal.any([stop, timeout]) : timeout;
}

/** adoptExisting: what answers on the recorded port is not the browser that recorded it. */
class NotTheRecordedBrowser extends Error {
  /** What it is instead, for the log. */
  constructor(readonly why: string) {
    super('not the recorded browser');
  }
}

/** The one tab a Chrome starts with when it restores nothing. */
function isStartupTabUrl(url: string): boolean {
  return url === 'about:blank' || /^[a-z]+:\/\/(newtab|new-tab-page(-third-party)?)\/?$/.test(url);
}

/** The slice of CDP's TargetInfo the watcher reads. */
interface WatchedTargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
  title?: string;
  /** The page that opened this one, noopener included. */
  openerId?: string;
  /** Set on a page that is not a tab's, such as `prerender`. */
  subtype?: string;
}

interface PageSessionEntry {
  socket: CdpConnection;
  sessionId: string;
  targetId: string;
  valid: boolean;
}

interface StreamSessionEntry {
  socket: CdpConnection;
  sessionId: string;
  /** Set on a session to an outside tab (releaseOutside ends it). */
  outside?: true;
  closed: boolean;
  unsubscribe: Array<() => void>;
  closers: Array<() => void>;
}

function watchedTargetInfo(params: Record<string, unknown>): WatchedTargetInfo | undefined {
  const info = params.targetInfo;
  return info && typeof info === 'object' ? (info as WatchedTargetInfo) : undefined;
}

export class ChromeLauncher implements ChromeBackendClient {
  private child: ChildProcess | null = null;
  /**
   * The current Chrome's endpoint and where it stands, whatever carries its
   * CDP. One field, so "running" and "reachable" cannot disagree:
   *  - stopped: null, nothing bound.
   *  - probing: a candidate endpoint is bound (adoption, or a launch whose
   *    endpoint is known) and has not answered yet (`ready: false`).
   *  - ready: the bound endpoint answered (`ready: true`). A launch may still
   *    be finishing (restored tabs, the download guard) while `launching` is set.
   * stopped → probing on bindEndpoint; probing → ready on markReady, for the
   * endpoint still bound; probing → stopped when that probe fails; any →
   * stopped in onChildGone. bindEndpoint and unbindEndpoint are the only
   * writers.
   */
  private bound: { readonly transport: ChromeTransport; ready: boolean } | null = null;
  /**
   * Pipe mode: the current Chrome's multiplexer, and its route on the relay
   * external clients dial, made on the first relayGrant() call. Both go with
   * the Chrome (onChildGone).
   */
  private piped: {
    readonly mux: CdpPipeMux;
    /** A protected profile's rules for the pipe's clients; null when unprotected. */
    readonly policy: ProtectedPipePolicy | null;
    /** With grants on an unprotected profile: downloads of the shared default context. */
    readonly relay: DownloadRelay | null;
    /** Main's own connection on the pipe. */
    readonly transport: ChromeTransport;
    route: RelayRoute | null;
    /** Blank tabs opened for a grant to attach through (relayGrant), until closed. */
    readonly bootstraps: Set<string>;
    /** Grants (C3b) narrow each client to its own targets: a tab main opens is none of them. */
    readonly grants: boolean;
  } | null = null;
  /** Pipe mode: liveness checks failed in a row, and when the last one counted ended. */
  private pingMisses = { count: 0, lastEnd: 0 };
  /** Pipe mode: a Chrome let go and still on its way out. The next launch waits for it. */
  private exiting: { readonly child: ChildProcess; readonly exited: Promise<boolean> } | null = null;
  private launching: Promise<number> | null = null;
  private disposed = false;
  private readonly portEnvVar: string | null;
  /** wmux-opened tabs, keyed by the stable surfaceId agents hold. */
  private readonly surfaces = new Map<string, ChromeSurfaceRecord>();
  /** Reverse index: current CDP targetId → surfaceId. */
  /** targetId → surfaceId. Every change lets the pipe's grants catch up (C3b). */
  private readonly byTargetId = new NotifyingMap<string, string>(() => this.scheduleRegrant());
  private regrantQueued = false;
  /** Reverse index: stable CDP tab-target anchor → surfaceId. */
  private readonly byTabTargetId = new Map<string, string>();
  /** True once the persisted records for this profile have been merged in. */
  private restored = false;
  /** True once those records are bound to the running Chrome, so a tab without one is not ours. */
  private recordsSettled = false;
  /** openTab calls between createTarget and their record: their target is not an outside one. */
  private readonly openingTabs = new Set<Promise<void>>();
  /** Outside tabs (outsideTabs): tab targetId → phone-only id, and back. */
  private readonly outsideIds = new Map<string, string>();
  private readonly outsideTabsById = new Map<string, string>();
  /** Told on every tab ↔ page pairing: outsideTabs waits on them for tabs just attached. */
  private readonly pairingWaiters = new Set<() => void>();
  /** When the watcher attached each tab: only a tab attached that recently is worth waiting for. */
  private readonly tabAttachedAt = new Map<string, number>();
  /** Bumped by releaseOutside and forgetOutside: an outside attach that started before them cannot finish. */
  private outsideGeneration = 0;

  // ── Tab-target watcher state (all of it optional; see TARGET_WATCHER_ENV) ──
  private watcher: CdpConnection | null = null;
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
  /** surfaceId → the page session pageSession() attached for it, on the watcher socket. */
  private readonly pageSessions = new Map<string, PageSessionEntry>();
  /** pageSession() attaches in flight, so concurrent callers share one. */
  private readonly attachingPages = new Map<string, Promise<PageSessionEntry>>();
  /** streamSession()s alive on the watcher socket. */
  private readonly streamSessions = new Set<StreamSessionEntry>();
  /** The watcher socket whose discovery replay is over: only pages created after it are adopted. */
  private adoptingOn: CdpConnection | null = null;
  private readonly openedListeners = new Set<(opened: ChromeOpenedSurface) => void>();
  /** Adoption times in the last minute, per opener (`tab:`), per workspace (`ws:`) and for all (ALL_OPENERS). */
  private readonly adoptedAt = new Map<string, number[]>();
  /** Adopted surfaces still open, by surfaceId: who opened them, and the workspace key. */
  private readonly adopted = new Map<string, { opener: string; workspace: string }>();
  /** Limits whose refusal has been logged since they last let a tab through. */
  private readonly capLogged = new Set<string>();

  private readonly profileLabel: string | undefined;
  private readonly profileName: string;
  private readonly surfaceStore: ChromeSurfaceStore | undefined;

  private readonly protection: (() => ChromeProtectionPlan | null) | undefined;
  private readonly extraArgs: string[];
  private readonly downloadsDir: (() => string | null) | undefined;
  private readonly protectedPortAllowed: (() => boolean) | undefined;
  /** The transport the running (or launching) Chrome was started on; null before the first launch. */
  private transport: ChromeTransportChoice | null = null;
  /** Why the last protected pipe Chrome was closed under it (a debugging port appeared); told once to the next call. */
  private protectionLost: string | null = null;
  /** Whether the running instance was launched behind the proxy. */
  private launchedProtected = false;
  /** False until a protected launch's download guard holds and the tabs
   *  session restore brought back are closed: the proxy refuses every request
   *  until then, so no restored page loads before enforcement is in place. */
  private enforcementReady = false;
  private proxy: ProtectedProxy | null = null;
  /** Hosts the proxy refused since this Chrome launched or the policy last
   *  changed (#2063); the pane editor offers an Allow for each. */
  private readonly blocked = new BlockedHostLog();
  /** Main's own browser-level session that keeps downloads denied. */
  private downloadGuard: CdpConnection | null = null;
  /** The guard being armed, so concurrent callers share one socket. */
  private guardArming: Promise<void> | null = null;
  private readonly proxyProbeTimeoutMs: number | undefined;
  /** Consent: may keep ONE download the guard would cancel (see consentDownloadGuard). */
  private downloadClaimant: ((params: Record<string, unknown>) => boolean) | null = null;
  /** The claimant's own behaviour, re-asserted on the guard's tick while it holds the guard. */
  private downloadClaimReassert: (() => Promise<unknown>) | null = null;
  private readonly downloadProgress = new Set<(params: Record<string, unknown>) => void>();
  private readonly downloadGuardClosed = new Set<() => void>();

  constructor(private readonly userDataDir: string, opts?: ChromeLauncherOptions) {
    this.profileLabel = opts?.profileLabel;
    this.portEnvVar = opts?.portEnvVar === undefined ? 'WMUX_CHROME_CDP_PORT' : opts.portEnvVar;
    this.profileName = opts?.profileName ?? DEFAULT_CHROME_PROFILE;
    this.surfaceStore = opts?.surfaceStore;
    this.protection = opts?.protection;
    this.extraArgs = opts?.extraArgs ?? [];
    this.downloadsDir = opts?.downloadsDir;
    this.protectedPortAllowed = opts?.protectedPortAllowed;
    this.proxyProbeTimeoutMs = opts?.proxyProbeTimeoutMs;
  }

  /** The protection this profile needs now (null = legacy). Never throws:
   *  an unanswerable question is not a reason to run unprotected, so a
   *  throwing hook reads as "protected, deny everything". */
  private wantedProtection(): ChromeProtectionPlan | null {
    if (!this.protection) return null;
    try {
      return this.protection();
    } catch {
      return { matcher: () => ({ allows: () => false }) };
    }
  }

  /** Whether this instance runs (or would run) behind the proxy. */
  isProtected(): boolean {
    return this.launchedProtected;
  }

  /** The transport the running Chrome was launched on; null when none is running. */
  launchedTransport(): ChromeTransportChoice | null {
    return this.isRunning() ? this.transport : null;
  }

  /** The hosts this profile's proxy refused recently, newest first. */
  blockedHosts(): BlockedHost[] {
    return this.blocked.list();
  }

  /** Forget the recently refused hosts (the policy changed). */
  clearBlockedHosts(): void {
    this.blocked.clear();
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

  /** Grants (C3b): the registry changed; the pipe catches up once, after this turn's changes. */
  private scheduleRegrant(): void {
    if (this.regrantQueued) return;
    this.regrantQueued = true;
    queueMicrotask(() => {
      this.regrantQueued = false;
      this.piped?.mux.regrant();
    });
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
    this.adopted.delete(surfaceId);
    this.adoptedAt.delete(`tab:${surfaceId}`);
    this.capLogged.delete(`tab:${surfaceId}`);
    this.capLogged.delete(`open:tab:${surfaceId}`);
    // A surface Chrome closed is nobody's any more: its connection entry would
    // only take a place in that registry from a live one.
    surfaceOpeners.forget(surfaceId);
  }

  // ── Tab-target watcher ────────────────────────────────────────────────────

  /** Kill switch: WMUX_CHROME_TARGET_WATCHER=0 never opens the socket. */
  private watcherEnabled(): boolean {
    return chromeTargetWatcherEnabled();
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
    this.adoptingOn = null;
    this.browserWsEndpoint = null;
    this.tabSessions.clear();
    this.sessionTabs.clear();
    this.tabToPage.clear();
    this.pageToTab.clear();
    this.forgetOutside();
    for (const entry of this.pageSessions.values()) entry.valid = false;
    this.pageSessions.clear();
    for (const entry of [...this.streamSessions]) this.endStreamSession(entry);
  }

  /** The watcher's connection went away (CdpSocket re-dials in place): every page session on it is dead. */
  private dropPageSessionsOf(socket: CdpConnection): void {
    // The tab topology the outside ids rest on is re-read on the next connection.
    if (this.watcher === socket) this.forgetOutside();
    for (const [surfaceId, entry] of this.pageSessions) {
      if (entry.socket !== socket) continue;
      entry.valid = false;
      this.pageSessions.delete(surfaceId);
    }
    for (const entry of [...this.streamSessions]) {
      if (entry.socket === socket) this.endStreamSession(entry);
    }
  }

  /** A stream session ends once: its handlers go, then its listeners hear it. */
  private endStreamSession(entry: StreamSessionEntry): void {
    if (entry.closed) return;
    entry.closed = true;
    this.streamSessions.delete(entry);
    for (const off of entry.unsubscribe.splice(0)) off();
    for (const listener of entry.closers.splice(0)) {
      try { listener(); } catch (err) { console.warn('[ChromeLauncher] stream session close listener threw:', err); }
    }
  }

  /** Chrome detached `sessionId`: a stream session on it is over. True when it was one. */
  private dropStreamSession(sessionId: string): boolean {
    for (const entry of this.streamSessions) {
      if (entry.sessionId !== sessionId) continue;
      this.endStreamSession(entry);
      return true;
    }
    return false;
  }

  /** Chrome detached `sessionId`: a page session on it is dead. True when it was one. */
  private dropPageSession(sessionId: string): boolean {
    for (const [surfaceId, entry] of this.pageSessions) {
      if (entry.sessionId !== sessionId) continue;
      entry.valid = false;
      this.pageSessions.delete(surfaceId);
      return true;
    }
    return false;
  }

  /** Whether pageSession can attach at all: the watcher socket is enabled and has not failed. */
  canPageSession(): boolean {
    return this.watcherEnabled() && !this.watcherFailed;
  }

  /**
   * A CDP session on the page behind a wmux-opened tab, attached over the
   * watcher's browser socket (Target.attachToTarget, flatten). Never launches
   * Chrome: a launcher that is not running, or has no watcher socket (turned
   * off, or it failed), answers `unavailable`; a surface with no live page
   * answers `gone`. Ownership is the caller's check — this only knows the tab.
   */
  async pageSession(surfaceId: string): Promise<ChromePageSession> {
    const record = this.surfaces.get(surfaceId);
    if (!this.isRunning()) throw new ChromePageSessionError('unavailable', 'ChromeLauncher: Chrome is not running');
    if (!record?.targetId) throw new ChromePageSessionError('gone', 'ChromeLauncher: no page for this surface');
    await this.ensureTargetWatcher();
    const socket = this.watcher;
    if (!socket?.isOpen()) throw new ChromePageSessionError('unavailable', 'ChromeLauncher: no browser CDP socket');
    const cached = this.pageSessions.get(surfaceId);
    let entry: PageSessionEntry;
    if (cached && cached.valid && cached.socket === socket && cached.targetId === record.targetId) {
      entry = cached;
    } else {
      if (cached) {
        // Chrome swapped the page behind the tab: the old session drives a page nobody sees.
        cached.valid = false;
        this.pageSessions.delete(surfaceId);
        if (cached.socket === socket) void socket.send('Target.detachFromTarget', { sessionId: cached.sessionId }).catch(() => undefined);
      }
      entry = await this.attachPage(surfaceId, record.targetId, socket);
    }
    return this.sessionOf(entry);
  }

  /** The ChromePageSession over one attached entry; dead once the entry is, or once `still` says no. */
  private sessionOf(entry: PageSessionEntry, still: () => boolean = () => true): ChromePageSession {
    const live = () => entry.valid && this.watcher === entry.socket && still();
    return {
      send: async (method, params = {}) => {
        if (!live()) throw new ChromePageSessionError('gone', 'ChromeLauncher: page session ended');
        try {
          return await entry.socket.send(method, params, entry.sessionId);
        } catch (err) {
          if (!live()) throw new ChromePageSessionError('gone', 'ChromeLauncher: page session ended');
          throw err;
        }
      },
      on: (method, handler) => entry.socket.on(method, (params, from) => {
        if (from === entry.sessionId && entry.valid) handler(params);
      }),
    };
  }

  /**
   * A session of its own on the page behind a wmux-opened tab, for a
   * screencast (ChromeStreamSession): attached fresh over the watcher's
   * browser socket, never cached, so its events and its detach touch nothing
   * else. Never launches Chrome; the same `unavailable` / `gone` answers as
   * pageSession. Ownership is the caller's check.
   */
  async streamSession(surfaceId: string): Promise<ChromeStreamSession> {
    return this.openStream(() => this.surfaces.get(surfaceId)?.targetId ?? undefined);
  }

  /** A stream session on the page `targetOf` names, re-read after the attach. */
  private async openStream(targetOf: () => string | undefined, outside = false): Promise<ChromeStreamSession> {
    if (!this.isRunning()) throw new ChromePageSessionError('unavailable', 'ChromeLauncher: Chrome is not running');
    if (!targetOf()) throw new ChromePageSessionError('gone', 'ChromeLauncher: no page for this surface');
    await this.ensureTargetWatcher();
    const socket = this.watcher;
    if (!socket?.isOpen()) throw new ChromePageSessionError('unavailable', 'ChromeLauncher: no browser CDP socket');
    const targetId = targetOf();
    if (!targetId) throw new ChromePageSessionError('gone', 'ChromeLauncher: no page for this surface');
    let sessionId: string | undefined;
    try {
      const res = (await socket.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId?: unknown };
      sessionId = typeof res?.sessionId === 'string' ? res.sessionId : undefined;
    } catch {
      sessionId = undefined;
    }
    if (!sessionId) throw new ChromePageSessionError('gone', 'ChromeLauncher: the page could not be attached');
    if (this.watcher !== socket || targetOf() !== targetId) {
      void socket.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      throw new ChromePageSessionError('gone', 'ChromeLauncher: the page changed while attaching');
    }
    const id = sessionId;
    const entry: StreamSessionEntry = { socket, sessionId: id, ...(outside && { outside: true as const }), closed: false, unsubscribe: [], closers: [] };
    this.streamSessions.add(entry);
    const ended = () => new ChromePageSessionError('gone', 'ChromeLauncher: stream session ended');
    return {
      send: async (method, params = {}) => {
        if (entry.closed) throw ended();
        try {
          return await socket.send(method, params, id);
        } catch (err) {
          if (entry.closed) throw ended();
          throw err;
        }
      },
      on: (method, handler) => {
        if (entry.closed) return;
        entry.unsubscribe.push(socket.on(method, (params, from) => {
          if (from === id && !entry.closed) handler(params);
        }));
      },
      onClosed: (listener) => {
        if (entry.closed) queueMicrotask(listener);
        else entry.closers.push(listener);
      },
      get closed() { return entry.closed; },
      detach: async () => {
        if (entry.closed) return;
        this.endStreamSession(entry);
        await socket.send('Target.detachFromTarget', { sessionId: id }).catch(() => undefined);
      },
    };
  }

  private attachPage(
    surfaceId: string,
    targetId: string,
    socket: CdpConnection,
    // What `surfaceId` names now; an outside id has its own (outsidePage).
    current: () => string | null | undefined = () => this.surfaces.get(surfaceId)?.targetId,
    // Attaches share one in flight only within one generation (an outside id's release generation).
    generation = '',
  ): Promise<PageSessionEntry> {
    const key = `${surfaceId}\n${targetId}\n${generation}`;
    const inFlight = this.attachingPages.get(key);
    if (inFlight) return inFlight;
    const attach = (async () => {
      let sessionId: string | undefined;
      try {
        const res = (await socket.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId?: unknown };
        sessionId = typeof res?.sessionId === 'string' ? res.sessionId : undefined;
      } catch {
        sessionId = undefined;
      }
      if (!sessionId) throw new ChromePageSessionError('gone', 'ChromeLauncher: the page could not be attached');
      if (this.watcher !== socket || current() !== targetId) {
        void socket.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
        throw new ChromePageSessionError('gone', 'ChromeLauncher: the page changed while attaching');
      }
      const entry: PageSessionEntry = { socket, sessionId, targetId, valid: true };
      this.pageSessions.set(surfaceId, entry);
      return entry;
    })().finally(() => this.attachingPages.delete(key));
    this.attachingPages.set(key, attach);
    return attach;
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
    // Attempt identity. onChildGone() drops watcherStarting when Chrome dies
    // mid-startup, so an attempt that is no longer the current one must
    // neither latch the watcher off — its failure was that death, not the
    // browser's verdict — nor null out the attempt that replaced it. Without
    // this, one launch dying during the first /json/version re-latched
    // watcherFailed AFTER onChildGone had cleared it, and the next Chrome ran
    // watcher-less until it too died.
    const attempt: Promise<void> = this.startTargetWatcher()
      .catch((err) => {
        if (this.watcherStarting === attempt) this.watcherDown('startup failed', err);
      })
      .finally(() => {
        if (this.watcherStarting === attempt) this.watcherStarting = null;
      });
    this.watcherStarting = attempt;
    return attempt;
  }

  private async startTargetWatcher(): Promise<void> {
    if (!this.isRunning()) return; // nothing running yet; a later demand retries
    // One transport for the read and the dial: an endpoint is only good on
    // the transport that named it.
    const transport = this.reach();
    const endpoint = await transport.browserEndpoint();
    if (endpoint === null) {
      this.watcherDown('no browser webSocketDebuggerUrl on /json/version');
      return;
    }
    this.closeWatcher();
    if (this.disposed) return;
    const generation = ++this.watcherGeneration;
    const socket: CdpConnection = transport.connect(
      () => {
        const url = this.browserWsEndpoint;
        if (!url) throw new Error('ChromeLauncher: no browser CDP endpoint');
        return url;
      },
      // A page session id belongs to one connection; a re-dial must not reuse it.
      { label: 'ChromeLauncher watcher', onDisconnect: () => this.dropPageSessionsOf(socket) },
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
    // Chrome announces every existing target before it answers: from here on
    // a created page is a new one.
    this.adoptingOn = socket;
    await this.syncTabAnchors();
  }

  private subscribeTargetEvents(socket: CdpConnection): void {
    socket.on('Target.targetCreated', (params) => {
      const info = watchedTargetInfo(params);
      if (info?.type === 'tab' && info.targetId) void this.attachTab(info.targetId);
      else if (info?.type === 'page' && this.adoptingOn === socket) this.adoptOpened(info);
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
      if (this.dropPageSession(gone)) return;
      if (this.dropStreamSession(gone)) return;
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
      this.tabAttachedAt.delete(targetId);
      const outsideId = this.outsideIds.get(targetId);
      if (outsideId) {
        this.outsideIds.delete(targetId);
        this.outsideTabsById.delete(outsideId);
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

  /**
   * A page one of our tabs opened (target=_blank, window.open, a popup)
   * becomes a surface of its own, in its opener's workspace, or in none when
   * the opener has none. A page another tab opened stays nobody's, and the
   * pages discovery replays when the watcher starts are never adopted.
   */
  private adoptOpened(info: WatchedTargetInfo): void {
    const { targetId, openerId } = info;
    // A prerendered (speculative) page is not a tab: a tab's page has no subtype.
    if (!targetId || !openerId || info.subtype || this.byTargetId.has(targetId)) return;
    const opener = this.recordForTarget(openerId);
    if (!opener) return;
    const now = Date.now();
    const workspace = workspaceKey(opener.workspaceId);
    if (!this.mayAdopt(opener.surfaceId, workspace, now)) return;
    const record: ChromeSurfaceRecord = {
      surfaceId: newSurfaceId(),
      targetId,
      ...(opener.workspaceId !== undefined && { workspaceId: opener.workspaceId }),
      url: info.url ?? '',
      createdAt: now,
      lastSeenAt: now,
    };
    this.surfaces.set(record.surfaceId, record);
    this.byTargetId.set(targetId, record.surfaceId);
    this.adopted.set(record.surfaceId, { opener: opener.surfaceId, workspace });
    surfaceOpeners.inherit(record.surfaceId, opener.surfaceId);
    // The tab's own attach may have landed first; otherwise noteTabPage anchors it.
    this.linkAnchor(record);
    this.persist(true);
    const opened: ChromeOpenedSurface = {
      openerSurfaceId: opener.surfaceId,
      surfaceId: record.surfaceId,
      ...(record.workspaceId !== undefined && { workspaceId: record.workspaceId }),
      url: record.url,
    };
    for (const listener of [...this.openedListeners]) {
      try { listener(opened); } catch (err) { console.warn('[ChromeLauncher] opened-surface listener threw:', err); }
    }
  }

  /**
   * A page that loops window.open must not grow the surface list without
   * bound. Past any limit below a new tab stays nobody's, as every opened
   * tab did before adoption: tabs adopted in the last minute from one tab,
   * from one workspace's tabs, and from the whole profile (which every
   * unbound workspace shares), and adopted tabs still open per opener and
   * per workspace. Each limit is logged once per run of refusals.
   */
  private mayAdopt(openerSurfaceId: string, workspace: string, now: number): boolean {
    const tab = `tab:${openerSurfaceId}`;
    const rates: Array<[string, number]> = [
      [tab, OPENED_PER_OPENER_PER_MINUTE],
      [workspace, OPENED_PER_WORKSPACE_PER_MINUTE],
      [ALL_OPENERS, OPENED_PER_MINUTE],
    ];
    const recent = rates.map(([key]) => (this.adoptedAt.get(key) ?? []).filter((at) => now - at < OPENED_WINDOW_MS));
    rates.forEach(([key], i) => this.adoptedAt.set(key, recent[i]));
    const open = [...this.adopted.values()];
    const limits: Array<{ key: string; full: boolean; what: string }> = [
      ...rates.map(([key, cap], i) => ({ key, full: recent[i].length >= cap, what: `${cap} new tabs in a minute` })),
      { key: `open:${tab}`, full: open.filter((a) => a.opener === openerSurfaceId).length >= OPENED_OPEN_PER_OPENER, what: `${OPENED_OPEN_PER_OPENER} open tabs from one tab` },
      { key: `open:${workspace}`, full: open.filter((a) => a.workspace === workspace).length >= OPENED_OPEN_PER_WORKSPACE, what: `${OPENED_OPEN_PER_WORKSPACE} open tabs in one workspace` },
    ];
    const full = limits.find((limit) => limit.full);
    if (full) {
      if (!this.capLogged.has(full.key)) {
        this.capLogged.add(full.key);
        console.warn(`[ChromeLauncher] tabs a tab opens are not adopted past ${full.what}`);
      }
      return false;
    }
    recent.forEach((times) => times.push(now));
    for (const limit of limits) this.capLogged.delete(limit.key);
    return true;
  }

  /** Told each tab a wmux-opened tab opens, once it is a surface; returns the unsubscribe. */
  onSurfaceOpened(listener: (opened: ChromeOpenedSurface) => void): () => void {
    this.openedListeners.add(listener);
    return () => { this.openedListeners.delete(listener); };
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
      this.tabAttachedAt.set(tabTargetId, Date.now());
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

  private async getTabTargets(socket: CdpConnection): Promise<WatchedTargetInfo[]> {
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
    for (const wake of [...this.pairingWaiters]) wake();

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
    // Chrome swapped the page inside this tab, and the new page, announced
    // with an opener, was adopted on its own before its tab was known: one
    // page is one surface, this tab's.
    const duplicate = this.recordForTarget(pageTargetId);
    if (duplicate && duplicate !== record && !duplicate.tabTargetId) this.forget(duplicate.surfaceId);
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

  /**
   * Dedicated instances expose the HTTP CDP port (launching on demand); on a
   * debugging pipe there is no port, and external clients connect through the
   * relay with a token from relayGrant() instead.
   */
  async endpoint(): Promise<ChromeBackendEndpoint> {
    const cdpPort = await this.ensureRunning();
    this.assertOpen(); // a quit may land between ensureRunning's gate and here
    if (this.piped) return { piped: true };
    return { cdpPort };
  }

  /**
   * A one-time token for `identity` to connect to the running Chrome on the
   * pipe through the relay (call endpoint() first). The token reaches this
   * Chrome only: one started later on the profile is not reached by it.
   */
  async relayGrant(identity: CallerIdentity): Promise<RelayGrant> {
    this.assertOpen();
    const piped = this.piped;
    if (!piped) throw new Error('ChromeLauncher: Chrome exited');
    // With grants, no client before main holds the default context's downloads.
    if (piped.relay) await piped.relay.ready;
    if (this.piped !== piped) throw new Error('ChromeLauncher: Chrome exited');
    piped.route ??= (pipeRelay ??= new CdpPipeRelay()).serve(piped.mux);
    const route = piped.route;
    // A full Chrome refuses here, before a tab is opened for nothing.
    route.assertRoom();
    // With grants a client sees only its own targets, so a tab main opens
    // would not help it attach, and it could not close the tab either.
    const page = piped.grants ? null : await this.openRelayPage(piped);
    const release = () => { if (page !== null) void this.closeRelayPage(piped, page); };
    let grant: RelayGrant;
    try {
      // The caller closes the tab once attached; this is for one that never
      // does: settled when its connection closes, or its token goes unused.
      grant = await route.grant(identity, page !== null ? { onSettled: release } : undefined);
    } catch (err) {
      release();
      throw err;
    }
    if (this.piped !== piped) throw new Error('ChromeLauncher: Chrome exited');
    return page !== null ? { ...grant, bootstrapTargetId: page } : grant;
  }

  /**
   * A Chrome with every window closed (the macOS default) has no default
   * browser context, and connectOverCDP fails on it. When the piped Chrome
   * has no page but the blank tabs earlier grants are still attaching
   * through, open one for this grant (each its own, as each caller closes
   * its own); its targetId, or null when Chrome has a page.
   */
  private async openRelayPage(piped: NonNullable<ChromeLauncher['piped']>): Promise<string | null> {
    try {
      const targets = (await piped.transport.listTargets(boundedBy())) as Array<{ id?: unknown; type?: unknown; url?: unknown }>;
      if (!Array.isArray(targets)) return null;
      // A blank tab of ours the user went somewhere in is a page like any other.
      const pages = targets.filter((t) => t.type === 'page' && !(typeof t.id === 'string' && piped.bootstraps.has(t.id) && t.url === 'about:blank'));
      if (pages.length > 0) return null;
      const opened = (await piped.transport.createTarget('about:blank', boundedBy())) as { id?: unknown } | null;
      if (typeof opened?.id !== 'string') return null;
      piped.bootstraps.add(opened.id);
      return opened.id;
    } catch {
      // The grant goes ahead: an attach that needed the tab fails as it did before.
      return null;
    }
  }

  /** Close a grant's blank tab if it is still there and still blank (a user may have used it). */
  private async closeRelayPage(piped: NonNullable<ChromeLauncher['piped']>, id: string): Promise<void> {
    try {
      if (this.piped !== piped) return;
      const targets = (await piped.transport.listTargets(boundedBy())) as Array<{ id?: unknown; url?: unknown }>;
      const tab = Array.isArray(targets) ? targets.find((t) => t.id === id) : undefined;
      if (tab && tab.url === 'about:blank') await piped.transport.closeTarget(id, boundedBy());
    } catch { /* gone with its Chrome */ } finally {
      piped.bootstraps.delete(id);
    }
  }

  /** Registry-scoped tabs seed page selection for dedicated instances. */
  cdpInfoTargets(workspaceId?: string): Promise<ChromeTargetInfo[]> {
    return this.listTargets(workspaceId);
  }

  /** True when a CDP endpoint is established (spawned child or adopted
   *  previous-session instance; liveness is re-verified on demand). It stays
   *  true while a candidate endpoint is being probed, as it did with cdpPort. */
  isRunning(): boolean {
    return this.bound !== null;
  }

  /** The established CDP port, or null. Pure read — unlike endpoint(), this
   *  never launches Chrome, so status probes stay side-effect-free. */
  currentPort(): number | null {
    const transport = this.bound?.transport;
    return transport?.kind === 'port' ? transport.port : null;
  }

  /** Binds a candidate endpoint: → probing. Returns it, for its probe. */
  private bindEndpoint(transport: ChromeTransport): ChromeTransport {
    this.bound = { transport, ready: false };
    return transport;
  }

  /**
   * `transport` answered: probing → ready, only while it is still the bound
   * one. A dispose or a dead child that unbound it during the probe wins.
   */
  private markReady(transport: ChromeTransport): void {
    if (this.bound?.transport === transport) this.bound.ready = true;
  }

  /** Nothing bound any more: → stopped. */
  private unbindEndpoint(): void {
    this.bound = null;
  }

  /**
   * The bound transport. With none bound, the port-0 transport, which answers
   * nothing: a call made then fails exactly as it did when it went to port 0.
   */
  private reach(): ChromeTransport {
    return this.bound?.transport ?? portTransport(0);
  }

  /** The bound port, 0 when none (what ensureRunning has always resolved). */
  private boundPort(): number {
    return this.bound?.transport.port ?? 0;
  }

  /**
   * Launch Chrome if needed and resolve its CDP port. Singleflight: parallel
   * first calls share one launch. A dead child relaunches here on demand.
   */
  async ensureRunning(): Promise<number> {
    this.assertOpen();
    const port = await this.ensureRunningOnce();
    // The endpoint gate: whatever the path awaited, a quit that began meanwhile
    // wins over handing out its port.
    this.assertOpen();
    return port;
  }

  /**
   * The shutdown gate. dispose() closes it for good; every async path that
   * could start, adopt or hand out a Chrome passes it after its last await, so
   * a call already in flight when the quit began cannot outlive it.
   */
  private assertOpen(): void {
    if (this.disposed) throw new Error('ChromeLauncher: disposed (app is quitting)');
  }

  private async ensureRunningOnce(): Promise<number> {
    if (this.protectionLost) {
      const cause = this.protectionLost;
      this.protectionLost = null;
      throw protectionNotReady(cause);
    }
    const wanted = this.wantedProtection();
    if (!wanted && !this.launchedProtected) {
      // A launch in flight has published its port before it is done (restored
      // tabs are still being closed); callers join it rather than race it.
      if (this.isRunning() && !this.launching) {
        // Cheap liveness check — the process object survives a crash until the
        // exit handler runs; /json/version is the truth.
        const startedAt = Date.now();
        try {
          await this.reach().ping();
          this.pingMisses.count = 0;
          return this.boundPort();
        } catch {
          if (!this.livenessFailed(startedAt)) throw new Error('ChromeLauncher: Chrome is not answering');
        }
      }
    } else if (this.isRunning() && !this.launching) {
      // Protection changed under a running Chrome: it cannot be re-routed in
      // place, so it is restarted under (or out from under) the proxy.
      if (!!wanted !== this.launchedProtected || (wanted && !this.proxy?.isRunning())) {
        await this.stopForProtectionChange();
      } else {
        let alive = true;
        const startedAt = Date.now();
        try {
          await this.reach().ping();
          this.pingMisses.count = 0;
        } catch {
          alive = false;
          if (!this.livenessFailed(startedAt)) throw new Error('ChromeLauncher: Chrome is not answering');
        }
        if (alive) {
          // Re-armed if its socket dropped; a guard that cannot be re-armed
          // refuses the call rather than hand out an unguarded profile.
          await this.armDownloadGuard();
          return this.boundPort();
        }
      }
    }
    if (!this.launching) {
      this.launching = this.launch().finally(() => {
        this.launching = null;
      });
    }
    if (!this.protection) return this.launching;
    const port = await this.launching;
    // A launch already in flight when protection changed was started under the
    // old terms; it is never handed out under the new ones.
    if (!!this.wantedProtection() !== this.launchedProtected) {
      await this.stopForProtectionChange();
      return this.ensureRunningOnce();
    }
    return port;
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
  private readPortFile(): { raw: string; port: number; browserPath: string | null } | null {
    let raw: string;
    try {
      raw = readFileSync(join(this.userDataDir, 'DevToolsActivePort'), 'utf8');
    } catch {
      return null;
    }
    const port = parseInt(raw.split('\n')[0]?.trim() ?? '', 10);
    if (Number.isNaN(port) || port <= 0 || port > 65535) return null;
    return { raw, port, browserPath: recordedBrowserPath(raw) };
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
      const candidate = this.bindEndpoint(portTransport(port));
      try {
        // A port named only by the file must answer as the Chrome that wrote
        // it: the port may be another browser's by now, or not a browser's at
        // all, and either is nothing to adopt. That one answer is the probe.
        // A pinned port is the user's own choice: any answer will do.
        if (file && port === file.port && port !== pinned) {
          // Rejects when nothing answers (or not with a 2xx), as ping() would.
          // Bounded so a port that takes the connection and never answers
          // cannot hold the launch; as long as a starting Chrome is given.
          const endpoint = await candidate.browserEndpoint(AbortSignal.timeout(CHROME_START_CEILING_MS)).catch((err: unknown) => {
            const status = /→ HTTP (\d+)/.exec(err instanceof Error ? err.message : '')?.[1];
            if (status) throw new NotTheRecordedBrowser(`it answers HTTP ${status}`);
            throw err;
          });
          this.assertOpen(); // a quit while it was asked
          if (!isRecordedBrowser(file.browserPath, endpoint)) {
            throw new NotTheRecordedBrowser(
              file.browserPath === null ? 'the port file records no browser' : endpoint !== null ? 'another browser' : 'no browser endpoint',
            );
          }
        } else {
          await candidate.ping();
        }
        this.markReady(candidate);
        this.assertOpen();
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
        this.assertOpen();
        this.recordsSettled = true;
        return port;
      } catch (err) {
        this.unbindEndpoint();
        if (this.disposed) throw err;
        if (err instanceof NotTheRecordedBrowser) {
          console.warn(`[ChromeLauncher] the recorded DevTools port answers, but not as the browser that recorded it (${err.why}); starting a new one`);
        }
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
      const live = (await this.reach().listTargets()) as Array<{ id: string; type: string }>;
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

  /**
   * Re-route the profile's protection: stop the running Chrome (ours or an
   * adopted one) and wait for its endpoint to go away. A Chrome that will not
   * stop leaves enforcement not ready, which refuses the call.
   */
  async stopForProtectionChange(): Promise<void> {
    const child = this.child;
    const transport = this.bound?.transport ?? null;
    // Our own Chrome quits through Browser.close first, so the restart keeps
    // what an ordinary quit keeps (closeGracefully); a signal is the fallback.
    if (child && !(transport && (await this.closeGracefully(transport, child)))) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    } else if (!child && transport) {
      await this.closeBrowserAt(transport);
    }
    if (transport && !(await this.waitEndpointGone(transport)) && !(await this.forceKill(transport, child))) {
      throw notReadyAt(this.profileName, 'stop-previous', 'the previous Chrome did not exit');
    }
    this.onChildGone();
  }

  /**
   * Last resort for a Chrome that will not stop: kill the browser process
   * outright (ours by handle, an adopted one by the pid it reports), so it
   * cannot keep running under the terms it was started with.
   */
  private async forceKill(transport: ChromeTransport, child: ChildProcess | null, browserPath?: string): Promise<boolean> {
    try {
      if (child) {
        child.kill('SIGKILL');
      } else {
        const url = await transport.browserEndpointIgnoringStatus();
        // Only the browser it was asked about: the port may have changed hands since.
        if (url && (browserPath === undefined || browserPathOf(url) === browserPath)) {
          const socket = transport.connect(() => url, { label: 'ChromeLauncher force stop', timeoutMs: 3_000 });
          try {
            const info = (await socket.send('SystemInfo.getProcessInfo')) as {
              processInfo?: Array<{ type?: string; id?: number }>;
            };
            const pid = info?.processInfo?.find((p) => p.type === 'browser')?.id;
            if (typeof pid === 'number' && pid > 0) process.kill(pid, 'SIGKILL');
          } finally {
            socket.close();
          }
        }
      }
    } catch {
      /* fall through to the endpoint check */
    }
    return this.waitEndpointGone(transport);
  }

  /** Apply a protection change now rather than at the next call (policy edits). */
  async reconcileProtection(): Promise<void> {
    // Open tunnels first: a policy edit applies to connections already made.
    this.proxy?.revalidate();
    if (this.launching) await this.launching.catch(() => undefined);
    if (!this.isRunning() || this.disposed) return;
    const wanted = this.wantedProtection();
    if (!!wanted === this.launchedProtected) return;
    await this.stopForProtectionChange();
  }

  /** Ask the Chrome at `transport` to quit. false when nothing there could be asked. */
  private async closeBrowserAt(
    transport: ChromeTransport,
    current: () => boolean = () => true,
    known?: string,
  ): Promise<boolean> {
    try {
      const url = known ?? await transport.browserEndpointIgnoringStatus();
      if (!url || !current()) return false;
      const socket = transport.connect(() => url, { label: 'ChromeLauncher evict', timeoutMs: 3_000 });
      await socket.send('Browser.close').catch(() => undefined);
      socket.close();
      return true;
    } catch {
      return false; // nothing answering there
    }
  }

  /**
   * Quit a Chrome wmux launched the way its own Quit does: CDP Browser.close.
   * Chrome then shuts down in order, writing out its cookie store and
   * recording a clean exit. A signal ends it as `SessionEnded` instead, and
   * cookie writes still pending in memory are lost with it. Its tabs are
   * closed first, so the session it saves restores nothing but a blank tab.
   * True when the process exited by `deadline` (QUIT_GRACE_MS from now unless
   * the caller shares one deadline across several Chromes).
   */
  private async closeGracefully(
    transport: ChromeTransport,
    child: ChildProcess,
    deadline = Date.now() + QUIT_GRACE_MS,
  ): Promise<boolean> {
    const exited = waitForExit(child, Math.max(0, deadline - Date.now()));
    // Once the bound is up the port may already belong to a newer Chrome (a
    // pinned port is reused): the rest of the ask is cancelled, in flight or not.
    const expiry = new AbortController();
    const stop = expiry.signal;
    const ask = async () => {
      try {
        const list = await transport.listTargets(boundedBy(stop));
        if (Array.isArray(list) && !stop.aborted) {
          const { closed } = await this.closeToStartupTab(
            transport,
            list as Array<{ id: string; url: string; type: string }>,
            stop,
          );
          // `/json/close` only starts a close; a tab still closing when the
          // quit lands stays in the saved session.
          await this.waitTargetsGone(transport, closed, stop);
        }
      } catch {
        /* nothing listed; the quit itself still keeps the cookies */
      }
      return !stop.aborted && this.closeBrowserAt(transport, () => !stop.aborted);
    };
    // The bound covers the ask too: a wedged endpoint must not hold a quit.
    const asked = await Promise.race([ask(), exited]);
    expiry.abort();
    return asked ? exited : hasExited(child);
  }

  /**
   * `--restore-last-session` brings the previous session's tabs back with its
   * cookies. wmux's own quits leave only a blank tab to restore
   * (closeGracefully), but a Chrome closed any other way leaves its pages. A
   * real launch has just dropped every record, so those tabs belong to no
   * surface and no agent could see or close them: close them before any
   * surface opens, keeping the single startup tab a launch without restore
   * shows (closing a window's last tab quits Chrome on Windows and Linux).
   * Restore can finish after the endpoint first answers, so the list is read
   * until it holds still.
   */
  private async closeRestoredTabs(): Promise<boolean> {
    const transport = this.reach();
    const deadline = Date.now() + RESTORE_SETTLE_MS;
    let pages: Array<{ id: string; url: string }> = [];
    let previous = '';
    for (;;) {
      try {
        const list = await transport.listTargets(AbortSignal.timeout(RESTORE_SETTLE_MS));
        if (!Array.isArray(list)) return false;
        pages = (list as Array<{ id: string; url: string; type: string }>).filter((t) => t.type === 'page');
      } catch {
        return false; // no list: what is open is unknown
      }
      const ids = pages.map((p) => p.id).sort().join(',');
      if ((pages.length > 0 && ids === previous) || Date.now() > deadline) break;
      previous = ids;
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    const { closed, complete } = await this.closeToStartupTab(transport, pages);
    return complete && (await this.waitTargetsGone(transport, closed));
  }

  /**
   * Close every page but a startup tab. A blank tab is opened first when
   * nothing else would be left; without one, a page stays rather than the
   * close quitting Chrome. Each request has its own bound, so a wedged
   * endpoint cannot hold a launch or a quit.
   */
  private async closeToStartupTab(
    transport: ChromeTransport,
    targets: Array<{ id: string; url: string; type?: string }>,
    stop?: AbortSignal,
  ): Promise<{ closed: string[]; complete: boolean }> {
    const pages = targets.filter((t) => t.type === undefined || t.type === 'page');
    const others = pages.filter((p) => !isStartupTabUrl(p.url));
    if (others.length === 0) return { closed: [], complete: true };
    const keptOpen =
      others.length < pages.length ||
      (await transport.createTarget(undefined, boundedBy(stop)).then(
        (t) => typeof (t as { id?: unknown } | null)?.id === 'string',
        () => false,
      ));
    if (stop?.aborted) return { closed: [], complete: false };
    const closing = keptOpen ? others : others.slice(1);
    await Promise.all(
      closing.map((p) => transport.closeTarget(p.id, boundedBy(stop)).catch(() => undefined)),
    );
    return { closed: closing.map((p) => p.id), complete: keptOpen };
  }

  /** Wait (bounded) until none of `ids` is listed any more; false if one still is. */
  private async waitTargetsGone(transport: ChromeTransport, ids: string[], stop?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + RESTORE_SETTLE_MS;
    for (;;) {
      if (ids.length === 0) return true;
      if (stop?.aborted) return false;
      try {
        const list = await transport.listTargets(boundedBy(stop));
        if (Array.isArray(list) && !list.some((t: { id?: string }) => t.id !== undefined && ids.includes(t.id))) {
          return true;
        }
      } catch {
        /* unanswered: not confirmed */
      }
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async waitEndpointGone(transport: ChromeTransport): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await transport.answers())) return true;
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    return false;
  }

  /**
   * A protected profile never adopts a Chrome it did not launch under its
   * proxy: whatever still answers on the profile's recorded endpoint is closed
   * first, and the launch waits for it to be gone.
   */
  private async evictExisting(): Promise<boolean> {
    const file = this.readPortFile();
    if (!file) return true;
    const previous = portTransport(file.port);
    if (!(await previous.answers())) return true; // stale file, nothing running
    // The file can outlive its Chrome, and the port can be another browser's
    // by now: only the one that wrote the file is asked to quit (or killed),
    // known by the browser path on the file's second line.
    const endpoint = await previous.browserEndpointIgnoringStatus();
    const recorded = recordedBrowserPath(file.raw);
    // Whatever answers there without naming the recorded browser (another
    // browser, or any other server that took the port) is not ours to stop;
    // waiting on it would hold every launch on this profile.
    if (!endpoint || !recorded || browserPathOf(endpoint) !== recorded) {
      console.warn('[ChromeLauncher] the recorded DevTools port answers for another browser; leaving it running');
      return true;
    }
    await this.closeBrowserAt(previous, () => true, endpoint);
    return (await this.waitEndpointGone(previous)) || this.forceKill(previous, null, recorded);
  }

  /**
   * A protected Chrome on the pipe wrote a DevToolsActivePort: a debugging port
   * is open in it. It is stopped, and the next call is told why.
   */
  private closeForOpenPort(): void {
    this.protectionLost = 'a debugging port opened in the protected browser, so it was closed';
    console.warn(`[ChromeLauncher] ${this.protectionLost}`);
    this.dropUnresponsive();
    this.forgetPortFile();
  }

  /** Drop the profile's DevToolsActivePort: a Chrome on a pipe writes none, so it could only name a Chrome gone by now. */
  private forgetPortFile(): void {
    try {
      unlinkSync(join(this.userDataDir, 'DevToolsActivePort'));
    } catch { /* none */ }
  }

  private async ensureProxy(plan: ChromeProtectionPlan): Promise<number> {
    this.assertOpen();
    if (!this.proxy) {
      // The proxy reads the CURRENT plan per request, so a policy edit applies
      // on the next request without a restart.
      const denyAll = { matcher: () => ({ allows: () => false }) };
      this.proxy = new ProtectedProxy({
        matcher: () => ((this.enforcementReady && this.wantedProtection()) || denyAll).matcher(),
        ...(plan.resolve && { resolve: plan.resolve }),
        ...(plan.onDecision && { onDecision: plan.onDecision }),
        // A refusal before enforcement is ready says nothing about the policy.
        onBlocked: (host, port) => {
          if (this.enforcementReady) this.blocked.record(host, port);
        },
      });
    }
    const proxy = this.proxy;
    let port: number;
    try {
      port = await proxy.start();
    } catch (err) {
      throw notReadyAt(this.profileName, 'proxy-start', err);
    }
    if (this.disposed) {
      // dispose() closed it before it was listening; close what start opened.
      proxy.close();
      if (this.proxy === proxy) this.proxy = null;
      this.assertOpen();
    }
    return port;
  }

  /**
   * Keep downloads denied on a protected profile. Playwright's connectOverCDP
   * sets `Browser.setDownloadBehavior: allowAndName` on the default context
   * every time it attaches, which overrides any deny set before it. So main
   * holds its own browser session with download events on: every download that
   * begins is cancelled at once and the deny re-asserted. Measured against
   * Chrome 155 with Playwright attached: the download ends `canceled`.
   *
   * A cancel can lose the race to a small file, and Chrome resets the behaviour
   * to its default whenever any client that set it detaches. So the guard also
   * re-asserts deny every DOWNLOAD_DENY_REASSERT_MS: another client's allow
   * lasts at most one tick, and a download that starts after it is refused
   * outright.
   *
   * Each browser context keeps its own behaviour, and download events go to
   * the session that enabled them. So on the same tick the guard's own session
   * lists the contexts a client created (Target.getBrowserContexts, which
   * sees one before it has a page) and denies each with events on. Best
   * effort: a download in a context created since the last tick is not
   * covered until the next one. On the pipe, a protected profile's policy
   * denies a client's new context before the client hears of it
   * (ProtectedPipePolicy).
   */
  private armDownloadGuard(): Promise<void> {
    if (this.downloadGuard?.isOpen()) return Promise.resolve();
    this.guardArming ??= this.armDownloadGuardOnce().finally(() => {
      this.guardArming = null;
    });
    return this.guardArming;
  }

  private async armDownloadGuardOnce(): Promise<void> {
    this.downloadGuard?.close();
    this.downloadGuard = null;
    const transport = this.reach();
    const url = await this.browserWsUrl(transport);
    const guard = transport.connect(() => url, {
      label: 'ChromeLauncher download guard',
      onDisconnect: () => {
        if (this.downloadGuard === guard) this.downloadGuard = null;
        this.dropConsentClaims();
      },
    });
    const deny = () => guard.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    /** Every browser context the guard has seen: listed on its tick, or named by a new target. */
    const contexts = new Set<string>();
    const listContexts = async (): Promise<string[]> => {
      const listed = (await guard.send('Target.getBrowserContexts')) as { browserContextIds?: unknown } | null;
      const ids = Array.isArray(listed?.browserContextIds) ? listed.browserContextIds.filter((id): id is string => typeof id === 'string') : [];
      for (const id of ids) contexts.add(id);
      return ids;
    };
    const denyContexts = async () => {
      const ids = await listContexts();
      await Promise.all(ids.map((browserContextId) =>
        guard.send('Browser.setDownloadBehavior', contextDeny(browserContextId)).catch(() => undefined)));
    };
    /**
     * Browser.cancelDownload looks for the guid in one context only (the
     * default one when none is named), and downloadWillBegin doesn't say which:
     * the cancel goes at once to the default context and to every context the
     * guard knows, then to any the list adds.
     */
    const cancelEverywhere = async (guid: string) => {
      const sent = new Set(contexts);
      void guard.send('Browser.cancelDownload', { guid }).catch(() => undefined);
      for (const browserContextId of sent) void guard.send('Browser.cancelDownload', { guid, browserContextId }).catch(() => undefined);
      const ids = await listContexts().catch(() => [] as string[]);
      await Promise.all(ids.filter((id) => !sent.has(id)).map((browserContextId) =>
        guard.send('Browser.cancelDownload', { guid, browserContextId }).catch(() => undefined)));
    };
    // A context is denied the moment a target in it appears, not on the next tick.
    guard.on('Target.targetCreated', (params) => {
      const info = params.targetInfo as { browserContextId?: unknown } | undefined;
      const id = info?.browserContextId;
      if (typeof id !== 'string' || contexts.has(id)) return;
      contexts.add(id);
      void guard.send('Browser.setDownloadBehavior', contextDeny(id)).catch(() => undefined);
    });
    guard.on('Browser.downloadWillBegin', (params) => {
      this.piped?.policy?.downloadEvent('Browser.downloadWillBegin', params);
      const guid = typeof params.guid === 'string' ? params.guid : '';
      // An operator-approved download (consent): its claimant re-denies itself.
      const claimant = this.downloadClaimant;
      if (guid && claimant?.(params) === true) return;
      if (guid) void cancelEverywhere(guid).catch(() => undefined);
      // While a claimant holds the guard it owns the behaviour (and restores
      // deny when it lets go); a stray download is cancelled by guid alone, so
      // it cannot close the window the operator approved.
      if (!claimant) {
        void deny().catch(() => undefined);
        void denyContexts().catch(() => undefined);
      }
    });
    guard.on('Browser.downloadProgress', (params) => {
      this.piped?.policy?.downloadEvent('Browser.downloadProgress', params);
      for (const listener of this.downloadProgress) listener(params);
    });
    try {
      await deny();
    } catch (err) {
      guard.close();
      throw notReadyAt(this.profileName, 'download-guard-deny', err);
    }
    try {
      await guard.send('Target.setDiscoverTargets', { discover: true });
    } catch (err) {
      // Discovery here only denies a new context before the next tick. On the
      // pipe the URL gate learns targets from the mux's own discovery session,
      // and this session's events reach it too: the start goes on only while
      // that session is up now (not yet up counts as down). On the port there
      // is no gate.
      const mux = this.piped?.mux;
      if (mux && !mux.discoveryLive()) {
        guard.close();
        throw notReadyAt(this.profileName, 'download-guard-discovery', err);
      }
      const why = err instanceof Error ? err.message : String(err);
      console.warn(`[ChromeLauncher] ${this.profileName}: protected start continues without download-guard-discovery: ${why}`);
    }
    const reassert = setInterval(() => {
      if (!guard.isOpen()) return clearInterval(reassert);
      // An operator-approved download pass owns the behaviour while it holds
      // the guard (and restores deny itself): the tick re-asserts the pass's
      // own, so another connection can't hold it away. Every other download
      // is still cancelled by guid in the meantime.
      if (this.downloadClaimant) {
        void this.downloadClaimReassert?.().catch(() => undefined);
        return;
      }
      void deny().catch(() => undefined);
      void denyContexts().catch(() => undefined);
    }, DOWNLOAD_DENY_REASSERT_MS);
    // A protected Chrome on the pipe writes no DevToolsActivePort: one that
    // appears means a debugging port opened in it. Checked on the same tick.
    if (this.piped) {
      const watch = setInterval(() => {
        if (!guard.isOpen() || !this.piped || !this.launchedProtected) return clearInterval(watch);
        if (this.readPortFile() === null) return;
        clearInterval(watch);
        this.closeForOpenPort();
      }, DOWNLOAD_DENY_REASSERT_MS);
      watch.unref?.();
    }
    reassert.unref?.();
    this.downloadGuard = guard;
  }

  /**
   * A protected profile's rules for its pipe's clients. A context a client
   * creates is denied on the download guard's own session, so the deny and the
   * download events stay with the guard after the client leaves. One the guard
   * can't deny is closed over the pipe itself instead of handed out.
   */
  private protectedPipePolicy(mux: () => CdpPipeMux | null): ProtectedPipePolicy {
    const onGuard = (method: string, params: Record<string, unknown>) => {
      const guard = this.downloadGuard;
      return guard?.isOpen() ? guard.send(method, params) : Promise.reject(new Error(PROTECTION_NOT_READY));
    };
    return new ProtectedPipePolicy({
      denyContext: (browserContextId) => onGuard('Browser.setDownloadBehavior', contextDeny(browserContextId)),
      disposeContext: (browserContextId) =>
        mux()?.command('Target.disposeBrowserContext', { browserContextId }) ?? Promise.reject(new Error(PROTECTION_NOT_READY)),
      contextOf: (client, frameId) => mux()?.contextOfFrame(client, frameId),
      emit: (client, method, params, sessionId) => mux()?.emitEvent(client, method, params, sessionId) ?? false,
    });
  }

  /**
   * With grants on an unprotected profile (C3b): main's own folder and rules
   * for the downloads of the shared default context. Main's session holds the
   * behaviour (armDownloadRelay); each client's own setting is recorded, not
   * forwarded.
   */
  private downloadRelay(mux: () => CdpPipeMux | null, dir: string): DownloadRelay {
    const holder: { session: CdpConnection | null; ready: Promise<void> } = { session: null, ready: Promise.resolve() };
    const downloadsDir = this.downloadsDir;
    const policy = new DownloadRelayPolicy({
      dir,
      contextOf: (client, frameId) => mux()?.contextOfFrame(client, frameId),
      created: (client, contextId) => mux()?.createdContext(client, contextId) ?? false,
      contextOfSession: (client, sessionId) => mux()?.contextOfSession(client, sessionId),
      emit: (client, method, params, sessionId) => mux()?.emitEvent(client, method, params, sessionId) ?? false,
      cancel: (guid) => holder.session?.send('Browser.cancelDownload', { guid }) ?? Promise.resolve(),
      ...(downloadsDir && { userDir: downloadsDir }),
    });
    return Object.assign(holder, { policy, dir });
  }

  /** Main's session on the pipe that holds the default context's downloads, events on. */
  private async armDownloadRelay(mux: CdpPipeMux, relay: DownloadRelay): Promise<void> {
    // Sent at spawn, so its first command waits out the same cold start the launch does.
    const session = mux.connect({ label: 'ChromeLauncher download relay', timeoutMs: READY_STARTING_MS });
    relay.session = session;
    session.on('Browser.downloadWillBegin', (params) => relay.policy.downloadEvent('Browser.downloadWillBegin', params));
    session.on('Browser.downloadProgress', (params) => relay.policy.downloadEvent('Browser.downloadProgress', params));
    await session.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: relay.dir, eventsEnabled: true });
  }

  /** The browser-level CDP endpoint `transport` names; not-ready when absent. */
  private async browserWsUrl(transport: ChromeTransport): Promise<string> {
    let endpoint: string | null;
    try {
      endpoint = await transport.browserEndpoint();
    } catch {
      endpoint = null;
    }
    if (endpoint === null) throw notReadyAt(this.profileName, 'browser-endpoint', 'no browser endpoint answered');
    return endpoint;
  }

  /**
   * Prove the fresh Chrome's traffic reaches the proxy: open a background tab
   * on a URL only the proxy answers. A managed proxy policy or a proxy
   * extension in the profile overrides `--proxy-server`; such a Chrome never
   * asks the proxy, and is not handed out as protected.
   *
   * The answer comes from what Chrome DID, not from a clock: the proxy saw the
   * probe (routed), or Chrome finished the probe tab's navigation some other
   * way — an error page, because `.invalid` never resolves without the proxy —
   * or lost the tab (not routed). A fixed few-second wait used to decide "not
   * routed" while a cold Chrome (a fresh profile on a busy Windows runner) had
   * not even issued the request yet, refusing a correctly routed browser.
   * `deadlineMs` (the launch's own deadline) only bounds a Chrome that never
   * reports anything.
   */
  private async verifyProxyRoute(deadlineMs: number): Promise<void> {
    const proxy = this.proxy;
    if (!proxy?.isRunning()) throw notReadyAt(this.profileName, 'route-check', 'the proxy is not running');
    const probe = proxy.armProbe();
    const transport = this.reach();
    const url = await this.browserWsUrl(transport);
    const socket = transport.connect(() => url, { label: 'ChromeLauncher proxy probe', timeoutMs: Math.max(1, deadlineMs - Date.now()) });
    let targetId: string | undefined;
    let settle: ((why: ProbeOutcome) => void) | null = null;
    const outcome = new Promise<ProbeOutcome>((resolve) => { settle = resolve; });
    const unsubscribe = [
      socket.on('Target.targetInfoChanged', (params) => {
        const info = params.targetInfo as { targetId?: unknown; url?: unknown } | undefined;
        if (targetId && info?.targetId === targetId && typeof info.url === 'string' && info.url.startsWith('chrome-error:')) {
          settle?.('navigation-failed');
        }
      }),
      socket.on('Target.targetDestroyed', (params) => {
        if (targetId && params.targetId === targetId) settle?.('tab-gone');
      }),
      socket.on('Target.targetCrashed', (params) => {
        if (targetId && params.targetId === targetId) settle?.('tab-gone');
      }),
    ];
    let why: ProbeOutcome = 'no-answer';
    try {
      await socket.send('Target.setDiscoverTargets', { discover: true });
      const created = (await socket.send('Target.createTarget', { url: probe.url, background: true })) as {
        targetId?: unknown;
      } | null;
      targetId = typeof created?.targetId === 'string' ? created.targetId : undefined;
      if (!targetId) why = 'no-tab';
      else {
        // An explicit override wins (tests); otherwise wait for Chrome to say.
        const budget = this.proxyProbeTimeoutMs ?? Math.max(0, deadlineMs - Date.now());
        why = await Promise.race([probe.seen(budget).then((seen) => (seen ? 'routed' : 'no-answer') as ProbeOutcome), outcome]);
        // A failed navigation can be reported a beat before the proxy's own
        // accounting; a probe the proxy did see is still routed.
        if (why !== 'routed' && (await probe.seen(0))) why = 'routed';
      }
    } catch {
      why = 'cdp-error';
    } finally {
      for (const off of unsubscribe) off();
      probe.dispose();
      if (targetId) await socket.send('Target.closeTarget', { targetId }).catch(() => undefined);
      socket.close();
    }
    if (why !== 'routed') {
      throw notReadyAt(this.profileName, 'route-check', `proxy route not proven (${why})`);
    }
  }

  /** The guard went away: an approved download cannot be watched or re-denied
   *  through it, so every pass holding it fails now. */
  private dropConsentClaims(): void {
    this.downloadClaimant = null;
    this.downloadClaimReassert = null;
    const listeners = [...this.downloadGuardClosed];
    this.downloadGuardClosed.clear();
    for (const l of listeners) {
      try {
        l();
      } catch { /* a listener must not break teardown */ }
    }
  }

  /** The armed download guard of a protected instance, for the consent
   *  service; null when this profile is not running protected. */
  consentDownloadGuard(): ConsentDownloadGuard | null {
    if (!this.launchedProtected || !this.downloadGuard?.isOpen()) return null;
    return {
      send: (method, params) => {
        const guard = this.downloadGuard;
        if (!guard?.isOpen()) return Promise.reject(new Error(PROTECTION_NOT_READY));
        return guard.send(method, params);
      },
      claim: (claimant, reassert) => {
        if (this.downloadClaimant) return null;
        this.downloadClaimant = claimant;
        this.downloadClaimReassert = reassert ?? null;
        return () => {
          if (this.downloadClaimant !== claimant) return;
          this.downloadClaimant = null;
          this.downloadClaimReassert = null;
        };
      },
      onProgress: (listener) => {
        this.downloadProgress.add(listener);
        return () => this.downloadProgress.delete(listener);
      },
      onClose: (listener) => {
        this.downloadGuardClosed.add(listener);
        return () => this.downloadGuardClosed.delete(listener);
      },
    };
  }

  private async launch(): Promise<number> {
    this.assertOpen();
    const plan = this.wantedProtection();
    // A fresh Chrome starts with a fresh list: what the last one was refused
    // is not what this one will ask for.
    this.blocked.clear();
    const transport = transportFor(plan, this.protectedPortAllowed?.() ?? false);
    const pipe = transport.kind === 'pipe';
    if (transport.weaker) {
      console.warn('[ChromeLauncher] a protected profile starts on the DevTools port (the protected-port setting is on): a client of the port reaches it without the pipe\'s rules');
    } else if (plan && process.env.WMUX_CHROME_TRANSPORT === 'port') {
      console.warn('[ChromeLauncher] WMUX_CHROME_TRANSPORT=port does not apply to a protected profile without the protected-port setting; it starts on the pipe');
    }
    this.transport = transport;
    // A Chrome let go still holds the profile until it exits: wait for it, bounded.
    if (this.exiting) {
      const { child, exited } = this.exiting;
      if (!(await exited) && !hasExited(child)) {
        try {
          child.kill('SIGKILL');
        } catch { /* already gone */ }
        if (!(await waitForExit(child, PIPE_KILL_WAIT_MS))) throw new Error('ChromeLauncher: the previous Chrome on this profile has not exited');
      }
      if (this.exiting?.child === child) this.exiting = null;
    }
    if (plan) {
      if (!(await this.evictExisting())) throw protectionNotReady('a Chrome still running on this profile did not stop');
    } else {
      // Protection is off: the previous instance's proxy has nothing to serve.
      this.proxy?.close();
      this.proxy = null;
      // A Chrome on a pipe can't be adopted (it exits with the process that
      // holds the pipe), and one still running on this profile would take the
      // new start over: it is closed instead, as for a protected profile.
      if (pipe) {
        if (!(await this.evictExisting())) throw new Error('ChromeLauncher: the Chrome still running on this profile did not stop');
      } else {
        const adopted = await this.adoptExisting();
        if (adopted !== null) return adopted;
      }
    }
    // Once on a pipe, the recorded port could only lead to whatever took it since.
    if (pipe) this.forgetPortFile();
    if (plan) {
      try {
        clearRemoteDebuggingToggle(this.userDataDir);
      } catch (err) {
        throw protectionNotReady(`the profile's remote debugging setting could not be turned off: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const binary = discoverChromeBinary();
    if (!binary) {
      throw new Error(
        'CHROME_BACKEND_NO_BINARY: no Chrome/Chromium/Edge installation found. ' +
          'Install Google Chrome or set WMUX_CHROME_PATH to a browser binary.',
      );
    }

    const pinned = pipe ? null : this.pinnedPort();
    // Port 0 (the normal path): Chrome picks an ephemeral port and records it
    // in DevToolsActivePort. The file may still hold the PREVIOUS instance's
    // endpoint (already probed dead by adoptExisting above) — snapshot it so
    // the fresh write is recognized by content, not mere existence.
    const stale = !pipe && pinned === null ? this.readPortFile() : null;

    if (this.profileLabel) seedChromeProfileLabel(this.userDataDir, this.profileLabel);

    const protectedArgs = plan ? protectedChromeArgs(await this.ensureProxy(plan)) : [];
    // After the last await before the spawn (adoption, eviction, the proxy):
    // a Chrome started now would be one dispose() never saw.
    this.assertOpen();
    // C3b: with grants, an unprotected profile's default-context downloads go
    // through main (DownloadRelayPolicy); a protected one's are denied (policy).
    // Its folder is made first: one that cannot be made stops the launch here.
    const relayDir = pipe && !plan && cdpTargetGrantEnabled() ? makeDownloadRelayDir() : null;
    const child = spawn(
      binary,
      mergeDisableFeatures([
        `--user-data-dir=${this.userDataDir}`,
        ...(pipe
          ? ['--remote-debugging-pipe']
          : [
            `--remote-debugging-port=${pinned ?? 0}`,
            // connectOverCDP's websocket handshake (Chrome 111+ origin check).
            '--remote-allow-origins=*',
          ]),
        // `--remote-debugging-port` alone flips `navigator.webdriver` to true on
        // every page, even with no client attached; this restores its normal value.
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        // Chrome drops cookies without an expiry (sign-ins without "stay signed
        // in") on every start that neither restores the last session nor
        // follows a crash. The flag is the startup choice "continue where you
        // left off", passed per launch rather than written into Preferences.
        // The tabs it brings back are closed below (closeRestoredTabs).
        '--restore-last-session',
        ...protectedArgs,
        // Edge: no implicit sign-in to the user's account, no sync.
        ...edgeArgs(binary),
        // A protected Chrome on the pipe opens no port, whatever else asks for one.
        ...(pipe && plan ? this.extraArgs.filter((arg) => !PORT_FLAG.test(arg)) : this.extraArgs),
      ]),
      // The pipe: Chrome reads fd 3 and writes fd 4. stderr is read so a
      // failed start can quote Chrome (STARTUP_STDERR_TAIL).
      {
        stdio: pipe ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
      },
    );
    // Drained for the child's whole life (a full pipe would block Chrome's
    // logging); only the newest STARTUP_STDERR_TAIL characters are kept.
    let stderrTail = '';
    const stderr = child.stderr;
    // 'exit' can come before the last of stderr: a failed start waits, bounded, for its end.
    const stderrEnded = stderr
      ? new Promise<void>((resolve) => {
        stderr.once('end', resolve);
        stderr.once('close', resolve);
      })
      : Promise.resolve();
    if (stderr) {
      stderr.setEncoding('utf8'); // a character split across reads stays whole
      stderr.on('data', (text: string) => {
        const joined = stderrTail + text;
        if (joined.length <= STARTUP_STDERR_TAIL) {
          stderrTail = joined;
          return;
        }
        // Over the cap: keep the newest whole lines only. A cut line could hold
        // half a home path that maskHomes would no longer recognise.
        const cut = joined.slice(-STARTUP_STDERR_TAIL);
        const nl = cut.indexOf('\n');
        stderrTail = nl === -1 ? '' : cut.slice(nl + 1);
      });
      // A broken stderr pipe is never a reason to fail; unhandled, it would throw.
      stderr.on('error', () => undefined);
    }
    /** The last probe that failed: what a start that ran out of time ran into. */
    let lastStartError: string | null = null;
    /**
     * Why a start failed: what Chrome said on stderr, and the last probe error
     * on a timeout, or on an exit Chrome said nothing about.
     */
    const startFailure = async (what: string, timedOut: boolean): Promise<Error> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([stderrEnded, new Promise((r) => { timer = setTimeout(r, STDERR_END_WAIT_MS); })]);
      clearTimeout(timer);
      const homes = [homedir(), process.env.USERPROFILE, process.env.HOME];
      const said = chromeSaid(stderrTail, homes.filter((h): h is string => !!h));
      const withProbe = timedOut || !said;
      const detail = [withProbe && lastStartError && `last error: ${lastStartError}`, said && `Chrome said: ${said}`].filter(Boolean).join('; ');
      return new Error(detail ? `ChromeLauncher: ${what} (${detail})` : `ChromeLauncher: ${what}`);
    };

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
    // The pipe ends with the process; one that breaks first ends it too.
    let mux: CdpPipeMux | null = null;
    const policy = pipe && plan ? this.protectedPipePolicy(() => mux) : null;
    const relay = relayDir !== null ? this.downloadRelay(() => mux, relayDir) : null;
    const muxGrants = cdpTargetGrantEnabled();
    mux = pipe
      ? new CdpPipeMux(child.stdio[3] as Writable, child.stdio[4] as Readable, {
        onClose: () => {
          if (this.child !== child) return;
          try {
            child.kill();
          } catch { /* already gone */ }
        },
        ...(policy && {
          filter: policy.filter,
          beforeReply: policy.beforeReply,
          onClientGone: (client: ClientRef) => policy.forget(client),
          // Outside clients see and drive only pages on the URLs a protected profile allows.
          urlGate: { allows: protectedUrlAllowed, handedOff: appLaunchUrl, refusal: SCHEME_NOT_ALLOWED },
        }),
        ...(relay && { filter: relay.policy.filter, onClientGone: (client: ClientRef) => relay.policy.forget(client) }),
        // C3b: each external client sees only its own targets, by this registry
        // and what it made itself. Main's own connections are never narrowed.
        ...(muxGrants && {
          grants: {
            registry: (targetId: string) => {
              const record = this.recordForTarget(targetId);
              if (!record) return null;
              return record.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {};
            },
          },
        }),
      })
      : null;
    this.piped = mux ? { mux, policy, relay, transport: pipeTransport(mux), route: null, bootstraps: new Set(), grants: muxGrants } : null;
    if (mux && relay) {
      relay.ready = this.armDownloadRelay(mux, relay);
      relay.ready.catch(() => undefined); // the launch below reports it
    }
    const piped = this.piped?.transport ?? null;

    // Resolve the port (pinned, or the fresh DevToolsActivePort write), then
    // poll /json/version until the endpoint answers. Past READY_TIMEOUT_MS a
    // Chrome that is still running is still starting: waited on, to a ceiling.
    const startedAt = Date.now();
    let toldStarting = false;
    /** A protected start on the pipe that failed: PROTECTION_NOT_READY with its cause, never a start on the port. */
    const protectedFailure = async (what: string, timedOut: boolean): Promise<Error> => {
      if (!(plan && pipe)) return startFailure(what, timedOut);
      if (!timedOut && handedOff(child, this.userDataDir)) return protectionNotReady(HANDED_OFF);
      return protectionNotReady((await startFailure(what, timedOut)).message.replace(/^ChromeLauncher: /, ''));
    };
    for (;;) {
      if (gone) throw await protectedFailure('Chrome exited during startup', false);
      let candidate = pinned;
      if (candidate === null && !piped) {
        const fresh = this.readPortFile();
        candidate = fresh && fresh.raw !== stale?.raw ? fresh.port : null;
      }
      const reachable = piped ?? (candidate !== null ? portTransport(candidate) : null);
      if (reachable) {
        const probe = this.bindEndpoint(reachable);
        try {
          await probe.ping();
          this.markReady(probe);
          // A REAL spawn (adoption already failed above) means this profile's
          // previous Chrome is gone and every tab it held with it. Neither
          // revival rule can hold, so the persisted records are dropped rather
          // than left to linger as permanently unbound handles.
          this.restored = true;
          this.recordsSettled = true;
          this.surfaces.clear();
          this.byTargetId.clear();
          this.byTabTargetId.clear();
          void this.surfaceStore?.dropProfile(this.profileName).catch(() => undefined);
          if (!plan) await this.closeRestoredTabs();
          if (relay) {
            try {
              await relay.ready;
            } catch (err) {
              console.warn('[ChromeLauncher] download relay not armed:', err instanceof Error ? err.message : String(err));
              try {
                child.kill();
              } catch { /* already gone */ }
              this.onChildGone();
              throw new Error(DOWNLOAD_RELAY_NOT_READY);
            }
          }
          if (plan) {
            // Enforcement readiness is part of the launch: no protected
            // surface is handed out before the download guard holds.
            this.launchedProtected = true;
            try {
              await this.armDownloadGuard();
              // Traffic opens only once no restored page is left to use it.
              if (!(await this.closeRestoredTabs())) throw notReadyAt(this.profileName, 'restored-tabs', 'a restored tab could not be closed');
              this.enforcementReady = true;
              // Its own bound from now: a slow start must not eat the probe's turn.
              await this.verifyProxyRoute(Date.now() + READY_TIMEOUT_MS);
            } catch (err) {
              try {
                child.kill();
              } catch { /* already gone */ }
              this.onChildGone();
              throw err;
            }
          }
          return candidate ?? 0;
        } catch (err) {
          // Enforcement that failed is final for this launch: the child is
          // already stopped, so polling on would only wait out the deadline.
          if (isProtectionNotReady(err) || (err instanceof Error && err.message === DOWNLOAD_RELAY_NOT_READY)) throw err;
          lastStartError = err instanceof Error ? err.message : String(err);
          this.unbindEndpoint();
        }
      }
      const waited = Date.now() - startedAt;
      if (waited > READY_TIMEOUT_MS && waited <= READY_STARTING_MS && !toldStarting) {
        toldStarting = true;
        console.warn(`[ChromeLauncher] Chrome is still starting after ${Math.round(waited / 1000)} s (a first start reads its install from disk); waiting up to ${READY_STARTING_MS / 1000} s`);
      }
      if (waited > READY_STARTING_MS) {
        // Kill the half-started child; a later demand may retry cleanly.
        try {
          child.kill();
        } catch { /* already gone */ }
        this.onChildGone();
        throw await protectedFailure('CDP endpoint did not become ready in time', true);
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }

  /**
   * A liveness check that started at `startedAt` failed. On the port the
   * Chrome is let go at once (a later launch adopts it if it still runs). On a
   * pipe only after PIPE_MISSES_BEFORE_STOP failed checks in a row, not
   * counting one that overlaps the last counted one or that spanned a sleep.
   * Returns whether it was let go.
   */
  private livenessFailed(startedAt: number): boolean {
    if (!this.piped) {
      this.onChildGone();
      return true;
    }
    const now = Date.now();
    const slept = now - startedAt > CDP_PIPE_COMMAND_TIMEOUT_MS + PIPE_SLEEP_SLACK_MS;
    if (!slept && startedAt >= this.pingMisses.lastEnd) {
      this.pingMisses.count++;
      this.pingMisses.lastEnd = now;
    }
    if (this.pingMisses.count < PIPE_MISSES_BEFORE_STOP) return false;
    this.dropUnresponsive();
    return true;
  }

  /**
   * The bound Chrome stopped answering: let it go. One on a pipe can't be found
   * again (it has no port to adopt), so it is stopped rather than left holding
   * the profile.
   */
  private dropUnresponsive(): void {
    const child = this.child;
    const piped = this.piped;
    this.onChildGone();
    if (!piped) return;
    piped.mux.close();
    if (!child || hasExited(child)) return;
    // SIGTERM first; a browser that does not act on it (hung, or stopped) gets SIGKILL.
    try {
      child.kill('SIGTERM');
    } catch { /* already gone */ }
    const exited = waitForExit(child, PIPE_KILL_GRACE_MS).then((gone) => {
      if (gone) return true;
      try {
        child.kill('SIGKILL');
      } catch { /* already gone */ }
      return waitForExit(child, PIPE_KILL_WAIT_MS);
    });
    this.exiting = { child, exited };
  }

  private onChildGone(): void {
    this.child = null;
    this.unbindEndpoint();
    this.pingMisses = { count: 0, lastEnd: 0 };
    const relay = this.piped?.relay;
    if (relay) {
      relay.session?.close();
      relay.policy.dispose();
      removeDownloadRelayDir(relay.dir);
    }
    // Its clients and unused tokens go with it.
    this.piped?.route?.close();
    this.piped = null;
    this.launchedProtected = false;
    this.enforcementReady = false;
    this.downloadGuard?.close();
    this.downloadGuard = null;
    this.dropConsentClaims();
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
    // Invalidate any startup still in flight: it is dialing a Chrome that no
    // longer exists, and handing its promise to the next launch would report
    // a start that never happened. Deliberately NOT inside closeWatcher() —
    // startTargetWatcher() calls that itself and must not self-invalidate.
    this.watcherStarting = null;
    // The tabs those limits counted died with this Chrome.
    this.adopted.clear();
    this.adoptedAt.clear();
    this.capLogged.clear();
    this.persist(true);
  }

  /** Open a tab and record it under a freshly minted stable surfaceId. */
  async openTab(url: string, workspaceId?: string): Promise<{ surfaceId: string; targetId: string; url: string }> {
    await this.ensureRunning();
    // Arm the anchor watcher before the tab exists so its targetCreated is
    // seen. Never throws — a launcher without a watcher still opens tabs.
    await this.ensureTargetWatcher();
    // Chrome lists the new tab before its record exists: outsideTabs waits for this.
    let recorded!: () => void;
    const opening = new Promise<void>((resolve) => { recorded = resolve; });
    this.openingTabs.add(opening);
    let record: ChromeSurfaceRecord;
    let created: { id?: string; url?: string };
    try {
      created = (await this.reach().createTarget(url)) as { id?: string; url?: string };
      if (!created?.id) throw new Error('ChromeLauncher: /json/new returned no target id');
      const now = Date.now();
      record = {
        surfaceId: newSurfaceId(),
        targetId: created.id,
        ...(workspaceId !== undefined && { workspaceId }),
        url: created.url ?? url,
        createdAt: now,
        lastSeenAt: now,
      };
      this.surfaces.set(record.surfaceId, record);
      this.byTargetId.set(created.id, record.surfaceId);
    } finally {
      this.openingTabs.delete(opening);
      recorded();
    }
    await this.anchorTab(record);
    this.persist(true);
    return { surfaceId: record.surfaceId, targetId: created.id as string, url: record.url };
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
      live = (await this.reach().listTargets()) as typeof live;
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
      // With grants (C3b) a caller is shown what the pipe would grant it: its own
      // workspace's records, never one filed under no workspace.
      if (workspaceId !== undefined && (cdpTargetGrantEnabled()
        ? !recordVisibleTo(record.workspaceId, workspaceId)
        : record.workspaceId !== undefined && record.workspaceId !== workspaceId)) {
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

  /**
   * Bring a wmux-opened tab, and its window, to the front. `/json/activate` is
   * the HTTP form of CDP `Target.activateTarget`: it needs no socket (the
   * watcher can be off), and Chrome raises the tab's window along with it.
   */
  async selectSurface(surfaceId: string): Promise<boolean> {
    const record = this.surfaces.get(surfaceId);
    if (!record?.targetId || !this.isRunning()) return false;
    try {
      await this.reach().activateTarget(record.targetId);
    } catch {
      return false;
    }
    return true;
  }

  // ── Outside tabs: the phone preview's view of tabs wmux holds no record of ──
  // Kept apart from the records on purpose: nothing here is in `surfaces`,
  // `byTargetId`, the store or the grants, so no agent lane can see it.

  async outsideTabs(opts?: { waitForPairing?: boolean }): Promise<ChromeTargetInfo[]> {
    // Until the persisted records are bound, a tab of ours would look like nobody's.
    if (!this.isRunning() || (this.surfaceStore && !this.recordsSettled)) return [];
    // The tab topology comes from the watcher; starting it never starts Chrome.
    await this.ensureTargetWatcher();
    if (!this.watcher?.isOpen()) return [];
    // Chrome names the page behind a tab just attached after it answers the
    // attach. Only the phone's list waits for that; a capture or input does not.
    if (opts?.waitForPairing) await this.tabPagesKnown(OUTSIDE_PAIRING_WAIT_MS);
    let live: Array<{ id: string; url: string; title: string; type: string }>;
    try {
      live = (await this.reach().listTargets()) as typeof live;
    } catch {
      return [];
    }
    // A tab openTab is creating is listed before its record exists. Only a
    // tab first seen now can be one. The list read waits a bounded time for
    // those creations; a tab still undecided then is left out. A read for a
    // tab by id does not wait: no tab first seen now carries an id yet.
    const fresh = (t: { id: string }) => {
      const tab = this.outsideTabOf(t.id);
      return tab !== undefined && !this.outsideIds.has(tab);
    };
    const opening = [...this.openingTabs];
    let undecided = false;
    if (opening.length > 0 && live.some((t) => t.type === 'page' && fresh(t))) {
      undecided = !opts?.waitForPairing || !(await settledWithin(opening, OUTSIDE_OPENING_WAIT_MS));
    }
    const out: ChromeTargetInfo[] = [];
    for (const t of live) {
      if (t.type !== 'page') continue;
      if (undecided && fresh(t)) continue;
      const tab = this.outsideTabOf(t.id);
      if (tab === undefined) continue;
      let id = this.outsideIds.get(tab);
      if (!id) {
        id = `${OUTSIDE_ID_PREFIX}${randomUUID()}`;
        this.outsideIds.set(tab, id);
        this.outsideTabsById.set(id, tab);
      }
      out.push({ surfaceId: id, targetId: t.id, url: t.url, title: t.title });
    }
    return out;
  }

  hasOutside(id: string): boolean {
    return this.isRunning() && this.outsidePage(id) !== undefined;
  }

  async outsidePageSession(id: string): Promise<ChromePageSession> {
    if (!this.isRunning()) throw new ChromePageSessionError('unavailable', 'ChromeLauncher: Chrome is not running');
    if (this.outsidePage(id) === undefined) throw new ChromePageSessionError('gone', 'ChromeLauncher: no page for this tab');
    await this.ensureTargetWatcher();
    const socket = this.watcher;
    if (!socket?.isOpen()) throw new ChromePageSessionError('unavailable', 'ChromeLauncher: no browser CDP socket');
    const page = this.outsidePage(id);
    if (page === undefined) throw new ChromePageSessionError('gone', 'ChromeLauncher: no page for this tab');
    const generation = this.outsideGeneration;
    const cached = this.pageSessions.get(id);
    let entry: PageSessionEntry;
    if (cached && cached.valid && cached.socket === socket && cached.targetId === page) {
      entry = cached;
    } else {
      // Chrome swapped the page inside the tab: the old session drives a page nobody sees.
      if (cached) this.dropOutsideSession(id, cached);
      // A release while the attach is out refuses it: it detaches, and nothing is kept.
      entry = await this.attachPage(id, page, socket, () => (generation === this.outsideGeneration ? this.outsidePage(id) : undefined), String(generation));
    }
    return this.sessionOf(entry, () => this.outsidePage(id) === entry.targetId);
  }

  outsideStreamSession(id: string): Promise<ChromeStreamSession> {
    const generation = this.outsideGeneration;
    return this.openStream(() => (generation === this.outsideGeneration ? this.outsidePage(id) : undefined), true);
  }

  async selectOutside(id: string): Promise<boolean> {
    const page = this.outsidePage(id);
    if (page === undefined || !this.isRunning()) return false;
    try {
      await this.reach().activateTarget(page);
    } catch {
      return false;
    }
    return true;
  }

  releaseOutside(): void {
    this.outsideGeneration++;
    for (const [id, entry] of [...this.pageSessions]) {
      if (id.startsWith(OUTSIDE_ID_PREFIX)) this.dropOutsideSession(id, entry);
    }
    for (const entry of [...this.streamSessions]) {
      if (!entry.outside) continue;
      this.endStreamSession(entry);
      if (entry.socket.isOpen()) void entry.socket.send('Target.detachFromTarget', { sessionId: entry.sessionId }).catch(() => undefined);
    }
  }

  /** Until every tab the watcher attached has its page named, or `ms` passed. */
  private async tabPagesKnown(ms: number): Promise<void> {
    // A tab whose page closed with no successor is not named again: only tabs attached within `ms` are waited for.
    const since = Date.now() - ms;
    const pending = () => [...this.tabSessions.keys()].some((tab) => !this.tabToPage.has(tab) && (this.tabAttachedAt.get(tab) ?? 0) >= since);
    if (!pending()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pairingWaiters.delete(check);
        resolve();
      };
      const check = () => { if (!pending()) done(); };
      const timer = setTimeout(done, ms);
      (timer as { unref?: () => void }).unref?.();
      this.pairingWaiters.add(check);
    });
  }

  /** The tab holding `pageId` while that page is its current one and neither has a record. */
  private outsideTabOf(pageId: string): string | undefined {
    const tab = this.pageToTab.get(pageId);
    if (tab === undefined || this.tabToPage.get(tab) !== pageId) return undefined;
    return this.byTargetId.has(pageId) || this.byTabTargetId.has(tab) ? undefined : tab;
  }

  /** The page an outside id names now: its tab's current page, while still without a record. */
  private outsidePage(id: string): string | undefined {
    const tab = this.outsideTabsById.get(id);
    const page = tab === undefined ? undefined : this.tabToPage.get(tab);
    return page !== undefined && this.outsideTabOf(page) === tab ? page : undefined;
  }

  private dropOutsideSession(id: string, entry: PageSessionEntry): void {
    entry.valid = false;
    this.pageSessions.delete(id);
    if (entry.socket.isOpen()) void entry.socket.send('Target.detachFromTarget', { sessionId: entry.sessionId }).catch(() => undefined);
  }

  private forgetOutside(): void {
    this.outsideGeneration++;
    this.outsideIds.clear();
    this.outsideTabsById.clear();
    this.tabAttachedAt.clear();
  }

  /**
   * Best effort: un-minimize the window holding a surface, over the watcher
   * socket when one is open. Only for a person's explicit "Show in Chrome" —
   * an agent selecting a tab must not undo a window the user minimized.
   */
  async restoreWindow(surfaceId: string): Promise<void> {
    const targetId = this.surfaces.get(surfaceId)?.targetId;
    if (!targetId) return;
    // An adopted Chrome (app restart) has no watcher until something opens a
    // tab; start it here. Never throws — no socket just means no restore.
    await this.ensureTargetWatcher();
    const socket = this.watcher;
    if (!socket?.isOpen()) return;
    try {
      const reply = (await socket.send('Browser.getWindowForTarget', { targetId })) as {
        windowId?: number;
        bounds?: { windowState?: string };
      };
      if (typeof reply?.windowId === 'number' && reply.bounds?.windowState === 'minimized') {
        await socket.send('Browser.setWindowBounds', { windowId: reply.windowId, bounds: { windowState: 'normal' } });
      }
    } catch {
      /* the tab is already active; a window we could not restore is cosmetic */
    }
  }

  async closeSurface(surfaceId: string): Promise<boolean> {
    const record = this.surfaces.get(surfaceId);
    if (!record) return false;
    if (record.targetId) {
      if (!this.isRunning()) return false;
      try {
        await this.reach().closeTarget(record.targetId);
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

  /**
   * Quit the child through Browser.close (closeGracefully), with a signal as
   * the fallback. `immediate` signals at once, for a quit that cannot wait.
   * Terminal: later demands throw (app teardown only).
   */
  async dispose(opts?: { immediate?: boolean; deadline?: number }): Promise<void> {
    this.disposed = true;
    // A let-go pipe Chrome still on its way out does not outlive us.
    if (this.exiting && !hasExited(this.exiting.child)) {
      try {
        this.exiting.child.kill('SIGKILL');
      } catch { /* already gone */ }
    }
    const child = this.child;
    const transport = this.bound?.transport ?? null;
    this.onChildGone();
    this.proxy?.close();
    this.proxy = null;
    if (!child) return;
    if (!opts?.immediate && transport && (await this.closeGracefully(transport, child, opts?.deadline))) return;
    // On Windows the signal is a hard kill: cookie writes Chrome still held in
    // memory are lost, so say when the grace ran out.
    if (!opts?.immediate && transport) {
      console.warn(`[ChromeLauncher] Chrome (${this.profileName}) did not quit within the grace — ${process.platform === 'win32' ? 'terminating it' : 'signalling it'}`);
    }
    try {
      child.kill();
    } catch {
      /* already gone */
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
import { LiveChromeClient, isLiveChromeReachable } from './LiveChromeClient';

export class ChromeLauncherRegistry {
  private readonly launchers = new Map<string, ChromeBackendClient>();
  private live: LiveChromeClient | null = null;
  /** Set by disposeAll: the app is quitting. Cleared by reopen(). */
  private disposed = false;

  constructor(
    private readonly opts: {
      /** 'default' keeps the pre-registry dir so existing logins survive. */
      defaultDir: string;
      /** Named profiles live under <profilesDir>/<name>. */
      profilesDir: string;
      store: Pick<ChromeProfileStore, 'profileFor' | 'hasPaneBindings' | 'isPaneBound'>;
      /** Persistence for stable surface ids. Optional — omitted keeps the
       *  pre-store in-memory behavior (older wirings, unit tests). */
      surfaceStore?: ChromeSurfaceStore;
      /** Protected panes: the plan a profile runs under now, or null (legacy). */
      protection?: (profile: string) => ChromeProtectionPlan | null;
      /** The user's download folder (ChromeLauncherOptions.downloadsDir). */
      downloadsDir?: () => string | null;
      /** ChromeLauncherOptions.protectedPortAllowed. */
      protectedPortAllowed?: () => boolean;
    },
  ) {}

  /** Apply a protection change to every running Chrome now (a policy edit, a
   *  rebind). Best-effort per profile; the next call re-checks regardless. */
  async reconcileProtection(): Promise<void> {
    await Promise.all(
      [...this.launchers.values()].map((l) =>
        l instanceof ChromeLauncher
          ? l.reconcileProtection().catch((err) => console.warn('[ChromeLauncher] protection restart failed:', err))
          : undefined,
      ),
    );
  }

  /** The hosts `profile`'s proxy refused recently (#2063); empty when that
   *  profile has no launcher or never ran protected. Never creates one. */
  blockedHostsFor(profile: string): BlockedHost[] {
    const launcher = this.launchers.get(profile);
    return launcher instanceof ChromeLauncher ? launcher.blockedHosts() : [];
  }

  /** Forget every profile's recently refused hosts (any policy change). */
  clearBlockedHosts(): void {
    for (const l of this.launchers.values()) {
      if (l instanceof ChromeLauncher) l.clearBlockedHosts();
    }
  }

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
        // One asked for during the quit owns no records: its own teardown
        // must not overwrite the profile's persisted ones.
        ...(this.opts.surfaceStore && !this.disposed && { surfaceStore: this.opts.surfaceStore }),
        ...(this.opts.protection && { protection: () => this.opts.protection?.(name) ?? null }),
        ...(this.opts.downloadsDir && { downloadsDir: this.opts.downloadsDir }),
        ...(this.opts.protectedPortAllowed && { protectedPortAllowed: this.opts.protectedPortAllowed }),
      },
    );
    // Asked while the app quits: a launcher outside disposeAll's snapshot
    // would start a Chrome nothing stops, so it is born disposed instead.
    if (this.disposed) void launcher.dispose();
    else this.launchers.set(name, launcher);
    return launcher;
  }

  /** The launcher a workspace's automation runs against (binding ?? default). */
  forWorkspace(workspaceId: string | undefined): ChromeBackendClient {
    return this.forProfile(this.opts.store.profileFor(workspaceId));
  }

  /** The profile a call runs in: the pane's own binding (same workspace only),
   *  else the workspace's, else 'default'. Pure read — creates nothing. */
  profileFor(workspaceId: string | undefined, paneId?: string): string {
    return this.opts.store.profileFor(workspaceId, paneId);
  }

  /** Whether resolving the profile needs to know the calling pane at all. */
  hasPaneBindings(workspaceId: string | undefined): boolean {
    return this.opts.store.hasPaneBindings(workspaceId);
  }

  /** Whether `profile` is some pane's exclusive profile. */
  isPaneBound(profile: string): boolean {
    return this.opts.store.isPaneBound(profile);
  }

  /** The launcher for `profile` if one was ever created, without creating it —
   *  for paths that must never spawn Chrome (reveal, status). */
  peekLauncher(profile: string): ChromeBackendClient | undefined {
    return profile === LIVE_CHROME_PROFILE ? (this.live ?? undefined) : this.launchers.get(profile);
  }

  /**
   * Read-only status for browser.session.status: which profile the workspace is
   * bound to and whether its instance is up. It must NEVER create a launcher or
   * spawn Chrome for a mere status probe. It is not launcher-map-only anymore:
   * on the live profile it also does a read-only reachability probe (parse the
   * user's DevToolsActivePort + one bounded, immediately-closed TCP connect) —
   * no process spawned, no automation opened.
   */
  async statusForWorkspace(
    workspaceId: string | undefined,
  ): Promise<{ profile: string; running: boolean; cdpPort: number | null; liveAttach?: boolean; transport?: ReturnType<typeof transportLabel> }> {
    return this.statusForProfile(this.opts.store.profileFor(workspaceId));
  }

  /** `statusForWorkspace` for an already resolved profile (a pane's own). */
  async statusForProfile(
    profile: string,
  ): Promise<{ profile: string; running: boolean; cdpPort: number | null; liveAttach?: boolean; transport?: ReturnType<typeof transportLabel> }> {
    if (profile === LIVE_CHROME_PROFILE) {
      // `running` here means the user's remote-debugging endpoint is LISTENING —
      // not the old "did we lazily new-up a LiveChromeClient" (an object the
      // agent never asked for), and not "does a DevToolsActivePort file parse"
      // (a force-killed Chrome leaves a stale file pointing at a dead port — the
      // false positive a live dogfood caught). isLiveChromeReachable confirms a
      // live listener with a bounded TCP connect (no WS upgrade, so Chrome's
      // per-connection consent dialog never fires on a status probe). NOTE this
      // is REACHABILITY, not readiness: a listening endpoint can still refuse
      // the first real drive at that consent dialog. It reads the SAME
      // user-data-dir the registry's LiveChromeClient uses (both default to
      // liveChromeUserDataDir()). liveAttach:true flags the attach case so the
      // RPC layer and agent read running:false as "enable remote debugging at
      // chrome://inspect", never "call session.start".
      const running = await isLiveChromeReachable();
      return { profile, running, cdpPort: null, liveAttach: true };
    }
    const launcher = this.launchers.get(profile);
    if (launcher instanceof ChromeLauncher && launcher.isRunning()) {
      const transport = launcher.launchedTransport();
      return { profile, running: true, cdpPort: launcher.currentPort(), ...(transport && { transport: transportLabel(transport) }) };
    }
    return { profile, running: false, cdpPort: null };
  }

  /**
   * Which launcher owns a surface, and which workspace it belongs to (the
   * browser.close cross-profile fallback). A caller's workspace may be bound
   * to profile A while the surface it names was opened under profile B —
   * browser.close checks the returned workspaceId against the caller's scope
   * before acting, so this lookup discloses ownership, it does not grant it.
   */
  ownerOfSurface(
    surfaceId: string,
  ): { workspaceId?: string; profile: string; client: ChromeBackendClient } | null {
    for (const [profile, launcher] of this.launchers) {
      if (!launcher.hasSurface(surfaceId)) continue;
      const workspaceId =
        launcher instanceof ChromeLauncher ? launcher.recordFor(surfaceId)?.workspaceId : undefined;
      // The profile lets browser.close refuse a pane's exclusive Chrome to a
      // caller in any other pane, even one in the same workspace.
      return { ...(workspaceId !== undefined && { workspaceId }), profile, client: launcher };
    }
    return null;
  }

  /**
   * "Show in Chrome" for a pane: bring the newest tab of `profile` that belongs
   * to `workspaceId` to the front. Never launches — a profile whose Chrome is
   * not up has nothing to show, and spawning a browser to answer a click would
   * be a surprise. Dedicated profiles only: on Live Chrome the newest tab may
   * be the user's own.
   */
  async revealNewest(profile: string, workspaceId: string): Promise<{ ok: boolean; error?: string }> {
    if (profile === LIVE_CHROME_PROFILE) {
      return { ok: false, error: 'Show in Chrome applies to a wmux Chrome profile, not Live Chrome' };
    }
    const launcher = this.peekLauncher(profile);
    if (!(launcher instanceof ChromeLauncher) || !launcher.isRunning()) {
      return { ok: false, error: `the Chrome for profile "${profile}" is not running` };
    }
    // listTargets lets an unattributed record through; "Show in Chrome" for a
    // pane must only ever raise a tab this workspace provably opened.
    const tabs = (await launcher.listTargets(workspaceId)).filter((t) => t.workspaceId === workspaceId);
    const newest = tabs[tabs.length - 1];
    if (!newest) return { ok: false, error: `no open wmux tab in the Chrome for profile "${profile}"` };
    if (!(await launcher.selectSurface(newest.surfaceId))) {
      return { ok: false, error: 'Chrome did not bring the tab to the front' };
    }
    await launcher.restoreWindow(newest.surfaceId);
    return { ok: true };
  }

  /**
   * Drop one workspace's live borrow grants.
   *
   * Called when its Chrome-profile binding changes, in either direction: the
   * grants were consent for THIS workspace driving the user's own browser, and a
   * workspace that has been unbound (or pointed at a dedicated profile) is not
   * that any more. Without this the grants outlived the binding, because the live
   * client is a process-lifetime singleton and re-binding later found them still
   * in place.
   *
   * A no-op when no live client has ever been created.
   */
  clearLiveBorrows(workspaceId: string): void {
    this.live?.writeScope.clearBorrows(workspaceId);
  }

  /**
   * The user's own Chrome tabs currently lent to one workspace's agents, for
   * the Return to me control. Empty when no live client was ever created; a
   * lent tab Chrome has since closed is pruned on the way.
   */
  async listLiveBorrows(workspaceId: string): Promise<LentLiveTab[]> {
    if (!this.live) return [];
    const targets = await this.live.cdpInfoTargets(workspaceId);
    return targets
      .filter((t) => t.owner === 'borrowed')
      .map((t) => ({ surfaceId: t.surfaceId, title: t.title, url: t.url }));
  }

  /** Hand one lent tab back to the user (the existing returnBorrow). */
  returnLiveBorrow(workspaceId: string, surfaceId: string): boolean {
    return this.live?.writeScope.returnBorrow(surfaceId, workspaceId) ?? false;
  }

  /** An install quit was called off (abortInstallQuit): profiles may launch again. */
  reopen(): void {
    this.disposed = false;
  }

  /**
   * Quit every launched Chrome; `immediate` as in ChromeLauncher.dispose. The
   * Chromes stop in parallel against one deadline, QUIT_GRACE_MS from now:
   * whichever is still running when it passes gets the signal, so the whole
   * call resolves within that bound however many profiles are open.
   */
  async disposeAll(opts?: { immediate?: boolean }): Promise<void> {
    // Closed for an immediate (install) quit too; reopen() undoes it if the
    // install is called off.
    this.disposed = true;
    const deadline = Date.now() + QUIT_GRACE_MS;
    const stopping = [...this.launchers.values()].map((launcher) =>
      launcher instanceof ChromeLauncher ? launcher.dispose({ ...opts, deadline }) : launcher.dispose(),
    );
    this.launchers.clear();
    // Socket close only — never touches the user's Chrome process.
    this.live?.dispose();
    this.live = null;
    try {
      await Promise.all(stopping);
    } finally {
      await closePipeRelay();
    }
  }
}
