// Input lanes in ComputerService (inputLanes.ts): agents on different apps
// run at once, one app's actions run in order, real input stays one agent at a
// time, and a helper without `input.deferForeground` keeps the old single lock.

import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import { trackedTempDir } from '../../../test-utils/trackedTempDir';
import { HelperProcess } from '../HelperProcess';
import { SNAPSHOT_TTL_MS, type ActionResult, type AppInfo, type AppState, type HelperMethod, type WindowInfo } from '../../../shared/computer/protocol';
import {
  ABORT_COOLDOWN_MS,
  CONTROL_RATE_PER_MINUTE,
  ComputerService,
  INPUT_LOCK_IDLE_MS,
  type ComputerAgent,
  type HelperLike,
} from '../ComputerService';

const notepad: AppInfo = { id: 'c:\\windows\\notepad.exe', name: 'Notepad', pid: 10, path: 'C:\\Windows\\notepad.exe' };
const paint: AppInfo = { id: 'c:\\windows\\mspaint.exe', name: 'Paint', pid: 12, path: 'C:\\Windows\\mspaint.exe' };
const win = (app: AppInfo): WindowInfo => ({
  id: `w-${app.pid}`,
  appId: app.id,
  pid: app.pid,
  title: `${app.name} window`,
  bounds: { x: 0, y: 0, width: 1600, height: 900 },
});
const APPS: Record<string, AppInfo> = { Notepad: notepad, Paint: paint };

const AGENT_A: ComputerAgent = { key: 'agent-a', label: 'agent A' };
const AGENT_B: ComputerAgent = { key: 'agent-b', label: 'agent B' };

const CONTROL = new Set(['click', 'setValue', 'type', 'pressKey', 'hotkey', 'scroll']);

interface PendingCall {
  method: HelperMethod;
  params: Record<string, unknown>;
  resolve: (r: ActionResult) => void;
  reject: (e: unknown) => void;
}

/**
 * A helper whose input calls stay pending until the test answers them, so
 * the test sees which calls reach it while others are still running.
 * `defer`: what the hello says about `input.deferForeground`; undefined
 * leaves the method out (a helper that predates it).
 */
function controllableHelper(defer: boolean | undefined) {
  let seq = 0;
  const pending: PendingCall[] = [];
  const controlCalls: Array<{ method: HelperMethod; params: Record<string, unknown> }> = [];
  const helper: HelperLike = {
    request: (async (method: HelperMethod, params: Record<string, unknown>) => {
      const found = APPS[params.app as string] ?? Object.values(APPS).find((a) => a.id === params.app);
      const app = (): AppInfo => {
        if (!found) throw new ComputerError('app_not_found', 'no such app');
        return found;
      };
      switch (method) {
        case 'resolveTarget':
          return { app: app(), window: win(app()) };
        case 'getAppState': {
          const state: AppState = {
            snapshotId: `s${++seq}`,
            app: app(),
            window: win(app()),
            tree: '0 window',
            screenshotStatus: { status: 'skipped' },
          };
          return state;
        }
        case 'capabilities':
          return { actions: [], modes: ['ax'], permissions: { accessibility: true, screenRecording: true } };
        default:
          if (!CONTROL.has(method)) return {};
          controlCalls.push({ method, params });
          return new Promise<ActionResult>((resolve, reject) => pending.push({ method, params, resolve, reject }));
      }
    }) as HelperLike['request'],
    abort: vi.fn(() => {
      for (const p of pending.splice(0)) p.reject(new ComputerError('aborted', 'stopped by the user'));
    }),
    dispose: vi.fn(),
    ...(defer !== undefined && { defersForeground: async () => defer }),
  };
  const done = (call: PendingCall, delivery: 'background' | 'foreground' = 'background') =>
    call.resolve({ method: 'synthetic', verification: 'unverified', delivery });
  const needsForeground = (call: PendingCall, disposition: 'not_delivered' | 'delivered_unverified' = 'not_delivered') =>
    call.reject(new ComputerError('needs_foreground', 'needs real input', disposition));
  return { helper, pending, controlCalls, done, needsForeground };
}

