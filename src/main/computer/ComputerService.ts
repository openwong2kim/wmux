// Main-process policy layer for computer use. Everything OS-specific sits
// behind the helper; this class is where wmux decides whether a request may
// reach it at all.
//
// Order of checks for anything that touches an app:
//   1. opt-in switch (~/.wmux/computer-use.json) — read per call, not cached
//   2. blocklist, on the helper-resolved app identity (exe path / bundle id)
//   3. per (agent, app) consent from the person, remembered for this run
// and, for input, additionally:
//   4. abort cooldown, input lock (one agent drives at a time), rate cap
//
// Control actions must name a snapshot this class recorded, so the target app
// of every click is one that already passed 2 and 3; a helper cannot be talked
// into acting on an app main never vetted.

import { ComputerError } from '../../shared/computer/errors';
import { BLOCK_REASON_TEXT, blockReasonFor, type BlockContext } from '../../shared/computer/blocklist';
import {
  MODIFIERS,
  OBSERVATION_MODES,
  SNAPSHOT_TTL_MS,
  TREE_MAX_DEPTH,
  TREE_MAX_NODES,
  type ActionResult,
  type AppInfo,
  type AppState,
  type ComputerControlAction,
  type HelperCapabilities,
  type HelperMethod,
  type HelperMethods,
  type Modifier,
  type MouseButton,
  type ObservationMode,
  type ScrollDirection,
  type WindowInfo,
} from '../../shared/computer/protocol';
import { screenshotPointToWindow } from '../../shared/computer/scale';

/** What main needs from a helper; HelperProcess implements it. */
export interface HelperLike {
  request<M extends HelperMethod>(method: M, params: HelperMethods[M]['params']): Promise<HelperMethods[M]['result']>;
  abort(reason?: string): void;
  dispose(): void;
}

export type ConsentRequester = (request: { clientName: string; app: AppInfo; window: WindowInfo }) => Promise<boolean>;

export interface ComputerServiceDeps {
  isEnabled: () => boolean;
  /** Null when this OS has no helper (unsupported_platform). */
  createHelper: (() => HelperLike) | null;
  requestConsent: ConsentRequester;
  blockContext: () => BlockContext;
  now?: () => number;
  /** Fires on every accepted control action (drives the agent-cursor overlay). */
  onControl?: (event: { clientName: string; action: ComputerControlAction; window: WindowInfo }) => void;
}

interface SnapshotRecord {
  clientName: string;
  app: AppInfo;
  window: WindowInfo;
  image?: { width: number; height: number; scale: number };
  expiresAt: number;
}

export const INPUT_LOCK_IDLE_MS = 15_000;
export const ABORT_COOLDOWN_MS = 5_000;
export const CONTROL_RATE_PER_MINUTE = 120;
const SNAPSHOT_RECORD_LIMIT = 64;

export interface ControlParams {
  action: ComputerControlAction;
  snapshotId?: string;
  index?: number;
  x?: number;
  y?: number;
  button?: MouseButton;
  clickCount?: number;
  modifiers?: Modifier[];
  value?: string;
  text?: string;
  key?: string;
  repeat?: number;
  keys?: string[];
  direction?: ScrollDirection;
  amount?: number;
}

function fail(code: ConstructorParameters<typeof ComputerError>[0], message: string): never {
  throw new ComputerError(code, message);
}

export class ComputerService {
  private readonly deps: ComputerServiceDeps;
  private helper: HelperLike | null = null;
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly grants = new Map<string, boolean>();
  private readonly consentInflight = new Map<string, Promise<boolean>>();
  private lock: { clientName: string; lastUsedAt: number } | null = null;
  private abortedUntil = 0;
  /**
   * Bumped by abort(). A call captures it on entry and re-checks after every
   * await, so a call that was parked on a consent prompt (or a helper reply)
   * when the person pressed stop cannot carry on afterwards.
   */
  private generation = 0;
  private readonly controlLog = new Map<string, number[]>();

