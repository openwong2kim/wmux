/**
 * Daemon PTY_CREATE — the dead-pane recovery lookup is WSL-only.
 *
 * A dead-pane replacement names its source session (`sourceSessionId`) so a
 * WSL pane can reuse the dead session's distro/user. Only WSL reads that
 * record, so non-WSL replacements must not issue `daemon.listSessions` at all:
 * a failed lookup RPC would otherwise fail every PTY_CREATE on every platform.
 *
 * Structural test (house pattern: pty.handler.promote.test.ts) — pty.handler.ts
 * imports electron and cannot be loaded under vitest.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('pty.handler PTY_CREATE (daemon) — recovery lookup scope', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'pty.handler.ts'), 'utf-8');

  function daemonCreateRegion(): string {
    const start = source.indexOf('ipcMain.handle(IPC.PTY_CREATE');
    expect(start, 'daemon PTY_CREATE handler not found').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('ipcMain.handle(IPC.PTY_CREATE', start + 1);
    expect(end, 'local PTY_CREATE handler not found').toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('issues daemon.listSessions for a recovery only when the shell is WSL', () => {
    const region = daemonCreateRegion();
    const lookups = region.match(/daemonClient\.rpc\('daemon\.listSessions'/g) ?? [];
    expect(lookups).toHaveLength(1);
    // Non-WSL (or no source session) short-circuits to [] with no RPC.
    expect(region).toMatch(
      /const recoverySessions = recoveryId && isWslShell\(shell\)\s*\?\s*await daemonClient\.rpc\('daemon\.listSessions', \{\}\)[^\n]*\n\s*: \[\];/,
    );
  });

  it('resolves the effective shell before the gated lookup', () => {
    const region = daemonCreateRegion();
    const shellAt = region.indexOf('const shell = ');
    const lookupAt = region.indexOf('const recoverySessions = ');
    expect(shellAt).toBeGreaterThanOrEqual(0);
    expect(shellAt).toBeLessThan(lookupAt);
  });
});
