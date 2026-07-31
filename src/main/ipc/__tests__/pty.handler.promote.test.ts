/**
 * Fix B — cap-skipped suspended session promote.
 *
 * Boot recovery honours a session cap, so a workspace beyond the cap came back
 * with its ptyId absent; reconcile then destructively cleared it and the pane
 * lost both its identity and its scrollback. `daemon.promoteSession` spawns
 * exactly the one session the renderer still needs, keeping the ptyId stable so
 * the daemon's ring buffer restores.
 *
 * Structural test (house pattern: pty.handler.surfaceIdExposure.test.ts,
 * appLayout.sessionSaveInvariants.test.ts). The chain crosses three untyped
 * hops (renderer IPC → daemon RPC → node-pty spawn) and the daemon half only
 * exists inside a running daemon process, so tsc and unit tests cannot catch a
 * dropped guard. These scans fail if a refactor removes the idempotency check,
 * the suspended-only lookup, the transient-spawn retry bound, or the
 * error-shape the renderer branches on.
 *
 * NOT covered here (needs a live daemon): the actual PTY spawn, the scrollback
 * dump replay, and the session-cap RESOURCE_EXHAUSTED path.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const srcRoot = path.join(__dirname, '..', '..', '..');

describe('pty.handler PTY_PROMOTE — renderer→daemon hop', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'handlers', 'pty.handler.ts'),
    'utf-8',
  );

  function promoteRegion(): string {
    const start = source.indexOf('ipcMain.handle(IPC.PTY_PROMOTE');
    expect(start, 'PTY_PROMOTE handler not found').toBeGreaterThanOrEqual(0);
    return source.slice(start, start + 1200);
  }

  it('is registered only in daemon mode (local mode has no daemon to promote in)', () => {
    const promoteAt = source.indexOf('ipcMain.handle(IPC.PTY_PROMOTE');
    const guardAt = source.lastIndexOf('if (useDaemon && daemonClient)', promoteAt);
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(promoteAt);
  });

  it('rejects an empty id before touching the daemon', () => {
    expect(promoteRegion()).toMatch(/if \(!id\) return \{ success: false/);
  });

  it('forwards to daemon.promoteSession and normalizes the reply the renderer reads', () => {
    const region = promoteRegion();
    expect(region).toMatch(/daemonClient\.rpc\('daemon\.promoteSession', \{ id \}\)/);
    expect(region).toMatch(/if \(res\.ok\) return \{ success: true \}/);
    // A failure must carry a message, or reconcile logs `undefined` and the
    // operator cannot tell a cap hit from a spawn crash.
    expect(region).toMatch(/success: false, error: res\.error\?\.message \?\? 'promote failed'/);
  });

  it('removes the handler on cleanup so a daemon reconnect cannot double-register', () => {
    const removals = source.match(/removeHandler\(IPC\.PTY_PROMOTE\)/g) ?? [];
    expect(removals.length).toBeGreaterThanOrEqual(2);
  });

  it('PTY_LIST threads includeSuspended through to the daemon', () => {
    const start = source.indexOf('ipcMain.handle(IPC.PTY_LIST');
    const region = source.slice(start, start + 1500);
    expect(region).toMatch(/opts\?\.includeSuspended === true/);
    expect(region).toMatch(/daemonClient\.rpc\('daemon\.listSessions', \{ includeSuspended \}\)/);
  });
});

describe('daemon.promoteSession — guards', () => {
  const source = fs.readFileSync(path.join(srcRoot, 'daemon', 'index.ts'), 'utf-8');

  function promoteRegion(): string {
    const start = source.indexOf("pipeServer.onRpc('daemon.promoteSession'");
    expect(start, 'daemon.promoteSession not registered').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('pipeServer.onRpc(', start + 1);
    return source.slice(start, end > 0 ? end : start + 6000);
  }

  it('is idempotent — an already-active session succeeds without respawning', () => {
    const region = promoteRegion();
    const existingAt = region.indexOf('sessionManager.getSession(sessionId)');
    const createAt = region.indexOf('sessionManager.createSession');
    expect(existingAt).toBeGreaterThanOrEqual(0);
    expect(existingAt).toBeLessThan(createAt);
    expect(region).toMatch(/return \{ ok: true, alreadyActive: true \}/);
  });

  it('only promotes a session the persisted state records as SUSPENDED', () => {
    const region = promoteRegion();
    expect(region).toMatch(/s\.id === sessionId && s\.state === 'suspended'/);
    expect(region).toMatch(/code: 'NOT_FOUND'/);
  });

  it('validates the id parameter', () => {
    expect(promoteRegion()).toMatch(/code: 'INVALID_PARAMS'/);
  });

  it('retries ONLY the known transient ConPTY spawn race, and with a bound', () => {
    const region = promoteRegion();
    expect(region).toMatch(/PROMOTE_RETRIES = \d+/);
    // A non-transient failure must break immediately rather than burn the budget.
    expect(region).toMatch(/if \(!msg\.includes\('error code: 87'\)\) break;/);
  });

  it('reuses the persisted geometry and identity rather than inventing new ones', () => {
    const region = promoteRegion();
    for (const field of ['id:', 'cmd:', 'cols:', 'rows:', 'agent:', 'createdAt:', 'supervision:']) {
      expect(region, `createSession must pass ${field}`).toContain(field);
    }
    // The ptyId is the whole point: a new id would lose the pane binding.
    expect(region).toMatch(/id: session\.id/);
  });

  it('falls back to the home directory when the recorded cwd is gone', () => {
    expect(promoteRegion()).toMatch(/fs\.existsSync\(session\.cwd\) \? session\.cwd : os\.homedir\(\)/);
  });

  it('reports a spawn failure as a structured error instead of throwing at the pipe', () => {
    expect(promoteRegion()).toMatch(/code: 'SPAWN_FAILED'/);
  });

  it('starts process monitoring for the promoted session', () => {
    // Without this the promoted pane would never be marked dead when it exits.
    expect(promoteRegion()).toMatch(/processMonitor\.watch\(/);
  });

  it('daemon.listSessions appends suspended entries ONLY when asked', () => {
    const start = source.indexOf("pipeServer.onRpc('daemon.listSessions'");
    const region = source.slice(start, source.indexOf("pipeServer.onRpc('daemon.promoteSession'"));
    expect(region).toMatch(/includeSuspended = params\['includeSuspended'\] === true/);
    expect(region).toMatch(/if \(includeSuspended\) \{/);
    // No duplicates: an id already in the active list must not be re-added.
    expect(region).toMatch(/!activeIdSet\.has\(s\.id\)/);
    // And the default (unscoped) reply must stay exactly the active list.
    expect(region).toMatch(/return activeSessions;/);
  });
});
