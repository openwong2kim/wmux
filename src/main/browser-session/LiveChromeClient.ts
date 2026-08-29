import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ChromeBackendClient, ChromeBackendEndpoint, ChromeTargetInfo } from './ChromeLauncher';

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

const ENABLE_HINT =
  'LIVE_CHROME_UNAVAILABLE: could not find your Chrome’s remote-debugging endpoint. ' +
  'Make sure Chrome is running and remote debugging is enabled at chrome://inspect/#remote-debugging ' +
  '(Chrome 144+), then retry.';

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

interface CdpTargetInfoWire {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export class LiveChromeClient implements ChromeBackendClient {
  private ws: WebSocket | null = null;
  private wsEndpoint: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

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
    const ws = this.ws;
    this.ws = null;
    this.wsEndpoint = null;
    for (const p of this.pending.values()) p.reject(new Error('LiveChromeClient: disposed'));
    this.pending.clear();
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
  }

  // ── CDP over WebSocket ────────────────────────────────────────────────────

  private async ensureSocket(): Promise<WebSocket> {
    const endpoint = readLiveChromeEndpoint(this.userDataDir);
    // Chrome restarts mint a new secret path — a stale socket is replaced.
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.wsEndpoint === endpoint) {
      return this.ws;
    }
    this.dispose();
    const ws = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(ENABLE_HINT)), CDP_TIMEOUT_MS);
      (t as { unref?: () => void }).unref?.();
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(ENABLE_HINT)); }, { once: true });
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id !== 'number') return; // event, not a reply
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`LiveChromeClient: ${msg.error.message ?? 'CDP error'}`));
      else waiter.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        // Reject in-flight calls; the next call re-reads the endpoint.
        this.ws = null;
        this.wsEndpoint = null;
        for (const p of this.pending.values()) p.reject(new Error('LiveChromeClient: connection closed'));
        this.pending.clear();
      }
    });
    this.ws = ws;
    this.wsEndpoint = endpoint;
    return ws;
  }

  private async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = await this.ensureSocket();
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`LiveChromeClient: ${method} timed out`));
      }, CDP_TIMEOUT_MS);
      (t as { unref?: () => void }).unref?.();
    });
    ws.send(JSON.stringify({ id, method, params }));
    return result;
  }
}
