import { describe, it, expect, vi } from 'vitest';

import {
  LIVE_ACTIVITY_DEBOUNCE_MS,
  LIVE_ACTIVITY_START_STALE_SEC,
  LIVE_ACTIVITY_UPDATE_STALE_SEC,
  LiveActivityPusher,
  type LiveActivityCounts,
  type LiveActivityTarget,
} from '../LiveActivityPusher';
import { RelayTransport } from '../RelayTransport';

const START = 'a'.repeat(64);
const ACTIVITY = 'b'.repeat(64);
const ACTIVITY_2 = 'c'.repeat(64);

const NOW = 1_700_000_000_000;

function counts(over: Partial<LiveActivityCounts> = {}): LiveActivityCounts {
  return {
    pendingApprovals: 0,
    runningAgents: 0,
    workingAgents: 0,
    idleAgents: 0,
    blockedPanes: 0,
    oldestBlockedMinutes: null,
    ...over,
  };
}

interface Harness {
  pusher: LiveActivityPusher;
  calls: Array<{ url: string; body: Record<string, any> }>;
  logs: Array<[string, string]>;
  forgotActivity: string[];
  forgotPushToStart: string[];
  setCounts: (c: LiveActivityCounts) => void;
  setTargets: (t: LiveActivityTarget[]) => void;
  /** Fires the pending debounce, then drains the queue. */
  tick: () => Promise<void>;
  pendingTimers: number;
  setNow: (ms: number) => void;
}

function harness(
  opts: {
    statuses?: Array<number | 'throw'>;
    targets?: LiveActivityTarget[];
    counts?: LiveActivityCounts;
    daemonName?: string;
  } = {},
): Harness {
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  const logs: Array<[string, string]> = [];
  const forgotActivity: string[] = [];
  const forgotPushToStart: string[] = [];
  const statuses = opts.statuses ?? [];
  let statusAt = 0;
  let current = opts.counts ?? counts();
  let targets = opts.targets ?? [];
  let now = NOW;

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const next = statuses[Math.min(statusAt, statuses.length - 1)] ?? 200;
    statusAt += 1;
    if (next === 'throw') throw new Error('relay is down');
    return new Response('', { status: next });
  }) as unknown as typeof fetch;

  // Deliberately a real queue: the cap, the one retry and the log-once rule are
  // the transport's, and this pusher is supposed to inherit them rather than
  // grow its own.
  const transport = new RelayTransport({
    relayUrl: 'https://relay.example',
    relaySecret: 'shh',
    fetchImpl,
    sleep: async () => undefined,
    now: () => now,
    log: (level, message) => logs.push([level, message]),
    tag: '[live-activity]',
    noun: 'update',
  });

  let fire: (() => void) | null = null;
  const pusher = new LiveActivityPusher({
    transport,
    targets: () => targets,
    counts: () => current,
    forgetLiveActivityToken: (id) => forgotActivity.push(id),
    forgetPushToStartToken: (id) => forgotPushToStart.push(id),
    ...(opts.daemonName ? { daemonName: () => opts.daemonName } : {}),
    log: (level, message) => logs.push([level, message]),
    now: () => now,
    setTimeoutImpl: (fn, ms) => {
      expect(ms).toBe(LIVE_ACTIVITY_DEBOUNCE_MS);
      fire = fn;
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutImpl: () => {
      fire = null;
    },
  });

  return {
    pusher,
    calls,
    logs,
    forgotActivity,
    forgotPushToStart,
    setCounts: (c) => {
      current = c;
    },
    setTargets: (t) => {
      targets = t;
    },
    setNow: (ms) => {
      now = ms;
    },
    get pendingTimers() {
      return fire === null ? 0 : 1;
    },
    tick: async () => {
      const run = fire;
      fire = null;
      run?.();
      await transport.flush();
    },
  };
}

const withActivity = (over: Partial<LiveActivityTarget['liveActivity']> = {}): LiveActivityTarget => ({
  deviceId: 'dev-1',
  liveActivity: { pushToStartToken: START, activityToken: ACTIVITY, ...over },
});

