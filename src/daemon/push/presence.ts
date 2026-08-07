// Is the person already looking at the desktop app?
//
// A push exists to reach somebody who is not at the machine. When the desktop
// app is open, connected, and its window was focused moments ago, the phone
// buzzing is pure noise — the same approval is already sitting in the in-app
// inbox that the user is staring at. This module answers "is the desktop
// present?" and nothing else.
//
// Deliberately NOT inside PushSender. The decision is about the human, not
// about the transport: an approval push, a webhook, and any future sink all
// want the same answer, and a predicate that lives in one sender's internals
// can only ever be consulted by that sender. Call sites ask this module and
// then decide.
//
// Two bits are required, never one. "A client is connected" is not presence —
// the desktop app stays connected while it sits minimized behind a full-screen
// editor for an hour. "A window was focused at time T" is not presence either
// once T is old enough. Presence is connected AND recently focused.
//
// Suppression is a DEFERRAL, not a drop. See `DeferredPushQueue` below: a
// suppressed push is parked and delivered the moment presence goes away while
// the approval is still pending. Suppressing without that is data loss — the
// user walks away from a focused window and the prompt they were meant to
// answer from the phone never arrives.

import { PUSH_RISK_CRITICAL, type PushPayload } from '../../shared/push/pushEnvelope';

/**
 * How long a focus report stays believable.
 *
 * The desktop reports focus on transition, not on a timer, so a user who
 * focused the window and then walked away leaves a report that ages without
 * ever being contradicted. Ninety seconds is short enough that "stepped away"
 * stops counting as present within the lifetime of a single approval prompt,
 * and long enough that a person reading a card for a minute is not suddenly
 * declared absent.
 */
export const DESKTOP_PRESENCE_STALE_AFTER_MS = 90_000;

/**
 * Hard ceiling on a configured freshness window.
 *
 * A large finite `staleAfterMs` is not a preference, it is an outage: one
 * focus report would suppress every push for as long as it stood. Ten minutes
 * is already far past any honest reading of "the user is at the desk right
 * now", so anything above it is clamped rather than honoured.
 */
export const DESKTOP_PRESENCE_STALE_CAP_MS = 10 * 60_000;

/**
 * A critical-risk approval is pushed even when the desktop is present.
 *
 * This is a deliberate exception to the whole feature, not an oversight. The
 * suppression trades a notification for quiet, and that trade is only worth
 * making for routine prompts. A destructive action deserves the second channel
 * — the cost of a redundant buzz is annoyance, the cost of a missed one is a
 * `DELETE FROM users` that got approved by somebody who never saw it, or an
 * unanswered gate blocking an agent because the user actually was away and the
 * stale-window heuristic guessed wrong.
 */
export const CRITICAL_RISK_IGNORES_PRESENCE = true;

/** One desktop client's last focus report. */
export interface DesktopClientReport {
  /** Was the last report a focus (`true`) or a blur (`false`)? */
  focused: boolean;
  /** When that report arrived, epoch ms. */
  reportedAt: number;
}

/**
 * What the daemon currently believes about the desktop app.
 *
 * A LIST, not a single slot. One slot was last-writer-wins, and that is two
 * bugs at once: a second client (a second window, a reconnect racing its own
 * close) could overwrite a real blur back into presence, and the real client's
 * later disconnect was then ignored because the id no longer matched. An empty
 * list is a daemon that has heard nothing — headless, or an app too old to send
 * the RPC — and is never treated as presence.
 */
export interface DesktopPresenceState {
  clients: DesktopClientReport[];
}

/** The state of a daemon that has heard nothing from any desktop app. */
export function emptyDesktopPresence(): DesktopPresenceState {
  return { clients: [] };
}

/** Knobs from `DaemonConfig.pushPresenceSuppression`, already normalised. */
export interface PushPresenceSuppressionConfig {
  enabled: boolean;
  staleAfterMs: number;
}

/**
 * The reading to fall back on whenever the config cannot be trusted — missing
 * slice, unreadable file, malformed JSON.
 *
 * OFF, i.e. send. An indeterminate config must not switch on a feature whose
 * whole effect is to withhold a notification; the fail-open direction for this
 * subsystem is always "the phone rings".
 */
export function failOpenPresenceConfig(): PushPresenceSuppressionConfig {
  return { enabled: false, staleAfterMs: DESKTOP_PRESENCE_STALE_AFTER_MS };
}

