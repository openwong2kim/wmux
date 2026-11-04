import { describe, it, expect, vi } from 'vitest';
import { createHeldStartFallback, HELD_START_FALLBACK_MS, promoteNeedsFirstParty } from '../heldUserShellStart';
import { HELD_START_CONCURRENCY } from '../../shared/userShellHolds';
import { runLimited } from '../../shared/runLimited';

// #3049 — who may start a held user shell, and the daemon's fallback start.
describe('promoteNeedsFirstParty', () => {
  it('credentials are main\'s alone, held or not, before the fallback and after it', () => {
    for (const startPending of [true, false]) {
      for (const fallbackFired of [true, false]) {
        expect(promoteNeedsFirstParty({ credentialEnv: true, startPending, fallbackFired })).toBe(true);
      }
    }
  });

  it('a held shell is main\'s to start until the fallback fires', () => {
    expect(promoteNeedsFirstParty({ credentialEnv: false, startPending: true, fallbackFired: false })).toBe(true);
    expect(promoteNeedsFirstParty({ credentialEnv: false, startPending: true, fallbackFired: true })).toBe(false);
  });

  it('any other promote is as open as before', () => {
    expect(promoteNeedsFirstParty({ credentialEnv: false, startPending: false, fallbackFired: false })).toBe(false);
  });
});

describe('createHeldStartFallback', () => {
  it('is about 20 s', () => {
    expect(HELD_START_FALLBACK_MS).toBe(20_000);
  });

  it('starts every shell still held, once, with one log line', async () => {
    const start = vi.fn(async () => ({ ok: true }));
    const log = vi.fn();
    const fallback = createHeldStartFallback({ heldIds: () => ['a', 'b'], start, log });
    expect(fallback.fired()).toBe(false);
    await fallback.fire();
    await fallback.fire();
    expect(fallback.fired()).toBe(true);
    expect(start.mock.calls.map((c: unknown[]) => c[0])).toEqual(['a', 'b']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/2 restored user shell\(s\).*without credentials/);
  });

  it('with nothing held it starts nothing and says nothing', async () => {
    const start = vi.fn(async () => ({ ok: true }));
    const log = vi.fn();
    await createHeldStartFallback({ heldIds: () => [], start, log }).fire();
    expect(start).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    // Fired all the same: from here on a held shell is no longer main's alone.
  });

  it('reads the held ids when it fires, so a shell main started meanwhile is left alone', async () => {
    const held = ['a', 'b'];
    const start = vi.fn(async () => ({ ok: true }));
    const fallback = createHeldStartFallback({ heldIds: () => [...held], start, log: () => undefined });
    held.splice(0, 1); // main started 'a'
    await fallback.fire();
    expect(start.mock.calls.map((c: unknown[]) => c[0])).toEqual(['b']);
  });

  it(`starts at most ${HELD_START_CONCURRENCY} at once, and one failed start does not stop the rest`, async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `s${i}`);
    let running = 0;
    let peak = 0;
    const started: string[] = [];
    const start = async (id: string) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 0));
      running--;
      started.push(id);
      if (id === 's3') throw new Error('spawn failed');
      return { ok: true };
    };
    await createHeldStartFallback({ heldIds: () => ids, start, log: () => undefined }).fire();
    expect(peak).toBe(HELD_START_CONCURRENCY);
    expect(started.sort()).toEqual([...ids].sort());
  });
});

describe('runLimited', () => {
  it('runs nothing for no items and settles', async () => {
    const fn = vi.fn(async () => undefined);
    await runLimited([], 6, fn);
    expect(fn).not.toHaveBeenCalled();
  });
});
