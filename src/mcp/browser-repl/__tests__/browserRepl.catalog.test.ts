import { describe, expect, it } from 'vitest';
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
    expect(BROWSER_REPL_TOOLS).not.toContain('screenshot');
    expect(BROWSER_REPL_TOOLS).not.toContain('replay');
  });

  it('stays under the tools/list budget it was squeezed into', () => {
    // The full profile has ~3.3KB of headroom; the spec's description plus
    // schema text is what tools/list serializes.
    const bytes = Buffer.byteLength(JSON.stringify(catalog[0].description), 'utf8');
    expect(bytes).toBeLessThan(1200);
  });
});
