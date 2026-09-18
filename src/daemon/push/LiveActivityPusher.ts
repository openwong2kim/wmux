// The daemon's half of "the lock screen keeps following this machine after iOS
// stops running the app".
//
// A Live Activity push is NOT a notification. It never runs the Notification
// Service Extension, so there is nowhere on-device to open a sealed envelope,
// and the content-state travels as plaintext. That is why what leaves here is
// six integers and nothing else — no pane name, no workspace, no question text.
// See §7 of docs/phone-client-contract.md, where the exception to the relay's
// blindness claim is written down.
//
// The firing rule is deliberately stingy. iOS budgets how often a remote
// activity may be updated, and the remote activity has no agent rows to show —
// so spending an update on "one agent went from working to idle" buys a number
// nobody can see and costs the budget that the next pending approval needs.

import type { RelayTransport } from './RelayTransport';

/** The six integers the lock screen shows. Nothing else is ever sent. */
export interface LiveActivityCounts {
  pendingApprovals: number;
  runningAgents: number;
  workingAgents: number;
  idleAgents: number;
  blockedPanes: number;
  /** Null when nothing is blocked — the widget draws no age at all then. */
  oldestBlockedMinutes: number | null;
}

export interface LiveActivityTarget {
  deviceId: string;
  liveActivity: {
    pushToStartToken?: string;
    activityToken?: string;
    apnsEnvironment?: 'development' | 'production';
  };
}

export interface LiveActivityPusherDeps {
  transport: RelayTransport;
  /** Devices with a Live Activity registration. Re-read per send. */
  targets: () => LiveActivityTarget[];
  /** The current numbers, as the daemon judges them. */
  counts: () => LiveActivityCounts;
  /** 410 on an update: this activity is gone. NEVER the push registration. */
  forgetLiveActivityToken: (deviceId: string) => void;
  /** 410 on a start: this push-to-start token is gone. */
  forgetPushToStartToken: (deviceId: string) => void;
  /** Shown on the activity when the daemon starts it. Optional. */
  daemonName?: () => string | undefined;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for tests. */
  now?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * How long approval churn is allowed to settle before the lock screen hears
 * about it.
 *
 * A single tool call can create, supersede and resolve inside a second. Pushing
 * each of those spends the update budget on numbers that were never true for
 * long enough to read.
 */
export const LIVE_ACTIVITY_DEBOUNCE_MS = 2_000;

/**
 * A started activity that never receives its first update should retire itself
 * in five minutes rather than sit there claiming a stale count. The activity
 * token can take a moment to arrive — or, if iOS never wakes the app, never.
 */
export const LIVE_ACTIVITY_START_STALE_SEC = 300;

/** An updated activity is trusted for twenty minutes, matching the app's own. */
export const LIVE_ACTIVITY_UPDATE_STALE_SEC = 1_200;

type LiveActivityEvent = 'start' | 'update' | 'end';

interface LastSent {
  pendingApprovals: number;
  blockedPanes: number;
  oldestBlockedMinutes: number | null;
  /** Which activity these numbers were sent to. A new one resets the memory. */
  activityToken: string | undefined;
}

export class LiveActivityPusher {
  private readonly deps: LiveActivityPusherDeps;
  private readonly now: () => number;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly lastSent = new Map<string, LastSent>();
  /**
   * Last `aps.timestamp` per device, kept OUTSIDE `lastSent` so it survives a
   * token change. APNs silently drops an activity update whose timestamp is not
   * greater than the last one it accepted, and two changes inside one second
   * are ordinary — so the sequence has to keep climbing even when the memory of
   * what was sent is thrown away.
   */
  private readonly lastTimestamp = new Map<string, number>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: LiveActivityPusherDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = deps.clearTimeoutImpl ?? ((h) => clearTimeout(h));
  }

  get enabled(): boolean {
    return this.deps.transport.enabled;
  }

  /**
   * Something happened to the approval roster. Returns immediately: the actual
   * decision runs after the debounce, against the numbers as they are THEN.
   */
  onApprovalsChanged(): void {
    if (!this.enabled) return;
    if (this.debounceTimer) this.clearTimeoutImpl(this.debounceTimer);
    this.debounceTimer = this.setTimeoutImpl(() => {
      this.debounceTimer = null;
      this.deps.transport.enqueue(() => this.sendNow());
    }, LIVE_ACTIVITY_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /** Test seam: drop a pending debounce and wait for the queue to empty. */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      this.clearTimeoutImpl(this.debounceTimer);
      this.debounceTimer = null;
      this.deps.transport.enqueue(() => this.sendNow());
    }
    await this.deps.transport.flush();
  }

  private async sendNow(): Promise<void> {
    const counts = this.deps.counts();
    for (const target of this.deps.targets()) {
      await this.sendToDevice(target, counts);
    }
  }