describe('LiveActivityPusher — what fires a send', () => {
  it('★ debounces a burst into one send, against the numbers as they end up', async () => {
    const h = harness({ targets: [withActivity()] });
    h.setCounts(counts({ pendingApprovals: 1 }));
    h.pusher.onApprovalsChanged();
    h.pusher.onApprovalsChanged();
    // The last word wins — a tool call that creates and supersedes inside a
    // second must not spend two updates saying two things that were never true
    // for long enough to read.
    h.setCounts(counts({ pendingApprovals: 3, blockedPanes: 2 }));
    h.pusher.onApprovalsChanged();
    await h.tick();

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body.contentState).toMatchObject({ pendingApprovals: 3, blockedPanes: 2 });
  });

  it('★ a change confined to the agent counts is not worth an update', async () => {
    const h = harness({ targets: [withActivity()] });
    h.setCounts(counts({ pendingApprovals: 1, workingAgents: 1, runningAgents: 2 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    expect(h.calls).toHaveLength(1);

    // The remote activity has no agent rows to show, so this buys a number
    // nobody can see and spends the budget the next approval needs.
    h.setCounts(counts({ pendingApprovals: 1, workingAgents: 0, idleAgents: 2, runningAgents: 2 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    expect(h.calls).toHaveLength(1);

    // …but the latest agent numbers DO ride along on the next real change.
    h.setCounts(counts({ pendingApprovals: 2, workingAgents: 0, idleAgents: 2, runningAgents: 2 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].body.contentState).toMatchObject({ idleAgents: 2, workingAgents: 0 });
  });

  it('the same numbers twice are sent once', async () => {
    const h = harness({ targets: [withActivity()] });
    h.setCounts(counts({ pendingApprovals: 2, blockedPanes: 1, oldestBlockedMinutes: 3 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    h.pusher.onApprovalsChanged();
    await h.tick();
    expect(h.calls).toHaveLength(1);
  });

  it('★ a new activity token resets the memory, so the fresh activity is filled', async () => {
    const h = harness({ targets: [withActivity()] });
    h.setCounts(counts({ pendingApprovals: 2 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    expect(h.calls).toHaveLength(1);

    // Rotated. The numbers are unchanged, but THIS activity has never been
    // shown them — suppressing here leaves a blank activity until the next
    // approval happens to change something.
    h.setTargets([withActivity({ activityToken: ACTIVITY_2 })]);
    h.pusher.onApprovalsChanged();
    await h.tick();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].body.apnsToken).toBe(ACTIVITY_2);
  });

  it('does nothing at all when the device registered no tokens', async () => {
    const h = harness({ targets: [{ deviceId: 'dev-1', liveActivity: {} }] });
    h.setCounts(counts({ pendingApprovals: 4 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    expect(h.calls).toEqual([]);
  });
});

describe('LiveActivityPusher — which event', () => {
  it('★ starts when there is a push-to-start token, something pending, and no activity', async () => {
    const h = harness({
      targets: [{ deviceId: 'dev-1', liveActivity: { pushToStartToken: START } }],
      daemonName: 'studio',
    });
    h.setCounts(counts({ pendingApprovals: 1 }));
    h.pusher.onApprovalsChanged();
    await h.tick();

    const body = h.calls[0].body;
    expect(body.event).toBe('start');
    expect(body.apnsToken).toBe(START);
    expect(body.attributes).toEqual({ daemonName: 'studio' });
    // Five minutes: if the activity token never arrives, the lock screen should
    // retire the activity itself rather than sit on a number nobody refreshed.
    expect(body.staleDate).toBe(Math.floor(NOW / 1000) + LIVE_ACTIVITY_START_STALE_SEC);
    expect(body.dismissalDate).toBeUndefined();
  });

  it('does not start when nothing is pending', async () => {
    const h = harness({
      targets: [{ deviceId: 'dev-1', liveActivity: { pushToStartToken: START } }],
    });
    h.setCounts(counts({ pendingApprovals: 0, workingAgents: 3 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    expect(h.calls).toEqual([]);
  });

  it('updates through the activity token once there is one', async () => {
    const h = harness({ targets: [withActivity()] });
    h.setCounts(counts({ pendingApprovals: 1 }));
    h.pusher.onApprovalsChanged();
    await h.tick();

    const body = h.calls[0].body;
    expect(body.event).toBe('update');
    expect(body.apnsToken).toBe(ACTIVITY);
    expect(body.staleDate).toBe(Math.floor(NOW / 1000) + LIVE_ACTIVITY_UPDATE_STALE_SEC);
  });

  it('★ ends with a dismissal date when the last approval is answered', async () => {
    const h = harness({ targets: [withActivity()] });
    h.setCounts(counts({ pendingApprovals: 1, blockedPanes: 1 }));
    h.pusher.onApprovalsChanged();
    await h.tick();

    h.setCounts(counts({ pendingApprovals: 0 }));
    h.pusher.onApprovalsChanged();
    await h.tick();

    const body = h.calls[1].body;
    expect(body.event).toBe('end');
    // Without this the activity lingers on the lock screen for up to four hours
    // after the thing it was reporting is over.
    expect(body.dismissalDate).toBe(Math.floor(NOW / 1000));
    expect(body.staleDate).toBeUndefined();
    // The activity is gone, so the token that addressed it is too.
    expect(h.forgotActivity).toEqual(['dev-1']);
    expect(h.forgotPushToStart).toEqual([]);
  });

  it('★ content-state carries the six integers and nothing else', async () => {
    const h = harness({ targets: [withActivity()] });
    h.setCounts(
      counts({
        pendingApprovals: 2,
        runningAgents: 4,
        workingAgents: 1,
        idleAgents: 2,
        blockedPanes: 1,
        oldestBlockedMinutes: 7,
      }),
    );
    h.pusher.onApprovalsChanged();
    await h.tick();

    // A Live Activity push never runs the extension, so this travels in the
    // clear. No pane name, no workspace, no question text — ever.
    expect(h.calls[0].body.contentState).toEqual({
      pendingApprovals: 2,
      runningAgents: 4,
      workingAgents: 1,
      idleAgents: 2,
      blockedPanes: 1,
      oldestBlockedMinutes: 7,
    });
  });
});

describe('LiveActivityPusher — timestamps', () => {
  it('★ strictly increases per device, so two changes in one second both land', async () => {
    const h = harness({ targets: [withActivity()] });
    h.setCounts(counts({ pendingApprovals: 1 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    h.setCounts(counts({ pendingApprovals: 2 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    h.setCounts(counts({ pendingApprovals: 3 }));
    h.pusher.onApprovalsChanged();
    await h.tick();

    const stamps = h.calls.map((c) => c.body.timestamp);
    // APNs silently drops an activity update whose timestamp is not greater
    // than the last one it accepted — same-second changes are ordinary.
    expect(stamps[1]).toBeGreaterThan(stamps[0]);
    expect(stamps[2]).toBeGreaterThan(stamps[1]);
  });

  it('keeps climbing across a token change, which resets everything else', async () => {
    const h = harness({ targets: [withActivity()] });
    h.setCounts(counts({ pendingApprovals: 1 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    h.setTargets([withActivity({ activityToken: ACTIVITY_2 })]);
    h.pusher.onApprovalsChanged();
    await h.tick();

    expect(h.calls[1].body.timestamp).toBeGreaterThan(h.calls[0].body.timestamp);
  });

  it('follows the wall clock once it has moved on', async () => {
    const h = harness({ targets: [withActivity()] });
    h.setCounts(counts({ pendingApprovals: 1 }));
    h.pusher.onApprovalsChanged();
    await h.tick();

    h.setNow(NOW + 90_000);
    h.setCounts(counts({ pendingApprovals: 2 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    expect(h.calls[1].body.timestamp).toBe(Math.floor((NOW + 90_000) / 1000));
  });
});

describe('LiveActivityPusher — 410 forgets exactly one token', () => {
  it('★ a 410 on an update forgets the ACTIVITY token only', async () => {
    const h = harness({ targets: [withActivity()], statuses: [410] });
    h.setCounts(counts({ pendingApprovals: 1 }));
    h.pusher.onApprovalsChanged();
    await h.tick();

    expect(h.forgotActivity).toEqual(['dev-1']);
    // An activity token dies every time an activity ends. Treating that as
    // "this device is gone" would switch approval notifications off several
    // times a day, which is why `forgetPush` is not reachable from here at all.
    expect(h.forgotPushToStart).toEqual([]);
  });

  it('★ a 410 on a start forgets the PUSH-TO-START token only', async () => {
    const h = harness({
      targets: [{ deviceId: 'dev-1', liveActivity: { pushToStartToken: START } }],
      statuses: [410],
    });
    h.setCounts(counts({ pendingApprovals: 1 }));
    h.pusher.onApprovalsChanged();
    await h.tick();

    expect(h.forgotPushToStart).toEqual(['dev-1']);
    expect(h.forgotActivity).toEqual([]);
  });
});

describe('LiveActivityPusher — a relay that is not there', () => {
  it('★ does not throw, and says so once rather than once per change', async () => {
    const h = harness({ targets: [withActivity()], statuses: ['throw'] });
    for (const pendingApprovals of [1, 2, 3, 4]) {
      h.setCounts(counts({ pendingApprovals }));
      h.pusher.onApprovalsChanged();
      await h.tick();
    }

    const noResponse = h.logs.filter(([, m]) => m.includes('no response from the relay'));
    expect(noResponse).toHaveLength(1);
    expect(noResponse[0][0]).toBe('warn');
    // Nothing was forgotten: a relay outage is not Apple saying a token is dead.
    expect(h.forgotActivity).toEqual([]);
    expect(h.forgotPushToStart).toEqual([]);
  });

  it('is inert without a relay configured', async () => {
    const pusher = new LiveActivityPusher({
      transport: new RelayTransport({}),
      targets: () => [withActivity()],
      counts: () => counts({ pendingApprovals: 1 }),
      forgetLiveActivityToken: () => undefined,
      forgetPushToStartToken: () => undefined,
    });
    expect(pusher.enabled).toBe(false);
    pusher.onApprovalsChanged();
    await pusher.flush();
  });

  it('carries the device APNs stage, and omits it when the device named none', async () => {
    const h = harness({ targets: [withActivity({ apnsEnvironment: 'development' })] });
    h.setCounts(counts({ pendingApprovals: 1 }));
    h.pusher.onApprovalsChanged();
    await h.tick();
    expect(h.calls[0].body.apnsEnvironment).toBe('development');
    expect(h.calls[0].url).toBe('https://relay.example/live');

    const bare = harness({ targets: [withActivity()] });
    bare.setCounts(counts({ pendingApprovals: 1 }));
    bare.pusher.onApprovalsChanged();
    await bare.tick();
    expect('apnsEnvironment' in bare.calls[0].body).toBe(false);
  });
});
