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
    // A fan-out pool worker's pick is pinned (no rotation), so its stage skips the quota.
    expect(source.match(/staged = await stageCreate\((options, botWorker, gateway\?\.launch, poolPinned, createPlace|pool\.options, botWorker, undefined, pool\.pinned, launchPlace\(isWslShell\(createShell\(options\)\), localRequestedDistro, undefined\))\);/g) ?? []).toHaveLength(2);
    const stage = source.slice(source.indexOf('async function stageCreate('));
    const quota = 'let staged = poolPinned ? options : await withAccountQuota(options, { wsl, place: place ?? launchPlace(wsl, requestedWslDistro(options), undefined) });';
    expect(stage.indexOf(quota)).toBeGreaterThan(-1);
    expect(stage.indexOf(quota)).toBeLessThan(stage.indexOf('staged = withWmuxTools(staged);'));
    expect(source).not.toMatch(/withAccountQuota\(withWmuxTools\(/);
  });

  it('resolves where a WSL launch runs before the gate, from the one session lookup', () => {
    const daemon = source.slice(source.indexOf('ipcMain.handle(IPC.PTY_CREATE'));
    const lookup = daemon.indexOf("recoverySessions = (recoveryId");
    expect(lookup).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(daemon.indexOf('staged = await stageCreate('));
    expect(daemon.indexOf('const knownTarget = ')).toBeLessThan(daemon.indexOf('staged = await stageCreate('));
  });
});
