import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PortAllocator } from './PortAllocator';

// ---------------------------------------------------------------------------
// 'chrome' backend (Phase 2): launch the user's installed Chrome with a
// DEDICATED profile directory and --remote-debugging-port, and let the MCP
// PlaywrightEngine drive it over the same connectOverCDP path it already
// uses. The dedicated user-data-dir keeps agent logins persistent while
// staying fully separate from the user's daily browser (ban-risk isolation),
// and is exempt from Chrome 136+'s default-profile CDP block.
//
// Tab ownership: only tabs wmux opened are addressable — openTab() records
// targetId → workspaceId, and listTargets() intersects that registry with
// Chrome's live /json/list. Manually opened tabs are invisible to agents.
//
// Child lifecycle follows the BrokerSupervisor idiom: singleflight launch,
// error+exit double-fire guard, a disposed flag so app teardown can never
// race a relaunch. No auto-restart loop — a dead Chrome relaunches on the
// next demand.
// ---------------------------------------------------------------------------

// Distinct range from the Electron CDP range (18800-18899) so the two
// endpoints can never collide on one machine.
const CHROME_PORT_MIN = 18900;
const CHROME_PORT_MAX = 18999;
// /json/version readiness poll.
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 250;

export interface ChromeTargetInfo {
  targetId: string;
  workspaceId?: string;
  url: string;
  title: string;
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

export interface ChromeLauncherOptions {
  /** Port probe range — the registry hands each profile a disjoint slice so
   *  parallel first-launches cannot race-pick the same port. */
  portRange?: { min: number; max: number };
  /** Env pin var; null disables (non-default profiles — one pin cannot serve
   *  N instances). */
  portEnvVar?: string | null;
}

export class ChromeLauncher {
  private child: ChildProcess | null = null;
  private cdpPort = 0;
  private launching: Promise<number> | null = null;
  private disposed = false;
  private readonly ports: PortAllocator;
  /** wmux-opened tabs: Chrome targetId → owning workspace. */
  private readonly tabOwners = new Map<string, string | undefined>();

  constructor(private readonly userDataDir: string, opts?: ChromeLauncherOptions) {
    this.ports = new PortAllocator({
      min: opts?.portRange?.min ?? CHROME_PORT_MIN,
      max: opts?.portRange?.max ?? CHROME_PORT_MAX,
      envVar: opts?.portEnvVar === undefined ? 'WMUX_CHROME_CDP_PORT' : opts.portEnvVar,
    });
  }

  /** True when this launcher opened (and still tracks) the given tab. */
  hasTab(targetId: string): boolean {
    return this.tabOwners.has(targetId);
  }

