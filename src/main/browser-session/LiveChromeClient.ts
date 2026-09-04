import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import type { ChromeBackendClient, ChromeBackendEndpoint, ChromeTargetInfo } from './ChromeLauncher';
import { CdpSocket, type CdpConnectFailure } from './CdpSocket';

// ---------------------------------------------------------------------------
// Live-Chrome attach (Phase 3): drive the user's REAL daily Chrome via the
// official M144 remote-debugging flow. The user enables
// chrome://inspect/#remote-debugging once; Chrome then writes a
// DevToolsActivePort file (line 1 = port, line 2 = secret WS path) into its
// user-data-dir, and we connect to ws://127.0.0.1:<port><path>. Chrome shows
// its own per-connection permission dialog plus the automation banner — that
// dialog and the explicit wmux workspace binding ARE the consent model.
//
// The endpoint is WS-only (no HTTP /json surface), so tab operations go over
// a small CDP client on the global WebSocket (Node 24 in Electron 41 main).
// dispose() closes the socket only — this class must NEVER kill the user's
// Chrome.
//
// Mechanism credit: the DevToolsActivePort discovery contract is Chrome's own
// (chrome://inspect/#remote-debugging); referenced via Google's
// chrome-devtools-mcp (Apache-2.0) as prior art. No code copied.
// ---------------------------------------------------------------------------

const CDP_TIMEOUT_MS = 10_000;

/**
 * Budget for the WebSocket handshake, deliberately separate from
 * CDP_TIMEOUT_MS.
 *
 * Chrome asks the user for permission on every connection to this endpoint and
 * holds the handshake open until they answer. Sharing the 10 s request timeout
 * meant wmux hung up while that prompt was still on screen — reproduced as a
 * silent timeout with no explanation, and structurally unwinnable: nobody
 * reaches the Allow button that fast unless they were already staring at the
 * window. Three minutes is long enough to walk back to the keyboard, and still
 * bounded, so a genuinely dead endpoint does not hang forever.
 */
const LIVE_CONNECT_TIMEOUT_MS = 180_000;

/** A handshake open this long is waiting on a human; say so while they can
 *  still act on it. */
const LIVE_CONNECT_NOTICE_MS = 5_000;

/** Reachability probe budget: a TCP connect on localhost either lands or is
 *  refused almost instantly, so this only bounds a black-holed port. */
const LIVE_TCP_PROBE_TIMEOUT_MS = 500;

/**
 * The `#remote-debugging` fragment does NOT open that page: chrome://inspect
 * lands on its Devices tab whatever fragment it is given, and the switch lives
 * behind a sidebar item the user has to click (dogfood 2026-09-04 — the user
 * followed the link, saw a list of devices, and had no reason to look further).
 * So name the item instead of trusting the URL to arrive at it.
 */
const ENABLE_HINT =
  'LIVE_CHROME_UNAVAILABLE: could not find your Chrome’s remote-debugging endpoint. ' +
  'Make sure Chrome is running, then open chrome://inspect and click "Remote debugging" in the ' +
  'left sidebar (Chrome 144+) to enable it, and retry.';

/**
 * Listening, but the handshake was never accepted — Chrome is almost certainly
 * holding it behind its permission prompt. The old code could not produce this
 * message at all: a pending prompt and a dead port came out as the same string,
 * so the one failure the user can actually fix read like a broken setup.
 */
const APPROVAL_HINT =
  'LIVE_CHROME_AWAITING_APPROVAL: your Chrome is running and its remote-debugging endpoint is ' +
  'listening, but it never accepted the connection. Chrome asks permission for every connection ' +
  'to this endpoint — switch to your Chrome window and click Allow, then retry. If no prompt is ' +
  'showing, something else may be holding the endpoint.';

/** Listening, and the handshake was actively refused rather than left hanging. */
const REFUSED_HINT =
  'LIVE_CHROME_REFUSED: your Chrome’s remote-debugging endpoint is listening but refused the ' +
  'connection. Its address changes every time Chrome restarts, so retry first — that re-reads ' +
  'the current endpoint. If it keeps failing, re-check chrome://inspect/#remote-debugging.';

/** The real Chrome's user-data-dir per platform (WMUX_LIVE_CHROME_DIR overrides). */
export function liveChromeUserDataDir(): string {
  const env = process.env.WMUX_LIVE_CHROME_DIR;
  if (env) return env;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  }
  return join(homedir(), '.config', 'google-chrome');
}

