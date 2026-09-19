import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore, coerceDeviceState, getDeviceStatePath } from '../DeviceStore';

// Disk-IO → `.runtime.test.ts`, same reasoning as deviceStore.runtime.test.ts:
// serial execution so the tmp+rename dance never races another file.

let dir: string;

const START = 'a'.repeat(64);
const ACTIVITY = 'b'.repeat(64);
const ACTIVITY_2 = 'c'.repeat(64);
const PUSH_KEY = Buffer.alloc(32, 7).toString('base64');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-la-devices-'));
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const store = (): DeviceStore => new DeviceStore({ wmuxDir: dir });

async function paired(s: DeviceStore): Promise<string> {
  const minted = await s.mint({ name: 'iPhone' });
  return minted.deviceId;
}

describe('DeviceStore — live activity registration merges', () => {
  it('★ an omitted field is kept, not erased — the two tokens arrive separately', async () => {
    const s = store();
    const id = await paired(s);

    expect(s.registerLiveActivity(id, { pushToStartToken: START })).toEqual({ ok: true });
    // A later call carrying only the activity token must not lose the first.
    expect(s.registerLiveActivity(id, { activityToken: ACTIVITY })).toEqual({ ok: true });

    const [target] = s.liveActivityTargets();
    expect(target.liveActivity.pushToStartToken).toBe(START);
    expect(target.liveActivity.activityToken).toBe(ACTIVITY);
  });

  it('★ an explicit null removes that token and leaves the other alone', async () => {
    const s = store();
    const id = await paired(s);
    s.registerLiveActivity(id, {
      pushToStartToken: START,
      activityToken: ACTIVITY,
      apnsEnvironment: 'development',
    });

    // "The activity is over" — the app ended it or the person swiped it away.
    expect(s.registerLiveActivity(id, { activityToken: null })).toEqual({ ok: true });

    const [target] = s.liveActivityTargets();
    expect(target.liveActivity.activityToken).toBeUndefined();
    expect(target.liveActivity.pushToStartToken).toBe(START);
    expect(target.liveActivity.apnsEnvironment).toBe('development');
  });

  it('a token that is not APNs hex is a bad-token, not a silent drop', async () => {
    const s = store();
    const id = await paired(s);
    expect(s.registerLiveActivity(id, { activityToken: 'nope' }).reason).toBe('bad-token');
    expect(s.registerLiveActivity(id, { pushToStartToken: 42 }).reason).toBe('bad-token');
    expect(s.liveActivityTargets()).toEqual([]);
  });

  it('keeps an ActivityKit token longer than a device token', async () => {
    const s = store();
    const id = await paired(s);
    // 160 hex characters observed for a push-to-start token; no fixed length.
    const long = 'd'.repeat(300);
    expect(s.registerLiveActivity(id, { pushToStartToken: long }).ok).toBe(true);
    expect(s.liveActivityTargets()[0].liveActivity.pushToStartToken).toBe(long);
  });

  it('a stage that is neither of Apple two words is refused', async () => {
    const s = store();
    const id = await paired(s);
    expect(
      s.registerLiveActivity(id, { pushToStartToken: START, apnsEnvironment: 'staging' }).reason,
    ).toBe('bad-apns-environment');
    expect(s.liveActivityTargets()).toEqual([]);
  });

  it('an unknown or revoked device cannot keep itself reachable', async () => {
    const s = store();
    const id = await paired(s);
    expect(s.registerLiveActivity('nobody', { pushToStartToken: START }).reason).toBe('not-found');
    s.revoke(id);
    expect(s.registerLiveActivity(id, { pushToStartToken: START }).reason).toBe('revoked');
  });

  it('a revoked device is not a live activity target', async () => {
    const s = store();
    const id = await paired(s);
    s.registerLiveActivity(id, { pushToStartToken: START });
    s.revoke(id);
    expect(s.liveActivityTargets()).toEqual([]);
  });
});

describe('DeviceStore — live activity persistence', () => {
  it('★ survives a restart: a daemon that forgot these would go quiet silently', async () => {
    const s = store();
    const id = await paired(s);
    s.registerLiveActivity(id, {
      pushToStartToken: START,
      activityToken: ACTIVITY,
      apnsEnvironment: 'production',
    });

    const reopened = store();
    const [target] = reopened.liveActivityTargets();
    expect(target.deviceId).toBe(id);
    expect(target.liveActivity).toMatchObject({
      pushToStartToken: START,
      activityToken: ACTIVITY,
      apnsEnvironment: 'production',
    });
  });

  it('★ a record written before this field existed still loads', () => {
    const legacy = {
      version: 1,
      devices: [
        {
          deviceId: 'old-device',
          name: 'iPhone',
          secretHash: 'ab'.repeat(16),
          salt: 'cd'.repeat(16),
          kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32 },
          createdAt: 1,
          lastSeenAt: 2,
        },
      ],
    };
    const state = coerceDeviceState(legacy);
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0].liveActivity).toBeUndefined();
  });

  it('a half-written record keeps the token that still parses', () => {
    const state = coerceDeviceState({
      version: 1,
      devices: [
        {
          deviceId: 'half',
          name: 'iPhone',
          secretHash: 'ab'.repeat(16),
          salt: 'cd'.repeat(16),
          kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32 },
          createdAt: 1,
          lastSeenAt: 2,
          liveActivity: {
            pushToStartToken: START,
            activityToken: 'garbage',
            apnsEnvironment: 'staging',
            registeredAt: 9,
          },
        },
      ],
    });
    expect(state.devices[0].liveActivity).toEqual({ pushToStartToken: START, registeredAt: 9 });
  });

  it('a record with no readable token and no stage is dropped entirely', () => {
    const state = coerceDeviceState({
      version: 1,
      devices: [
        {
          deviceId: 'empty',
          name: 'iPhone',
          secretHash: 'ab'.repeat(16),
          salt: 'cd'.repeat(16),
          kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32 },
          createdAt: 1,
          lastSeenAt: 2,
          liveActivity: { registeredAt: 9 },
        },
      ],
    });
    expect(state.devices[0].liveActivity).toBeUndefined();
  });
});

