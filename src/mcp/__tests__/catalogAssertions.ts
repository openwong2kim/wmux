import { expect } from 'vitest';
import { COMMANDER_TOOL_SURFACE } from '../../shared/commanderSurface';
import type { WmuxToolSpec } from '../toolCatalog';

/**
 * Transitional invariant while the legacy commander manifest and typed
 * catalog coexist. Membership is set-based; public ordering is pinned
 * independently by each domain and the raw protocol probe.
 */
export function expectCommanderCatalogLockstep(
  specs: readonly WmuxToolSpec[],
): void {
  const migratedNames = new Set<string>(specs.map((spec) => spec.name));
  const catalogCommanderNames = specs
    .filter((spec) => spec.profiles.includes('commander'))
    .map((spec) => spec.name);
  const manifestCommanderNames = COMMANDER_TOOL_SURFACE.filter((name) =>
    migratedNames.has(name),
  );

  expect(new Set(catalogCommanderNames)).toEqual(
    new Set(manifestCommanderNames),
  );
}

export function expectFrozenCatalog(specs: readonly WmuxToolSpec[]): void {
  expect(Object.isFrozen(specs)).toBe(true);
  for (const spec of specs) {
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.profiles)).toBe(true);
    expect(Object.isFrozen(spec.inputSchema)).toBe(true);
  }
}
