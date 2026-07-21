import { webContents } from 'electron';
import { randomUUID } from 'crypto';

export interface CdpTargetInfo {
  surfaceId: string;
  webContentsId: number;
  targetId: string;
  wsUrl: string;
}

// Post-release idle grace before a guest is re-throttled, so back-to-back
// automation ops (screenshot → click → evaluate) don't flap throttling.
// Same bounded-staleness idea as STALE_TRUST_MS in the hook env fast-path.
const LEASE_IDLE_GRACE_MS = 5_000;
// Safety net for RPC-held leases (browser.lease.acquire from the MCP process):
// if the holder dies without releasing, the lease expires on its own. Holders
// of long-running ops renew via browser.lease.renew.
const RPC_LEASE_TTL_MS = 30_000;
// CDP CPU throttling factor for an invisible guest. Dogfood (2026-07-21)
// falsified the design's "setBackgroundThrottling is the single lever"
// premise: Electron keeps a CSS-hidden <webview> guest in the 'visible'
// page-visibility state (its rAF loop keeps pumping at full rate), so
// background timer throttling and Page lifecycle freezing are both inert.
// Emulation.setCPUThrottlingRate works regardless of visibility — measured
// ~5x task-CPU reduction at rate 20 (tasks/s 131→27, rAF 50→22.6).
// setBackgroundThrottling(true) is still applied alongside as belt-and-braces
// for the minimized-window case, where the guest IS considered hidden.
const BACKGROUND_CPU_THROTTLE_RATE = 20;
// Failsafe for in-main per-op leases: a hung CDP command (dogfood repro —
// Page.captureScreenshot never resolves for a display:none guest) would
// otherwise pin its lease forever and permanently exempt the guest from
// lightweight mode. After this bound the lease is force-released; the hung op
// keeps running (it is hung anyway) and may be re-throttled.
const OP_LEASE_FAILSAFE_MS = 60_000;
// Memory relief (#517 slice C): how long a guest must stay continuously
// invisible, unleased and out of grace before its renderer is discarded
// (the renderer unmounts the <webview>, destroying the guest process).
// Env override is for dogfooding/tests only (a 5-minute dwell is impractical
// to exercise live); not a supported user setting.
const DISCARD_AFTER_MS =
  Number(process.env['WMUX_DISCARD_AFTER_MS']) > 0
    ? Number(process.env['WMUX_DISCARD_AFTER_MS'])
    : 5 * 60_000;
// How long ensureAwake() waits for a discarded guest to remount + register
// after the wake signal. Longer than waitForTarget's default 5s because the
// page has to fully reload before dom-ready re-registers it.
const WAKE_TIMEOUT_MS = 15_000;

interface GuestState {
  /** Effective visibility reported by the renderer (workspace ∧ window ∧ ¬zoom ∧ selected). */
  visible: boolean;
  /** Ref-count of in-flight automation ops touching this surface. */
  leases: number;
  /** Idle-grace timer armed when leases drop to 0. */
  idleTimer: NodeJS.Timeout | null;
  /** True while inside the post-release idle grace window. */
  inGrace: boolean;
  /** Last throttle decision actually applied (for transition logging). */
  appliedThrottle?: boolean;
  /** Lease generation — bumped when unregister() zeroes the lease count, so a
   *  stale release from a pre-unregister op cannot decrement a replacement
   *  guest's fresh leases (CodeRabbit, PR #528). */
  gen: number;
  /** Renderer discarded this guest's <webview> to free memory (#517 slice C).
   *  Cleared when the surface re-registers. */
  discarded: boolean;
  /** Dwell timer armed while the guest is throttle-eligible; fires a discard. */
  discardTimer: NodeJS.Timeout | null;
}

