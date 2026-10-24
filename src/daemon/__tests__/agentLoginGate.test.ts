import { describe, expect, it, vi } from 'vitest';
import { AgentLoginGate } from '../agentLoginGate';

const account = (dir?: string): NodeJS.ProcessEnv => (dir ? { CLAUDE_CONFIG_DIR: dir } : {});

describe('AgentLoginGate', () => {
  it('lets a launch through the moment a sign-in lands, inside the cache window', async () => {
    const clock = { t: 0 };
    let signedIn = false;
    const probe = vi.fn(async () => signedIn);
    const gate = new AgentLoginGate(probe, { now: () => clock.t, ttlMs: 60_000 });
    expect(await gate.signedOut('claude', account('/acc/a'))).toBe(true);
    // The user signs in; one second later the next launch is not refused.
    signedIn = true;
    clock.t += 1_000;
    expect(await gate.signedOut('claude', account('/acc/a'))).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('asks each agent and account at most once a minute while it is signed in, and shares a probe in flight', async () => {
    const clock = { t: 0 };
    const probe = vi.fn(async () => true);
    const gate = new AgentLoginGate(probe, { now: () => clock.t, ttlMs: 60_000 });
    await Promise.all([gate.signedOut('claude', account()), gate.signedOut('claude', account())]);
    expect(probe).toHaveBeenCalledTimes(1);
    clock.t += 59_000;
    await gate.signedOut('claude', account());
    expect(probe).toHaveBeenCalledTimes(1);
    // Another account and another agent are their own entries.
    await gate.signedOut('claude', account('/acc/b'));
    await gate.signedOut('codex', account());
    expect(probe).toHaveBeenCalledTimes(3);
    clock.t += 2_000;
    await gate.signedOut('claude', account());
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('ignores a probe that was running when the account was forgotten, and asks afresh after', async () => {
    let release: (v: boolean) => void = () => undefined;
    const probe = vi.fn(() => new Promise<boolean | null>((resolve) => { release = resolve; }));
    const gate = new AgentLoginGate(probe);
    const stale = gate.check('claude', account('/acc/a'));
    // A turn of that account just failed on its sign-in (or just worked).
    gate.forget('claude', '/acc/a');
    release(true);
    expect(await stale).toBeNull();
    probe.mockResolvedValueOnce(false);
    expect(await gate.check('claude', account('/acc/a'))).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('drops a cached signed-in answer when the account is forgotten', async () => {
    const probe = vi.fn(async () => true as boolean | null);
    const gate = new AgentLoginGate(probe, { now: () => 0 });
    expect(await gate.check('codex', {})).toBe(true);
    gate.forget('codex', null);
    probe.mockResolvedValueOnce(false);
    expect(await gate.signedOut('codex', {})).toBe(true);
  });

  it('records a working turn as signed in, so the next launch needs no probe, and voids one in flight', async () => {
    let release: (v: boolean | null) => void = () => undefined;
    const probe = vi.fn(() => new Promise<boolean | null>((resolve) => { release = resolve; }));
    const gate = new AgentLoginGate(probe, { now: () => 0 });
    const stale = gate.check('claude', account());
    gate.markWorks('claude', null);
    release(false);
    expect(await stale).toBeNull();
    expect(await gate.check('claude', account())).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting after waitMs while the probe runs on and its answer is cached', async () => {
    vi.useFakeTimers();
    try {
      let release: (v: boolean | null) => void = () => undefined;
      const probe = vi.fn(() => new Promise<boolean | null>((resolve) => { release = resolve; }));
      const gate = new AgentLoginGate(probe, { now: () => 0 });
      const bounded = gate.check('claude', account(), { waitMs: 3_000 });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await bounded).toBeNull();
      release(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(await gate.check('claude', account(), { waitMs: 3_000 })).toBe(true);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats "cannot tell" and a failed probe as not signed out', async () => {
    expect(await new AgentLoginGate(async () => null).signedOut('codex', {})).toBe(false);
    expect(await new AgentLoginGate(async () => { throw new Error('spawn failed'); }).signedOut('codex', {})).toBe(false);
  });
});
