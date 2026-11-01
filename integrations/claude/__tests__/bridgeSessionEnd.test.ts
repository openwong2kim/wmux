/**
 * `SessionEnd` → `agent.session_end` on both Claude bridges, registered in
 * both bundled manifests. It is how a session outside wmux ends where no pid
 * can be checked; an unmapped name is a silent `unknown-hook-name` no-op.
 *
 * Same harness as bridgeStopFailure.test.ts: strip the CLI entrypoint,
 * re-export the map, dynamic-import a temp copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAgentSignal } from '../../../src/shared/hooks/signal-types';

const BRIDGES = {
  claude: 'integrations/claude',
  openclaude: 'integrations/openclaude',
};
const ENTRYPOINT_MARKER = '// Run; never throw upward';

let tmp: string;
const maps: Record<string, Record<string, string>> = {};

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-sessionend-'));
  for (const [name, dir] of Object.entries(BRIDGES)) {
    const src = readFileSync(path.resolve(process.cwd(), dir, 'bin/wmux-bridge.mjs'), 'utf8');
    const cut = src.indexOf(ENTRYPOINT_MARKER);
    expect(cut, `${name} entrypoint marker`).toBeGreaterThan(-1);
    const mod = path.join(tmp, `${name}-under-test.mjs`);
    writeFileSync(mod, `${src.slice(0, cut).replace(/^#![^\n]*\n/, '')}\nexport { HOOK_TO_KIND };\n`, 'utf8');
    maps[name] = (await import(pathToFileURL(mod).href)).HOOK_TO_KIND;
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe.each(Object.keys(BRIDGES))('%s bridge SessionEnd', (name) => {
  it('maps SessionEnd to agent.session_end, a kind the daemon accepts', () => {
    expect(maps[name]['SessionEnd']).toBe('agent.session_end');
    expect(isAgentSignal({ kind: maps[name]['SessionEnd'], agent: 'claude', cwd: '/r', payload: {}, ts: 1 })).toBe(true);
  });

  it('registers SessionEnd in the bundled hooks.json at matcher ""', () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), BRIDGES[name as keyof typeof BRIDGES], 'hooks/hooks.json'), 'utf8'),
    ) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    const groups = manifest.hooks['SessionEnd'];
    expect(groups).toBeDefined();
    expect(groups.some((g) => g.matcher === '' && g.hooks.some((h) => h.command.endsWith('SessionEnd')))).toBe(true);
  });
});