export class WebviewCdpManager {
  private sessions = new Map<string, CdpTargetInfo>();
  private waiters = new Map<string, Array<(target: CdpTargetInfo) => void>>();
  private cdpPort: number;
  // Lightweight mode (#517): when ON, a guest that is effectively invisible
  // and not under automation is background-throttled (CPU relief only — the
  // renderer stays resident; this is NOT a memory mode).
  private lightweightMode = false;
  // Memory relief (#517 slice C, default OFF): when ON — and only alongside
  // lightweight mode — a guest that stays throttle-eligible for
  // DISCARD_AFTER_MS is discarded: main signals the renderer, which unmounts
  // the <webview> (destroying the guest renderer process and freeing its
  // memory) and shows a placeholder. The page reloads on wake.
  private discardMode = false;
  // Renderer signalling hooks, injected by main/index.ts.
  private onDiscard?: (surfaceId: string) => void;
  private onWake?: (surfaceId: string) => void;
  // In-flight wake promises, keyed by surfaceId — concurrent automation
  // targeting the same discarded surface must share ONE wake (a duplicate
  // browser:wake would remount/reload the page twice) (GLM review).
  private waking = new Map<string, Promise<CdpTargetInfo | null>>();
  // Keyed by surfaceId; survives register/unregister so a visibility signal
  // that arrives before register() still applies.
  private guestState = new Map<string, GuestState>();
  // RPC-held leases (token → expiry timer + surfaceId), for automation that
  // drives the guest outside main (Playwright in the MCP process).
  private rpcLeases = new Map<string, { surfaceId: string; gen: number; timer: NodeJS.Timeout }>();
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
    // Same-guest re-registration (codex P2, PR #528): BrowserPanel re-calls
    // register() on every dom-ready, so a hidden navigation/reload would
    // otherwise round-trip through unregister() — zeroing lease counts and
    // invalidating tokens held by an in-flight op. Only a DIFFERENT guest
    // replacing this surface goes through the full unregister.
    const prev = this.sessions.get(surfaceId);
    const sameGuestReregister = prev?.webContentsId === webContentsId;
    if (prev && !sameGuestReregister) {
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
      // Electron's message is "Debugger is already attached to the target" —
      // the old guard matched "Already attached", which never hit, so an
      // already-attached guest aborted registration entirely (observed live:
      // the wake path left the surface permanently unregistered). Match
      // case-insensitively on the stable part of the message.
      if (!/already attached/i.test(String(err))) {
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
    // Keep a background guest running full-speed by default: background
    // timer/rAF throttling otherwise stalls background screenshots and
    // evaluate-driven flows (#353). Lightweight mode (#517) re-applies
    // throttling below via recomputeThrottle() only when the guest is
    // effectively invisible AND no automation lease is held.
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

    // Same-guest re-registration keeps the existing destroyed listener —
    // adding another would fire unregister twice.
    if (!sameGuestReregister) {
      wc.on('destroyed', () => {
        // Stale-destroyed guard: a replacement guest may have re-registered
        // under the same surfaceId. Only unregister if WE are still current.
        if (this.sessions.get(surfaceId)?.webContentsId === webContentsId) {
          this.unregister(surfaceId);
        }
      });
    }

    // Fresh-registration grace (codex P2, PR #528): a tool invoked before any
    // target existed runs unleased (lease.acquire returned null) and may have
    // just auto-opened this guest — throttling it the instant it registers
    // would starve that first attach/op. Give a newly registered guest the
    // same idle grace a released lease gets; the renderer's visibility signal
    // and later leases take over from there.
    // Only for a NEW or replaced guest (codex round 4): a same-guest dom-ready
    // re-register fires on every navigation, and re-arming grace there would
    // let a hidden page that reloads periodically stay unthrottled forever.
    const gs = this.ensureGuestState(surfaceId);
    // A registration IS the wake: the renderer remounted the webview (wake
    // signal, user click, or surface became visible again).
    gs.discarded = false;
    if (!sameGuestReregister && this.lightweightMode && !gs.visible && gs.leases === 0) {
      gs.inGrace = true;
      if (gs.idleTimer) clearTimeout(gs.idleTimer);
      gs.idleTimer = setTimeout(() => {
        gs.idleTimer = null;
        gs.inGrace = false;
        this.recomputeThrottle(surfaceId);
      }, LEASE_IDLE_GRACE_MS);
      gs.idleTimer.unref?.();
    }

    // Apply lightweight throttling if this guest is already known-invisible.
    this.recomputeThrottle(surfaceId);

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
    // Clear lease bookkeeping for this surface. The visibility flag is kept:
    // the renderer may re-register the same surface (e.g. webview remount) and
    // its last-known effective visibility still applies.
    const gs = this.guestState.get(surfaceId);
    if (gs) {
      if (gs.idleTimer) clearTimeout(gs.idleTimer);
      gs.idleTimer = null;
      if (gs.discardTimer) clearTimeout(gs.discardTimer);
      gs.discardTimer = null;
      // gs.discarded is deliberately NOT cleared here: a discard-driven
      // unmount arrives as webview 'destroyed' → unregister, and the flag is
      // what lets ensureAwake() know the surface can be woken.
      gs.leases = 0;
      gs.inGrace = false;
      // Invalidate outstanding lease handles: an op that acquired before this
      // unregister must not decrement a replacement guest's fresh lease count.
      gs.gen += 1;
    }
    for (const [token, lease] of this.rpcLeases) {
      if (lease.surfaceId === surfaceId) {
        clearTimeout(lease.timer);
        this.rpcLeases.delete(token);
      }
    }
    console.log(`[WebviewCdpManager] Unregistered surface=${surfaceId}`);
  }

  // ── Lightweight mode (#517) ────────────────────────────────────────────

  /** Toggle lightweight mode and immediately recompute EVERY registered guest. */
  setLightweightMode(enabled: boolean): void {
    if (this.lightweightMode === enabled) return;
    this.lightweightMode = enabled;
    console.log(`[WebviewCdpManager] lightweightMode=${enabled}`);
    for (const surfaceId of this.sessions.keys()) {
      this.recomputeThrottle(surfaceId);
    }
  }

  isLightweightMode(): boolean {
    return this.lightweightMode;
  }

  /** Toggle discard (memory-relief) mode and recompute every guest's dwell timer. */
  setDiscardMode(enabled: boolean): void {
    if (this.discardMode === enabled) return;
    this.discardMode = enabled;
    console.log(`[WebviewCdpManager] discardMode=${enabled}`);
    for (const surfaceId of this.sessions.keys()) {
      this.recomputeThrottle(surfaceId);
    }
    if (!enabled) {
      // Cancel pending dwell timers for surfaces without a live session too,
      // and restore already-discarded panes — turning the option off must not
      // leave panes stranded on the placeholder (GLM review).
      for (const [sid, gs] of this.guestState) {
        if (gs.discardTimer) {
          clearTimeout(gs.discardTimer);
          gs.discardTimer = null;
        }
        // Skip a surface ensureAwake() is already waking — it has had its
        // signal, and a second one would ask the renderer to remount twice
        // (CodeRabbit, PR #530).
        if (gs.discarded && !this.waking.has(sid)) {
          try {
            this.onWake?.(sid);
          } catch (err) {
            console.warn(`[WebviewCdpManager] restore-on-disable failed:`, err);
          }
        }
      }
    }
  }

  isDiscardMode(): boolean {
    return this.discardMode;
  }

  /** Wire renderer signalling for discard/wake (main/index.ts). */
  setDiscardHooks(hooks: { onDiscard?: (surfaceId: string) => void; onWake?: (surfaceId: string) => void }): void {
    this.onDiscard = hooks.onDiscard;
    this.onWake = hooks.onWake;
  }

  isDiscarded(surfaceId: string): boolean {
    return this.guestState.get(surfaceId)?.discarded === true;
  }

  /**
   * Resolve a live CDP target, waking a discarded surface first. With no
   * surfaceId, falls back to any live session and then to any discarded
   * surface — mirroring getTarget()'s default-target behavior, so automation
   * that omits surfaceId keeps working after the only browser pane was
   * discarded (codex review P1). Returns null when there is nothing live and
   * nothing to wake, or when the wake reload times out. Concurrent calls for
   * the same surface share one in-flight wake.
   */
  async ensureAwake(surfaceId?: string): Promise<CdpTargetInfo | null> {
    let resolved = surfaceId;
    if (!resolved) {
      const first = this.sessions.values().next();
      if (!first.done) return first.value;
      // No live session — wake the first discarded surface, if any.
      for (const [sid, gs] of this.guestState) {
        if (gs.discarded) { resolved = sid; break; }
      }
      if (!resolved) return null;
    }
    const existing = this.sessions.get(resolved);
    if (existing) return existing;
    const gs = this.guestState.get(resolved);
    if (!gs?.discarded) return null;
    const inFlight = this.waking.get(resolved);
    if (inFlight) return inFlight;
    const sid = resolved;
    const wake = (async (): Promise<CdpTargetInfo | null> => {
      console.log(`[WebviewCdpManager] waking discarded surface=${sid}`);
      try {
        this.onWake?.(sid);
      } catch (err) {
        console.warn(`[WebviewCdpManager] wake signal failed:`, err);
        return null;
      }
      try {
        return await this.waitForTarget(sid, WAKE_TIMEOUT_MS);
      } catch {
        console.warn(`[WebviewCdpManager] wake timed out for surface=${sid}`);
        return null;
      }
    })();
    this.waking.set(sid, wake);
    try {
      return await wake;
    } finally {
      this.waking.delete(sid);
    }
  }

  /**
   * Record a surface's effective visibility (workspace ∧ window ∧ ¬zoom ∧
   * selected, computed renderer-side). Accepted before register() so an early
   * signal is not lost.
   */
  setVisibility(surfaceId: string, visible: boolean): void {
    const gs = this.ensureGuestState(surfaceId);
    if (gs.visible === visible) return;
    gs.visible = visible;
    this.recomputeThrottle(surfaceId);
  }

  /**
   * Acquire an automation lease: while at least one lease is held, the guest
   * is never throttled regardless of visibility (#353 — background automation
   * must run full-speed). Ref-counted; call releaseAutomationLease exactly
   * once per acquire, passing back the returned generation so a release that
   * straddles an unregister/re-register cycle becomes a no-op instead of
   * decrementing the replacement guest's fresh lease count.
   */
  acquireAutomationLease(surfaceId: string): number {
    const gs = this.ensureGuestState(surfaceId);
    gs.leases += 1;
    if (gs.idleTimer) {
      clearTimeout(gs.idleTimer);
      gs.idleTimer = null;
    }
    gs.inGrace = false;
    this.recomputeThrottle(surfaceId);
    return gs.gen;
  }

  releaseAutomationLease(surfaceId: string, gen?: number): void {
    const gs = this.guestState.get(surfaceId);
    if (!gs || gs.leases === 0) return;
    // Stale handle from before an unregister — the count was already zeroed.
    if (gen !== undefined && gen !== gs.gen) return;
    gs.leases -= 1;
    if (gs.leases > 0) return;
    // Idle grace: stay unthrottled briefly so back-to-back ops don't flap.
    gs.inGrace = true;
    if (gs.idleTimer) clearTimeout(gs.idleTimer);
    gs.idleTimer = setTimeout(() => {
      gs.idleTimer = null;
      gs.inGrace = false;
      this.recomputeThrottle(surfaceId);
    }, LEASE_IDLE_GRACE_MS);
    gs.idleTimer.unref?.();
    this.recomputeThrottle(surfaceId);
  }

  /** Convenience wrapper: lease held for the duration of fn, with a failsafe
   *  release so a hung op cannot pin the lease forever (see
   *  OP_LEASE_FAILSAFE_MS). */
  async withAutomationLease<T>(surfaceId: string, fn: () => Promise<T>): Promise<T> {
    const gen = this.acquireAutomationLease(surfaceId);
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      this.releaseAutomationLease(surfaceId, gen);
    };
    const failsafe = setTimeout(() => {
      console.warn(`[WebviewCdpManager] op lease failsafe fired for ${surfaceId} (op hung > ${OP_LEASE_FAILSAFE_MS}ms)`);
      releaseOnce();
    }, OP_LEASE_FAILSAFE_MS);
    failsafe.unref?.();
    try {
      return await fn();
    } finally {
      clearTimeout(failsafe);
      releaseOnce();
    }
  }

