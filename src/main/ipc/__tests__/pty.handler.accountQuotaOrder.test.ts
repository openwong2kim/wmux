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
    // The session pin wraps the result last, after the delegate stage; quota still runs before the tool splice.
    expect(source.match(/options = withLaunchSessionPin\(withDelegateSpawnSettings\(withWmuxTools\(await withAccountQuota\(options\)\)\)\);/g) ?? []).toHaveLength(2);
    expect(source).not.toMatch(/withAccountQuota\(withWmuxTools\(/);
  });
});
