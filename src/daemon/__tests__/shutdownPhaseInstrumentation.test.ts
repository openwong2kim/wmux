import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariants for the daemon shutdown phase-latency
// instrumentation added 2026-05-17 in response to user dogfood showing the
// 4 s main-side race budget (BEFORE_QUIT_TIMEOUT_MS) timing out on a
// 48-PTY daemon. The phase logs are the only structured signal we have
// for which step dominates shutdown wall-time, so a refactor that drops
// any of them silently regresses our ability to budget the race.

describe('daemon shutdown — phase-latency instrumentation', () => {
  const daemonPath = path.join(__dirname, '..', 'index.ts');
  const daemonSrc = fs.readFileSync(daemonPath, 'utf-8');

  // The shutdown function body — slice from its declaration to the next
  // top-level function so we only assert on the right region.
  const shutdownStart = daemonSrc.indexOf('async function shutdown(');
  expect(shutdownStart).toBeGreaterThan(0);
  const shutdownEnd = daemonSrc.indexOf('\nasync function main', shutdownStart);
  expect(shutdownEnd).toBeGreaterThan(shutdownStart);
  const shutdownBody = daemonSrc.slice(shutdownStart, shutdownEnd);

  it('captures a shutdown start timestamp and a phaseLog helper', () => {
    expect(shutdownBody).toMatch(/const\s+shutdownStartedAt\s*=\s*Date\.now\(\)\s*;/);
    expect(shutdownBody).toMatch(/const\s+phaseLog\s*=\s*\(/);
    expect(shutdownBody).toMatch(/\[shutdown\.phase\]/);
  });

  it.each([
    ['pipeStops', 'pipeStops'],
    ['bufferDumps', 'bufferDumps'],
    ['stateSave', 'stateSave'],
    ['disposeAll', 'disposeAll'],
  ])('emits a phaseLog for the %s hot spot', (_name, phaseName) => {
    // Each hot spot identified in the latency analysis must be wrapped:
    // a phaseStartedAt() before the work and a phaseLog after.
    const re = new RegExp(`phaseLog\\(\\s*['"]${phaseName}['"]`);
    expect(shutdownBody).toMatch(re);
  });

  it('logs the pipeServerStop phase when the caller did not skip it', () => {
    // The RPC handler passes { skipPipeStop: true } and stops the pipe
    // itself via setImmediate so the ack can flush. The non-RPC path
    // (SIGTERM/SIGINT/WM_ENDSESSION) must keep its phase log.
    const skipBranch = shutdownBody.indexOf('if (!opts.skipPipeStop)');
    expect(skipBranch).toBeGreaterThan(0);
    const afterSkipBranch = shutdownBody.slice(skipBranch);
    expect(afterSkipBranch).toMatch(/phaseLog\(\s*['"]pipeServerStop['"]/);
  });

  it('logs a total-elapsed line so external aggregators can budget the race', () => {
    expect(shutdownBody).toMatch(
      /Daemon stopped[\s\S]*Date\.now\(\)\s*-\s*shutdownStartedAt/,
    );
  });
});