/** Parse DevToolsActivePort → browser WS endpoint. Exported for unit tests. */
export function readLiveChromeEndpoint(userDataDir: string = liveChromeUserDataDir()): string {
  let content: string;
  try {
    content = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8');
  } catch {
    throw new Error(ENABLE_HINT);
  }
  const [rawPort, rawPath] = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !!l);
  const port = parseInt(rawPort ?? '', 10);
  if (!rawPath || Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(ENABLE_HINT);
  }
  return `ws://127.0.0.1:${port}${rawPath}`;
}

/**
 * Is the live Chrome ACTUALLY reachable over remote debugging right now?
 *
 * A parseable DevToolsActivePort is necessary but NOT sufficient: a Chrome that
 * was force-killed (or crashed) leaves the file behind pointing at a dead port,
 * so parsing alone reports "reachable" for a browser that is gone — the
 * stale-file false positive a live dogfood caught. After parsing the port we
 * therefore confirm something is actually LISTENING with a short, bounded TCP
 * connect.
 *
 * Why a bare TCP connect and not a real CDP/WS probe: the live endpoint is
 * WS-only, and opening the WS makes Chrome raise its per-connection permission
 * dialog — a status/start probe must never pop that at the user. A raw TCP
 * connect sends no WS upgrade, so it never touches the consent flow while still
 * proving the port is held by a live listener.
 *
 * Ceiling: this proves the endpoint is LISTENING, not that automation will be
 * allowed. A listening endpoint can still refuse the first real drive at
 * Chrome's per-connection consent dialog (so reachable:true is NOT "consent
 * granted"), and another process squatting that exact port would also read as
 * reachable. Both are far narrower than the stale-file case, and closing them
 * fully would require the WS handshake — i.e. the very dialog we avoid.
 *
 * Fail-safe: any parse failure, refusal, timeout, or socket error → false.
 */
export async function isLiveChromeReachable(
  userDataDir: string = liveChromeUserDataDir(),
  timeoutMs: number = LIVE_TCP_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  let port: number;
  try {
    // readLiveChromeEndpoint yields ws://127.0.0.1:<port><path> (or throws);
    // pull the port straight from it rather than re-reading the file.
    const match = /^ws:\/\/127\.0\.0\.1:(\d+)/.exec(readLiveChromeEndpoint(userDataDir));
    if (!match) return false;
    port = Number(match[1]);
  } catch {
    return false;
  }
  return probeTcpListening('127.0.0.1', port, timeoutMs);
}

/** Resolve true iff a TCP connection to host:port is accepted within timeoutMs.
 *  Never rejects — refusal / timeout / error all resolve false — and the probe
 *  socket is destroyed the instant the outcome is known. Exported for unit
 *  tests (the timeout branch needs a black-holed host status can't produce). */