function makeService(defer: boolean | undefined) {
  let now = 1_000_000;
  const stopKey = { held: true };
  const h = controllableHelper(defer);
  const service = new ComputerService({
    isEnabled: () => true,
    askPerApp: () => false,
    createHelper: () => h.helper,
    requestConsent: async () => 'approved',
    stopKey: { arm: () => stopKey.held, release: vi.fn() },
    blockContext: () => ({ selfPids: new Set([1]) }),
    now: () => now,
    platform: 'win32',
  });
  return { service, ...h, stopKey, advance: (ms: number) => { now += ms; } };
}

/** The oldest input call still waiting at the helper. */
function oldest(pending: PendingCall[]): PendingCall {
  const call = pending.shift();
  if (!call) throw new Error('no input call is waiting at the helper');
  return call;
}

/** Runs every queued promise reaction (setImmediate is not faked). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Whether a promise settled, and how. */
function track<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then(
    (value) => { state.settled = true; state.value = value; },
    (error: unknown) => { state.settled = true; state.error = error; },
  );
  return state;
}

/**
 * A deadline on fake timers: rejects if `p` has not settled by then. Time
 * moves in steps, with every pending reaction run between them, so a promise
 * that can settle does so before the deadline fires.
 */
async function withinDeadline<T>(p: Promise<T>, ms = 5_000): Promise<T> {
  const state = track(p);
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms (deadlock?)`)), ms));
  const raced = Promise.race([p, deadline]);
  raced.catch(() => undefined);
  for (let elapsed = 0; elapsed < ms && !state.settled; elapsed += 100) {
    await settle();
    if (!state.settled) await vi.advanceTimersByTimeAsync(100);
  }
  return raced;
}

describe('ComputerService input lanes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs two agents on different apps at once: neither is busy, the second does not wait for the first', async () => {
    const { service, pending, controlCalls, done } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Paint' });
    const first = track(service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' }));
    await settle();
    const second = track(service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' }));
    await settle();
    // Both are at the helper while the first is still running.
    expect(controlCalls.map((c) => (c.params.target as { pid: number }).pid)).toEqual([10, 12]);
    expect(controlCalls.every((c) => c.params.foreground === 'refuse')).toBe(true);
    expect(first.settled).toBe(false);
    for (const call of pending.splice(0)) done(call);
    await settle();
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect((second.value as ActionResult).disposition).toBe('delivered_unverified');
  });

  it('runs two agents on one app in arrival order', async () => {
    const { service, pending, controlCalls, done } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Notepad' });
    const first = track(service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' }));
    const second = track(service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' }));
    await settle();
    expect(controlCalls.map((c) => c.params.key)).toEqual(['a']);
    done(oldest(pending));
    await settle();
    expect(first.settled).toBe(true);
    expect(controlCalls.map((c) => c.params.key)).toEqual(['a', 'b']);
    done(oldest(pending));
    await settle();
    expect(second.error).toBeUndefined();
  });

  it('after A drives in the foreground, B may still post in the background but gets input_busy for real input', async () => {
    const { service, pending, controlCalls, done, advance } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Paint' });
    // A chord is foreground-certain: A takes the lease up front.
    const chord = service.control(AGENT_A, { action: 'hotkey', snapshotId: a.snapshotId, keys: ['ctrl', 's'] });
    await settle();
    expect(controlCalls[0].params.foreground).toBe('allow');
    done(oldest(pending), 'foreground');
    await chord;
    advance(INPUT_LOCK_IDLE_MS - 1);

    const background = service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' });
    await settle();
    done(oldest(pending));
    expect((await background).disposition).toBe('delivered_unverified');

    const before = controlCalls.length;
    const busy = await service.control(AGENT_B, { action: 'click', snapshotId: b.snapshotId, index: 0, button: 'right' }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(ComputerError);
    expect((busy as ComputerError).code).toBe('input_busy');
    expect((busy as ComputerError).disposition).toBe('not_delivered');
    expect(controlCalls.length).toBe(before);
  });

  it('upgrades a needs_foreground answer once, in allow mode, and keeps the app\'s next action behind it', async () => {
    const { service, pending, controlCalls, done, needsForeground } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Notepad' });
    const upgraded = service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' });
    const later = track(service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' }));
    await settle();
    needsForeground(oldest(pending));
    await settle();
    // The re-send is A's, in allow mode; B is still queued behind it.
    expect(controlCalls.map((c) => [c.params.key, c.params.foreground])).toEqual([['a', 'refuse'], ['a', 'allow']]);
    done(oldest(pending), 'foreground');
    const result = await withinDeadline(upgraded);
    expect(result.delivery).toBe('foreground');
    await settle();
    expect(controlCalls.map((c) => c.params.key)).toEqual(['a', 'a', 'b']);
    done(oldest(pending));
    await settle();
    expect(later.settled).toBe(true);
    expect(later.error).toBeUndefined();
    expect(service.inputHolder()).toBe('agent A');
  });

  it('ends an upgrade input_busy, not_delivered, while another agent holds real input', async () => {
    const { service, pending, controlCalls, done, needsForeground } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Paint' });
    const chord = service.control(AGENT_A, { action: 'hotkey', snapshotId: a.snapshotId, keys: ['ctrl', 's'] });
    await settle();
    done(oldest(pending), 'foreground');
    await chord;

    const blocked = service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' }).catch((e: unknown) => e);
    await settle();
    needsForeground(oldest(pending));
    const err = await withinDeadline(blocked);
    expect((err as ComputerError).code).toBe('input_busy');
    expect((err as ComputerError).disposition).toBe('not_delivered');
    // Sent once (refuse), never re-sent.
    expect(controlCalls.filter((c) => c.params.key === 'b').map((c) => c.params.foreground)).toEqual(['refuse']);
    // And the app's slot was given back.
    const again = service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'c' });
    await settle();
    done(oldest(pending));
    expect((await again).disposition).toBe('delivered_unverified');
  });

  it('never shows needs_foreground to an agent and re-sends it only once', async () => {
    const { service, pending, controlCalls, needsForeground } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const result = service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' }).catch((e: unknown) => e);
    await settle();
    needsForeground(oldest(pending));
    await settle();
    needsForeground(oldest(pending));
    const err = (await withinDeadline(result)) as ComputerError;
    expect(err.code).not.toBe('needs_foreground');
    expect(err.code).toBe('internal');
    expect(err.disposition).toBe('not_delivered');
    expect(controlCalls.map((c) => c.params.foreground)).toEqual(['refuse', 'allow']);
  });

  it('ends every queued action aborted, not_delivered, on a stop, without reaching the helper', async () => {
    const { service, controlCalls } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Notepad' });
    const running = service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' }).catch((e: unknown) => e);
    const queued = [
      service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' }).catch((e: unknown) => e),
      service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'c' }).catch((e: unknown) => e),
    ];
    await settle();
    expect(controlCalls).toHaveLength(1);
    service.abort();
    for (const q of queued) {
      const err = (await withinDeadline(q)) as ComputerError;
      expect(err.code).toBe('aborted');
      expect(err.disposition).toBe('not_delivered');
    }
    expect(((await running) as ComputerError).code).toBe('aborted');
    expect(controlCalls).toHaveLength(1);
  });

  it('gives a helper without deferForeground the single lock of before, for every input', async () => {
    const { service, pending, controlCalls, done } = makeService(undefined);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Paint' });
    const first = service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' });
    await settle();
    expect(controlCalls[0].params).not.toHaveProperty('foreground');
    const busy = await service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' }).catch((e: unknown) => e);
    expect((busy as ComputerError).code).toBe('input_busy');
    expect((busy as ComputerError).disposition).toBe('not_delivered');
    expect(controlCalls).toHaveLength(1);
    done(oldest(pending));
    await first;
  });

  it('treats a helper whose hello says deferForeground: false like one without it', async () => {
    const { service, pending, controlCalls, done } = makeService(false);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Paint' });
    const first = service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' });
    await settle();
    expect(controlCalls[0].params).not.toHaveProperty('foreground');
    expect((await service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' }).catch((e: unknown) => e) as ComputerError).code).toBe('input_busy');
    done(oldest(pending));
    await first;
  });

  it('runs a foreground action on an app behind that app\'s queued background action, slot then lease', async () => {
    const { service, pending, controlCalls, done } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Notepad' });
    // B's background action holds Notepad's slot (the helper holds it)...
    const background = track(service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' }));
    await settle();
    // ...so A's scroll on the same app waits for it, then runs in allow mode.
    const scroll = service.control(AGENT_A, { action: 'scroll', snapshotId: a.snapshotId, index: 0 });
    await settle();
    expect(controlCalls.map((c) => [c.method, c.params.foreground])).toEqual([['pressKey', 'refuse']]);
    done(oldest(pending));
    await settle();
    expect(background.settled).toBe(true);
    expect(controlCalls.map((c) => [c.method, c.params.foreground])).toEqual([['pressKey', 'refuse'], ['scroll', 'allow']]);
    done(oldest(pending), 'foreground');
    const result = await withinDeadline(scroll);
    expect(result.delivery).toBe('foreground');
    expect(service.inputHolder()).toBe('agent A');
  });

  it('re-sends needs_foreground only when the helper says nothing was sent', async () => {
    const { service, pending, controlCalls, needsForeground } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const result = service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' }).catch((e: unknown) => e);
    await settle();
    needsForeground(oldest(pending), 'delivered_unverified');
    const err = (await withinDeadline(result)) as ComputerError;
    expect(err.code).not.toBe('needs_foreground');
    expect(err.disposition).toBe('delivered_unverified');
    expect(controlCalls.map((c) => c.params.foreground)).toEqual(['refuse']);
    // Nor did it take the lease.
    expect(service.inputHolder()).toBeNull();
  });

  it('checks the snapshot before taking the lease on an upgrade, so a failed check leaves no lease', async () => {
    const { service, pending, controlCalls, done, needsForeground, advance } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const result = service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' }).catch((e: unknown) => e);
    await settle();
    // The snapshot expires while the helper works on the background attempt.
    advance(SNAPSHOT_TTL_MS + 1);
    needsForeground(oldest(pending));
    const err = (await withinDeadline(result)) as ComputerError;
    expect(err.code).toBe('snapshot_unknown');
    expect(err.disposition).toBe('not_delivered');
    expect(service.inputHolder()).toBeNull();
    // B's foreground action right after is not busy.
    const fresh = await service.getAppState(AGENT_B, { app: 'Paint' });
    const chord = service.control(AGENT_B, { action: 'hotkey', snapshotId: fresh.snapshotId, keys: ['ctrl', 's'] });
    await settle();
    expect(controlCalls.at(-1)?.method).toBe('hotkey');
    done(oldest(pending), 'foreground');
    expect((await chord).delivery).toBe('foreground');
  });

  it('charges no rate budget for actions that ended while queued', async () => {
    const { service, pending, controlCalls, done, advance } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Notepad' });
    const p = await service.getAppState(AGENT_B, { app: 'Paint' });
    const running = service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' }).catch((e: unknown) => e);
    const queued = Array.from({ length: CONTROL_RATE_PER_MINUTE }, () =>
      service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' }).catch((e: unknown) => e));
    await settle();
    service.abort();
    for (const q of queued) expect(((await q) as ComputerError).code).toBe('aborted');
    await running;
    advance(ABORT_COOLDOWN_MS + 1);
    // B has used none of its budget: its next action goes to the helper.
    const next = service.control(AGENT_B, { action: 'pressKey', snapshotId: p.snapshotId, key: 'c' });
    await settle();
    expect(controlCalls.at(-1)?.params.key).toBe('c');
    done(oldest(pending));
    expect((await next).disposition).toBe('delivered_unverified');
  });

  it('refuses stop_key_unavailable, not_delivered, when the stop key was lost while the action waited', async () => {
    const { service, pending, controlCalls, done, stopKey } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const b = await service.getAppState(AGENT_B, { app: 'Notepad' });
    const first = service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' });
    const waiting = service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' }).catch((e: unknown) => e);
    await settle();
    stopKey.held = false;
    done(oldest(pending));
    await first;
    const err = (await withinDeadline(waiting)) as ComputerError;
    expect(err.code).toBe('stop_key_unavailable');
    expect(err.disposition).toBe('not_delivered');
    expect(controlCalls.map((c) => c.params.key)).toEqual(['a']);
  });

  it('sends a hotkey without modifiers in refuse mode, like the helper\'s own table', async () => {
    const { service, pending, controlCalls, done } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const plain = service.control(AGENT_A, { action: 'hotkey', snapshotId: a.snapshotId, keys: ['Enter'] });
    await settle();
    expect(controlCalls.map((c) => [c.method, c.params.foreground])).toEqual([['hotkey', 'refuse']]);
    done(oldest(pending));
    await plain;
  });

  it('keeps the lease busy while its real input waits at the helper, and starts the idle time when it settles', async () => {
    const { service, pending, controlCalls, done, advance } = makeService(true);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const d = await service.getAppState(AGENT_B, { app: 'Paint' });
    // A's chord sits at the helper (behind other agents' requests) for 20 s.
    const chord = service.control(AGENT_A, { action: 'hotkey', snapshotId: a.snapshotId, keys: ['ctrl', 's'] });
    await settle();
    advance(16_000);
    const early = await service.control(AGENT_B, { action: 'click', snapshotId: d.snapshotId, index: 0, button: 'right' }).catch((e: unknown) => e);
    expect((early as ComputerError).code).toBe('input_busy');
    expect((early as ComputerError).disposition).toBe('not_delivered');
    advance(4_000);
    done(oldest(pending), 'foreground');
    await withinDeadline(chord);
    advance(INPUT_LOCK_IDLE_MS);
    const fresh = await service.getAppState(AGENT_B, { app: 'Paint' });
    expect((await service.control(AGENT_B, { action: 'click', snapshotId: fresh.snapshotId, index: 0, button: 'right' }).catch((e: unknown) => e) as ComputerError).code).toBe('input_busy');
    advance(1);
    const late = service.control(AGENT_B, { action: 'click', snapshotId: fresh.snapshotId, index: 0, button: 'right' });
    await settle();
    expect(controlCalls.at(-1)?.params.button).toBe('right');
    done(oldest(pending), 'foreground');
    expect((await withinDeadline(late)).delivery).toBe('foreground');
  });

  it('a real-input request that outlives a stop does not release the same agent\'s next lease', async () => {
    const h = makeService(true);
    const { service, pending, controlCalls, done, advance } = h;
    // The request is not at the helper yet (it waits for a replacement
    // helper), so the stop cannot kill it: it settles after the stop.
    h.helper.abort = vi.fn();
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const old = service.control(AGENT_A, { action: 'hotkey', snapshotId: a.snapshotId, keys: ['ctrl', 's'] }).catch((e: unknown) => e);
    await settle();
    const oldCall = oldest(pending);
    service.abort();
    advance(ABORT_COOLDOWN_MS + 1);

    const p = await service.getAppState(AGENT_A, { app: 'Paint' });
    const next = service.control(AGENT_A, { action: 'hotkey', snapshotId: p.snapshotId, keys: ['ctrl', 's'] });
    await settle();
    const nextCall = oldest(pending);
    done(oldCall, 'foreground');
    await withinDeadline(old);

    // A's new real input is still on its way: B must not get the lease.
    advance(INPUT_LOCK_IDLE_MS + 1);
    const b = await service.getAppState(AGENT_B, { app: 'Notepad' });
    const before = controlCalls.length;
    const busy = service.control(AGENT_B, { action: 'click', snapshotId: b.snapshotId, index: 0, button: 'right' }).catch((e: unknown) => e);
    await settle();
    expect(controlCalls.length).toBe(before);
    expect(((await withinDeadline(busy)) as ComputerError).code).toBe('input_busy');
    done(nextCall, 'foreground');
    await withinDeadline(next);
  });

  it.each([
    ['a foreground-certain action', true, 'not_delivered', 'not_delivered'],
    ['a foreground-certain action', true, 'delivered_unverified', 'delivered_unverified'],
    ['a helper without deferForeground', undefined, 'not_delivered', 'not_delivered'],
    ['a helper without deferForeground', undefined, 'delivered_unverified', 'delivered_unverified'],
  ] as const)('never surfaces needs_foreground from an allowed send (%s, %s)', async (_what, defer, helperSays, expected) => {
    const { service, pending, controlCalls, needsForeground } = makeService(defer);
    const a = await service.getAppState(AGENT_A, { app: 'Notepad' });
    const result = service.control(AGENT_A, { action: 'hotkey', snapshotId: a.snapshotId, keys: ['ctrl', 's'] }).catch((e: unknown) => e);
    await settle();
    needsForeground(oldest(pending), helperSays);
    const err = (await withinDeadline(result)) as ComputerError;
    expect(err.code).toBe('internal');
    expect(err.disposition).toBe(expected);
    expect(controlCalls).toHaveLength(1);
    // The lease's idle time started when the send settled; it is not stuck busy.
    expect(service.inputHolder()).toBe('agent A');
  });
});

// Real timers and a real helper process: every helper request made while a
// pid slot is held settles at its timeout (HelperProcess kills and replaces
// the helper), so a helper that never answers cannot park an app's lane.
describe('input lanes over a real helper process', () => {
  it('releases a slot whose helper request times out, and then runs the next action on that app', async () => {
    const logFile = path.join(trackedTempDir('wmux-lanes-', { until: 'file' }), 'requests.log');
    const proc = new HelperProcess({
      command: process.execPath,
      args: [path.join(__dirname, 'fixtures', 'fakeHelper.mjs'), 'deferring-hang-once', logFile],
      helloTimeoutMs: 5_000,
      timeoutFor: (method) => (method === 'pressKey' ? 500 : 5_000),
    });
    const service = new ComputerService({
      isEnabled: () => true,
      askPerApp: () => false,
      createHelper: () => proc,
      requestConsent: async () => 'approved',
      stopKey: { arm: () => true, release: vi.fn() },
      blockContext: () => ({ selfPids: new Set([1]) }),
      platform: 'win32',
    });
    try {
      const a = await service.getAppState(AGENT_A, { app: 'Fake' });
      const b = await service.getAppState(AGENT_B, { app: 'Fake' });
      const hung = service.control(AGENT_A, { action: 'pressKey', snapshotId: a.snapshotId, key: 'a' }).catch((e: unknown) => e);
      const next = service.control(AGENT_B, { action: 'pressKey', snapshotId: b.snapshotId, key: 'b' });
      const err = (await hung) as ComputerError;
      expect(err.code).toBe('timeout');
      expect(err.disposition).toBe('delivered_unverified');
      // The slot came back at the timeout: B's action on the same app ran.
      expect((await next).disposition).toBe('delivered_unverified');
    } finally {
      service.dispose();
    }
  }, 20_000);
});
