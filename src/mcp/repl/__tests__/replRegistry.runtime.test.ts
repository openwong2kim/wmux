/**
 * Registry behavior against real children: the cap that protects the shared
 * broker, the respawn-after-death contract, and connection-scoped isolation.
 */
import * as os from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { runInConnectionScope, createConnectionScope } from '../../connectionScope';
import {
  MAX_SESSIONS_PER_CONNECTION,
  MAX_SESSIONS_PER_PROCESS,
  ReplRegistry,
  disposeReplRegistry,
  getReplRegistry,
  setReplBrokerMode,
} from '../replRegistry';

const registries: ReplRegistry[] = [];

function makeRegistry(): ReplRegistry {
  const registry = new ReplRegistry();
  registries.push(registry);
  return registry;
}

afterEach(() => {
  while (registries.length > 0) registries.pop()?.disposeAll();
});

describe('ReplRegistry', () => {
  it('reuses a live session and reports when it had to start a new one', async () => {
    const registry = makeRegistry();
    const first = registry.acquire('default', os.tmpdir());
    expect(first.created).toBe(true);
    await first.session.run('let shared = 5;', 5000);

    const second = registry.acquire('default', os.tmpdir());
    expect(second.created).toBe(false);
    expect(second.session).toBe(first.session);
    const outcome = await second.session.run('shared', 5000);
    expect(outcome.result?.text).toBe('5');
  }, 20_000);

  it('respawns after a death and names the reason the old state is gone', async () => {
    const registry = makeRegistry();
    const first = registry.acquire('default', os.tmpdir());
    await first.session.run('let gone = 1;', 5000);
    await first.session.run('process.exit(0)', 5000);
    expect(first.session.dead).toBe(true);

    const second = registry.acquire('default', os.tmpdir());
    expect(second.created).toBe(true);
    expect(second.previousDeath).toContain('exited on its own');
    const outcome = await second.session.run('typeof gone', 5000);
    expect(outcome.result?.text).toContain('undefined');
  }, 20_000);

  it('refuses to exceed the per-connection session cap', () => {
    const registry = makeRegistry();
    for (let i = 0; i < MAX_SESSIONS_PER_CONNECTION; i++) {
      registry.acquire(`s${i}`, os.tmpdir());
    }
    expect(() => registry.acquire('one-too-many', os.tmpdir())).toThrow(
      /already holds 4 REPL sessions/,
    );
    // Freeing one makes room again.
    expect(registry.reset('s0')).toBe(true);
    expect(() => registry.acquire('one-too-many', os.tmpdir())).not.toThrow();
  }, 20_000);

  it('kills the child on reset and starts clean afterwards', async () => {
    const registry = makeRegistry();
    const { session } = registry.acquire('default', os.tmpdir());
    await session.run('let wiped = "old";', 5000);
    const pid = session.pid;

    expect(registry.reset('default')).toBe(true);
    expect(registry.reset('default')).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid as number, 0)).toThrow();

    const fresh = registry.acquire('default', os.tmpdir());
    expect(fresh.created).toBe(true);
    const outcome = await fresh.session.run('typeof wiped', 5000);
    expect(outcome.result?.text).toContain('undefined');
  }, 20_000);

  it('lists only live sessions', async () => {
    const registry = makeRegistry();
    registry.acquire('a', os.tmpdir());
    const { session } = registry.acquire('b', os.tmpdir());
    expect(registry.list().map((s) => s.name).sort()).toEqual(['a', 'b']);
    await session.run('process.exit(0)', 5000);
    expect(registry.list().map((s) => s.name)).toEqual(['a']);
  }, 20_000);
});

describe('host-wide bound', () => {
  it('refuses past the process ceiling even across separate connections', () => {
    // The per-connection cap is not a host bound: the broker hosts N agents, so
    // N x 4 children would land on one machine without this.
    const owned: ReplRegistry[] = [];
    let created = 0;
    try {
      for (let r = 0; r < 8; r++) {
        const registry = makeRegistry();
        owned.push(registry);
        for (let i = 0; i < MAX_SESSIONS_PER_CONNECTION; i++) {
          try {
            registry.acquire(`s${i}`, os.tmpdir());
            created++;
          } catch (error) {
            expect(String(error)).toMatch(/host-wide limit|already holds/);
            expect(created).toBe(MAX_SESSIONS_PER_PROCESS);
            return;
          }
        }
      }
      throw new Error(`expected the process ceiling to bite; created ${created}`);
    } finally {
      for (const registry of owned) registry.disposeAll();
    }
  }, 60_000);
});

describe('connection scoping', () => {
  it('gives each connection its own sessions and disposes only its own', async () => {
    const scopeA = createConnectionScope();
    const scopeB = createConnectionScope();

    const runIn = <T>(scope: ReturnType<typeof createConnectionScope>, fn: () => T): T =>
      runInConnectionScope(scope, fn);

    const a = runIn(scopeA, () => getReplRegistry().acquire('default', os.tmpdir()));
    const b = runIn(scopeB, () => getReplRegistry().acquire('default', os.tmpdir()));
    expect(a.session).not.toBe(b.session);

    await a.session.run('let onlyA = 1;', 5000);
    const bView = await b.session.run('typeof onlyA', 5000);
    expect(bView.result?.text).toContain('undefined');

    // Tearing down A's connection must not touch B's live runtime.
    runIn(scopeA, () => disposeReplRegistry());
    expect(a.session.dead).toBe(true);
    expect(b.session.dead).toBe(false);
    const stillLive = await b.session.run('1 + 1', 5000);
    expect(stillLive.result?.text).toBe('2');

    runIn(scopeB, () => disposeReplRegistry());
    expect(b.session.dead).toBe(true);
  }, 20_000);

  it('refuses to serve a scopeless call once broker mode is declared', () => {
    // Run LAST: broker mode is process-wide and one-way, matching the real
    // broker, where it is set at startup and never cleared.
    setReplBrokerMode();
    // Outside any runInConnectionScope there is no way to tell whose session
    // this would be. Falling back to a shared registry would hand one agent
    // another's live runtime, so this must fail loudly instead.
    expect(() => getReplRegistry()).toThrow(/cannot be attributed/);

    // Inside a scope it still works, and disposal stays tolerant so teardown
    // is never abandoned half-done.
    const scope = createConnectionScope();
    runInConnectionScope(scope, () => {
      expect(getReplRegistry()).toBeInstanceOf(ReplRegistry);
    });
    expect(() => disposeReplRegistry()).not.toThrow();
  });
});
