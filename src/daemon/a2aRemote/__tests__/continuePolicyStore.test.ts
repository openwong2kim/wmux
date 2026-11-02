// This PC's continue policy: off both ways until saved, a save that read an
// old version changes nothing, and what is saved is what a reload reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTINUE_POLICY_FILE, ContinuePolicyStore } from '../continuePolicyStore';

const HOST = '11111111-1111-4111-8111-111111111111';
let dir: string;
const open = (): ContinuePolicyStore => new ContinuePolicyStore({ dir, scheduleHarden: () => undefined });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-continue-policy-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ContinuePolicyStore', () => {
  it('starts off both ways; a save bumps the version and survives a reload; a stale save is a conflict', () => {
    const store = open();
    expect(store.get()).toMatchObject({ in: { enabled: false }, out: {}, version: 0 });
    const saved = store.set({ v: 1, in: { enabled: true, permissionMode: 'bypassPermissions' }, out: { [HOST]: { allowed: true } }, version: 0 });
    // A mode that skips the agent's permission checks is never taken.
    expect(saved).toMatchObject({ ok: true, policy: { in: { enabled: true, permissionMode: 'auto' }, version: 1 } });
    expect(open().get()).toMatchObject({ in: { enabled: true }, out: { [HOST]: { allowed: true } }, version: 1 });
    expect(store.set({ v: 1, in: { enabled: false }, version: 0 })).toMatchObject({ ok: false, conflict: true });
    expect(store.set({ v: 2 })).toMatchObject({ ok: false });
    expect(store.get().in.enabled).toBe(true);
  });

  it('a save must name the version it read: a missing or malformed one is refused, even on a fresh store', () => {
    const store = open();
    for (const version of [undefined, -1, 0.5, '0']) {
      expect(store.set({ v: 1, in: { enabled: true }, version })).toMatchObject({ ok: false, error: 'the policy is not valid' });
    }
    expect(store.get()).toMatchObject({ in: { enabled: false }, version: 0 });
    expect(fs.existsSync(path.join(dir, CONTINUE_POLICY_FILE))).toBe(false);
  });

  it('a removal whose write failed says so, and the next write carries it: unpair, pair again, reload', () => {
    let failing = false;
    const store = new ContinuePolicyStore({
      dir, scheduleHarden: () => undefined,
      write: (p, d) => {
        if (failing) throw new Error('disk full');
        fs.writeFileSync(p, JSON.stringify(d));
      },
    });
    store.set({ v: 1, in: { enabled: true }, out: { [HOST]: { allowed: true } }, version: 0 });
    failing = true;
    expect(() => store.forgetHost(HOST)).toThrow('not saved after forgetting');
    expect(store.get().out).toEqual({});
    failing = false;
    // HOST is paired again: nothing more to drop, but the removal is still owed.
    expect(store.retainHosts(() => true)).toBe(false);
    expect(open().get().out).toEqual({});
  });

  it('a removed PC loses its send allow, in memory and on disk; retaining keeps only paired PCs', () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const store = open();
    store.set({ v: 1, in: { enabled: true }, out: { [HOST]: { allowed: true }, [OTHER]: { allowed: true } }, version: 0 });
    expect(store.forgetHost(HOST)).toBe(true);
    expect(store.get().out).toEqual({ [OTHER]: { allowed: true } });
    expect(open().get()).toMatchObject({ out: { [OTHER]: { allowed: true } }, version: 2 });
    expect(store.forgetHost(HOST)).toBe(false);
    expect(open().retainHosts((h) => h === HOST)).toBe(true);
    expect(open().get().out).toEqual({});
  });

  it('a file that is not a policy reads as off, and is kept aside', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONTINUE_POLICY_FILE), JSON.stringify({ v: 9, in: { enabled: true } }));
    expect(open().get().in.enabled).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.startsWith(`${CONTINUE_POLICY_FILE}.corrupt-`))).toBe(true);
  });
});
