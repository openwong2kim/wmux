import { webContents } from 'electron';

export interface CdpTargetInfo {
  surfaceId: string;
  webContentsId: number;
  targetId: string;
  wsUrl: string;
}

export class WebviewCdpManager {
  private sessions = new Map<string, CdpTargetInfo>();
  private waiters = new Map<string, Array<(target: CdpTargetInfo) => void>>();
  private cdpPort: number;
  // Optional hook so a CDP event-capture layer (BrowserCaptureManager, #106) can
  // tear down its debugger listeners when a surface is unregistered — manual
  // wc.debugger.detach() does not remove EventEmitter listeners, and may not
  // fire the debugger 'detach' event, so we notify explicitly.
  private captureCleanup?: (webContentsId: number) => void;

  constructor(cdpPort = 18800) {
    this.cdpPort = cdpPort;
  }

  /** Register a callback invoked with the webContentsId on every unregister. */
  setCaptureCleanup(fn: (webContentsId: number) => void): void {
    this.captureCleanup = fn;
  }

  async register(surfaceId: string, webContentsId: number): Promise<void> {
    if (this.sessions.has(surfaceId)) {
      this.unregister(surfaceId);
    }

    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      console.warn(`[WebviewCdpManager] webContents ${webContentsId} not found or destroyed`);
      return;
    }

    try {
      wc.debugger.attach('1.3');
    } catch (err) {
      if (!String(err).includes('Already attached')) {
        console.error(`[WebviewCdpManager] debugger.attach failed:`, err);
        return;
      }
    }

    // Emulate focus so a background surface (the browser panel is rendered
    // display:none when not foregrounded) still behaves focused for input,
    // accessibility, and document.hasFocus(). Without this, key events dispatched
    // into an unfocused guest can be dropped before reaching the focused node
    // (issue #353). Best-effort — non-fatal if the domain rejects the command.
    try {
      await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (err) {
      console.warn(`[WebviewCdpManager] setFocusEmulationEnabled failed:`, err);
    }
    // Keep a background guest running full-speed: background timer/rAF throttling
    // otherwise stalls background screenshots and evaluate-driven flows (#353).
    try {
      wc.setBackgroundThrottling(false);
    } catch (err) {
      console.warn(`[WebviewCdpManager] setBackgroundThrottling failed:`, err);
    }

    let targetId = `wc-${webContentsId}`;
    let wsUrl = `ws://127.0.0.1:${this.cdpPort}/devtools/page/${targetId}`;

    try {
      const resp = await fetch(`http://127.0.0.1:${this.cdpPort}/json`);
      const targets: Array<{ id: string; webSocketDebuggerUrl: string; url: string; title: string }> =
        await resp.json();
      const wcUrl = wc.getURL();
      const match = targets.find(
        (t) => t.url === wcUrl || t.title === wc.getTitle(),
      );
      if (match) {
        targetId = match.id;
        wsUrl = match.webSocketDebuggerUrl;
      }
    } catch (err) {
      console.warn(`[WebviewCdpManager] /json fetch failed, using fallback:`, err);
    }

    const info: CdpTargetInfo = { surfaceId, webContentsId, targetId, wsUrl };
    this.sessions.set(surfaceId, info);

    wc.on('destroyed', () => {
      this.unregister(surfaceId);
    });

    const pending = this.waiters.get(surfaceId);
    if (pending) {
      for (const resolve of pending) resolve(info);
      this.waiters.delete(surfaceId);
    }

    console.log(`[WebviewCdpManager] Registered surface=${surfaceId} target=${targetId}`);
  }

  unregister(surfaceId: string): void {
    const session = this.sessions.get(surfaceId);
    if (!session) return;

    // Let the capture layer remove its debugger listeners before we detach.
    try {
      this.captureCleanup?.(session.webContentsId);
    } catch {
      // capture cleanup is best-effort
    }

    try {
      const wc = webContents.fromId(session.webContentsId);
      if (wc && !wc.isDestroyed()) {
        wc.debugger.detach();
      }
    } catch {
      // Already detached or destroyed
    }

    this.sessions.delete(surfaceId);
    console.log(`[WebviewCdpManager] Unregistered surface=${surfaceId}`);
  }

  getTarget(surfaceId?: string): CdpTargetInfo | null {
    if (surfaceId) {
      return this.sessions.get(surfaceId) ?? null;
    }
    const first = this.sessions.values().next();
    return first.done ? null : first.value;
  }

  waitForTarget(surfaceId: string, timeoutMs = 5000): Promise<CdpTargetInfo> {
    const existing = this.sessions.get(surfaceId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.waiters.get(surfaceId);
        if (pending) {
          const idx = pending.indexOf(wrappedResolve);
          if (idx >= 0) pending.splice(idx, 1);
          if (pending.length === 0) this.waiters.delete(surfaceId);
        }
        reject(new Error(`timeout waiting for CDP target: ${surfaceId}`));
      }, timeoutMs);

      const wrappedResolve = (target: CdpTargetInfo) => {
        clearTimeout(timer);
        resolve(target);
      };

      if (!this.waiters.has(surfaceId)) {
        this.waiters.set(surfaceId, []);
      }
      this.waiters.get(surfaceId)!.push(wrappedResolve);
    });
  }

  getCdpPort(): number {
    return this.cdpPort;
  }

  listTargets(): CdpTargetInfo[] {
    return [...this.sessions.values()];
  }

  disposeAll(): void {
    for (const surfaceId of [...this.sessions.keys()]) {
      this.unregister(surfaceId);
    }
    this.waiters.clear();
  }
}