  private async sendToDevice(target: LiveActivityTarget, counts: LiveActivityCounts): Promise<void> {
    const { deviceId, liveActivity } = target;
    let remembered = this.lastSent.get(deviceId);
    // A rotated or re-registered activity is a DIFFERENT activity, and the
    // numbers it was shown are not the numbers this one was. Without this the
    // "same numbers, do not send" rule below would suppress the first update
    // after a rotate and leave the new activity empty until the next change.
    if (remembered && remembered.activityToken !== liveActivity.activityToken) {
      this.lastSent.delete(deviceId);
      remembered = undefined;
    }

    const event = pickEvent(liveActivity, counts);
    if (event === null) return;

    // WHAT MAY TRIGGER A SEND: the approval numbers only. The agent counts ride
    // along at their latest value, but a change confined to them is not worth an
    // update the lock screen has no row to show it in.
    if (
      remembered &&
      remembered.pendingApprovals === counts.pendingApprovals &&
      remembered.blockedPanes === counts.blockedPanes &&
      remembered.oldestBlockedMinutes === counts.oldestBlockedMinutes
    ) {
      return;
    }

    const apnsToken =
      event === 'start' ? liveActivity.pushToStartToken : liveActivity.activityToken;
    if (!apnsToken) return;

    const nowSec = Math.floor(this.now() / 1000);
    const timestamp = Math.max(nowSec, (this.lastTimestamp.get(deviceId) ?? 0) + 1);
    this.lastTimestamp.set(deviceId, timestamp);

    const status = await this.deps.transport.post('/live', {
      apnsToken,
      ...(liveActivity.apnsEnvironment
        ? { apnsEnvironment: liveActivity.apnsEnvironment }
        : {}),
      event,
      contentState: {
        pendingApprovals: counts.pendingApprovals,
        runningAgents: counts.runningAgents,
        workingAgents: counts.workingAgents,
        idleAgents: counts.idleAgents,
        blockedPanes: counts.blockedPanes,
        oldestBlockedMinutes: counts.oldestBlockedMinutes,
      },
      ...(event === 'start' ? { attributes: this.startAttributes() } : {}),
      ...(event === 'end'
        ? // Without a dismissal date the activity lingers on the lock screen for
          // up to four hours after the thing it was reporting is over.
          { dismissalDate: nowSec }
        : {
            staleDate:
              nowSec +
              (event === 'start' ? LIVE_ACTIVITY_START_STALE_SEC : LIVE_ACTIVITY_UPDATE_STALE_SEC),
          }),
      timestamp,
    });

    if (status === 200) {
      this.deps.transport.noteDelivered();
      if (event === 'end') {
        // The activity this token addressed no longer exists.
        this.lastSent.delete(deviceId);
        this.deps.forgetLiveActivityToken(deviceId);
        return;
      }
      this.lastSent.set(deviceId, {
        pendingApprovals: counts.pendingApprovals,
        blockedPanes: counts.blockedPanes,
        oldestBlockedMinutes: counts.oldestBlockedMinutes,
        activityToken: liveActivity.activityToken,
      });
      return;
    }

    if (status === 410) {
      // ONE token, never the push registration. An activity token dies every
      // time an activity ends, which is routine — forgetting the device's
      // approval notifications alongside it would switch them off several times
      // a day, from a signal that means nothing of the sort.
      this.lastSent.delete(deviceId);
      if (event === 'start') this.deps.forgetPushToStartToken(deviceId);
      else this.deps.forgetLiveActivityToken(deviceId);
      return;
    }

    // Everything else is a relay or transport problem. The transport logs a
    // distinct status once rather than one line per attempt, and the daemon
    // carries on: a lock screen that stopped updating is not worth a single
    // stalled approval.
    this.deps.transport.noteFailure(deviceId, status);
  }

  private startAttributes(): Record<string, unknown> {
    const daemonName = this.deps.daemonName?.();
    return daemonName ? { daemonName } : {};
  }
}

/**
 * Which APNs event this device needs, or null for "nothing to do".
 *
 * DELIBERATELY BLIND TO WHETHER THE APP IS IN THE FOREGROUND. The daemon cannot
 * see the phone's scene phase, and the alternative to starting anyway is losing
 * the activity in the case it exists for — a pending approval on a phone whose
 * owner locked it. The cost is an activity on the lock screen while its owner
 * is looking at the app, which the app overwrites with its own fuller snapshot.
 */
function pickEvent(
  liveActivity: LiveActivityTarget['liveActivity'],
  counts: LiveActivityCounts,
): LiveActivityEvent | null {
  if (liveActivity.activityToken) {
    return counts.pendingApprovals === 0 ? 'end' : 'update';
  }
  if (counts.pendingApprovals > 0 && liveActivity.pushToStartToken) return 'start';
  return null;
}