  constructor(deps: ComputerServiceDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private ensureReady(): HelperLike {
    if (!this.deps.isEnabled()) {
      fail('helper_unavailable', 'computer use is turned off. The user turns it on in Settings › Computer use');
    }
    if (!this.deps.createHelper) {
      fail('unsupported_platform', `computer use is not available on ${process.platform}`);
    }
    if (!this.helper) this.helper = this.deps.createHelper();
    return this.helper;
  }

  async capabilities(): Promise<HelperCapabilities> {
    return this.ensureReady().request('capabilities', {});
  }

  async listApps(): Promise<{ apps: Array<AppInfo & { blocked?: string }> }> {
    const { apps } = await this.ensureReady().request('listApps', {});
    const ctx = this.deps.blockContext();
    // Blocked apps stay listed, marked, so an agent learns why instead of
    // hunting for a way around a missing entry.
    return {
      apps: apps.map((app) => {
        const reason = blockReasonFor(app, ctx);
        return reason ? { ...app, blocked: BLOCK_REASON_TEXT[reason] } : app;
      }),
    };
  }

  async listWindows(app?: string): Promise<{ windows: Array<WindowInfo & { blocked?: string }> }> {
    const helper = this.ensureReady();
    const [{ windows }, { apps }] = await Promise.all([
      helper.request('listWindows', app ? { app } : {}),
      helper.request('listApps', {}),
    ]);
    // Window titles leak content (a vault entry, a mail subject), and this call
    // needs no per-app consent — so a blocked app's windows are listed without
    // their titles.
    const ctx = this.deps.blockContext();
    const blockedByPid = new Map<number, string>();
    for (const a of apps) {
      const reason = blockReasonFor(a, ctx);
      if (reason) blockedByPid.set(a.pid, BLOCK_REASON_TEXT[reason]);
    }
    return {
      windows: windows.map((w) => {
        const blocked = blockedByPid.get(w.pid) ?? (ctx.selfPids?.has(w.pid) ? BLOCK_REASON_TEXT.wmux : undefined);
        return blocked ? { ...w, title: '', blocked } : w;
      }),
    };
  }

  async getAppState(clientName: string, params: { app: string; window?: string; mode?: ObservationMode }): Promise<AppState> {
    const helper = this.ensureReady();
    if (!params.app) fail('invalid_argument', 'app is required');
    const mode = params.mode ?? 'both';
    if (!OBSERVATION_MODES.includes(mode)) fail('invalid_argument', `mode must be one of ${OBSERVATION_MODES.join(', ')}`);

    const generation = this.generation;
    const target = await helper.request('resolveTarget', { app: params.app, ...(params.window && { window: params.window }) });
    this.assertCurrent(generation);
    await this.vet(clientName, target.app, target.window, generation);

    const state = await helper.request('getAppState', {
      app: target.app.id,
      window: target.window.id,
      mode,
      maxNodes: TREE_MAX_NODES,
      maxDepth: TREE_MAX_DEPTH,
    });
    this.assertCurrent(generation);
    // The helper answered for a window; re-vet in case it is not the one we
    // resolved (a window selector can go stale between the two calls). The
    // window matters on its own: elevation is per window, not per app.
    if (state.app.id !== target.app.id || state.window.id !== target.window.id) {
      await this.vet(clientName, state.app, state.window, generation);
    }

    this.recordSnapshot(state.snapshotId, {
      clientName,
      app: state.app,
      window: state.window,
      ...(state.screenshot && {
        image: { width: state.screenshot.width, height: state.screenshot.height, scale: state.screenshot.scale },
      }),
      expiresAt: this.now() + SNAPSHOT_TTL_MS,
    });
    return state;
  }

  async control(clientName: string, params: ControlParams): Promise<ActionResult> {
    const helper = this.ensureReady();
    const now = this.now();
    if (now < this.abortedUntil) fail('aborted', 'computer use was just stopped by the user');
    const generation = this.generation;

    if (!params.snapshotId) fail('invalid_argument', 'snapshotId is required; call getAppState first');
    const snap = this.snapshots.get(params.snapshotId);
    if (!snap || snap.expiresAt < now) fail('snapshot_unknown', `snapshot ${params.snapshotId} is unknown or expired`);
    if (snap.clientName !== clientName) fail('snapshot_unknown', 'that snapshot belongs to another agent');
    // Consent may have been revoked (abort clears grants) since the snapshot.
    await this.vet(clientName, snap.app, snap.window, generation);
    // Consent can take minutes; the clock and the stop key may both have moved.
    this.assertCurrent(generation);

    this.takeInputLock(clientName, now);
    this.checkRate(clientName, now);

    const point = this.resolvePoint(params, snap);
    const snapshotId = params.snapshotId;
    this.deps.onControl?.({ clientName, action: params.action, window: snap.window });

    switch (params.action) {
      case 'click':
        this.requireTarget(params, point);
        return helper.request('click', {
          snapshotId,
          ...(params.index !== undefined && { index: params.index }),
          ...(point && { point }),
          button: params.button ?? 'left',
          clickCount: clampInt(params.clickCount ?? 1, 1, 3),
          modifiers: validModifiers(params.modifiers),
        });
      case 'setValue':
        if (params.index === undefined) fail('invalid_argument', 'setValue needs an element index');
        if (typeof params.value !== 'string') fail('invalid_argument', 'setValue needs a string value');
        return helper.request('setValue', { snapshotId, index: params.index, value: params.value });
      case 'type':
        if (typeof params.text !== 'string' || params.text.length === 0) fail('invalid_argument', 'type needs text');
        return helper.request('type', {
          snapshotId,
          ...(params.index !== undefined && { index: params.index }),
          text: params.text,
        });
      case 'pressKey':
        if (!params.key) fail('invalid_argument', 'pressKey needs a key');
        return helper.request('pressKey', { snapshotId, key: params.key, repeat: clampInt(params.repeat ?? 1, 1, 50) });
      case 'hotkey':
        if (!Array.isArray(params.keys) || params.keys.length === 0) fail('invalid_argument', 'hotkey needs keys');
        return helper.request('hotkey', { snapshotId, keys: params.keys.map(String) });
      case 'scroll':
        this.requireTarget(params, point);
        return helper.request('scroll', {
          snapshotId,
          ...(params.index !== undefined && { index: params.index }),
          ...(point && { point }),
          direction: params.direction ?? 'down',
          amount: clampInt(params.amount ?? 3, 1, 50),
        });
      default:
        return fail('invalid_argument', `unknown action ${String((params as { action: unknown }).action)}`);
    }
  }

  /**
   * The user's stop key. Kills in-flight work, drops the input lock and every
   * consent given this run, and refuses input for a short cooldown so a queued
   * action cannot slip in right behind the stop.
   */
  abort(): void {
    this.generation += 1;
    this.helper?.abort('stopped by the user');
    this.lock = null;
    this.grants.clear();
    // A prompt raised before the stop must not grant anything afterwards; a
    // new call asks again (the approval queue coalesces the same question).
    this.consentInflight.clear();
    this.abortedUntil = this.now() + ABORT_COOLDOWN_MS;
  }

  /** Who holds desktop input right now, for the overlay and status UI. */
  inputHolder(): string | null {
    if (!this.lock || this.now() - this.lock.lastUsedAt > INPUT_LOCK_IDLE_MS) return null;
    return this.lock.clientName;
  }

  dispose(): void {
    this.helper?.dispose();
    this.helper = null;
    this.snapshots.clear();
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) fail('aborted', 'computer use was stopped by the user');
  }

