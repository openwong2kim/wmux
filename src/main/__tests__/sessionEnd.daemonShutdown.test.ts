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
    const marker = "app.on('session-end' as any";
    const start = src.indexOf(marker);
    expect(start, "session-end registration not found").toBeGreaterThanOrEqual(0);
    // The handler is the only call until the next top-level statement; slice
    // a generous window — the assertions below are all string-pattern based.
    return src.slice(start, start + 3000);
  }

  it('is registered inside a win32 platform guard', () => {
    // The marker must live inside a `process.platform === 'win32'` block.
    // Pattern: the win32 guard appears before the handler registration.
    const winIdx = src.lastIndexOf("if (process.platform === 'win32')");
    const handlerIdx = src.indexOf("app.on('session-end'");
    expect(winIdx).toBeLessThan(handlerIdx);
    expect(winIdx).toBeGreaterThanOrEqual(0);
  });

  it('handler is async (await Promise.race is allowed)', () => {
    const handler = extractHandler();
    // session-end registration body opens with `async () => {` (or async function).
    expect(handler).toMatch(/'session-end'\s+as\s+any[\s\S]{0,40}async\s*\(\s*\)\s*=>/);
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
