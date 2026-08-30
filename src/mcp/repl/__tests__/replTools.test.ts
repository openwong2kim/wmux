import { describe, expect, it } from 'vitest';
import {
  expectCommanderCatalogLockstep,
  expectFrozenCatalog,
} from '../../__tests__/catalogAssertions';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  clampTimeout,
  createReplToolCatalog,
  formatOutcome,
} from '../tools';
import { DEFAULT_SESSION_NAME, isValidSessionName } from '../replRegistry';
import { truncateText } from '../truncate';

describe('repl tool catalog', () => {
  const catalog = createReplToolCatalog();

  it('registers exactly the three MVP tools', () => {
    expect(catalog.map((spec) => spec.name)).toEqual(['repl_run', 'repl_reset', 'repl_sessions']);
  });

  it('is frozen and stays out of the commander surface', () => {
    expectFrozenCatalog(catalog);
    expectCommanderCatalogLockstep(catalog);
    for (const spec of catalog) {
      expect(spec.profiles).toEqual(['full']);
    }
  });

  it('tells the caller the runtime is unsandboxed and connection-scoped', () => {
    const run = catalog.find((spec) => spec.name === 'repl_run');
    // Both are load-bearing honesty: an agent that thinks this is a jail, or
    // that state outlives wmux, will write code against a fiction.
    expect(run?.description).toContain('NO sandbox');
    expect(run?.description).toContain('MCP connection');
  });
});

describe('clampTimeout', () => {
  it('defaults when unset or not a number', () => {
    expect(clampTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('clamps rather than rejecting out-of-range requests', () => {
    expect(clampTimeout(1)).toBe(MIN_TIMEOUT_MS);
    expect(clampTimeout(-5000)).toBe(MIN_TIMEOUT_MS);
    expect(clampTimeout(10 * MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
    expect(clampTimeout(1234.9)).toBe(1234);
  });
});

describe('session names', () => {
  it('accepts the boring shapes and rejects everything else', () => {
    expect(isValidSessionName(DEFAULT_SESSION_NAME)).toBe(true);
    expect(isValidSessionName('build-2.worker_1')).toBe(true);
    expect(isValidSessionName('')).toBe(false);
    expect(isValidSessionName('has space')).toBe(false);
    expect(isValidSessionName('../escape')).toBe(false);
    expect(isValidSessionName('a'.repeat(65))).toBe(false);
    expect(isValidSessionName('a'.repeat(64))).toBe(true);
  });
});

describe('formatOutcome', () => {
  const empty = truncateText('', 1024);

  it('renders result, stdout, and stderr in labelled blocks', () => {
    const text = formatOutcome(
      'default',
      {
        ok: true,
        result: truncateText('42', 1024),
        stdout: truncateText('printed\n', 1024),
        stderr: truncateText('warned\n', 1024),
        elapsedMs: 12,
      },
      [],
    );
    expect(text).toContain('session default · ok · 12ms');
    expect(text).toContain('--- stdout ---\nprinted');
    expect(text).toContain('--- stderr ---\nwarned');
    expect(text).toContain('--- result ---\n42');
  });

  it('surfaces the fatal reason so lost state is never silent', () => {
    const text = formatOutcome(
      'default',
      {
        ok: false,
        error: 'killed',
        fatal: 'hard timeout: session state was lost',
        stdout: empty,
        stderr: empty,
        elapsedMs: 500,
      },
      [],
    );
    expect(text).toContain('note: hard timeout: session state was lost');
    expect(text).toContain('--- error ---');
  });

  it('says state survived when the vm watchdog stopped the run', () => {
    const text = formatOutcome(
      'default',
      { ok: false, error: 'Script execution timed out', stdout: empty, stderr: empty, elapsedMs: 300, timedOut: true },
      [],
    );
    expect(text).toContain('Session state survived');
  });

  it('reports truncation with the true byte total', () => {
    const flood = truncateText('z'.repeat(5000), 400);
    const text = formatOutcome(
      'default',
      { ok: true, result: truncateText('1', 1024), stdout: flood, stderr: empty, elapsedMs: 5 },
      [],
    );
    expect(text).toContain('stdout truncated: 5000 bytes total');
  });

  it('passes through registry notes such as a fresh runtime', () => {
    const text = formatOutcome(
      'build',
      { ok: true, result: truncateText('1', 1024), stdout: empty, stderr: empty, elapsedMs: 1 },
      ['started a new runtime in /tmp'],
    );
    expect(text).toContain('note: started a new runtime in /tmp');
  });
});
