/**
 * `StopFailure` → `agent.stop_failure` on the Claude Code bridge.
 *
 * Claude Code fires `StopFailure` INSTEAD of `Stop` when a turn ends on an API
 * error. The bridge resolves a hook's signal kind by looking the argv name up
 * in `HOOK_TO_KIND` and RETURNS EARLY on a miss (`unknown-hook-name`), so an
 * unmapped name is a silent no-op: the pane keeps the amber dot its
 * `UserPromptSubmit` lit until the agent process dies. Nothing else in the
 * pipeline can catch that, because nothing else ever sees the signal.
 *
 * Same harness as bridgeInputAnswered.test.ts: strip the CLI entrypoint,
 * re-export the map, dynamic-import a temp copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGE = 'integrations/claude/bin/wmux-bridge.mjs';
const ENTRYPOINT_MARKER = '// Run; never throw upward';

let tmp: string;
let hookToKind: Record<string, string>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-stopfailure-'));
  const src = readFileSync(path.resolve(process.cwd(), BRIDGE), 'utf8');
  const cut = src.indexOf(ENTRYPOINT_MARKER);
  expect(cut, `${BRIDGE} entrypoint marker`).toBeGreaterThan(-1);
  const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '')
    + '\nexport { HOOK_TO_KIND };\n';
  const mod = path.join(tmp, 'claude-under-test.mjs');
  writeFileSync(mod, testable, 'utf8');
  ({ HOOK_TO_KIND: hookToKind } = await import(pathToFileURL(mod).href));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('claude bridge HOOK_TO_KIND', () => {
  it('maps StopFailure to agent.stop_failure', () => {
    expect(hookToKind['StopFailure']).toBe('agent.stop_failure');
  });

  it('keeps StopFailure distinct from Stop', () => {
    // The two are different turn ends: Stop completed, StopFailure did not.
    // Collapsing them here would put "Task finished" on a failed turn.
    expect(hookToKind['Stop']).toBe('agent.stop');
    expect(hookToKind['StopFailure']).not.toBe(hookToKind['Stop']);
  });

  it('registers StopFailure in the bundled hooks.json at matcher ""', () => {
    // The plugin path reads hooks.json; a map entry with no registration is a
    // kind that can never arrive.
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'integrations/claude/hooks/hooks.json'), 'utf8'),
    ) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    const groups = manifest.hooks['StopFailure'];
    expect(groups).toBeDefined();
    expect(groups.some((g) => g.matcher === '')).toBe(true);
    expect(groups.some((g) => g.hooks.some((h) => h.command.endsWith('StopFailure')))).toBe(true);
  });
});
