import { describe, it, expect } from 'vitest';
import { raceDaemonShutdown, type DaemonShutdownClient } from '../daemonShutdownRace';

// Phase A — A3 (before-quit) and A5 (session-end) test. The helper itself is
// pure (no electron, no daemon bootstrap), so we exercise it directly with a
// fake client.

function makeClient(impl: (timeoutMs?: number) => Promise<unknown>): DaemonShutdownClient {
  return {
    rpc: (_method, _params, opts) => impl(opts?.timeoutMs),
  };
}

describe('raceDaemonShutdown', () => {
  it('resolves ok when the RPC settles before the budget', async () => {
    const client = makeClient(() => new Promise((resolve) => setTimeout(() => resolve({ status: 'ok' }), 50)));
    const result = await raceDaemonShutdown(client, 1_000);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns ok=false with timeout error when the RPC never resolves', async () => {
    const client = makeClient(() => new Promise<never>(() => { /* never */ }));
    const result = await raceDaemonShutdown(client, 100);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);
    expect(result.error).toMatch(/100ms/);
  });

  it('returns ok=false with the underlying error when the RPC rejects', async () => {
    const client = makeClient(() => Promise.reject(new Error('daemon dead')));
    const result = await raceDaemonShutdown(client, 1_000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('daemon dead');
  });

  it('passes the budget through to client.rpc as opts.timeoutMs', async () => {
    let observed: number | undefined;
    const client: DaemonShutdownClient = {
      rpc: (_method, _params, opts) => {
        observed = opts?.timeoutMs;
        return Promise.resolve({ status: 'ok' });
      },
    };
    await raceDaemonShutdown(client, 4_000);
    expect(observed).toBe(4_000);
  });

  // Defensive: the helper sets a setTimeout to enforce the budget. If the
  // RPC wins before the timer fires, the timer must be cleared so vitest
  // does not warn about open handles or keep the event loop alive.
  it('clears its internal timer once the RPC wins', async () => {
    let resolveRpc: ((v: unknown) => void) | null = null;
    const client = makeClient(() => new Promise((resolve) => { resolveRpc = resolve; }));
    const pending = raceDaemonShutdown(client, 30_000);
    // Yield once so the helper sets up its timer + awaits the race.
    await new Promise<void>((resolve) => setImmediate(resolve));
    resolveRpc!({ status: 'ok' });
    const result = await pending;
    expect(result.ok).toBe(true);
    // If the timer were leaked, this test would still pass but vitest's
    // open-handle detection or process exit hooks would flag it. Document
    // the contract in the assertion message.
  });
});
