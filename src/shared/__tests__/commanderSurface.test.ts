import { describe, expect, it } from 'vitest';
import {
  COMMANDER_TOOL_SURFACE,
  COMMANDER_RPC_METHODS,
  COMMANDER_TEARDOWN_DENY,
} from '../commanderSurface';
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
