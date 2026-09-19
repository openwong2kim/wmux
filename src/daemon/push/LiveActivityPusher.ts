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
  /**
   * 410 on an update: this activity is gone. NEVER the push registration.
   *
   * The TOKEN is named, not just the device: a registration can land while the
   * refused request was in flight, and dropping whatever is stored now would
   * throw away a token Apple never refused.
   */
  forgetLiveActivityToken: (deviceId: string, token: string) => void;
  /** 410 on a start: this push-to-start token is gone. Named, as above. */
  forgetPushToStartToken: (deviceId: string, token: string) => void;
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
 * The ceiling on that settling.
 *
 * A trailing-edge debounce alone has no ceiling: approvals arriving every
 * 1.9 seconds reset the timer forever and the lock screen never hears anything
 * at all — the exact traffic pattern where somebody is most obviously blocked.
 * Once the first event of a burst is this old, the next one flushes on the spot
 * instead of pushing the deadline out again.
 */
export const LIVE_ACTIVITY_DEBOUNCE_MAX_WAIT_MS = 10_000;

/**
 * A started activity that never receives its first update should retire itself
 * in five minutes rather than sit there claiming a stale count. The activity
 * token can take a moment to arrive — or, if iOS never wakes the app, never.
 */
export const LIVE_ACTIVITY_START_STALE_SEC = 300;

/**
 * The relay's cap on `attributes.daemonName`, mirrored here so the daemon cuts
 * rather than earning a `400 bad-attributes` on a start it cannot re-send.
 */
export const LIVE_ACTIVITY_DAEMON_NAME_MAX = 64;

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
  /**
   * When a `start` was last put on the wire for a device that has no activity
   * token yet, in epoch seconds. Deleted the moment a token shows up.
   *
   * The token comes back through the phone — the app has to be woken, read it
   * off the started activity and POST it to the daemon — and the approval
   * numbers can change several times before that round trip lands. Without this
   * memory every one of those changes fires ANOTHER start, and iOS obliges:
   * the lock screen ends up with a stack of activities all claiming to be the
   * one activity this daemon shows.
   */
  private readonly startSentAt = new Map<string, number>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the burst the pending timer belongs to began. Null between bursts. */
  private debounceStartedAt: number | null = null;

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
    const now = this.now();
    if (this.debounceStartedAt === null) this.debounceStartedAt = now;
    else if (now - this.debounceStartedAt >= LIVE_ACTIVITY_DEBOUNCE_MAX_WAIT_MS) {
      // The ceiling. Send what we have NOW and do not arm another timer — a
      // steady drip of approvals must not be able to hold the lock screen back
      // indefinitely by resetting the deadline on every arrival.
      if (this.debounceTimer) this.clearTimeoutImpl(this.debounceTimer);
      this.debounceTimer = null;
      this.debounceStartedAt = null;
      this.deps.transport.enqueue(() => this.sendNow());
      return;
    }
    if (this.debounceTimer) this.clearTimeoutImpl(this.debounceTimer);
    this.debounceTimer = this.setTimeoutImpl(() => {
      this.debounceTimer = null;
      this.debounceStartedAt = null;
      this.deps.transport.enqueue(() => this.sendNow());
    }, LIVE_ACTIVITY_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /** Test seam: drop a pending debounce and wait for the queue to empty. */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      this.clearTimeoutImpl(this.debounceTimer);
      this.debounceTimer = null;
      this.debounceStartedAt = null;
      this.deps.transport.enqueue(() => this.sendNow());
    }
    await this.deps.transport.flush();
  }

  private async sendNow(): Promise<void> {
    const counts = this.deps.counts();
    for (const target of this.deps.targets()) {
      // One device's failure is its own. The transport already turns network
      // errors into a status, but forgetting a dead token writes the device
      // store, and a throw there must not skip every device after it.
      try {
        await this.sendToDevice(target, counts);
      } catch (err) {
        this.deps.log?.('warn', `[live-activity] send to ${target.deviceId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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

    const nowSec = Math.floor(this.now() / 1000);
    const event = pickEvent(liveActivity, counts, this.startSentAt.get(deviceId), nowSec);
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
      // An update or an end means an activity token was in hand, so whatever
      // start is outstanding has landed and its suppression is spent.
      if (event === 'start') this.startSentAt.set(deviceId, nowSec);
      else this.startSentAt.delete(deviceId);
      if (event === 'end') {
        // The activity this token addressed no longer exists.
        this.lastSent.delete(deviceId);
        this.deps.forgetLiveActivityToken(deviceId, apnsToken);
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
      this.startSentAt.delete(deviceId);
      if (event === 'start') this.deps.forgetPushToStartToken(deviceId, apnsToken);
      else this.deps.forgetLiveActivityToken(deviceId, apnsToken);
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
    if (!daemonName) return {};
    // CUT TO THE RELAY'S CAP. This is a hostname, which nobody promised to keep
    // short, and the relay answers `400 bad-attributes` over 64 characters —
    // which would fail the START, the one event that cannot be retried into
    // existence later. A truncated machine name on the lock screen is a worse
    // label; no activity at all is no lock screen.
    return { daemonName: daemonName.slice(0, LIVE_ACTIVITY_DAEMON_NAME_MAX) };
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
  startSentAt: number | undefined,
  nowSec: number,
): LiveActivityEvent | null {
  if (liveActivity.activityToken) {
    return counts.pendingApprovals === 0 ? 'end' : 'update';
  }
  if (counts.pendingApprovals > 0 && liveActivity.pushToStartToken) {
    // ONE start until its activity token comes back, or until the activity it
    // started has gone stale anyway. The token arrives through the phone, and
    // the numbers move while it is in flight — firing a start per change would
    // stack activities on the lock screen, all of them this daemon's.
    //
    // After the stale window the previous activity has already stopped being
    // shown as current, so a fresh start is the only way back.
    if (startSentAt !== undefined && nowSec - startSentAt < LIVE_ACTIVITY_START_STALE_SEC) {
      return null;
    }
    return 'start';
  }
  return null;
}