  private async vet(clientName: string, app: AppInfo, window: WindowInfo, generation: number): Promise<void> {
    const reason = blockReasonFor(app, this.deps.blockContext());
    if (reason) fail('app_blocked', `${app.name}: ${BLOCK_REASON_TEXT[reason]}`);
    if (window.elevated) {
      fail('target_elevated', `${app.name} runs as administrator; Windows blocks input from wmux into it`);
    }
    const key = `${clientName}\u0000${app.id}`;
    const granted = this.grants.get(key);
    if (granted === true) return;
    if (granted === false) fail('app_blocked', `the user declined computer use of ${app.name} for this agent`);

    let pending = this.consentInflight.get(key);
    if (!pending) {
      pending = this.deps.requestConsent({ clientName, app, window }).catch(() => false);
      this.consentInflight.set(key, pending);
    }
    let approved: boolean;
    try {
      approved = await pending;
    } finally {
      if (this.consentInflight.get(key) === pending) this.consentInflight.delete(key);
    }
    // An answer that arrives after a stop belongs to the world before it.
    this.assertCurrent(generation);
    this.grants.set(key, approved);
    if (!approved) fail('app_blocked', `the user declined computer use of ${app.name} for this agent`);
  }

  private takeInputLock(clientName: string, now: number): void {
    if (this.lock && this.lock.clientName !== clientName && now - this.lock.lastUsedAt <= INPUT_LOCK_IDLE_MS) {
      fail('input_busy', `${this.lock.clientName} is using the desktop`);
    }
    this.lock = { clientName, lastUsedAt: now };
  }

  private checkRate(clientName: string, now: number): void {
    const windowStart = now - 60_000;
    const recent = (this.controlLog.get(clientName) ?? []).filter((t) => t > windowStart);
    if (recent.length >= CONTROL_RATE_PER_MINUTE) {
      this.controlLog.set(clientName, recent);
      fail('input_busy', `more than ${CONTROL_RATE_PER_MINUTE} input actions in a minute; slow down and check the app state`);
    }
    recent.push(now);
    this.controlLog.set(clientName, recent);
  }

  private resolvePoint(params: ControlParams, snap: SnapshotRecord): { x: number; y: number } | undefined {
    if (params.x === undefined && params.y === undefined) return undefined;
    if (params.index !== undefined) fail('invalid_argument', 'give either an element index or x/y, not both');
    if (typeof params.x !== 'number' || typeof params.y !== 'number') fail('invalid_argument', 'x and y must both be numbers');
    if (!snap.image) fail('invalid_argument', 'x/y need a snapshot taken with a screenshot (mode "vision" or "both")');
    const point = screenshotPointToWindow(params.x, params.y, snap.image);
    if (!point) fail('invalid_argument', `(${params.x}, ${params.y}) is outside the ${snap.image.width}x${snap.image.height} screenshot`);
    return point;
  }

  private requireTarget(params: ControlParams, point: { x: number; y: number } | undefined): void {
    if (params.index === undefined && !point) fail('invalid_argument', `${params.action} needs an element index or x/y`);
  }

  private recordSnapshot(id: string, record: SnapshotRecord): void {
    this.snapshots.set(id, record);
    if (this.snapshots.size <= SNAPSHOT_RECORD_LIMIT) return;
    const now = this.now();
    for (const [key, value] of this.snapshots) {
      if (value.expiresAt < now || this.snapshots.size > SNAPSHOT_RECORD_LIMIT) this.snapshots.delete(key);
      if (this.snapshots.size <= SNAPSHOT_RECORD_LIMIT) break;
    }
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function validModifiers(modifiers: Modifier[] | undefined): Modifier[] {
  if (!modifiers) return [];
  for (const m of modifiers) {
    if (!MODIFIERS.includes(m)) fail('invalid_argument', `unknown modifier ${String(m)}`);
  }
  return [...new Set(modifiers)];
}
