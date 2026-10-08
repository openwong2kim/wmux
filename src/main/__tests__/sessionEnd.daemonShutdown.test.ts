import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase A — A5 source-level invariants for the Windows session-end
// (WM_ENDSESSION) handler in src/main/index.ts.
//
// The previous handler called daemonClient.disconnectSync() and trusted the
// daemon to flush on its own clock. A5 races daemon.shutdown against a
// calibrated budget (4 s placeholder until the T5 measurement lands) so the
// daemon completes atomic dumps before we die. We assert these invariants
// at the source level — running the actual handler requires Electron and
// an OS shutdown signal, neither of which a vitest process can reproduce.
describe('A5 — session-end (WM_ENDSESSION) handler invariants', () => {
  const mainIndexPath = path.join(__dirname, '..', 'index.ts');
  const src = fs.readFileSync(mainIndexPath, 'utf-8');

  function extractHandler(): string {
    const marker = 'async function onWindowsSessionEnd(';
    const start = src.indexOf(marker);
    expect(start, 'session-end handler not found').toBeGreaterThanOrEqual(0);
    const end = src.indexOf("\napp.on('activate'", start);
    expect(end, 'end of the session-end handler not found').toBeGreaterThan(start);
    return src.slice(start, end);
  }

  function extractAdoptMainWindow(): string {
    const start = src.indexOf('function adoptMainWindow(win: BrowserWindow): void {');
    expect(start, 'adoptMainWindow not found').toBeGreaterThanOrEqual(0);
    // The registration sits at the top of the function; a bounded window keeps
    // the assertions from matching some later, unrelated listener.
    return src.slice(start, start + 1200);
  }

  it('is never registered on app, which does not emit session-end', () => {
    // Electron 41 emits 'session-end' only on BaseWindow/BrowserWindow
    // (WM_ENDSESSION is per window; electron_api_base_window.cc). The
    // `app.on('session-end' as any, …)` this replaced compiled through the
    // cast and never ran, so a Windows logoff skipped the emergency save.
    expect(src).not.toMatch(/app\.(on|once|addListener)\(\s*'session-end'/);
    expect(src).not.toMatch(/'session-end'\s+as\s+any/);
  });

  it('is registered on every adopted main window, inside a win32 guard', () => {
    const adopt = extractAdoptMainWindow();
    const guardIdx = adopt.indexOf("if (process.platform === 'win32') {");
    const regIdx = adopt.indexOf("win.on('session-end',");
    expect(guardIdx).toBeGreaterThan(0);
    expect(regIdx).toBeGreaterThan(guardIdx);
    // The event is passed through: the handler needs its `reasons` to tell a
    // Restart Manager close from a logoff or shutdown.
    expect(adopt.slice(regIdx, regIdx + 120)).toMatch(
      /win\.on\('session-end',\s*\((\w+)\)\s*=>\s*\{\s*void onWindowsSessionEnd\(\1\)/,
    );
  });

  it('every main window goes through adoptMainWindow', () => {
    // A window built without adoptMainWindow would miss the listener. All
    // createWindow() call sites must be followed by an adoptMainWindow call.
    const creates = src.match(/=\s*createWindow\(/g) ?? [];
    const adopts = src.match(/\n\s*adoptMainWindow\(/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(adopts.length).toBe(creates.length);
  });

  it('runs once even when several windows receive WM_ENDSESSION', () => {
    const handler = extractHandler();
    const guardIdx = handler.indexOf('if (sessionEndHandled) return;');
    const setIdx = handler.indexOf('sessionEndHandled = true;');
    const flushIdx = handler.indexOf('sessionManager.flushSync()');
    expect(guardIdx).toBeGreaterThan(0);
    expect(setIdx).toBeGreaterThan(guardIdx);
    // The flag flips before anything else so a second window's listener,
    // dispatched while the first is still awaiting, returns at once.
    expect(flushIdx).toBeGreaterThan(setIdx);
    expect(src).toMatch(/let\s+sessionEndHandled\s*=\s*false\s*;/);
  });

  it('ignores a Restart Manager close-app without consuming the once-flag', () => {
    // ENDSESSION_CLOSEAPP alone does not end the session or terminate wmux.
    // Running the handler would shut the daemon down and leave wmux open
    // with no daemon, so it must return before anything else happens.
    const handler = extractHandler();
    const ignoreIdx = handler.indexOf("reasons.every((r) => r === 'close-app')");
    const guardIdx = handler.indexOf('if (sessionEndHandled) return;');
    const setIdx = handler.indexOf('sessionEndHandled = true;');
    expect(ignoreIdx, 'close-app check not found').toBeGreaterThan(0);
    // Only a non-empty list made of close-app alone is skipped; logoff,
    // shutdown, critical, or no reasons at all run the full handler.
    expect(handler.slice(ignoreIdx - 40, ignoreIdx)).toMatch(/reasons\.length\s*>\s*0\s*&&\s*$/);
    // The check comes before the once-guard and the flag flip, so a later
    // real logoff still finds the flag clear and runs the handler once.
    expect(ignoreIdx).toBeLessThan(guardIdx);
    expect(ignoreIdx).toBeLessThan(setIdx);

    // The ignore branch returns without touching the flag, the session
    // file or the daemon.
    const branchStart = handler.indexOf('{', ignoreIdx);
    const branchEnd = handler.indexOf('return;', branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = handler.slice(branchStart, branchEnd);
    expect(branch).not.toMatch(/sessionEndHandled/);
    expect(branch).not.toMatch(/flushSync|raceDaemonShutdown|disconnectSync/);
    expect(branch).not.toMatch(/session-end received/);
    // Nothing between the top of the handler and the close-app check sets
    // the flag either.
    expect(handler.slice(0, ignoreIdx)).not.toMatch(/sessionEndHandled\s*=/);
  });

  it('a logoff after an ignored close-app still runs the handler once', () => {
    // After the close-app early return the flag is still false, so the next
    // session-end whose reasons are not close-app alone reaches the once-guard,
    // flips the flag and runs the save; any later call returns at the guard.
    const handler = extractHandler();
    const ignoreReturnIdx = handler.indexOf(
      'return;',
      handler.indexOf("reasons.every((r) => r === 'close-app')"),
    );
    const guardIdx = handler.indexOf('if (sessionEndHandled) return;');
    const setIdx = handler.indexOf('sessionEndHandled = true;');
    const logIdx = handler.indexOf('session-end received');
    const flushIdx = handler.indexOf('sessionManager.flushSync()');
    expect(ignoreReturnIdx).toBeGreaterThan(0);
    expect(ignoreReturnIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(setIdx);
    expect(setIdx).toBeLessThan(logIdx);
    expect(logIdx).toBeLessThan(flushIdx);
    // The flag is set in exactly one place, so it can be consumed only by
    // a run that gets past the close-app check.
    expect(src.match(/sessionEndHandled\s*=\s*true/g)?.length).toBe(1);
  });

  it('flushes synchronously before the first await', () => {
    // Windows may end the process once the window returns from WM_ENDSESSION,
    // so only the synchronous prefix of the handler is guaranteed to run.
    const handler = extractHandler();
    const flushIdx = handler.indexOf('sessionManager.flushSync()');
    const awaitIdx = handler.indexOf('await ');
    expect(flushIdx).toBeGreaterThan(0);
    expect(awaitIdx).toBeGreaterThan(flushIdx);
  });

  it('flushes the live singleton via flushSync (no stale reload-resave)', () => {
    const handler = extractHandler();
    // v2 RCA fix (reboot-reattach): the previous `new SessionManager().load() ->
    // save(existing)` re-confirmed a STALE on-disk snapshot (and could resurrect a
    // .bak fossil), overwriting the renderer's newest layout. The renderer now
    // persists ptyId changes synchronously (event-driven session.save), so
    // session-end only flushes the LIVE singleton's pending debounced write.
    expect(handler).toMatch(/sessionManager\.flushSync\(\)/);
    // Guard against the stale reload-resave pattern ever coming back.
    expect(handler).not.toMatch(/sm\.save\(existing\)/);
  });

  it('races daemon.shutdown via raceDaemonShutdown before disconnectSync', () => {
    const handler = extractHandler();
    expect(handler).toMatch(/await\s+raceDaemonShutdown\(\s*daemonClient\s*,/);
    // The disconnect must come AFTER the race so callers observe the race
    // semantics (success or timeout) before the pipe goes away.
    const raceIdx = handler.indexOf('raceDaemonShutdown(');
    const disconnectIdx = handler.indexOf('disconnectSync(');
    expect(raceIdx).toBeGreaterThan(0);
    expect(disconnectIdx).toBeGreaterThan(raceIdx);
  });

  it('uses a 4 s timeout placeholder (T5 calibration target)', () => {
    const handler = extractHandler();
    // Either an explicit 4_000 constant or A5_TIMEOUT_MS = 4_000.
    expect(handler).toMatch(/A5_TIMEOUT_MS\s*=\s*4_?000/);
  });

  it('logs a warning if the race did not complete in time', () => {
    const handler = extractHandler();
    expect(handler).toMatch(/race\.ok/);
    expect(handler).toMatch(/console\.warn\(/);
  });
});
