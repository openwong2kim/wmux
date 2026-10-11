// The MCP protocol baseline (scripts/mcp-protocol-baseline.json): compare a
// measured surface against it, or — in update mode — rewrite it.
//
// probe-commander-surface.mjs pins the exact bytes a host sees (tool names,
// schemas, descriptions, ordering, server instructions) by hash. Any change to
// an MCP tool's schema or description changes those hashes, which is correct:
// the change must be deliberate and reviewed. The fix is always the same, so
// every mismatch says it:
//
//   npm run mcp:baseline:update   (rebuilds MCP, rewrites the baseline)
//
// Budgets (maxListBytes) are never rewritten here: raising one is a
// deliberate act with its own note in probe-commander-surface.mjs.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

export const BASELINE_HINT =
  'MCP tool schema changed; run npm run mcp:baseline:update and commit scripts/mcp-protocol-baseline.json';

/** Fields the update mode may rewrite. */
export const UPDATABLE_FIELDS = new Set(['wireResultSha256', 'instructionSha256', 'toolNames']);

export function createBaselineGuard({ update = false } = {}) {
  const changes = [];
  return {
    update,
    changes,
    /**
     * Compare `actual` with `config[key]`. Check mode: throw with the update
     * instruction. Update mode: record and adopt the new value.
     */
    expect(config, key, actual, label) {
      if (!UPDATABLE_FIELDS.has(key)) throw new Error(`baseline field ${key} is not updatable`);
      let same = true;
      try {
        assert.deepEqual(actual, config[key]);
      } catch {
        same = false;
      }
      if (same) return;
      if (!update) {
        assert.deepEqual(actual, config[key], `${label}\n\n${BASELINE_HINT}\n`);
        return;
      }
      changes.push({ label, key });
      config[key] = Array.isArray(actual) ? [...actual] : actual;
    },
  };
}

/** Write the baseline back in its checked-in format (2-space JSON + newline). */
export function writeBaseline(file, baseline) {
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
}