/**
 * Is the desktop app both attached and recently at the user's attention?
 *
 * True when ANY reporting client is freshly focused. Two windows open with one
 * of them focused is still the user being present.
 *
 * Fails toward "absent" on every uncertainty: no reports, only blurs, reports
 * older than the freshness window, or a nonsense clock all answer `false`, and
 * `false` is what lets the push through.
 */
export function isDesktopPresent(
  state: DesktopPresenceState,
  now: number,
  staleAfterMs: number = DESKTOP_PRESENCE_STALE_AFTER_MS,
): boolean {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) return false;
  const window = Math.min(staleAfterMs, DESKTOP_PRESENCE_STALE_CAP_MS);
  return state.clients.some((c) => {
    if (!c.focused) return false;
    const age = now - c.reportedAt;
    // A future-dated report (clock step, or a client that sent its own clock)
    // is not evidence of anything; only a report in the recent past counts.
    if (age < 0) return false;
    return age <= window;
  });
}

export interface SuppressPushInput {
  state: DesktopPresenceState;
  now: number;
  config: PushPresenceSuppressionConfig;
  /**
   * The risk tier already stamped on the payload. `critical` is pushed
   * regardless — see {@link CRITICAL_RISK_IGNORES_PRESENCE}.
   */
  risk?: PushPayload['risk'];
}

/**
 * Should this push be HELD because the user is already looking at it?
 *
 * The event itself is unaffected — it has already reached the in-app inbox by
 * the time anybody asks this. Only the phone's copy is at stake, and only its
 * timing: a held push is parked, not discarded.
 */
export function shouldSuppressPush(input: SuppressPushInput): boolean {
  if (!input.config.enabled) return false;
  if (CRITICAL_RISK_IGNORES_PRESENCE && input.risk === PUSH_RISK_CRITICAL) return false;
  return isDesktopPresent(input.state, input.now, input.config.staleAfterMs);
}

/**
 * The mutable half: what the presence RPC writes and the predicate reads.
 *
 * Keyed by pipe client id, so a socket close removes exactly one client's
 * report and nothing else. Only first-party clients are ever admitted — the
 * caller enforces that, because the pipe server owns the classification.
 */
export class DesktopPresenceTracker {
  private readonly reports = new Map<string, DesktopClientReport>();

  /** Record a focus/blur transition reported by a desktop client. */
  report(clientId: string, focused: boolean, at: number): void {
    this.reports.set(clientId, { focused, reportedAt: at });
  }

  /** A client's pipe closed. Removes only that client's report. */
  forget(clientId: string): void {
    this.reports.delete(clientId);
  }

  snapshot(): DesktopPresenceState {
    return { clients: [...this.reports.values()].map((r) => ({ ...r })) };
  }
}

