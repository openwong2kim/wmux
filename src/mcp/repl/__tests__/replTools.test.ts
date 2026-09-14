import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { toolInputSchema } from '../../toolCatalog';
import {
  expectCommanderCatalogLockstep,
  expectCoreCatalogLockstep,
  expectFrozenCatalog,
} from '../../__tests__/catalogAssertions';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  REPL_BROWSER_PROFILE_REFUSAL,
  clampTimeout,
  createReplToolCatalog,
  formatOutcome,
  resolveReplBrowser,
} from '../tools';
import { BROWSER_REPL_TOOLS, REPL_RUN_BROWSER_TOOLS } from '../../browser-repl/bridge';
import type { CollectedTool } from '../../playwright/toolCollector';
import { REPL_RUNNER_SOURCE, buildRunnerBootstrap } from '../replRunnerSource';
import { DEFAULT_SESSION_NAME, isValidSessionName } from '../replRegistry';
import { truncateText } from '../truncate';

describe('repl tool catalog', () => {
  const catalog = createReplToolCatalog();

  it('registers exactly the three MVP tools', () => {
    expect(catalog.map((spec) => spec.name)).toEqual(['repl_run', 'repl_reset', 'repl_sessions']);
  });

  it('is frozen, on the core surface, and out of the commander surface', () => {
    expectFrozenCatalog(catalog);
    expectCommanderCatalogLockstep(catalog);
    expectCoreCatalogLockstep(catalog);
    for (const spec of catalog) {
      // core: an agent doing terminal/pane/delegation work wants the REPL.
      // commander: still out — the brain drives workers, it does not execute.
      expect(spec.profiles).toEqual(['full', 'core']);
    }
  });

  it('rejects an unknown option and names the ones that would have worked', () => {
    for (const spec of catalog) expect(spec.strictInput).toBe(true);

    // A dropped `timeoutMs` would have run under the default timeout and read
    // back exactly like a run that honoured the caller's number.
    const run = (toolInputSchema(catalog[0]) as z.ZodObject).safeParse({
      code: '1',
      timeoutMs: 500,
    });
    expect(run.success).toBe(false);
    expect(run.error?.issues[0]?.message).toBe(
      'unknown option "timeoutMs"; valid: code, session, timeout, cwd, maxBytes',
    );

    const reset = (toolInputSchema(catalog[1]) as z.ZodObject).safeParse({
      sessionName: 'a',
    });
    expect(reset.error?.issues[0]?.message).toBe(
      'unknown option "sessionName"; valid: session',
    );

    const sessions = (toolInputSchema(catalog[2]) as z.ZodObject).safeParse({
      session: 'a',
    });
    expect(sessions.error?.issues[0]?.message).toBe(
      'unknown option "session"; this tool takes no options',
    );
  });

  it('leaves the documented options working', () => {
    const run = toolInputSchema(catalog[0]) as z.ZodObject;
    expect(run.safeParse({ code: '1 + 1' }).success).toBe(true);
    expect(
      run.safeParse({ code: '1 + 1', session: 'a', timeout: 500, cwd: '/tmp' }).success,
    ).toBe(true);
    const reset = toolInputSchema(catalog[1]) as z.ZodObject;
    expect(reset.safeParse({ session: 'a' }).success).toBe(true);
    const sessions = toolInputSchema(catalog[2]) as z.ZodObject;
    expect(sessions.safeParse({}).success).toBe(true);
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

describe('repl_run browser binding', () => {
  function fakeBrowserTools(): { tools: Map<string, CollectedTool>; called: string[] } {
    const called: string[] = [];
    const tools = new Map<string, CollectedTool>();
    for (const short of ['click', 'screenshot', 'storage', 'evaluate']) {
      tools.set(`browser_${short}`, {
        name: `browser_${short}`,
        shape: {},
        handler: async () => {
          called.push(short);
          return { content: [{ type: 'text', text: `${short} ran` }] };
        },
      });
    }
    return { tools, called };
  }

  it('binds the browser only on the full profile, even when the sink holds handlers', async () => {
    const full = fakeBrowserTools();
    const bound = resolveReplBrowser({ tools: full.tools, profile: 'full' }, undefined);
    expect(bound.call).not.toBeNull();
    await expect(bound.call?.('click', {})).resolves.toMatchObject({ ok: true });
    expect(full.called).toEqual(['click']);

    // core and commander: the collector sink is full of browser handlers (it
    // records before the surface filter skips registration), yet nothing binds.
    for (const profile of ['core', 'commander'] as const) {
      const sink = fakeBrowserTools();
      const refused = resolveReplBrowser({ tools: sink.tools, profile }, undefined);
      expect(refused.call).toBeNull();
      expect(refused.refusal).toBe(REPL_BROWSER_PROFILE_REFUSAL);
      expect(refused.tools).toEqual(REPL_RUN_BROWSER_TOOLS);
      expect(sink.called).toEqual([]);
    }
    expect(resolveReplBrowser(undefined, undefined).call).toBeNull();
  });

  it('exposes exactly the browser_repl set plus screenshot, and refuses the rest per call', async () => {
    expect(REPL_RUN_BROWSER_TOOLS).toEqual([...new Set([...BROWSER_REPL_TOOLS, 'screenshot'])]);
    const sink = fakeBrowserTools();
    const bound = resolveReplBrowser({ tools: sink.tools, profile: 'full' }, undefined);
    for (const name of ['storage', 'evaluate']) {
      await expect(bound.call?.(name, {})).resolves.toMatchObject({
        ok: false,
        error: `browser.${name} is not available inside repl_run — call the browser_${name} tool directly`,
      });
    }
    await expect(bound.call?.('screenshot', {})).resolves.toMatchObject({ ok: true });
    expect(sink.called).toEqual(['screenshot']);
  });

  it('keeps the runner bootstrap within its command-line budget', () => {
    const base64 = Buffer.from(REPL_RUNNER_SOURCE, 'utf8').toString('base64');
    expect(base64.length).toBeLessThanOrEqual(17_600);
    expect(buildRunnerBootstrap()).toContain(base64);
  });

  it('names the browser object in the description without spending the budget', () => {
    expect(catalogDescription()).toContain('browser.X(args)');
  });

  it('renders hints and the image legend from a run that drove the browser', () => {
    const empty = truncateText('', 1024);
    const text = formatOutcome(
      'default',
      {
        ok: true,
        result: truncateText("'img-1'", 1024),
        stdout: empty,
        stderr: empty,
        elapsedMs: 3,
        browser: {
          calls: 2,
          hints: ['1. [replay] 1 recorded flow(s) for this page: login'],
          hintsElided: 0,
          images: [{ id: 'img-1', callIndex: 2, data: 'AAAA', mimeType: 'image/png' }],
          imagesElided: 1,
        },
      },
      [],
    );
    expect(text).toContain('--- hints ---\n1. [replay] 1 recorded flow(s) for this page: login');
    expect(text).toContain('--- images ---\nimg-1: call 2 (image/png, 1 KiB)');
    expect(text).toContain('(1 image(s) not attached: at most 4 images and 2 MiB per run)');
  });
});

function catalogDescription(): string {
  return createReplToolCatalog()[0].description;
}
