import { describe, it, expect } from 'vitest';
import { tryEscalatedReping, recoverFromBlockedProbe } from '../launcher';

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

// Fleet-scale regression (scale-30-sessions). Under ~13 concurrent Claude
// sessions a busy-but-alive daemon missed the launcher's two-shot startup
// ping, AND the AV-blocked process probe (tasklist / Get-CimInstance) returned
// null. The OLD code jumped from that null probe STRAIGHT to a SYNC recovery
// modal — freezing the whole main process — and, if clicked, spawned a second
// daemon over the live one. `recoverFromBlockedProbe` inserts the same
// escalated re-ping the verified branch uses BEFORE the dialog: a daemon that
// answers a ping is alive regardless of what the blocked probe reports. These
// tests pin the reuse-before-dialog ordering via injected reping/sleep/askUser
// (no live daemon, no Electron dialog).
describe('recoverFromBlockedProbe (escalated re-ping BEFORE the recovery dialog)', () => {
  it('cmdline-lookup-failure branch: reuses on a successful re-ping WITHOUT showing the dialog', async () => {
    let askUserCalls = 0;
    const outcome = await recoverFromBlockedProbe({
      token: 'auth-token',
      reping: () => Promise.resolve(true), // busy-but-alive daemon answers
      sleep: noSleep,
      askUser: () => {
        askUserCalls += 1;
        return Promise.resolve(true);
      },
    });
    expect(outcome).toBe('reuse');
    expect(askUserCalls).toBe(0); // no modal — the daemon is provably alive
  });

  it('image-lookup-failure branch: reuses on the escalated (1000 ms) ping too, still no dialog', async () => {
    const seen: number[] = [];
    let askUserCalls = 0;
    const outcome = await recoverFromBlockedProbe({
      token: 'auth-token',
      reping: (t) => {
        seen.push(t);
        return Promise.resolve(t === 1000); // 500 ms fails, escalated 1000 ms succeeds
      },
      sleep: noSleep,
      askUser: () => {
        askUserCalls += 1;
        return Promise.resolve(true);
      },
    });
    expect(outcome).toBe('reuse');
    expect(seen).toEqual([500, 1000]); // same escalating budget as the verified branch
    expect(askUserCalls).toBe(0);
  });

  it('falls through to the dialog only after EVERY escalated re-ping fails (user approves → recover)', async () => {
    const seen: number[] = [];
    let askUserCalls = 0;
    const outcome = await recoverFromBlockedProbe({
      token: 'auth-token',
      reping: (t) => {
        seen.push(t);
        return Promise.resolve(false); // wedged daemon never answers
      },
      sleep: noSleep,
      askUser: () => {
        askUserCalls += 1;
        return Promise.resolve(true); // user clicks "Clean up and start fresh"
      },
    });
    expect(seen).toEqual([500, 1000]); // re-ping attempted BEFORE the dialog
    expect(askUserCalls).toBe(1);
    expect(outcome).toBe('recover');
  });

  it('re-ping fails and the user cancels → refuse (caller re-throws the legacy error)', async () => {
    const outcome = await recoverFromBlockedProbe({
      token: 'auth-token',
      reping: () => Promise.resolve(false),
      sleep: noSleep,
      askUser: () => Promise.resolve(false),
    });
    expect(outcome).toBe('refuse');
  });

  it('no auth token → skips the re-ping entirely and goes straight to the dialog', async () => {
    let repings = 0;
    let askUserCalls = 0;
    const outcome = await recoverFromBlockedProbe({
      token: '', // readDaemonAuthToken() returns '' when there is no token file
      reping: () => {
        repings += 1;
        return Promise.resolve(true);
      },
      sleep: noSleep,
      askUser: () => {
        askUserCalls += 1;
        return Promise.resolve(true);
      },
    });
    expect(repings).toBe(0); // cannot ping without a token
    expect(askUserCalls).toBe(1);
    expect(outcome).toBe('recover');
  });
});
