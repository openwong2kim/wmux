/**
 * Per-call RPC deadline — regression guard.
 *
 * The blocking `events.poll` needs a deadline longer than 10s, and the cheap
 * way to get one is to widen the shared constant. That would be wrong in a way
 * nothing else catches: `TIMEOUT_MS` is the deadline for EVERY MCP tool, so
 * raising it means a genuinely wedged call (dead main, stuck renderer hop) now
 * hangs the agent for the new duration instead of failing fast. The blast
 * radius is every tool; the symptom is "wmux got slow sometimes".
 *
 * So the contract is: the default stays 10000, and only a caller that asks
 * gets more. These are source-structural assertions rather than socket tests
 * because the behavioral transport fixture is a Unix domain socket and skips on
 * win32 — this repo's primary platform — so a behavior-only guard would not run
 * where the regression would land.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLIENT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'wmux-client.ts'),
  'utf-8',
);
const INDEX_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'index.ts'),
  'utf-8',
);

describe('wmux-client — per-call timeout', () => {
  it('keeps the shared default at 10s', () => {
    expect(CLIENT_SRC).toMatch(/const TIMEOUT_MS = 10000;/);
  });

  it('defaults every call to the shared constant, so an omitted arg cannot change behavior', () => {
    // Both the retry wrapper and the socket attempt default to TIMEOUT_MS.
    // If either loses its default, an internal call site that forgets the
    // argument silently gets `undefined` → setTimeout fires immediately.
    const defaulted = CLIENT_SRC.match(/timeoutMs: number = TIMEOUT_MS,/g) ?? [];
    expect(defaulted.length).toBeGreaterThanOrEqual(2);
  });

  it('applies the per-call value to the timer AND reports it in the error', () => {
    // The timer must use the parameter, not the constant — otherwise the
    // parameter is accepted and ignored, which is worse than not having it.
    expect(CLIENT_SRC).toMatch(/\}, timeoutMs\);/);
    expect(CLIENT_SRC).toMatch(/RPC timeout: \$\{method\} \(\$\{timeoutMs\}ms\)/);
    expect(CLIENT_SRC).not.toMatch(/\}, TIMEOUT_MS\);/);
  });

  it('threads the value through every attempt, including the TCP fallback', () => {
    // The win32 TCP fallback is a separate call site; missing it there means a
    // blocking poll works on the pipe and times out at 10s on the fallback.
    const attempts = CLIENT_SRC.match(/attemptRpc\([^)]*timeoutMs\)/g) ?? [];
    expect(attempts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('mcp — only a blocking poll raises its own deadline', () => {
  it('passes a custom timeout for events.poll only when blockMs > 0', () => {
    expect(INDEX_SRC).toMatch(
      /if \(blockMs !== undefined && blockMs > 0\) \{[\s\S]*?callRpc\('events\.poll', params, blockMs \+ EVENTS_POLL_BLOCK_MARGIN_MS\)/,
    );
  });

  it('leaves the non-blocking path on the default deadline', () => {
    // The fall-through call must NOT pass a third argument.
    expect(INDEX_SRC).toMatch(/return callRpc\('events\.poll', params\);/);
  });

  it('adds slack over the server-side budget', () => {
    // main returns AT its own blockMs; the client must outlive that by enough
    // to receive the answer, or an on-time response surfaces as a timeout.
    const m = INDEX_SRC.match(/const EVENTS_POLL_BLOCK_MARGIN_MS = ([\d_]+);/);
    if (!m) throw new Error('EVENTS_POLL_BLOCK_MARGIN_MS not found in mcp/index.ts');
    expect(Number(m[1].replace(/_/g, ''))).toBeGreaterThanOrEqual(1_000);
  });
});
