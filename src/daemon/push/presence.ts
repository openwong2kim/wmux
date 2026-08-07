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

/** What the daemon currently believes about the desktop app. */
export interface DesktopPresenceState {
  /** Is a desktop client's control pipe open right now? */
  connected: boolean;
  /** Was the last focus report a focus (`true`) or a blur (`false`)? */
  focused: boolean;
  /**
   * When that report arrived, epoch ms. `null` means the desktop never told us
   * anything — a headless daemon, or an app too old to send the RPC. Never
   * treated as presence.
   */
  reportedAt: number | null;
}

/** The state of a daemon that has heard nothing from any desktop app. */
export function emptyDesktopPresence(): DesktopPresenceState {
  return { connected: false, focused: false, reportedAt: null };
}

/** Knobs from `DaemonConfig.pushPresenceSuppression`, already normalised. */
export interface PushPresenceSuppressionConfig {
  enabled: boolean;
  staleAfterMs: number;
}

/**
 * Is the desktop app both attached and recently at the user's attention?
 *
 * Fails toward "absent" on every uncertainty: no report, a blur, a report older
 * than the freshness window, a disconnected client, or a nonsense clock all
 * answer `false`, and `false` is what lets the push through.
 */
export function isDesktopPresent(
  state: DesktopPresenceState,
  now: number,
  staleAfterMs: number = DESKTOP_PRESENCE_STALE_AFTER_MS,
): boolean {
  if (!state.connected) return false;
  if (!state.focused) return false;
  if (state.reportedAt === null) return false;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) return false;
  const age = now - state.reportedAt;
  // A future-dated report (clock step, or a client that sent its own clock)
  // is not evidence of anything; only a report in the recent past counts.
  if (age < 0) return false;
  return age <= staleAfterMs;
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
 * Should this push be skipped because the user is already looking at it?
 *
 * The event itself is unaffected — it has already reached the in-app inbox by
 * the time anybody asks this. Only the phone's copy is at stake.
 */
export function shouldSuppressPush(input: SuppressPushInput): boolean {
  if (!input.config.enabled) return false;
  if (CRITICAL_RISK_IGNORES_PRESENCE && input.risk === PUSH_RISK_CRITICAL) return false;
  return isDesktopPresent(input.state, input.now, input.config.staleAfterMs);
}

/**
 * The mutable half: what the presence RPC writes and the predicate reads.
 *
 * Single-client on purpose. There is one desktop app per daemon in practice,
 * and "any connected desktop is focused" is the reading that matters anyway —
 * if two were ever open, one of them being focused is still the user being
 * present. The client id is kept only so a disconnect can retract a report
 * that a LATER client has since replaced.
 */
export class DesktopPresenceTracker {
  private state: DesktopPresenceState = emptyDesktopPresence();
  private clientId: string | null = null;

  /** Record a focus/blur transition reported by a desktop client. */
  report(clientId: string, focused: boolean, at: number): void {
    this.clientId = clientId;
    this.state = { connected: true, focused, reportedAt: at };
  }

  /**
   * A client went away. Only the client that owns the current report can
   * retract it — a second app closing must not blank a live one's presence.
   */
  forget(clientId: string): void {
    if (this.clientId !== clientId) return;
    this.clientId = null;
    this.state = emptyDesktopPresence();
  }

  snapshot(): DesktopPresenceState {
    return { ...this.state };
  }
}