export function probeTcpListening(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Turn a failed dial into the one thing the user can act on.
 *
 * The three outcomes need three different remedies, and the old single string
 * covered only the first:
 *   port not listening  → Chrome is down, or remote debugging was never enabled
 *   listening, timed out → a permission prompt nobody has answered
 *   listening, refused   → the endpoint moved (Chrome restarted) or is not ours
 *
 * Exported for unit tests: the listening/not-listening split is what decides
 * the message, and it is worth pinning.
 */
export async function describeLiveConnectFailure(
  reason: CdpConnectFailure,
  endpoint: string,
  probe: (host: string, port: number, timeoutMs: number) => Promise<boolean> = probeTcpListening,
): Promise<string> {
  const match = /^ws:\/\/127\.0\.0\.1:(\d+)/.exec(endpoint);
  // No parseable port means we never had an endpoint to begin with.
  if (!match) return ENABLE_HINT;
  const listening = await probe('127.0.0.1', Number(match[1]), LIVE_TCP_PROBE_TIMEOUT_MS).catch(() => false);
  if (!listening) return ENABLE_HINT;
  return reason === 'timeout' ? APPROVAL_HINT : REFUSED_HINT;
}

interface CdpTargetInfoWire {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export class LiveChromeClient implements ChromeBackendClient {
  /** CDP transport. The endpoint is re-read on every call, so a Chrome
   *  restart (new secret path) transparently re-dials. */
  private readonly socket = new CdpSocket(() => readLiveChromeEndpoint(this.userDataDir), {
    label: 'LiveChromeClient',
    connectError: ENABLE_HINT,
    timeoutMs: CDP_TIMEOUT_MS,
    connectTimeoutMs: LIVE_CONNECT_TIMEOUT_MS,
    connectNoticeAfterMs: LIVE_CONNECT_NOTICE_MS,
    onConnectPending: (elapsedMs) => {
      // The caller is still blocked inside the dial, so this is the only place
      // that can reach the user while the prompt is still actionable.
      console.warn(
        `[LiveChromeClient] waiting ${Math.round(elapsedMs / 1000)}s for Chrome to accept this ` +
          'connection — click Allow on the prompt in your Chrome window.',
      );
    },
    connectErrorFor: (reason, endpoint) => describeLiveConnectFailure(reason, endpoint),
  });

  constructor(private readonly userDataDir?: string) {}

  /** cdp.info surface: live mode reports a WS endpoint, never a port. */
  async endpoint(): Promise<ChromeBackendEndpoint> {
    return { wsEndpoint: readLiveChromeEndpoint(this.userDataDir) };
  }

  /** wmux-opened tabs: targetId → owning workspace (ChromeLauncher mirror). */
  private readonly tabOwners = new Map<string, string | undefined>();

  /**
   * Seed page selection with the tabs WMUX opened (dogfood P1 on #1064:
   * seeding nothing left the engine unable to match ANY pinned surface — its
   * registry match had no candidates — so every page tool failed after a
   * successful browser_open). Only wmux-opened tabs are seeded, so a random
   * user tab still can never become the default pin; PRE-EXISTING tabs are
   * reached explicitly via the browser_tabs list + the engine's live-attach
   * direct match. Dead targetIds are pruned as a side effect.
   */
  async cdpInfoTargets(workspaceId?: string): Promise<ChromeTargetInfo[]> {
    // No wmux-opened tabs → nothing to seed. Return without touching the
    // socket so a mere cdp.info (backend probe) never dials the user's Chrome.
    if (this.tabOwners.size === 0) return [];
    let live: ChromeTargetInfo[];
    try {
      live = await this.listTargets();
    } catch {
      return [];
    }
    const liveById = new Map(live.map((t) => [t.targetId, t]));
    const out: ChromeTargetInfo[] = [];
    for (const [targetId, owner] of [...this.tabOwners]) {
      const t = liveById.get(targetId);
      if (!t) {
        this.tabOwners.delete(targetId);
        continue;
      }
      if (workspaceId !== undefined && owner !== undefined && owner !== workspaceId) continue;
      out.push({ surfaceId: targetId, targetId, workspaceId: owner, url: t.url, title: t.title });
    }
    return out;
  }

  /**
   * Live attach keeps surfaceId ≡ targetId, deliberately. The engine's
   * live-only escape hatch (PlaywrightEngine, wsEndpoint branch) matches a
   * pinned surfaceId against Chrome's OWN Target.getTargets, because
   * browser_tabs exposes pre-existing user tabs the wmux registry never saw.
   * Minting a wmux id here would break that match for exactly those tabs. The
   * dedicated (port) path is where stable ids buy something: there every
   * addressable tab is one wmux opened.
   */
  async openTab(url: string, workspaceId?: string): Promise<{ surfaceId: string; targetId: string; url: string }> {
    const res = (await this.send('Target.createTarget', { url })) as { targetId?: string };
    if (!res?.targetId) throw new Error('LiveChromeClient: Target.createTarget returned no targetId');
    this.tabOwners.set(res.targetId, workspaceId);
    return { surfaceId: res.targetId, targetId: res.targetId, url };
  }

  /** Full exposure by design (consent model): ALL live page tabs, regardless
   *  of workspace — only the workspace bound to 'live' ever reaches here. */
  async listTargets(): Promise<ChromeTargetInfo[]> {
    const res = (await this.send('Target.getTargets', {})) as { targetInfos?: CdpTargetInfoWire[] };
    return (res?.targetInfos ?? [])
      .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
      .map((t) => ({ surfaceId: t.targetId, targetId: t.targetId, url: t.url, title: t.title }));
  }

  async closeSurface(surfaceId: string): Promise<boolean> {
    try {
      await this.send('Target.closeTarget', { targetId: surfaceId });
      this.tabOwners.delete(surfaceId);
      return true;
    } catch {
      return false;
    }
  }

  async selectSurface(surfaceId: string): Promise<boolean> {
    try {
      await this.send('Target.activateTarget', { targetId: surfaceId });
      return true;
    } catch {
      return false;
    }
  }

  /** Every live tab is addressable — the workspace binding IS the ownership,
   *  so this answers true for ids this client never opened. The parameter is
   *  named for the interface, not consulted: the alternative (checking
   *  tabOwners) would hide the user's own pre-existing tabs, which live mode
   *  exists to reach. */
  // The ignored parameter is the point: it keeps this signature readable
  // against the ChromeBackendClient contract instead of silently taking zero
  // arguments.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  hasSurface(_surfaceId: string): boolean {
    return true;
  }

  /** Close our socket only. Never touch the user's Chrome process. */
  dispose(): void {
    this.socket.close();
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.socket.send(method, params);
  }
}
