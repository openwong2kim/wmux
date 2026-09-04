import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  COMMANDER_TOOL_SURFACE,
  COMMANDER_RPC_METHODS,
  COMMANDER_TEARDOWN_DENY,
  COMMANDER_ONLY_TOOLS,
  COMMANDER_ONLY_RESERVED_TOOLS,
  COMMANDER_VARIANT_TOOLS,
} from '../commanderSurface';
import { CORE_TOOL_SURFACE } from '../coreSurface';
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_ALLOWED_TOOLS_FROM_SURFACE,
} from '../../main/deck/ClaudeSdkAdapter';
import { FIRST_PARTY_METHODS } from '../../main/mcp/firstParty';

// BYOB P4 invariants (eng review P2): the manifest is only an SSOT if tests
// pin every consumer to it — a shared string[] alone would just replicate a
// typo into all layers.
describe('commander surface manifest invariants', () => {
  it('has no duplicate tool names', () => {
    expect(new Set(COMMANDER_TOOL_SURFACE).size).toBe(COMMANDER_TOOL_SURFACE.length);
  });

  it('never contains a teardown or out-of-scope tool family', () => {
    for (const name of COMMANDER_TOOL_SURFACE) {
      expect(name).not.toMatch(/^(pane_close|surface_close|workspace_close)$/);
      expect(name).not.toMatch(/^browser_/);
      expect(name).not.toMatch(/^company_/);
    }
  });

  it('SDK auto-allow list === the registered surface (no drift, invariant ①)', () => {
    // Order-insensitive equality: the literal D2 list in ClaudeSdkAdapter and
    // the SSOT derivation must be the same set.
    expect(new Set(DEFAULT_ALLOWED_TOOLS)).toEqual(new Set(DEFAULT_ALLOWED_TOOLS_FROM_SURFACE));
    expect(DEFAULT_ALLOWED_TOOLS).toHaveLength(DEFAULT_ALLOWED_TOOLS_FROM_SURFACE.length);
  });

  it('commander RPC allow lane ⊆ the bundled server first-party set (invariant ②)', () => {
    // The bundled MCP child can only ever call FIRST_PARTY_METHODS (enforced
    // by firstParty.test.ts's source parser). The commander lane must be a
    // strict narrowing of that — anything outside it could not have come from
    // the registered tool surface.
    for (const method of COMMANDER_RPC_METHODS) {
      expect(FIRST_PARTY_METHODS.has(method as never), `${method} not first-party`).toBe(true);
    }
    expect(COMMANDER_RPC_METHODS.size).toBeLessThan(FIRST_PARTY_METHODS.size);
  });

  it('teardown deny-set is disjoint from the commander allow lane (invariant ③)', () => {
    for (const method of COMMANDER_TEARDOWN_DENY) {
      expect(COMMANDER_RPC_METHODS.has(method), `${method} both allowed and denied`).toBe(false);
    }
    // Effect-based inventory: the known teardown reachers must all be present.
    for (const required of [
      'pane.close',
      'surface.close',
      'workspace.close',
      'browser.tabs',
      'browser.close',
    ]) {
      expect(COMMANDER_TEARDOWN_DENY.has(required)).toBe(true);
    }
  });
});

// Lane F: the commander-only lane (src/mcp/index.ts) ADDS tools to the
// commander profile that no other profile registers. Every enforcement layer
// must agree on that second list too.
const baseline = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'mcp-protocol-baseline.json'), 'utf8'),
) as { profiles: Record<string, { toolNames: string[] }> };

describe('commander-only lane invariants (COMMANDER_ONLY_TOOLS)', () => {
  it('is disjoint from the filtered commander surface, core and full — except the declared variants', () => {
    const full = new Set(baseline.profiles.full.toolNames);
    const variants = new Set(COMMANDER_VARIANT_TOOLS);
    for (const name of COMMANDER_ONLY_TOOLS) {
      expect(COMMANDER_TOOL_SURFACE).not.toContain(name);
      if (variants.has(name)) {
        // A variant re-registers a full/core name under the brain's schema;
        // the worker registration must exist in full and core for it to be
        // a variant at all.
        expect(full.has(name), `${name} is declared a variant but is not in full`).toBe(true);
        expect(CORE_TOOL_SURFACE).toContain(name);
        continue;
      }
      expect(CORE_TOOL_SURFACE).not.toContain(name);
      expect(full.has(name), `${name} leaked into the full profile`).toBe(false);
      expect(baseline.profiles.core.toolNames).not.toContain(name);
    }
    for (const name of COMMANDER_VARIANT_TOOLS) expect(COMMANDER_ONLY_TOOLS).toContain(name);
  });

  it('the commander profile lists each name exactly once (a variant replaces, never duplicates)', () => {
    const names = baseline.profiles.commander.toolNames;
    expect(new Set(names).size).toBe(names.length);
  });

  it('the brain has a ledger write path: ledger_update on the commander lane and ledger.update in the RPC lane', () => {
    expect(COMMANDER_ONLY_TOOLS).toContain('ledger_update');
    expect(COMMANDER_RPC_METHODS.has('ledger.update')).toBe(true);
  });

  it('the published commander baseline === COMMANDER_TOOL_SURFACE (full order) + COMMANDER_ONLY_TOOLS', () => {
    const fullOrder = baseline.profiles.full.toolNames;
    const filtered = new Set(COMMANDER_TOOL_SURFACE);
    expect(baseline.profiles.commander.toolNames).toEqual([
      ...fullOrder.filter((n) => filtered.has(n)),
      ...COMMANDER_ONLY_TOOLS,
    ]);
  });

  it('SDK auto-allow list covers the commander-only tools too (invariant ①, extended)', () => {
    for (const name of COMMANDER_ONLY_TOOLS) {
      expect(DEFAULT_ALLOWED_TOOLS).toContain(`mcp__wmux__${name}`);
    }
  });

  it('reserved lane-O2 names are absent from every profile and from the src/mcp/index.ts wiring', () => {
    // The wiring point is index.ts. The implementations (src/mcp/worktask.ts,
    // src/mcp/git.ts) may exist ahead of being wired — that is exactly the
    // reserved state — so only the entry file is scanned.
    const sources = readFileSync(path.join(__dirname, '..', '..', 'mcp', 'index.ts'), 'utf8');
    for (const name of COMMANDER_ONLY_RESERVED_TOOLS) {
      expect(COMMANDER_ONLY_TOOLS).not.toContain(name);
      expect(COMMANDER_TOOL_SURFACE).not.toContain(name);
      for (const profile of Object.values(baseline.profiles)) expect(profile.toolNames).not.toContain(name);
      expect(sources.includes(`'${name}'`), `${name} is registered in src/mcp before being wired`).toBe(false);
    }
  });

  it('the commander RPC lane carries the ledger read the commander-only tool calls', () => {
    expect(COMMANDER_RPC_METHODS.has('ledger.list')).toBe(true);
  });
});