  /** True when the child is alive and its CDP endpoint answered readiness. */
  isRunning(): boolean {
    return this.child !== null && this.cdpPort > 0;
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

  private async launch(): Promise<number> {
    const binary = discoverChromeBinary();
    if (!binary) {
      throw new Error(
        'CHROME_BACKEND_NO_BINARY: no Chrome/Chromium/Edge installation found. ' +
          'Install Google Chrome or set WMUX_CHROME_PATH to a browser binary.',
      );
    }
    const prev = this.ports.getPort();
    if (prev !== null) this.ports.release(prev);
    const port = await this.ports.allocate();

    const child = spawn(
      binary,
      [
        `--user-data-dir=${this.userDataDir}`,
        `--remote-debugging-port=${port}`,
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
    this.cdpPort = port;

    // Poll /json/version until the endpoint answers.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (gone) throw new Error('ChromeLauncher: Chrome exited during startup');
      try {
        await this.fetchJson('/json/version');
        return port;
      } catch {
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
  }

  private onChildGone(): void {
    this.child = null;
    if (this.cdpPort > 0) this.ports.release(this.cdpPort);
    this.cdpPort = 0;
    this.tabOwners.clear();
  }

  /** Open a tab and record its owner. Returns the Chrome targetId. */
  async openTab(url: string, workspaceId?: string): Promise<{ targetId: string; url: string }> {
    await this.ensureRunning();
    // Chrome 111+ requires PUT for /json/new.
    const created = (await this.fetchJson(`/json/new?${encodeURIComponent(url)}`, 'PUT')) as {
      id?: string;
      url?: string;
    };
    if (!created?.id) throw new Error('ChromeLauncher: /json/new returned no target id');
    this.tabOwners.set(created.id, workspaceId);
    return { targetId: created.id, url: created.url ?? url };
  }

  /**
   * wmux-opened tabs still alive in Chrome, optionally filtered to one
   * workspace. Dead targetIds are pruned from the registry as a side effect.
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
    const out: ChromeTargetInfo[] = [];
    for (const [targetId, owner] of [...this.tabOwners]) {
      const t = liveById.get(targetId);
      if (!t) {
        this.tabOwners.delete(targetId);
        continue;
      }
      if (workspaceId !== undefined && owner !== undefined && owner !== workspaceId) continue;
      out.push({ targetId, workspaceId: owner, url: t.url, title: t.title });
    }
    return out;
  }

  async closeTab(targetId: string): Promise<boolean> {
    if (!this.isRunning()) return false;
    try {
      await this.fetchJson(`/json/close/${targetId}`);
    } catch {
      return false;
    }
    this.tabOwners.delete(targetId);
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
// CDP ports.
// ---------------------------------------------------------------------------

import { join as joinPath } from 'node:path';
import { validateBrowserProfileName } from './ProfileManager';
import { DEFAULT_CHROME_PROFILE, type ChromeProfileStore } from './ChromeProfileStore';

// Disjoint per-profile port slices inside the chrome range (20 profiles × 5).
const PORT_SLOT_WIDTH = 5;

export class ChromeLauncherRegistry {
  private readonly launchers = new Map<string, ChromeLauncher>();
  /** Stable slot per profile name for the port slice (append-only). */
  private readonly slots = new Map<string, number>();

  constructor(
    private readonly opts: {
      /** 'default' keeps the pre-registry dir so existing logins survive. */
      defaultDir: string;
      /** Named profiles live under <profilesDir>/<name>. */
      profilesDir: string;
      store: Pick<ChromeProfileStore, 'profileFor'>;
    },
  ) {}

  forProfile(name: string): ChromeLauncher {
    validateBrowserProfileName(name); // re-validate at the interpolation site
    const existing = this.launchers.get(name);
    if (existing) return existing;

    let slot = this.slots.get(name);
    if (slot === undefined) {
      slot = this.slots.size;
      this.slots.set(name, slot);
    }
    const min = CHROME_PORT_MIN + slot * PORT_SLOT_WIDTH;
    const launcher = new ChromeLauncher(
      name === DEFAULT_CHROME_PROFILE ? this.opts.defaultDir : joinPath(this.opts.profilesDir, name),
      {
        portRange: { min, max: Math.min(min + PORT_SLOT_WIDTH - 1, CHROME_PORT_MAX) },
        portEnvVar: name === DEFAULT_CHROME_PROFILE ? 'WMUX_CHROME_CDP_PORT' : null,
      },
    );
    this.launchers.set(name, launcher);
    return launcher;
  }

  /** The launcher a workspace's automation runs against (binding ?? default). */
  forWorkspace(workspaceId: string | undefined): ChromeLauncher {
    return this.forProfile(this.opts.store.profileFor(workspaceId));
  }

  /** Which live launcher opened this tab (close path). */
  ownerOfTarget(targetId: string): ChromeLauncher | undefined {
    for (const launcher of this.launchers.values()) {
      if (launcher.hasTab(targetId)) return launcher;
    }
    return undefined;
  }

  disposeAll(): void {
    for (const launcher of this.launchers.values()) launcher.dispose();
    this.launchers.clear();
  }
}
