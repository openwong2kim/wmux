import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_MODE_ARG, CORE_TOOL_SURFACE } from '../coreSurface';
import { COMMANDER_TOOL_SURFACE } from '../commanderSurface';

/** The published full-profile contract. Deriving the expectation from the
 *  protocol baseline (rather than restating it) is what makes a NEW tool on
 *  the full surface fail this suite until someone classifies it. */
const baseline = JSON.parse(
  readFileSync(
    path.join(__dirname, '..', '..', '..', 'scripts', 'mcp-protocol-baseline.json'),
    'utf8',
  ),
) as { profiles: Record<string, { toolNames: string[] }> };

/** Tool families the core profile drops. Prefix-based on purpose: a new
 *  browser_/company_ tool is excluded automatically, and anything else new
 *  must be added to CORE_TOOL_SURFACE explicitly.
 *
 *  `company_` is kept even though the full surface ships no company tool
 *  today (the six `company_a2a_*` tools were removed): the probe bans the
 *  whole `company_` family from core, and matching the wider prefix here keeps
 *  the two drift gates from disagreeing the day a company tool comes back. */
const EXCLUDED_PREFIXES = ['browser_', 'company_'];

describe('core surface manifest invariants', () => {
  it('has no duplicate tool names', () => {
    expect(new Set(CORE_TOOL_SURFACE).size).toBe(CORE_TOOL_SURFACE.length);
  });

  it('contains no browser or company tool', () => {
    for (const name of CORE_TOOL_SURFACE) {
      expect(name).not.toMatch(/^browser_/);
      expect(name).not.toMatch(/^company_/);
    }
  });

  it('is exactly full minus the excluded families, in full registration order', () => {
    const fullNames = baseline.profiles.full.toolNames;
    const expected = fullNames.filter(
      (name) => !EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );
    // deepEqual, not set equality: core must preserve the canonical
    // full-profile registration order so a host's cached ordering holds.
    expect([...CORE_TOOL_SURFACE]).toEqual(expected);
  });

  it('matches the published core baseline exactly', () => {
    // Closes the regeneration loophole. Without this, dropping 'core' from one
    // catalog spec fails the probe once ("core: tool surface changed"), and a
    // developer who reflexively regenerates the baseline makes both gates
    // green again with a tool silently missing from the surface. Pinning
    // CORE_TOOL_SURFACE to baseline.core.toolNames means the regenerated
    // baseline has to disagree with the manifest to land.
    expect(baseline.profiles.core.toolNames).toEqual([...CORE_TOOL_SURFACE]);
  });

  it('is a strict subset of the full surface', () => {
    const fullNames = new Set(baseline.profiles.full.toolNames);
    for (const name of CORE_TOOL_SURFACE) expect(fullNames.has(name)).toBe(true);
    expect(CORE_TOOL_SURFACE.length).toBeLessThan(fullNames.size);
  });

  it('contains the entire commander surface (commander is a subset of core)', () => {
    const core = new Set(CORE_TOOL_SURFACE);
    for (const name of COMMANDER_TOOL_SURFACE) expect(core.has(name)).toBe(true);
  });

  it('selects the profile by an argv flag, never an env var', () => {
    expect(CORE_MODE_ARG).toBe('--core');
    expect(CORE_MODE_ARG.startsWith('--')).toBe(true);
  });
});
