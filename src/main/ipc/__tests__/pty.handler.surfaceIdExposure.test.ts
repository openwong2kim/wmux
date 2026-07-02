/**
 * v2 RCA fix (reboot-reattach, axis B-lite) — PTY_LIST surfaceId exposure.
 *
 * Structural test (house pattern: pty.handler.resize-retry.test.ts). The
 * surfaceId chain (daemon env WMUX_SURFACE_ID → PTY_LIST map → renderer
 * reconcile rebind) is wired through untyped RPC payloads and optional
 * chaining, so tsc cannot catch a dropped hop — the exact tsc-invisible
 * field-drop class behind the U-PERM runtime drops (testing specialist,
 * confidence 78). This scan fails if a refactor strips the mapping, the
 * suspended-exclusion, or the createdAt exposure.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('pty.handler PTY_LIST — axis B-lite surfaceId exposure invariants', () => {
  const handlerPath = path.join(__dirname, '..', 'handlers', 'pty.handler.ts');
  const source = fs.readFileSync(handlerPath, 'utf-8');

  /** Narrow to the daemon-mode PTY_LIST handler region. */
  function listRegion(): string {
    const start = source.indexOf('ipcMain.handle(IPC.PTY_LIST');
    expect(start, 'daemon-mode PTY_LIST handler not found').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('ipcMain.handle(IPC.PTY_LIST', start + 1);
    return source.slice(start, end > 0 ? end : start + 4000);
  }

  it('maps env.WMUX_SURFACE_ID onto the returned surfaceId field', () => {
    const region = listRegion();
    expect(region).toMatch(/s\.env\?\.\[ENV_KEYS\.SURFACE_ID\]/);
    expect(region).toMatch(/surfaceId:\s*s\.env\[ENV_KEYS\.SURFACE_ID\]/);
  });

  it('excludes suspended sessions from rebind targets (no live PTY behind them)', () => {
    const region = listRegion();
    // The surfaceId attachment must be conditioned on NOT-suspended.
    expect(region).toMatch(/s\.state\s*!==\s*'suspended'/);
  });

  it('keeps the dead filter AND exposes createdAt for newest-wins duplicate resolution', () => {
    const region = listRegion();
    expect(region).toMatch(/\.filter\(s => s\.state !== 'dead'\)/);
    expect(region).toMatch(/createdAt:\s*s\.createdAt/);
  });
});