describe('DeviceStore — a stage-only registration', () => {
  it('★ a record carrying only the APNs stage survives the round trip', () => {
    // Reachable because `registerLiveActivity` MERGES and the stage arrives on
    // its own call: a phone reported its environment before iOS had issued
    // either token. Dropping it on restore loses the answer for good — from the
    // app's side it already told us, so it never says it again, and the daemon
    // falls back to the relay's single `APNS_ENV` for that device.
    const state = coerceDeviceState({
      version: 1,
      devices: [
        {
          deviceId: 'stage-only',
          name: 'iPhone',
          secretHash: 'ab'.repeat(16),
          salt: 'cd'.repeat(16),
          kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32 },
          createdAt: 1,
          lastSeenAt: 2,
          liveActivity: { apnsEnvironment: 'development', registeredAt: 9 },
        },
      ],
    });
    expect(state.devices[0].liveActivity).toEqual({
      apnsEnvironment: 'development',
      registeredAt: 9,
    });
  });
});

describe('DeviceStore — forgetting one token at a time', () => {
  it('★ a dead activity token does not take the push registration with it', async () => {
    const s = store();
    const id = await paired(s);
    s.registerPush(id, { apnsToken: START, publicKey: PUSH_KEY });
    s.registerLiveActivity(id, { pushToStartToken: START, activityToken: ACTIVITY });

    expect(s.forgetLiveActivityToken(id, ACTIVITY)).toBe(true);

    const [target] = s.liveActivityTargets();
    expect(target.liveActivity.activityToken).toBeUndefined();
    // Both of these survive: an activity ends several times a day, and taking
    // approval notifications down with it is the bug this rule exists for.
    expect(target.liveActivity.pushToStartToken).toBe(START);
    expect(s.pushTargets()).toHaveLength(1);
  });

  it('★ a dead push-to-start token leaves the activity token alone', async () => {
    const s = store();
    const id = await paired(s);
    s.registerPush(id, { apnsToken: START, publicKey: PUSH_KEY });
    s.registerLiveActivity(id, { pushToStartToken: START, activityToken: ACTIVITY });

    expect(s.forgetPushToStartToken(id, START)).toBe(true);

    const [target] = s.liveActivityTargets();
    expect(target.liveActivity.pushToStartToken).toBeUndefined();
    expect(target.liveActivity.activityToken).toBe(ACTIVITY);
    expect(s.pushTargets()).toHaveLength(1);
  });

  it('forgetting a token nobody registered is a no-op, not an error', async () => {
    const s = store();
    const id = await paired(s);
    expect(s.forgetLiveActivityToken(id, ACTIVITY)).toBe(false);
    expect(s.forgetPushToStartToken('nobody', START)).toBe(false);
  });

  it('★ a 410 naming an OLD token leaves the one that replaced it alone', async () => {
    const s = store();
    const id = await paired(s);
    s.registerLiveActivity(id, { pushToStartToken: START, activityToken: ACTIVITY });
    // The app rotated its activity while the refused push was in flight. The
    // 410 is about the token the request CARRIED, not about whatever is stored
    // now — dropping the new one would leave the daemon unable to update an
    // activity that is perfectly alive.
    s.registerLiveActivity(id, { activityToken: ACTIVITY_2 });

    expect(s.forgetLiveActivityToken(id, ACTIVITY)).toBe(false);
    expect(s.liveActivityTargets()[0].liveActivity.activityToken).toBe(ACTIVITY_2);

    // The same rule on the other token, and the matching one still deletes.
    expect(s.forgetPushToStartToken(id, ACTIVITY_2)).toBe(false);
    expect(s.liveActivityTargets()[0].liveActivity.pushToStartToken).toBe(START);
    expect(s.forgetLiveActivityToken(id, ACTIVITY_2)).toBe(true);
    expect(s.liveActivityTargets()[0].liveActivity.activityToken).toBeUndefined();
  });

  it('a re-registered activity token replaces the previous one', async () => {
    const s = store();
    const id = await paired(s);
    s.registerLiveActivity(id, { activityToken: ACTIVITY });
    s.registerLiveActivity(id, { activityToken: ACTIVITY_2 });
    expect(s.liveActivityTargets()[0].liveActivity.activityToken).toBe(ACTIVITY_2);
  });
});
