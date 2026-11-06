/**
 * Characterisation of integrations/claude/bin/wmux-bridge.mjs as a process:
 * argv, stdin, the requests that reach the daemon and main pipes, stdout,
 * stderr, exit code, bridge.log, the resume spool and the activity stamps.
 *
 * Each case is a JSON file in fixtures/claude-hook/cases. Its `expect` block
 * was recorded from the bridge itself; any change to what the bridge does
 * shows up here as a diff. When a change is intended, re-record and review:
 *
 *   WMUX_UPDATE_CLAUDE_HOOK_GOLDENS=1 npx vitest run integrations/claude/__tests__/claudeHookCharacterisation.os.test.ts
 *
 * Endpoints are stubs (support/stubDaemon.ts): unix sockets on POSIX, named
 * pipes on Windows. Nothing here can reach a running wmux: HOME, the data
 * suffix and every pipe name belong to a per-case sandbox.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFixture, type Fixture } from './support/claudeHookHarness';

const CASES_DIR = path.resolve(process.cwd(), 'integrations/claude/__tests__/fixtures/claude-hook/cases');
const UPDATE = process.env.WMUX_UPDATE_CLAUDE_HOOK_GOLDENS === '1';

const cases = readdirSync(CASES_DIR).filter((name) => name.endsWith('.json')).sort();

describe('wmux-bridge.mjs characterisation', () => {
  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const name of cases) {
    const file = path.join(CASES_DIR, name);
    const fixture = JSON.parse(readFileSync(file, 'utf8')) as Fixture;
    const skip = fixture.platforms !== undefined && !fixture.platforms.includes(process.platform);
    const title = skip ? `${name} (skipped on ${process.platform}: ${fixture.skipReason})` : name;

    it.skipIf(skip)(title, async () => {
      const { result, problems } = await runFixture(fixture);
      expect(problems).toEqual([]);
      if (UPDATE) {
        writeFileSync(file, `${JSON.stringify({ ...fixture, expect: result }, null, 2)}\n`);
        return;
      }
      // Compared as text so key order is part of the contract.
      expect(JSON.stringify(result, null, 2)).toBe(JSON.stringify(fixture.expect, null, 2));
    });
  }
});
