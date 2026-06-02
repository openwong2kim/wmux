import { describe, it, expect } from 'vitest';
import { tryEscalatedReping } from '../launcher';

// Step ② of the duplicate-daemon / split-brain fix
// (plans/duplicate-daemon-split-brain.md). When a verified-but-unresponsive
// daemon misses the two short startup pings, the OLD code went straight to
// SIGKILL — destroying the sessions the user chose to keep (Defect 2). The
// escalated re-ping gives a busy-but-alive daemon a longer budget so it is
// reused instead of killed. These tests pin the reuse-vs-kill decision via
// injected ping/sleep (no live daemon needed).

const noSleep = (): Promise<void> => Promise.resolve();

describe('tryEscalatedReping (Step ② escalating re-ping)', () => {
  it('reuses (true) as soon as an escalated ping succeeds, stopping early', async () => {
    const seen: number[] = [];
    const ping = (t: number): Promise<boolean> => {
      seen.push(t);
      return Promise.resolve(t === 1000); // first (500ms) fails, second (1000ms) succeeds
    };
    const ok = await tryEscalatedReping(ping, [500, 1000], 0, noSleep);
    expect(ok).toBe(true);
    expect(seen).toEqual([500, 1000]);
  });

  it('returns true on the very first escalated ping if it succeeds (no further pings)', async () => {
    const seen: number[] = [];
    const ping = (t: number): Promise<boolean> => {
      seen.push(t);
      return Promise.resolve(true);
    };
    const ok = await tryEscalatedReping(ping, [500, 1000], 0, noSleep);
    expect(ok).toBe(true);
    expect(seen).toEqual([500]); // stopped after the first success — no kill considered yet
  });

  it('returns false (→ proceed to kill) only when every escalated ping fails', async () => {
    const seen: number[] = [];
    const ping = (t: number): Promise<boolean> => {
      seen.push(t);
      return Promise.resolve(false);
    };
    const ok = await tryEscalatedReping(ping, [500, 1000], 0, noSleep);
    expect(ok).toBe(false);
    expect(seen).toEqual([500, 1000]);
  });

  it('backs off before each ping (escalating budget, not a tight loop)', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    await tryEscalatedReping(() => Promise.resolve(false), [500, 1000], 200, sleep);
    expect(sleeps).toEqual([200, 200]);
  });

  it('an empty timeout list performs no pings and returns false', async () => {
    let pings = 0;
    await tryEscalatedReping(
      () => {
        pings += 1;
        return Promise.resolve(true);
      },
      [],
      0,
      noSleep,
    );
    expect(pings).toBe(0);
  });
});
