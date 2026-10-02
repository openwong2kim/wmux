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
import { BLOCK_REASON_TEXT, blockReasonFor, osChordRefusal, osPointerModifierRefusal, type BlockContext } from '../../shared/computer/blocklist';
import {
  MODIFIERS,
  OBSERVATION_MODES,
  SNAPSHOT_TTL_MS,
  TREE_MAX_DEPTH,
  TREE_MAX_NODES,
  KEY_VOCABULARY_TEXT,
  normalizeKey,
  parseHotkey,
  type ActionResult,
  type AppInfo,
  type AppState,
  type ComputerControlAction,
  type HelperCapabilities,
  type HelperMethod,
  type HelperMethods,
  type Key,
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

/**
 * How a consent prompt ended. Only `approved` and `denied` are the person's
 * answer, and only those are remembered. `expired` (nobody answered in time),
 * `withdrawn` (the stop key took the prompt down) and `unavailable` (no
 * approval queue yet, or it threw) refuse this one call and nothing more: the
 * next call asks again.
 */
export type ConsentAnswer = 'approved' | 'denied' | 'expired' | 'withdrawn' | 'unavailable';

/**
 * Who is calling, as main resolved it (computer.rpc.ts). Consent grants,
 * snapshot ownership, the input lock and the rate cap are keyed on `key`, which
 * names one agent session (its pane, commander workspace or MCP server
 * process), never the bare client name every Claude Code pane shares. `label`
 * is what the person and other agents are shown: the client name and the
 * workspace by its name, with no ids in it.
 */
export interface ComputerAgent {
  key: string;
  label: string;
}

export type ConsentRequester = (request: {
  agent: ComputerAgent;
  app: AppInfo;
  window: WindowInfo;
  /** Bumped by every stop; part of the prompt's dedupe key. */
  epoch: number;
  /** Aborted by the stop key: withdraw the prompt and answer `withdrawn`. */
  signal: AbortSignal;
}) => Promise<ConsentAnswer>;

export interface ComputerServiceDeps {
  isEnabled: () => boolean;
  /** Null when this OS has no helper (unsupported_platform). */
  createHelper: (() => HelperLike) | null;
  requestConsent: ConsentRequester;
  /**
   * The global stop key (stopKey.ts). Held while computer use is on: armed on
   * every call, released when a call finds the switch off. `arm()` returning
   * false refuses input (fail closed); observation still works.
   */
  stopKey: { arm(): boolean; release(): void };
  blockContext: () => BlockContext;
  now?: () => number;
  /** Picks the OS-wide chord rules (blocklist.ts); defaults to this process's OS. */
  platform?: string;
  /** Fires on every accepted control action (drives the agent-cursor overlay). */
  onControl?: (event: { agent: ComputerAgent; action: ComputerControlAction; window: WindowInfo }) => void;
}

interface SnapshotRecord {
  agentKey: string;
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

let shutDown = false;

/**
 * True once any ComputerService was disposed (app quit). Settings IPC reads it
 * so opening Settings during quit does not take the stop key back.
 */
export function computerUseShutDown(): boolean {
  return shutDown;
}

function fail(code: ConstructorParameters<typeof ComputerError>[0], message: string): never {
  throw new ComputerError(code, message);
}

export class ComputerService {
  private readonly deps: ComputerServiceDeps;
  private helper: HelperLike | null = null;
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly grants = new Map<string, boolean>();
  private readonly consentInflight = new Map<string, Promise<ConsentAnswer>>();
  /** Aborted (and replaced) by every stop: withdraws the open consent prompts. */
  private consentAbort = new AbortController();
  private lock: { agentKey: string; label: string; lastUsedAt: number } | null = null;
  private abortedUntil = 0;
  /**
   * Bumped by abort(). A call captures it on entry and re-checks after every
   * await, so a call that was parked on a consent prompt (or a helper reply)
   * when the person pressed stop cannot carry on afterwards.
   */
  private generation = 0;
  private readonly controlLog = new Map<string, number[]>();
  /** Set by dispose() (app quit): no new helper, no stop-key re-take, ever. */
  private disposed = false;

  constructor(deps: ComputerServiceDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private ensureReady(): HelperLike {
    // Checked before anything else: a call that lands during quit must not
    // take the stop key back or spawn a helper nothing will ever dispose.
    if (this.disposed) fail('helper_unavailable', 'wmux is shutting down');
    if (!this.deps.isEnabled()) {
      // Turned off, possibly by editing the file by hand: give the chord back.
      this.deps.stopKey.release();
      fail('helper_unavailable', 'computer use is turned off. The user turns it on in Settings › Computer use');
    }
    if (!this.deps.createHelper) {
      fail('unsupported_platform', `computer use is not available on ${process.platform}`);
    }
    // Hold the stop key for as long as computer use is on (idempotent).
    this.deps.stopKey.arm();
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

  /**
   * Window titles leak content (a vault entry, a mail subject) and this call
   * asks for no consent, so a title is sent only for apps this agent already
   * has the person's consent for; every other window keeps its id and bounds
   * with a blank title. Pass an agent with an empty key when the caller is not
   * identified: no title at all is sent then.
   */
  async listWindows(agent: ComputerAgent, app?: string): Promise<{ windows: Array<WindowInfo & { blocked?: string }> }> {
    const helper = this.ensureReady();
    const [{ windows }, { apps }] = await Promise.all([
      helper.request('listWindows', app ? { app } : {}),
      helper.request('listApps', {}),
    ]);
    // Blocked apps are marked so an agent learns why it cannot ask for them;
    // their titles are blank like any app without consent.
    const ctx = this.deps.blockContext();
    const blockedByPid = new Map<number, string>();
    for (const a of apps) {
      const reason = blockReasonFor(a, ctx);
      if (reason) blockedByPid.set(a.pid, BLOCK_REASON_TEXT[reason]);
    }
    return {
      windows: windows.map((w) => {
        const blocked = blockedByPid.get(w.pid) ?? (ctx.selfPids?.has(w.pid) ? BLOCK_REASON_TEXT.wmux : undefined);
        if (blocked) return { ...w, title: '', blocked };
        return agent.key && this.grants.get(grantKey(agent, w.appId)) === true ? w : { ...w, title: '' };
      }),
    };
  }

  async getAppState(agent: ComputerAgent, params: { app: string; window?: string; mode?: ObservationMode }): Promise<AppState> {
    const helper = this.ensureReady();
    if (!params.app) fail('invalid_argument', 'app is required');
    const mode = params.mode ?? 'both';
    if (!OBSERVATION_MODES.includes(mode)) fail('invalid_argument', `mode must be one of ${OBSERVATION_MODES.join(', ')}`);

    const generation = this.generation;
    const target = await helper.request('resolveTarget', { app: params.app, ...(params.window && { window: params.window }) });
    this.assertCurrent(generation);
    await this.vet(agent, target.app, target.window, generation);

    assertConsistent(target.app, target.window);
    const state = await helper.request('getAppState', {
      app: target.app.id,
      window: target.window.id,
      mode,
      maxNodes: TREE_MAX_NODES,
      maxDepth: TREE_MAX_DEPTH,
    });
    this.assertCurrent(generation);
    // Always re-vet what the helper answered for, not only when the ids
    // changed: the app's path, bundle id or the window's elevation can differ
    // from the resolved pair, and a vetted window must belong to its app. A
    // consented app costs no prompt here.
    assertConsistent(state.app, state.window);
    await this.vet(agent, state.app, state.window, generation);

    this.recordSnapshot(state.snapshotId, {
      agentKey: agent.key,
      app: state.app,
      window: state.window,
      ...(state.screenshot && {
        image: { width: state.screenshot.width, height: state.screenshot.height, scale: state.screenshot.scale },
      }),
      expiresAt: this.now() + SNAPSHOT_TTL_MS,
    });
    return state;
  }

  async control(agent: ComputerAgent, params: ControlParams): Promise<ActionResult> {
    const helper = this.ensureReady();
    // No input without a working emergency stop.
    if (!this.deps.stopKey.arm()) {
      fail(
        'stop_key_unavailable',
        'the computer-use stop key could not be registered (another app probably uses the same shortcut), so wmux does not let agents drive other apps',
      );
    }
    const generation = this.generation;
    if (!params.snapshotId) fail('invalid_argument', 'snapshotId is required; call getAppState first');
    const snapshotId = params.snapshotId;
    const checkSnapshot = (now: number): SnapshotRecord => {
      if (now < this.abortedUntil) fail('aborted', 'computer use was just stopped by the user');
      const record = this.snapshots.get(snapshotId);
      if (!record || record.expiresAt < now) fail('snapshot_unknown', `snapshot ${snapshotId} is unknown or expired`);
      if (record.agentKey !== agent.key) fail('snapshot_unknown', 'that snapshot belongs to another agent');
      return record;
    };
    const snap = checkSnapshot(this.now());
    // Keys and modifiers are checked before consent or the lock: a refused
    // chord raises no prompt and takes nothing.
    const keys = this.resolveKeys(params);
    // Consent may have been revoked (abort clears grants) since the snapshot.
    await this.vet(agent, snap.app, snap.window, generation);
    // Consent can take minutes; the clock and the stop key may both have
    // moved, so the snapshot and the cooldown are checked again on a fresh
    // clock before the lock and the rate slot are taken.
    this.assertCurrent(generation);
    const now = this.now();
    checkSnapshot(now);

    this.takeInputLock(agent, now);
    this.checkRate(agent.key, now);

    const point = this.resolvePoint(params, snap);
    // The helper re-checks this window right before each input batch.
    const target = { pid: snap.window.pid, windowId: snap.window.id };
    this.deps.onControl?.({ agent, action: params.action, window: snap.window });

    switch (params.action) {
      case 'click':
        this.requireTarget(params, point);
        return helper.request('click', {
          snapshotId,
          target,
          ...(params.index !== undefined && { index: params.index }),
          ...(point && { point }),
          button: params.button ?? 'left',
          clickCount: clampInt(params.clickCount ?? 1, 1, 3),
          modifiers: validModifiers(params.modifiers),
        });
      case 'setValue':
        if (params.index === undefined) fail('invalid_argument', 'setValue needs an element index');
        if (typeof params.value !== 'string') fail('invalid_argument', 'setValue needs a string value');
        return helper.request('setValue', { snapshotId, target, index: params.index, value: params.value });
      case 'type':
        if (typeof params.text !== 'string' || params.text.length === 0) fail('invalid_argument', 'type needs text');
        return helper.request('type', {
          snapshotId,
          target,
          ...(params.index !== undefined && { index: params.index }),
          text: params.text,
        });
      case 'pressKey': {
        const { key } = keys ?? fail('internal', 'pressKey reached the helper without a resolved key');
        return helper.request('pressKey', { snapshotId, target, key, repeat: clampInt(params.repeat ?? 1, 1, 50) });
      }
      case 'hotkey': {
        const { modifiers, key } = keys ?? fail('internal', 'hotkey reached the helper without a resolved chord');
        return helper.request('hotkey', { snapshotId, target, modifiers, key });
      }
      case 'scroll':
        this.requireTarget(params, point);
        return helper.request('scroll', {
          snapshotId,
          target,
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
   * The user's stop key. Kills in-flight work, takes down every consent prompt
   * this service raised (their parked calls fail with `aborted` right away),
   * drops the input lock and every consent given this run, and refuses input
   * and new prompts for a short cooldown so a queued action cannot slip in
   * right behind the stop.
   */
  abort(): void {
    this.generation += 1;
    this.withdrawConsentPrompts();
    this.helper?.abort('stopped by the user');
    this.lock = null;
    this.grants.clear();
    this.abortedUntil = this.now() + ABORT_COOLDOWN_MS;
  }

  /** Who holds desktop input right now, for the overlay and status UI. */
  inputHolder(): string | null {
    if (!this.lock || this.now() - this.lock.lastUsedAt > INPUT_LOCK_IDLE_MS) return null;
    return this.lock.label;
  }

  dispose(): void {
    this.disposed = true;
    shutDown = true;
    this.generation += 1;
    this.withdrawConsentPrompts();
    this.helper?.dispose();
    this.helper = null;
    this.snapshots.clear();
  }

  private withdrawConsentPrompts(): void {
    // A prompt raised before the stop must not grant anything afterwards, and
    // must not stay on screen: aborting the signal makes each requester cancel
    // its prompt in the approval queue.
    this.consentAbort.abort();
    this.consentAbort = new AbortController();
    this.consentInflight.clear();
  }

  /** Canonical key (and chord) for pressKey / hotkey; null for other actions. */
  private resolveKeys(params: ControlParams): { modifiers: Modifier[]; key: Key } | null {
    if (params.modifiers !== undefined && params.action !== 'click') {
      // Dropping them silently would send a different input than asked for.
      fail('invalid_argument', `${params.action} takes no modifiers; use hotkey for a chord (e.g. ["ctrl","s"]) or click with modifiers`);
    }
    if (params.action === 'click') {
      const modifiers = validModifiers(params.modifiers);
      const why = osPointerModifierRefusal(this.deps.platform ?? process.platform, modifiers);
      if (why) fail('shortcut_blocked', `${[...modifiers, 'click'].join('+')} is refused because ${why}`);
      return null;
    }
    let resolved: { modifiers: Modifier[]; key: Key };
    if (params.action === 'pressKey') {
      const key = typeof params.key === 'string' ? normalizeKey(params.key) : null;
      if (!key) fail('invalid_argument', `pressKey needs one key from: ${KEY_VOCABULARY_TEXT}. Use hotkey for chords`);
      resolved = { modifiers: [], key };
    } else if (params.action === 'hotkey') {
      if (!Array.isArray(params.keys) || params.keys.length === 0) fail('invalid_argument', 'hotkey needs keys');
      const chord = parseHotkey(params.keys);
      if ('error' in chord) fail('invalid_argument', `${chord.error}. Keys: ${KEY_VOCABULARY_TEXT}`);
      resolved = chord;
    } else {
      return null;
    }
    this.refuseOsChord(resolved.modifiers, resolved.key);
    return resolved;
  }

  private refuseOsChord(modifiers: Modifier[], key: Key): void {
    const why = osChordRefusal(this.deps.platform ?? process.platform, modifiers, key);
    if (why) {
      const chord = [...modifiers, key].join('+');
      fail('shortcut_blocked', `${chord} is refused because ${why}`);
    }
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) fail('aborted', 'computer use was stopped by the user');
  }

  private async vet(agent: ComputerAgent, app: AppInfo, window: WindowInfo, generation: number): Promise<void> {
    const reason = blockReasonFor(app, this.deps.blockContext());
    if (reason) fail('app_blocked', `${app.name}: ${BLOCK_REASON_TEXT[reason]}`);
    if (window.elevated) {
      fail('target_elevated', `${app.name} runs as administrator; Windows blocks input from wmux into it`);
    }
    const key = grantKey(agent, app.id);
    const granted = this.grants.get(key);
    if (granted === true) return;
    if (granted === false) fail('app_blocked', `the user declined computer use of ${app.name} for this agent`);

    let pending = this.consentInflight.get(key);
    if (!pending) {
      // Right after a stop no new prompt goes up: the person just said stop.
      const coolingMs = this.abortedUntil - this.now();
      if (coolingMs > 0) {
        fail('aborted', `computer use was just stopped by the user; no new request for ${Math.ceil(coolingMs / 1000)} s`);
      }
      pending = this.deps
        .requestConsent({ agent, app, window, epoch: this.generation, signal: this.consentAbort.signal })
        .catch((): ConsentAnswer => 'unavailable');
      this.consentInflight.set(key, pending);
    }
    let answer: ConsentAnswer;
    try {
      answer = await pending;
    } finally {
      if (this.consentInflight.get(key) === pending) this.consentInflight.delete(key);
    }
    // An answer that arrives after a stop belongs to the world before it.
    this.assertCurrent(generation);
    switch (answer) {
      case 'approved':
        this.grants.set(key, true);
        return;
      case 'denied':
        // Only an explicit Deny is remembered.
        this.grants.set(key, false);
        return fail('app_blocked', `the user declined computer use of ${app.name} for this agent`);
      case 'expired':
        return fail(
          'timeout',
          `nobody answered the consent prompt for ${app.name} in time. That is not a refusal and was not remembered: the next call asks again`,
        );
      case 'withdrawn':
        return fail('aborted', 'computer use was stopped by the user');
      default:
        return fail('internal', `wmux could not show the consent prompt for ${app.name}; nothing was remembered`);
    }
  }

  private takeInputLock(agent: ComputerAgent, now: number): void {
    if (this.lock && this.lock.agentKey !== agent.key && now - this.lock.lastUsedAt <= INPUT_LOCK_IDLE_MS) {
      // The label, never the key: the key carries pane ids.
      fail('input_busy', `${this.lock.label} is using the desktop`);
    }
    this.lock = { agentKey: agent.key, label: agent.label, lastUsedAt: now };
  }

  private checkRate(agentKey: string, now: number): void {
    const windowStart = now - 60_000;
    const recent = (this.controlLog.get(agentKey) ?? []).filter((t) => t > windowStart);
    if (recent.length >= CONTROL_RATE_PER_MINUTE) {
      this.controlLog.set(agentKey, recent);
      fail('input_busy', `more than ${CONTROL_RATE_PER_MINUTE} input actions in a minute; slow down and check the app state`);
    }
    recent.push(now);
    this.controlLog.set(agentKey, recent);
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

/** A window the helper reports must belong to the app it reports with it. */
function assertConsistent(app: AppInfo, window: WindowInfo): void {
  if (app.pid !== window.pid || app.id !== window.appId) {
    fail('internal', `the computer-use helper reported a window that does not belong to ${app.name}`);
  }
}

function grantKey(agent: ComputerAgent, appId: string): string {
  return `${agent.key}\u0000${appId}`;
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
