import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { toolInputSchema } from '../../toolCatalog';
import {
  expectCommanderCatalogLockstep,
  expectCoreCatalogLockstep,
  expectFrozenCatalog,
} from '../../__tests__/catalogAssertions';
import { BROWSER_REPL_TOOLS } from '../bridge';
import { createBrowserReplCatalog } from '../tool';

describe('browser_repl catalog', () => {
  const catalog = createBrowserReplCatalog(new Map());

  it('registers exactly browser_repl, full profile only, frozen', () => {
    expect(catalog.map((spec) => spec.name)).toEqual(['browser_repl']);
    expectFrozenCatalog(catalog);
    expectCommanderCatalogLockstep(catalog);
    expectCoreCatalogLockstep(catalog);
    // The browser_ prefix is excluded from core by derivation; the commander
    // has no browser hands. Saying so in the spec keeps the probe honest.
    expect(catalog[0].profiles).toEqual(['full']);
  });

  it('names the permission boundary it moves: every allowed tool, and that the rest stay separate', () => {
    const description = catalog[0].description;
    for (const name of BROWSER_REPL_TOOLS) expect(description).toContain(name);
    expect(description).toContain('Other browser_* tools stay separate calls');
    // Evaluate is the one an agent would most expect; it must be absent.
    expect(BROWSER_REPL_TOOLS).not.toContain('evaluate');
    expect(BROWSER_REPL_TOOLS).not.toContain('replay');
    // Screenshot reads the page only, and its image now rides back with the
    // run's result, so it is in — everything that reaches state outside the
    // page still stays a separate call.
    expect(BROWSER_REPL_TOOLS).toContain('screenshot');
    for (const outside of ['storage', 'download', 'pdf', 'trace', 'response_body']) {
      expect(BROWSER_REPL_TOOLS).not.toContain(outside);
    }
  });

  it('rejects an unknown option and names the ones that would have worked', () => {
    expect(catalog[0].strictInput).toBe(true);
    const schema = toolInputSchema(catalog[0]) as z.ZodObject;
    // Silently dropping this used to run the snippet under the default
    // timeout, which reads exactly like a snippet that never timed out.
    const result = schema.safeParse({ code: '1', timeoutMs: 500 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'unknown option "timeoutMs"; valid: code, timeout, surfaceId, maxBytes',
    );
    expect(schema.safeParse({ code: '1' }).success).toBe(true);
    expect(
      schema.safeParse({ code: '1', timeout: 500, surfaceId: 's1' }).success,
    ).toBe(true);
  });

  it('stays under the tools/list budget it was squeezed into', () => {
    // The full profile has ~3.3KB of headroom; the spec's description plus
    // schema text is what tools/list serializes.
    const bytes = Buffer.byteLength(JSON.stringify(catalog[0].description), 'utf8');
    expect(bytes).toBeLessThan(1200);
  });
});