  /**
   * Token-based lease for out-of-process automation (Playwright in the MCP
   * process, via browser.lease.* RPC). TTL-bounded so a dead holder cannot
   * pin a guest unthrottled forever; long ops renew.
   */
  acquireRpcLease(surfaceId: string): string {
    // Bearer capability (codex P2, PR #528): a guessable counter would let any
    // browser.read-capable client release someone else's lease and strip the
    // full-speed exemption from an in-flight hidden-guest op.
    const token = `lease-${randomUUID()}`;
    const gen = this.acquireAutomationLease(surfaceId);
    const timer = setTimeout(() => this.releaseRpcLease(token), RPC_LEASE_TTL_MS);
    timer.unref?.();
    this.rpcLeases.set(token, { surfaceId, gen, timer });
    return token;
  }

  renewRpcLease(token: string): boolean {
    const lease = this.rpcLeases.get(token);
    if (!lease) return false;
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => this.releaseRpcLease(token), RPC_LEASE_TTL_MS);
    lease.timer.unref?.();
    return true;
  }

  releaseRpcLease(token: string): boolean {
    const lease = this.rpcLeases.get(token);
    if (!lease) return false;
    clearTimeout(lease.timer);
    this.rpcLeases.delete(token);
    this.releaseAutomationLease(lease.surfaceId, lease.gen);
    return true;
  }

  private ensureGuestState(surfaceId: string): GuestState {
    let gs = this.guestState.get(surfaceId);
    if (!gs) {
      // Unknown surfaces default to visible — fail open (never throttle a
      // guest we have no visibility signal for).
      gs = { visible: true, leases: 0, idleTimer: null, inGrace: false, gen: 0, discarded: false, discardTimer: null };
      this.guestState.set(surfaceId, gs);
    }
    return gs;
  }

  /**
   * The single decision point: throttled ⇔ lightweight && !visible &&
   * leases===0 && !inGrace. Applied only to registered guests; a visibility
   * change for a not-yet-registered surface is applied on register().
   */
  private recomputeThrottle(surfaceId: string): void {
    const session = this.sessions.get(surfaceId);
    if (!session) return;
    const wc = webContents.fromId(session.webContentsId);
    if (!wc || wc.isDestroyed()) return;
    const gs = this.ensureGuestState(surfaceId);
    const throttled =
      this.lightweightMode && !gs.visible && gs.leases === 0 && !gs.inGrace;
    if (gs.appliedThrottle !== throttled) {
      gs.appliedThrottle = throttled;
      console.log(
        `[WebviewCdpManager] throttle ${surfaceId}: ${throttled} ` +
        `(lw=${this.lightweightMode} visible=${gs.visible} leases=${gs.leases} grace=${gs.inGrace})`,
      );
    }
    try {
      wc.setBackgroundThrottling(throttled);
    } catch (err) {
      console.warn(`[WebviewCdpManager] recomputeThrottle failed:`, err);
    }
    // Primary CPU lever (see BACKGROUND_CPU_THROTTLE_RATE). Best-effort and
    // fire-and-forget: a failed CDP command must never break visibility/lease
    // bookkeeping, and rate 1 restores full speed.
    try {
      wc.debugger
        .sendCommand('Emulation.setCPUThrottlingRate', {
          rate: throttled ? BACKGROUND_CPU_THROTTLE_RATE : 1,
        })
        .catch((err) => {
          console.warn(`[WebviewCdpManager] setCPUThrottlingRate failed:`, err);
        });
    } catch (err) {
      console.warn(`[WebviewCdpManager] setCPUThrottlingRate failed:`, err);
    }

    // Memory relief (#517 slice C): a guest that stays throttled long enough
    // is discarded. The dwell timer arms exactly when the throttle condition
    // holds (and discard mode is on) and is cancelled the moment it stops
    // holding — visibility, a lease, grace or a mode flip all reset the dwell.
    const discardEligible = throttled && this.discardMode && !gs.discarded;
    if (discardEligible && !gs.discardTimer) {
      gs.discardTimer = setTimeout(() => {
        gs.discardTimer = null;
        this.fireDiscard(surfaceId);
      }, DISCARD_AFTER_MS);
      gs.discardTimer.unref?.();
    } else if (!discardEligible && gs.discardTimer) {
      clearTimeout(gs.discardTimer);
      gs.discardTimer = null;
    }
  }

  /** Dwell timer fired — re-check conditions and signal the renderer. */
  private fireDiscard(surfaceId: string): void {
    const session = this.sessions.get(surfaceId);
    if (!session) return;
    const gs = this.guestState.get(surfaceId);
    if (!gs) return;
    const stillEligible =
      this.discardMode && this.lightweightMode &&
      !gs.visible && gs.leases === 0 && !gs.inGrace && !gs.discarded;
    if (!stillEligible) return;
    const wc = webContents.fromId(session.webContentsId);
    if (!wc || wc.isDestroyed()) return;
    // Never discard a guest that is playing audio (background music/calls
    // are a deliberate use of a hidden browser pane). Re-arm and try later.
    try {
      if (wc.isCurrentlyAudible()) {
        gs.discardTimer = setTimeout(() => {
          gs.discardTimer = null;
          this.fireDiscard(surfaceId);
        }, DISCARD_AFTER_MS);
        gs.discardTimer.unref?.();
        return;
      }
    } catch { /* audible check is best-effort */ }
    gs.discarded = true;
    console.log(`[WebviewCdpManager] discarding surface=${surfaceId}`);
    // Retire the session SYNCHRONOUSLY, before the renderer signal. The
    // actual <webview> unmount is an async renderer round-trip; if the
    // session stayed published during that window, getTarget()/the leased RPC
    // wrapper would hand automation a target that the already-queued unmount
    // is about to destroy mid-op (3-way review consensus). With the session
    // gone first, that automation resolves no target and takes the
    // ensureAwake path instead — and IPC ordering guarantees the renderer
    // sees discard before the wake, so it unmounts then remounts cleanly.
    this.unregister(surfaceId);
    try {
      this.onDiscard?.(surfaceId);
    } catch (err) {
      console.warn(`[WebviewCdpManager] discard signal failed:`, err);
      gs.discarded = false;
    }
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
    for (const lease of this.rpcLeases.values()) clearTimeout(lease.timer);
    this.rpcLeases.clear();
    for (const gs of this.guestState.values()) {
      if (gs.idleTimer) clearTimeout(gs.idleTimer);
      if (gs.discardTimer) clearTimeout(gs.discardTimer);
    }
    this.guestState.clear();
  }
}
