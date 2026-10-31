// Main-process policy layer for computer use. Everything OS-specific sits
// behind the helper; this class is where wmux decides whether a request may
// reach it at all.
//
// Order of checks for anything that touches an app:
//   1. opt-in switch (~/.wmux/computer-use.json) — read per call, not cached
//   2. blocklist, on the helper-resolved app identity (exe path / bundle id)
//   3. per (agent, app) consent from the person, remembered for this run —
//      only while `askPerApp` is on (opt-in, read per call); otherwise every
//      app that passed 2 counts as consented (owner decision 2026-10-08)
// and, for input, additionally:
//   4. abort cooldown, rate cap, and the input lanes (inputLanes.ts): real
//      (foreground) input takes the foreground lease, one agent at a time;
//      input a helper with `input.deferForeground` can post in the background
//      takes only its target pid's slot, so agents on different apps run at
//      once. Without that flag every input takes the lease, as before.
//
// Control actions must name a snapshot this class recorded, so the target app
// of every click is one that already passed 2 and 3; a helper cannot be talked
// into acting on an app main never vetted. openApp has no snapshot: it checks
// the selector before the launch and the launched app after it.

import { ComputerError, inputActionError } from '../../shared/computer/errors';
import {
  BLOCK_REASON_TEXT,
  blockReasonFor,
  osChordRefusal,
  selectorBlockReasonFor,
  type BlockContext,
} from '../../shared/computer/blocklist';
import {
  COMPUTER_CONTROL_ACTIONS,
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
import { appBundleSelector } from './appBundleId';
import { ForegroundLease, INPUT_LOCK_IDLE_MS, PidLanes, foregroundCertain } from './inputLanes';

export { INPUT_LOCK_IDLE_MS };

/** What main needs from a helper; HelperProcess implements it. */
export interface HelperLike {
  request<M extends HelperMethod>(method: M, params: HelperMethods[M]['params']): Promise<HelperMethods[M]['result']>;
  abort(reason?: string): void;
  dispose(): void;
  /** Whether the running helper's hello listed `method`; undefined while none runs. */
  supports?(method: HelperMethod): boolean | undefined;
  /** Pushes Settings to a running helper that lists `configure`; never starts one. */
  reconfigure?(): Promise<void>;
  /** Ends the running helper (a stale permission verdict); the next call starts a fresh one. */
  reset?(): void;
  /**
   * Whether the helper's hello has `input.deferForeground: true` (protocol
   * ForegroundMode). Starts the helper when none runs (the action needs it
   * anyway) and reads its hello; sends no request. A start that fails
   * rejects with that error, which ends the action (not_delivered); it is
   * not retried by the request. A helper without this method never gets
   * input lanes.
   */
  defersForeground?(): Promise<boolean>;
}

/** What `capabilities` tells an agent: the helper's answer minus what cannot work. */
export type AgentCapabilities = HelperCapabilities & { missingPermissions?: Array<'accessibility' | 'screenRecording'> };

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
  /** Settings › Computer use › Ask before each app. Read per call; off by default. */
  askPerApp: () => boolean;
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
  /**
   * CFBundleIdentifier of a .app on disk (appBundleId.ts), or null when it
   * cannot be read. openApp reads it for an absolute .app path before the
   * launch, because the path's file name says nothing about the bundle.
   */
  readBundleId?: (appPath: string) => Promise<string | null>;
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

export const ABORT_COOLDOWN_MS = 5_000;
const STOP_KEY_UNAVAILABLE =
  'the computer-use stop key could not be registered (another app probably uses the same shortcut), so wmux does not let agents drive other apps';
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

/**
 * App quit. Set even when no service was ever built, so a call or a Settings
 * read that lands during quit cannot build one and take the stop key back.
 */
export function markComputerUseShutDown(): void {
  shutDown = true;
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
  /** Real input: one agent at a time (inputLanes.ts). */
  private readonly lease = new ForegroundLease();
  /** Background input: one action at a time per target pid. */
  private readonly lanes = new PidLanes();
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
    if (this.disposed) fail('shutting_down', 'wmux is shutting down');
    if (!this.deps.isEnabled()) {
      // Turned off, possibly by editing the file by hand: give the chord back.
      this.deps.stopKey.release();
      fail('turned_off', 'computer use is turned off. The user turns it on in Settings › Computer use');
    }
    if (!this.deps.createHelper) {
      fail('unsupported_platform', `computer use is not available on ${process.platform}`);
    }
    // Hold the stop key for as long as computer use is on (idempotent).
    this.deps.stopKey.arm();
    if (!this.helper) this.helper = this.deps.createHelper();
    return this.helper;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return capabilitiesForAgent(await this.ensureReady().request('capabilities', {}));
  }

  /** Settings changed (the overlay): tell a running helper. Never starts one. */
  async reconfigure(): Promise<void> {
    if (this.disposed) return;
    await this.helper?.reconfigure?.();
  }

  /**
   * Ends the running helper so the next call starts one with a fresh TCC
   * verdict (after Reset access or Request access). Stops its work first.
   */
  resetHelper(): void {
    if (this.disposed || !this.helper) return;
    this.abort();
    this.helper.reset?.();
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
   * Window titles leak content (a vault entry, a mail subject). With
   * `askPerApp` off every unblocked app counts as consented and its titles are
   * sent. With it on, this call asks for no consent, so a title is sent only
   * for apps this agent already has the person's consent for; every other
   * window keeps its id and bounds with a blank title, and an agent with an
   * empty key (caller not identified) gets no title at all.
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
    const askPerApp = this.deps.askPerApp();
    const blockedByPid = new Map<number, string>();
    for (const a of apps) {
      const reason = blockReasonFor(a, ctx);
      if (reason) blockedByPid.set(a.pid, BLOCK_REASON_TEXT[reason]);
    }
    return {
      windows: windows.map((w) => {
        const blocked = blockedByPid.get(w.pid) ?? (ctx.selfPids?.has(w.pid) ? BLOCK_REASON_TEXT.wmux : undefined);
        if (!blocked && (!askPerApp || (agent.key && this.grants.get(grantKey(agent, w.appId)) === true))) return w;
        // A folder location says as much as a title, so it needs the same consent.
        const hidden: WindowInfo & { blocked?: string } = { ...w, title: '', ...(blocked && { blocked }) };
        delete hidden.shellLocation;
        return hidden;
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

  /**
   * An input action. Its result's disposition follows its verification (a
   * call that returned is no proof of delivery); an error before the request
   * went to the helper is `not_delivered`, and after it the helper's verdict,
   * or `delivered_unverified` when there is none.
   */
  async control(agent: ComputerAgent, params: ControlParams): Promise<ActionResult> {
    const sent = { requested: false, done: false };
    try {
      const result = await this.dispatchControl(agent, params, sent);
      return { ...result, disposition: result.verification === 'verified' ? 'delivered' : 'delivered_unverified' };
    } catch (err) {
      throw inputActionError(err, sent.requested, sent.done);
    }
  }

  private async dispatchControl(
    agent: ComputerAgent,
    params: ControlParams,
    sent: { requested: boolean; done: boolean },
  ): Promise<ActionResult> {
    const ready = this.ensureReady();
    const helper = {
      async request<M extends HelperMethod>(method: M, p: HelperMethods[M]['params']): Promise<HelperMethods[M]['result']> {
        sent.requested = true;
        const result = await ready.request(method, p);
        sent.done = true;
        return result;
      },
    };
    // No input without a working emergency stop.
    if (!this.deps.stopKey.arm()) fail('stop_key_unavailable', STOP_KEY_UNAVAILABLE);
    if (params.action === 'openApp') fail('invalid_argument', 'openApp takes an app, not a snapshot');
    const generation = this.generation;
    if (!params.snapshotId) fail('invalid_argument', 'snapshotId is required; call getAppState first');
    const snapshotId = params.snapshotId;
    const snap = this.checkSnapshot(agent, snapshotId, this.now());
    // Keys and modifiers are checked before consent or the lock: a refused
    // chord raises no prompt and takes nothing.
    const keys = this.resolveKeys(params);
    // Consent may have been revoked (abort clears grants) since the snapshot.
    await this.vet(agent, snap.app, snap.window, generation);
    // Whether this helper can be told to stay in the background decides the
    // lane. Read from its hello: it starts the helper if none runs, which
    // the action needs anyway, and sends no request.
    const defer = (await ready.defersForeground?.()) === true;
    // Consent can take minutes; the clock and the stop key may both have
    // moved, so the snapshot and the cooldown are checked again on a fresh
    // clock before the lease, the slot and the rate slot are taken.
    this.assertCurrent(generation);
    let now = this.now();
    this.checkSnapshot(agent, snapshotId, now);

    const point = this.resolvePoint(params, snap);
    // The helper re-checks this window right before each input batch.
    const target = { pid: snap.window.pid, windowId: snap.window.id };
    const call = this.buildControlCall(params, snapshotId, target, point, keys);
    const send = (foreground?: 'allow' | 'refuse'): Promise<ActionResult> =>
      helper.request(call.method, (foreground ? { ...call.params, foreground } : call.params) as never) as Promise<ActionResult>;

    if (!defer) {
      // A helper that cannot defer real input: the single lease of before,
      // taken at once or refused at once (input_busy, not_delivered).
      return this.underLease(agent, now, sent, () => {
        this.checkRate(agent.key, now);
        this.deps.onControl?.({ agent, action: params.action, window: snap.window });
        return send();
      });
    }

    const foreground = foregroundCertain({
      action: params.action,
      button: params.button,
      clickCount: clampInt(params.clickCount ?? 1, 1, 3),
      modifiers: keys?.modifiers ?? params.modifiers,
      text: params.text,
    });
    // Every action on this app takes its slot first, foreground or not, so
    // one app's actions run in arrival order; other apps' agents never wait
    // on it. The wait happens outside the slot; everything that may have
    // changed meanwhile is checked again once it is held. Lock order is
    // always slot, then lease, and the lease never waits.
    const release = await this.lanes.acquire(target.pid);
    try {
      now = this.now();
      this.recheckInLane(agent, snapshotId, target.pid, generation, now);
      if (foreground) {
        const at = now;
        return await this.underLease(agent, at, sent, () => {
          this.checkRate(agent.key, at);
          this.deps.onControl?.({ agent, action: params.action, window: snap.window });
          return send('allow');
        });
      }
      // Charged once the action will really be sent: one that ended while
      // queued (a stop) costs no rate budget.
      this.checkRate(agent.key, now);
      this.deps.onControl?.({ agent, action: params.action, window: snap.window });
      try {
        return await send('refuse');
      } catch (err) {
        if (!(err instanceof ComputerError && err.code === 'needs_foreground')) throw err;
        // Re-sent only when the helper says nothing went out (protocol
        // ForegroundMode rule). Any other verdict ends here: a re-send could
        // deliver it twice.
        if (err.disposition !== 'not_delivered') throw needsForegroundAsInternal(err, sent);
      }
      // Upgrade, still holding the slot, so a later action on this app stays
      // behind it. Checked first, then the lease: a failed check never
      // leaves the lease held.
      sent.requested = false;
      now = this.now();
      this.recheckInLane(agent, snapshotId, target.pid, generation, now);
      return await this.underLease(agent, now, sent, () => send('allow'));
    } finally {
      release();
    }
  }

  /**
   * Real input under the foreground lease: takes it (input_busy at once when
   * another agent holds it), runs `send`, and only once that settles
   * (result, error or timeout) starts the lease's idle time. Until then the
   * lease stays busy, however long the request waits in the helper's queue,
   * so it cannot lapse while its own real input is still on the way. A
   * needs_foreground answer never reaches the agent.
   */
  private async underLease<T>(
    agent: ComputerAgent,
    now: number,
    sent: { requested: boolean },
    send: () => Promise<T>,
  ): Promise<T> {
    const ticket = this.lease.take(agent, now);
    try {
      return await send();
    } catch (err) {
      throw needsForegroundAsInternal(err, sent);
    } finally {
      this.lease.touch(ticket, this.now());
    }
  }

  /** The helper method and params of a control action (arguments validated here, before any lock). */
  private buildControlCall(
    params: ControlParams,
    snapshotId: string,
    target: { pid: number; windowId: string },
    point: { x: number; y: number } | undefined,
    keys: { modifiers: Modifier[]; key: Key } | null,
  ): { method: HelperMethod; params: object } {
    switch (params.action) {
      case 'click':
        this.requireTarget(params, point);
        return {
          method: 'click',
          params: {
            snapshotId,
            target,
            ...(params.index !== undefined && { index: params.index }),
            ...(point && { point }),
            button: params.button ?? 'left',
            clickCount: clampInt(params.clickCount ?? 1, 1, 3),
            modifiers: validModifiers(params.modifiers),
          },
        };
      case 'setValue':
        if (params.index === undefined) fail('invalid_argument', 'setValue needs an element index');
        if (typeof params.value !== 'string') fail('invalid_argument', 'setValue needs a string value');
        return { method: 'setValue', params: { snapshotId, target, index: params.index, value: params.value } };
      case 'type':
        if (typeof params.text !== 'string' || params.text.length === 0) fail('invalid_argument', 'type needs text');
        return {
          method: 'type',
          params: {
            snapshotId,
            target,
            ...(params.index !== undefined && { index: params.index }),
            text: params.text,
          },
        };
      case 'pressKey': {
        const { key } = keys ?? fail('internal', 'pressKey reached the helper without a resolved key');
        return { method: 'pressKey', params: { snapshotId, target, key, repeat: clampInt(params.repeat ?? 1, 1, 50) } };
      }
      case 'hotkey': {
        const { modifiers, key } = keys ?? fail('internal', 'hotkey reached the helper without a resolved chord');
        return { method: 'hotkey', params: { snapshotId, target, modifiers, key } };
      }
      case 'scroll':
        this.requireTarget(params, point);
        return {
          method: 'scroll',
          params: {
            snapshotId,
            target,
            ...(params.index !== undefined && { index: params.index }),
            ...(point && { point }),
            direction: params.direction ?? 'down',
            amount: clampInt(params.amount ?? 3, 1, 50),
          },
        };
      default:
        return fail('invalid_argument', `unknown action ${String((params as { action: unknown }).action)}`);
    }
  }

  /**
   * Launches the app if needed, brings it forward and makes sure it has a
   * window (helper `openApp`, optional). Input like the other control
   * actions: it needs the stop key, the input lock and a rate slot. The
   * selector is checked against the blocklist before anything launches, and
   * the app the helper opened is checked again after.
   */
  async openApp(agent: ComputerAgent, params: { app: string }): Promise<{ app: AppInfo; window: WindowInfo | null }> {
    let requested = false;
    try {
      return await this.dispatchOpenApp(agent, params, () => { requested = true; });
    } catch (err) {
      throw inputActionError(err, requested, false);
    }
  }

  private async dispatchOpenApp(
    agent: ComputerAgent,
    params: { app: string },
    onLaunch: () => void,
  ): Promise<{ app: AppInfo; window: WindowInfo | null }> {
    const helper = this.ensureReady();
    if (!this.deps.stopKey.arm()) fail('stop_key_unavailable', STOP_KEY_UNAVAILABLE);
    const generation = this.generation;
    if (typeof params.app !== 'string' || !params.app.trim()) fail('invalid_argument', 'openApp needs app');
    const coolingMs = this.abortedUntil - this.now();
    if (coolingMs > 0) fail('aborted', 'computer use was just stopped by the user');
    const ctx = this.deps.blockContext();
    const named = selectorBlockReasonFor(params.app, ctx);
    if (named) fail('app_blocked', `${params.app}: ${BLOCK_REASON_TEXT[named]}`);
    // A .app path can be named anything: judge it by its bundle id, and open
    // nothing whose bundle id cannot be read.
    const bundlePath = appBundleSelector(params.app);
    if (bundlePath) {
      const bundleId = this.deps.readBundleId ? await this.deps.readBundleId(bundlePath).catch(() => null) : null;
      this.assertCurrent(generation);
      if (!bundleId) {
        fail('app_not_found', `wmux could not read the bundle id of ${bundlePath}, so it does not open it; use the app's name or its listApps id`);
      }
      const byId = selectorBlockReasonFor(bundleId, ctx);
      if (byId) fail('app_blocked', `${params.app}: ${BLOCK_REASON_TEXT[byId]}`);
    }
    if (!(await this.helperSupports(helper, 'openApp'))) {
      fail('unsupported_action', 'this computer-use helper cannot open apps yet; open the app another way (or ask the user to), then use getAppState');
    }
    this.assertCurrent(generation);
    // With consent on, an app that is already running is asked about before
    // it is brought forward. One that is not running has nothing to show the
    // person yet, so it is asked about right after the launch.
    if (this.deps.askPerApp()) {
      const running = await helper.request('resolveTarget', { app: params.app }).catch(() => null);
      this.assertCurrent(generation);
      if (running) {
        assertConsistent(running.app, running.window);
        await this.vet(agent, running.app, running.window, generation);
      }
    }
    const now = this.now();
    // Launching and raising an app is always real (foreground) input; the
    // lease stays busy until the launch request settles.
    const opened = await this.underLease(agent, now, { requested: true }, () => {
      this.checkRate(agent.key, now);
      onLaunch();
      return helper.request('openApp', { app: params.app });
    });
    this.assertCurrent(generation);
    const reason = blockReasonFor(opened.app, this.deps.blockContext());
    if (reason) fail('app_blocked', `${opened.app.name}: ${BLOCK_REASON_TEXT[reason]}`);
    if (opened.window) {
      assertConsistent(opened.app, opened.window);
      await this.vet(agent, opened.app, opened.window, generation);
      this.deps.onControl?.({ agent, action: 'openApp', window: opened.window });
    }
    return opened;
  }

  /** Whether the helper's hello listed an optional method; starts the helper to find out. */
  private async helperSupports(helper: HelperLike, method: HelperMethod): Promise<boolean> {
    const known = helper.supports?.(method);
    if (known !== undefined) return known;
    const caps = await helper.request('capabilities', {});
    return helper.supports?.(method) ?? caps.actions.includes(method);
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
    this.lease.clear();
    // Every action still waiting for its app's slot ends `aborted` without
    // reaching the helper.
    this.lanes.abortWaiting();
    this.grants.clear();
    this.abortedUntil = this.now() + ABORT_COOLDOWN_MS;
  }

  /** Who holds real (foreground) input right now, for the overlay and status UI. */
  inputHolder(): string | null {
    return this.lease.label(this.now());
  }

  dispose(): void {
    this.disposed = true;
    markComputerUseShutDown();
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
      validModifiers(params.modifiers);
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

  /**
   * A snapshot this agent may act on now: not inside the stop cooldown,
   * known, not expired, and its own.
   */
  private checkSnapshot(agent: ComputerAgent, snapshotId: string, now: number): SnapshotRecord {
    if (now < this.abortedUntil) fail('aborted', 'computer use was just stopped by the user');
    const record = this.snapshots.get(snapshotId);
    if (!record || record.expiresAt < now) fail('snapshot_unknown', `snapshot ${snapshotId} is unknown or expired`);
    if (record.agentKey !== agent.key) fail('snapshot_unknown', 'that snapshot belongs to another agent');
    return record;
  }

  /**
   * The part of vet that needs no prompt: the blocklist, elevation and the
   * remembered answer. True when the app may be used now (consent given, or
   * not asked for); false when a prompt would be needed. Throws for a
   * blocked app, an elevated window or a remembered Deny.
   */
  private vetWithoutPrompt(agent: ComputerAgent, app: AppInfo, window: WindowInfo): boolean {
    const reason = blockReasonFor(app, this.deps.blockContext());
    if (reason) fail('app_blocked', `${app.name}: ${BLOCK_REASON_TEXT[reason]}`);
    if (window.elevated) {
      fail('target_elevated', `${app.name} runs as administrator; Windows blocks input from wmux into it`);
    }
    // Consent is opt-in: off, every app that passed the blocklist counts as consented.
    if (!this.deps.askPerApp()) return true;
    const granted = this.grants.get(grantKey(agent, app.id));
    if (granted === false) fail('app_blocked', `the user declined computer use of ${app.name} for this agent`);
    return granted === true;
  }

  private async vet(agent: ComputerAgent, app: AppInfo, window: WindowInfo, generation: number): Promise<void> {
    if (this.vetWithoutPrompt(agent, app, window)) return;
    const key = grantKey(agent, app.id);

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

  /**
   * After waiting for a pid slot: everything that may have changed while the
   * action waited, checked again without a prompt. Each failure is
   * not_delivered (nothing went to the helper).
   */
  private recheckInLane(agent: ComputerAgent, snapshotId: string, pid: number, generation: number, now: number): void {
    this.assertCurrent(generation);
    // The stop key may have been lost (another app took the chord) while
    // the action waited.
    if (!this.deps.stopKey.arm()) fail('stop_key_unavailable', STOP_KEY_UNAVAILABLE);
    const record = this.checkSnapshot(agent, snapshotId, now);
    if (record.window.pid !== pid) fail('internal', 'the snapshot window does not belong to the app this action waited for');
    if (!this.vetWithoutPrompt(agent, record.app, record.window)) {
      // A prompt is never raised while holding an app's slot: getAppState asks.
      fail('snapshot_unknown', `consent for ${record.app.name} is not given for this agent any more; call getAppState to ask again`);
    }
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

/**
 * Drops what cannot work without a missing OS permission, so an agent learns
 * up front instead of from a permission_missing error: no Accessibility, no
 * input (openApp included) and no tree; no Screen Recording, no screenshot.
 * getAppState goes when no observation mode is left.
 */
export function capabilitiesForAgent(caps: HelperCapabilities): AgentCapabilities {
  const missing: Array<'accessibility' | 'screenRecording'> = [];
  if (!caps.permissions.accessibility) missing.push('accessibility');
  if (!caps.permissions.screenRecording) missing.push('screenRecording');
  if (missing.length === 0) return caps;
  const control: ReadonlySet<string> = new Set(COMPUTER_CONTROL_ACTIONS);
  const modes = caps.modes.filter((m) =>
    m === 'ax' ? caps.permissions.accessibility
      : m === 'vision' ? caps.permissions.screenRecording
        : caps.permissions.accessibility && caps.permissions.screenRecording);
  const actions = caps.actions.filter((a) =>
    (caps.permissions.accessibility || !control.has(a)) && (a !== 'getAppState' || modes.length > 0));
  // No Accessibility, no input at all: background ways of sending it do not apply.
  const { input, ...rest } = caps;
  return { ...rest, ...(caps.permissions.accessibility && input ? { input } : {}), actions, modes, missingPermissions: missing };
}

/**
 * needs_foreground is internal to main: an agent never sees the code. Every
 * place that would surface it goes through here. With `not_delivered` the
 * helper says nothing went out for the action, so the error stays
 * `not_delivered`; any other verdict may have sent input and is
 * `delivered_unverified`. Other errors pass through unchanged.
 */
function needsForegroundAsInternal(err: unknown, sent: { requested: boolean }): unknown {
  if (!(err instanceof ComputerError && err.code === 'needs_foreground')) return err;
  const nothingSent = err.disposition === 'not_delivered';
  if (nothingSent) sent.requested = false;
  return new ComputerError(
    'internal',
    nothingSent
      ? 'the computer-use helper refused real input it was allowed to use; nothing was sent'
      : `the computer-use helper asked for real input after it may have sent some (${err.message}); nothing more was sent`,
    nothingSent ? 'not_delivered' : 'delivered_unverified',
  );
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
