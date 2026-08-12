import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Durable daemon logging + recovery instrumentation (macOS reboot-recovery
// investigation, 2026-07-20).
//
// The daemon is spawned with stdio:'ignore' (src/main/daemon/launcher.ts), so
// console output is discarded on every platform — a running daemon leaves no
// trace of what it did. These invariants keep the durable file log and the
// recovery summary lines wired, so a post-reboot daemon.log can tell us whether
// recovery loaded 0 sessions (persistence failure) vs. loaded N but respawned 0
// (spawn failure) vs. recovered N (renderer-side bug).
//
// Asserted at the source level rather than by spawning a real daemon: importing
// src/daemon/index.ts runs main() at module load and would lock the test
// process (same rationale as syncExitGuard.test.ts).
describe('daemon durable logging + recovery instrumentation', () => {
  const daemonIndexPath = path.join(__dirname, '..', 'index.ts');
  const src = fs.readFileSync(daemonIndexPath, 'utf-8');

  it('log() mirrors every line to the durable daemon.log writer', () => {
    expect(src).toMatch(/const DAEMON_LOG_PATH = path\.join\(wmuxDir, 'daemon\.log'\)/);
    // The console.log line stays; the file side now routes through the
    // buffered writer (logWriter.ts — behavior covered by logWriter.test.ts,
    // incl. sync write-through for warn/error and rotation at the byte cap).
    expect(src).toMatch(/daemonLogWriter\.write\(level, line\)/);
  });

  it('rotates at a byte cap and drains the buffer on process exit', () => {
    expect(src).toMatch(/DAEMON_LOG_MAX_BYTES/);
    expect(src).toMatch(/process\.once\('exit', \(\) => daemonLogWriter\.flush\(\)\)/);
  });

  it('recoverSessions logs a load summary and a completion summary', () => {
    // "loaded N session(s)" is the persistence-vs-spawn discriminator.
    expect(src).toMatch(/\[recovery\] loaded \$\{state\.sessions\.length\} session/);
    expect(src).toMatch(/\[recovery\] complete: recovered \$\{recoveredIds\.size\}/);
  });

  it('the exit-save handler is registered unconditionally (not win32-gated)', () => {
    const exitIdx = src.indexOf("process.on('exit',");
    expect(exitIdx, "process.on('exit') not found").toBeGreaterThanOrEqual(0);
    // The 200 chars before the handler must NOT re-introduce a win32 platform
    // gate — the handler now runs on macOS/Linux as a backstop too.
    const preamble = src.slice(Math.max(0, exitIdx - 200), exitIdx);
    expect(preamble).not.toMatch(/if\s*\(\s*process\.platform === 'win32'\s*\)\s*\{/);
  });
});
