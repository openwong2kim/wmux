/**
 * Idle reclaim: the axis that bounds how many REPL children a long-lived MCP
 * connection can leave resident. Every case here runs a real child, because the
 * thing being asserted is that an OS process actually went away.
 */
import * as os from 'os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionScope, runInConnectionScope } from '../../connectionScope';
import {
  IDLE_SWEEP_INTERVAL_MS,
  IDLE_TIMEOUT_MS,
  ReplRegistry,
  getReplRegistry,
  idleSweepTimerForTest,
  reclaimIdleSessions,
} from '../replRegistry';
import { createReplToolCatalog } from '../tools';

const registries: ReplRegistry[] = [];

function makeRegistry(): ReplRegistry {
  const registry = new ReplRegistry();
  registries.push(registry);
  return registry;
}

function alive(pid: number | undefined): boolean {
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for a SIGKILLed child to actually leave the process table. A killed
 * child is a zombie until its parent reaps it, and `kill(pid, 0)` succeeds on a
 * zombie — so a fixed sleep is a flake on a loaded CI runner, not a check.
 */
async function waitForExit(pid: number | undefined, deadlineMs = 5000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (alive(pid) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterEach(() => {
  vi.useRealTimers();
  while (registries.length > 0) registries.pop()?.disposeAll();
});

describe('idle reclaim', () => {
  it('kills the child of a session that has gone quiet past the threshold', async () => {
    const registry = makeRegistry();
    const { session } = registry.acquire('default', os.tmpdir());
    await session.run('let held = 1;', 5000);
    const pid = session.pid;
    expect(alive(pid)).toBe(true);

    // One millisecond short of the threshold is still a live session. Counted
    // through the registry, not the process-wide entry point, so a registry
    // another test forgot to dispose cannot skew the number.
    expect(registry.reclaimIdle(session.lastUsed + IDLE_TIMEOUT_MS - 1)).toBe(0);
    expect(session.dead).toBe(false);

    expect(registry.reclaimIdle(session.lastUsed + IDLE_TIMEOUT_MS)).toBe(1);
    expect(session.dead).toBe(true);
    await waitForExit(pid);
    expect(alive(pid)).toBe(false);
  }, 20_000);

  it('tells the next repl_run why its state is gone instead of quietly respawning', async () => {
    const registry = makeRegistry();
    const first = registry.acquire('default', os.tmpdir());
    await first.session.run('let survivor = "old";', 5000);
    reclaimIdleSessions(Date.now() + IDLE_TIMEOUT_MS);

    const second = registry.acquire('default', os.tmpdir());
    expect(second.created).toBe(true);
    // The same field the hard-kill and crash paths use: a reclaimed session
    // must never look like one the caller simply never started.
    expect(second.previousDeath).toBe('idle for 15 minutes');
    const outcome = await second.session.run('typeof survivor', 5000);
    expect(outcome.result?.text).toContain('undefined');
  }, 20_000);

  it('still explains itself after repl_sessions has listed the connection', async () => {
    // Regression: `list()` used to DELETE dead sessions, so a repl_sessions
    // call landing between the reclaim and the next repl_run threw away the
    // reason and the agent got a silently empty runtime instead of a warning.
    const registry = makeRegistry();
    const first = registry.acquire('default', os.tmpdir());
    await first.session.run('let doomed = 1;', 5000);
    registry.reclaimIdle(Date.now() + IDLE_TIMEOUT_MS);

    expect(registry.list().map((s) => s.name)).toEqual([]);
    expect(registry.get('default')).toBeUndefined();

    const second = registry.acquire('default', os.tmpdir());
    expect(second.created).toBe(true);
    expect(second.previousDeath).toBe('idle for 15 minutes');
  }, 20_000);

  it('does not let corpses occupy the per-connection session cap', async () => {
    const registry = makeRegistry();
    const { session } = registry.acquire('default', os.tmpdir());
    await session.run('1', 5000);
    registry.reclaimIdle(Date.now() + IDLE_TIMEOUT_MS);

    // Four fresh sessions must still fit beside the corpse.
    for (let i = 0; i < 4; i++) registry.acquire(`live${i}`, os.tmpdir());
    expect(registry.liveCount).toBe(4);
    expect(() => registry.acquire('one-too-many', os.tmpdir())).toThrow(
      /already holds 4 REPL sessions/,
    );
  }, 30_000);

  it('spares a session that is still running code', async () => {
    const registry = makeRegistry();
    const { session } = registry.acquire('default', os.tmpdir());
    await session.run('1', 5000);

    // A single eval may legitimately run for minutes, and `lastUsed` is stamped
    // when it STARTS; reclaiming one mid-flight would destroy state the caller
    // is actively using.
    const inFlight = session.run('await new Promise((r) => setTimeout(r, 1500)); "done"', 10_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(session.busy).toBe(true);
    expect(registry.reclaimIdle(Date.now() + 10 * IDLE_TIMEOUT_MS)).toBe(0);
    expect(session.dead).toBe(false);

    const outcome = await inFlight;
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toContain('done');
  }, 20_000);

  it('reclaims on its own interval once enough time passes', async () => {
    // The clock goes fake BEFORE the registry exists, so the sweep interval is
    // the fake one; an interval scheduled on the real clock would never see
    // advanceTimersByTime. shouldAdvanceTime keeps real I/O progressing
    // meanwhile — the child under test is a real process and still needs it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const registry = makeRegistry();
    const { session } = registry.acquire('default', os.tmpdir());
    // A generous per-run timeout: under shouldAdvanceTime the hard deadline
    // burns real seconds, and a slow runner must not turn this into a hard-kill
    // death that masquerades as the reclaim being asserted.
    await session.run('let stale = 1;', 60_000);
    const pid = session.pid;
    expect(session.dead).toBe(false);

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + IDLE_SWEEP_INTERVAL_MS);
    vi.useRealTimers();

    expect(session.dead).toBe(true);
    expect(session.diedBecause).toBe('idle for 15 minutes');
    await waitForExit(pid);
    expect(alive(pid)).toBe(false);
  }, 20_000);
});

describe('the sweep timer', () => {
  it("is one per process, unref'd, and released with the last registry", () => {
    // A registry alone arms nothing: a connection that only ever ran
    // repl_sessions should not carry a sixty-second wakeup for its lifetime.
    expect(idleSweepTimerForTest()).toBeNull();
    const a = makeRegistry();
    a.acquire('default', os.tmpdir());
    const timer = idleSweepTimerForTest();
    expect(timer).not.toBeNull();
    // Waiting out an idle REPL is not work worth keeping the MCP server alive
    // for: a ref'd interval would stop the process ever exiting on its own.
    expect(timer?.hasRef()).toBe(false);

    const b = makeRegistry();
    b.acquire('default', os.tmpdir());
    b.acquire('second', os.tmpdir());
    // One interval for the process, not one per registry — and emphatically
    // not one per session.
    expect(idleSweepTimerForTest()).toBe(timer);

    a.disposeAll();
    expect(idleSweepTimerForTest()).toBe(timer);
    b.disposeAll();
    expect(idleSweepTimerForTest()).toBeNull();
  }, 20_000);
});

describe('repl_sessions idle reporting', () => {
  const sessionsTool = createReplToolCatalog().find((spec) => spec.name === 'repl_sessions');

  function listSessions(scope: ReturnType<typeof createConnectionScope>): string {
    const result = runInConnectionScope(
      scope,
      () => sessionsTool?.invoke({}, {} as never),
    ) as CallToolResult;
    return String(result.content[0]?.type === 'text' ? result.content[0].text : '');
  }

  it('reports time since the last run and time left before reclaim', async () => {
    const scope = createConnectionScope();
    const registry = runInConnectionScope(scope, () => getReplRegistry());
    registries.push(registry);
    const { session } = registry.acquire('default', os.tmpdir());
    await session.run('1', 5000);

    const idleView = listSessions(scope);
    expect(idleView).toMatch(/idle \d+s/);
    expect(idleView).toMatch(/reclaim in 1[45]m\d+s/);

    // A busy session has no countdown to report — the sweep does not touch it.
    const inFlight = session.run('await new Promise((r) => setTimeout(r, 1200)); 1', 10_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(listSessions(scope)).toContain('reclaim held while busy');
    await inFlight;
  }, 20_000);
});