export interface PresenceRpcHandlerDeps {
  /** The pipe server's classification. See `DaemonPipeServer.markFirstParty`. */
  isFirstParty: (clientId: string) => boolean;
  tracker: DesktopPresenceTracker;
  /** Called after a report lands, so a held push can be released on a blur. */
  onPresenceChanged: () => void;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface PresenceRpcResult {
  ok: boolean;
  reason?: string;
}

/**
 * The `daemon.presence.desktop` handler, as a testable unit.
 *
 * FIRST-PARTY ONLY. This method is a request to WITHHOLD a notification, so an
 * unauthenticated caller — the MCP server, the CLI, or an agent talked into it
 * by prompt injection — could otherwise report `focused:true` on a loop and
 * silence the approval pushes for its own gated tool calls. That is the one
 * way this feature turns into a security hole rather than a convenience.
 *
 * Honest scope, as with the transcript RPCs: this is a classification over one
 * shared token, not a second credential. It removes the accidental and
 * prompt-injection paths, not a local attacker holding the token.
 */
export function createPresenceRpcHandler(
  deps: PresenceRpcHandlerDeps,
): (params: Record<string, unknown>, clientId: string) => PresenceRpcResult {
  const now = deps.now ?? Date.now;
  return (params, clientId) => {
    if (!deps.isFirstParty(clientId)) {
      deps.log?.(
        'warn',
        `[push] ignored presence report from non-first-party client ${clientId}`,
      );
      return { ok: false, reason: 'not-authorized' };
    }
    deps.tracker.report(clientId, params['focused'] === true, now());
    deps.onPresenceChanged();
    return { ok: true };
  };
}

// ── Deferred delivery ────────────────────────────────────────────────────────

/**
 * How many held pushes are remembered.
 *
 * Same reasoning as `PUSH_QUEUE_CAP`: these are "someone is blocked on you"
 * events, and a backlog past a couple of dozen is a sign nobody is answering
 * anyway. Drop-oldest keeps the ones still worth delivering.
 */
export const DEFERRED_PUSH_CAP = 32;

/**
 * Slack added to the stale horizon before the queue re-checks presence.
 *
 * The timer exists to catch the case where presence expires by AGE with no
 * transition to hook on — a user who focused the window and walked away
 * without locking the screen. Firing a moment after the window closes rather
 * than exactly on it avoids a re-arm loop from millisecond rounding.
 */
export const DEFERRED_PUSH_TIMER_SLACK_MS = 1_000;

interface ParkedPush {
  payload: PushPayload;
  collapseId?: string;
}

export interface DeferredPushQueueDeps {
  /** Hand a payload to the sender. Same collapseId as the original attempt. */
  send: (payload: PushPayload, opts: { collapseId?: string }) => void;
  /** Ask the predicate whether the desktop is present RIGHT NOW. */
  isPresent: () => boolean;
  /** The freshness window in force, for sizing the re-check timer. */
  staleAfterMs: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Pushes held back by presence, waiting for the user to actually leave.
 *
 * Two release paths, because presence can end two ways. A TRANSITION (blur,
 * screen lock, the app quitting) is reported and calls `onPresenceChanged`.
 * An EXPIRY has nobody to report it — the user simply walked away — so a
 * single timer at the freshness horizon re-checks and releases.
 *
 * An approval that gets answered or expires while parked is dropped rather
 * than sent: the notification was asking for the thing that already happened.
 */
export class DeferredPushQueue {
  private readonly parked = new Map<string, ParkedPush>();
  private readonly deps: DeferredPushQueueDeps;
  private readonly now: () => number;
  private readonly setTimerImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerImpl: (handle: unknown) => void;
  private timer: unknown = null;

  constructor(deps: DeferredPushQueueDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimerImpl =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // A held notification must never be the reason a daemon stays up.
        t.unref?.();
        return t;
      });
    this.clearTimerImpl = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get size(): number {
    return this.parked.size;
  }

  /** Hold a push that presence suppressed, and arm the expiry re-check. */
  park(approvalId: string, payload: PushPayload, collapseId?: string): void {
    if (!this.parked.has(approvalId) && this.parked.size >= DEFERRED_PUSH_CAP) {
      const oldest = this.parked.keys().next();
      if (!oldest.done) this.parked.delete(oldest.value);
    }
    this.parked.set(approvalId, { payload, ...(collapseId ? { collapseId } : {}) });
    this.arm();
  }

  /** The approval was answered, expired, or superseded — the push is moot. */
  forget(approvalId: string): void {
    this.parked.delete(approvalId);
    if (this.parked.size === 0) this.disarm();
  }

  /**
   * Presence may have changed (a report arrived, or a client disconnected).
   * Releases everything if the desktop is no longer present.
   */
  onPresenceChanged(): void {
    if (this.parked.size === 0) return;
    if (this.deps.isPresent()) {
      this.arm();
      return;
    }
    this.release();
  }

  /** Drop every held push without sending. For daemon shutdown. */
  dispose(): void {
    this.parked.clear();
    this.disarm();
  }

  private release(): void {
    const entries = [...this.parked.entries()];
    this.parked.clear();
    this.disarm();
    for (const [approvalId, item] of entries) {
      // The approval id only — never the question or the choices.
      this.deps.log?.('info', `[push] desktop went away, delivering held push for ${approvalId}`);
      this.deps.send(item.payload, item.collapseId ? { collapseId: item.collapseId } : {});
    }
  }

  private arm(): void {
    this.disarm();
    if (this.parked.size === 0) return;
    const window = this.deps.staleAfterMs();
    const delay =
      (Number.isFinite(window) && window > 0
        ? Math.min(window, DESKTOP_PRESENCE_STALE_CAP_MS)
        : DESKTOP_PRESENCE_STALE_AFTER_MS) + DEFERRED_PUSH_TIMER_SLACK_MS;
    this.timer = this.setTimerImpl(() => {
      this.timer = null;
      if (this.parked.size === 0) return;
      // Still present means a fresher report landed after we armed; wait again.
      if (this.deps.isPresent()) {
        this.arm();
        return;
      }
      this.release();
    }, delay);
  }

  private disarm(): void {
    if (this.timer !== null) {
      this.clearTimerImpl(this.timer);
      this.timer = null;
    }
  }
}
