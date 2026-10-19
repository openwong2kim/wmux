/**
 * PTY_CREATE — quota rotation runs before the wmux tool splice.
 *
 * withWmuxTools decides whether codex may get the wmux MCP override from the
 * codex config under options.env.CODEX_HOME. A rotated Codex pane gets its
 * CODEX_HOME from withAccountQuota, so rotation has to run first or the check
 * reads the wrong account's config.
 *
 * Structural test (house pattern: pty.handler.promote.test.ts) — pty.handler.ts
 * imports electron and cannot be loaded under vitest.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('pty.handler PTY_CREATE — account quota before wmux tools', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'pty.handler.ts'), 'utf-8');

  it('applies withAccountQuota first on both the daemon and the local path', () => {
    // The session pin wraps the result last (after the bot worker guard);
    // quota still runs before the tool splice.
    // Both paths run stageCreate, whose first stage is the quota; the tool
    // level is applied to its result.
    expect(source.match(/const staged = await stageCreate\(options, botWorker\);/g) ?? []).toHaveLength(2);
    const stage = source.slice(source.indexOf('async function stageCreate('));
    expect(stage.indexOf('let staged = await withAccountQuota(options);')).toBeGreaterThan(-1);
    expect(stage.indexOf('let staged = await withAccountQuota(options);')).toBeLessThan(stage.indexOf('staged = withWmuxTools(staged);'));
    expect(source).not.toMatch(/withAccountQuota\(withWmuxTools\(/);
  });
});
