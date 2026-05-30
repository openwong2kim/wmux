import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A2 invariant lock test.
//
// The daemon.shutdown RPC must:
//   1. Call the shutdown() body with { skipPipeStop: true, skipExit: true }
//      so the ack can flush back to the caller before the pipe closes and
//      the process exits.
//   2. Defer pipeServer.stop() and process.exit(0) to setImmediate AFTER
//      returning from the handler, so the caller (e.g., main's before-quit
//      or session-end races in A3/A5) can rely on the RPC promise actually
//      meaning "shutdown work complete".
//
// The shutdown() function must honor:
//   - opts.skipPipeStop — skip pipeServer.stop() (caller will run it later).
//   - opts.skipExit — return instead of calling process.exit(0).
//
// We do not bootstrap a real daemon here (that would trigger main() and lock
// the test process — see codex P1 lesson from A1b). Instead we read the
// source and assert the invariants on the live code.
describe('A2 — daemon.shutdown RPC + shutdown() opts (source-level invariants)', () => {
  const daemonIndexPath = path.join(__dirname, '..', 'index.ts');
  const src = fs.readFileSync(daemonIndexPath, 'utf-8');
  const lines = src.split('\n');

  function extractRpcHandlerBody(method: string): string {
    const startMarker = `// daemon.${method}`;
    const startIdx = lines.findIndex((l) => l.trim().startsWith(startMarker));
    if (startIdx < 0) throw new Error(`Marker not found: ${startMarker}`);
    const nextHandlerIdx = lines.findIndex(
      (l, i) => i > startIdx && /^\s*\/\/ daemon\.\w+/.test(l),
    );
    const endIdx = nextHandlerIdx > 0 ? nextHandlerIdx : lines.length;
    return lines.slice(startIdx, endIdx).join('\n');
  }

  it('daemon.shutdown handler awaits shutdown(...) with skipPipeStop + skipExit', () => {
    const body = extractRpcHandlerBody('shutdown');

    // Must call shutdown() and await it.
    expect(body).toMatch(/await\s+shutdown\s*\(/);

    // Must pass skipPipeStop: true and skipExit: true together.
    expect(body).toMatch(/skipPipeStop:\s*true/);
    expect(body).toMatch(/skipExit:\s*true/);
  });

  it('daemon.shutdown handler defers pipeServer.stop + process.exit via setImmediate', () => {
    const body = extractRpcHandlerBody('shutdown');

    // pipeServer.stop must happen in a setImmediate after the ack returns.
    expect(body).toMatch(/setImmediate\([\s\S]*?pipeServer\.stop\(\)/);
    // process.exit(0) must also be inside that deferred path.
    expect(body).toMatch(/setImmediate\([\s\S]*?process\.exit\(0\)/);
  });

  it('daemon.shutdown guards the deferred exit with a non-unref force-exit timer (orphan-daemon fix)', () => {
    // Regression lock for the zombie-daemon bug: pipeServer.stop() awaits
    // server.close(cb), which never fires if a tracked client socket won't
    // close, so the .finally(process.exit) never runs and the daemon survives
    // forever after acking shutdown — the exact zombie wmux.exe daemons users
    // saw outlive every Quit. The handler must arm a force-exit setTimeout that
    // calls process.exit(0) regardless, and must NOT unref() it (an unref'd
    // timer wouldn't hold the event loop, defeating the guarantee).
    const body = extractRpcHandlerBody('shutdown');

    // A force-exit timer lives inside the deferred setImmediate and exits.
    expect(body).toMatch(/setImmediate\([\s\S]*?setTimeout\([\s\S]*?process\.exit\(0\)/);
    // The force-exit timer must never be unref'd.
    expect(body).not.toMatch(/forceExit\.unref\(\)/);
    // The happy path (stop resolved) clears the guard before its own exit.
    expect(body).toMatch(/clearTimeout\(forceExit\)/);
  });

  it('shutdown function signature accepts opts with skipPipeStop and skipExit', () => {
    // Match shutdown() definition (named async function).
    const defStart = lines.findIndex((l) => /^async function shutdown\(/.test(l));
    expect(defStart, 'shutdown function not found').toBeGreaterThanOrEqual(0);
    // Body span until the closing brace of the function. We just need
    // enough source to verify the opts handling — slice ahead a few hundred
    // lines.
    const defBody = lines.slice(defStart, defStart + 200).join('\n');

    expect(defBody).toMatch(/opts:\s*{\s*skipPipeStop\?:\s*boolean;\s*skipExit\?:\s*boolean\s*}/);

    // Body must gate pipeServer.stop() on !opts.skipPipeStop.
    expect(defBody).toMatch(/if\s*\(\s*!opts\.skipPipeStop\s*\)\s*{[\s\S]*?pipeServer\.stop/);

    // Body must early-return when opts.skipExit is true (skipping
    // process.exit) — match the inverse: `if (opts.skipExit) { ... return; }`.
    expect(defBody).toMatch(/if\s*\(\s*opts\.skipExit\s*\)\s*\{[\s\S]*?return;/);
  });

  it('DaemonClient.rpc accepts opts.timeoutMs (per-call override)', () => {
    const clientPath = path.join(__dirname, '..', '..', 'main', 'DaemonClient.ts');
    const clientSrc = fs.readFileSync(clientPath, 'utf-8');
    // Signature includes opts: { timeoutMs?: number }.
    expect(clientSrc).toMatch(/rpc\(\s*method:\s*string[\s\S]*?opts:\s*\{\s*timeoutMs\?:\s*number\s*\}/);
    // Uses opts.timeoutMs in the setTimeout call.
    expect(clientSrc).toMatch(/opts\.timeoutMs\s*\?\?\s*RPC_TIMEOUT_MS/);
  });
});
