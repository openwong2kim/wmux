import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariant lock for daemon idle self-shutdown.
//
// We deliberately avoid bootstrapping a real daemon process (that would
// invoke main() inside the test runner and lock the test process —
// codex P1 lesson from A1b, see shutdownRpc.test.ts). Instead we read
// the daemon source and pin the wiring so future refactors that move
// the callbacks around or rename the env vars break loudly.
describe('Daemon idle shutdown (source-level invariants)', () => {
  const daemonIndexPath = path.join(__dirname, '..', 'index.ts');
  const src = fs.readFileSync(daemonIndexPath, 'utf-8');

  it('parses WMUX_IDLE_SHUTDOWN_MS / WMUX_IDLE_GRACE_MS env overrides', () => {
    // Both env vars must be read — they are the lever the dynamic test
    // (scripts/daemon-idle-shutdown-dynamic.mjs) pulls to verify the
    // self-terminate path within seconds instead of waiting 6 minutes.
    expect(src).toMatch(/WMUX_IDLE_SHUTDOWN_MS/);
    expect(src).toMatch(/WMUX_IDLE_GRACE_MS/);
  });

  it('feeds connection count + LIVE session count + last-disconnect into onIdleCheck', () => {
    // Watchdog cannot infer activity by itself — it needs the three
    // signals we expose via the public accessors. The accessor names
    // are pinned here so a refactor that drops or renames one of them
    // surfaces immediately.
    //
    // The session-count signal MUST go through listLiveSessions(): a
    // plain listSessions().length would keep counting tombstones
    // (dead + suspended) for up to 24h after the user closed every
    // pane, and idle shutdown would never fire on the orphan path
    // the feature is meant to clean up. The regex below explicitly
    // rejects the broader accessor.
    expect(src).toMatch(/onIdleCheck:\s*\(\)\s*=>/);
    expect(src).toMatch(/pipeServer\.getConnectionCount\(\)/);
    expect(src).toMatch(/sessionManager\.listLiveSessions\(\)\.length/);
    expect(src).not.toMatch(/onIdleCheck[\s\S]{0,300}sessionManager\.listSessions\(\)\.length/);
    expect(src).toMatch(/pipeServer\.getLastDisconnectAt\(\)/);
  });

  it('routes onIdleShutdown through doShutdown("idle.timeout")', () => {
    // Single termination path: idle uses the same shutdown() body as
    // SIGTERM/SIGINT/daemon.shutdown RPC. The `shuttingDown` re-entry
    // guard at the top of shutdown() must protect against a racing
    // signal arriving while idle is already on its way out.
    expect(src).toMatch(/onIdleShutdown:\s*\(idleMs\)\s*=>/);
    expect(src).toMatch(/doShutdown\(\s*['"]idle\.timeout['"]\s*\)/);
    // Diagnostic breadcrumb — matches the [shutdown.phase] prefix used
    // by the rest of the shutdown instrumentation.
    expect(src).toMatch(/\[shutdown\.phase\]\s+idle\.timeout/);
  });

  it('defaults idleShutdownMinutes to 5 when config omits it', () => {
    // Behavior contract: an existing ~/.wmux/config.json that predates
    // this feature must opt into the 5-minute default without user
    // action. A value of 0 (explicit opt-out) keeps the legacy
    // "alive forever" behavior.
    expect(src).toMatch(/config\.daemon\.idleShutdownMinutes\s*\?\?\s*5/);
  });

  it('hoists doShutdown above setCallbacks so the idle callback can reference it', () => {
    // The idle callback is wired inside watchdog.setCallbacks(), which
    // runs synchronously during boot — before the SIGTERM listener line.
    // doShutdown must be declared first or this is a TDZ error.
    const setCallbacksIdx = src.indexOf('watchdog.setCallbacks(');
    const doShutdownIdx = src.indexOf('const doShutdown =');
    expect(doShutdownIdx).toBeGreaterThan(0);
    expect(setCallbacksIdx).toBeGreaterThan(0);
    expect(doShutdownIdx).toBeLessThan(setCallbacksIdx);
  });

  it('watches every spawned/recovered PTY so a dead process can reap the session (S2 orphan path)', () => {
    // idle-shutdown can only fire once listLiveSessions() reaches 0. A
    // session leaves the live set only when its PTY death transitions it to
    // 'dead', and that transition is driven by processMonitor.watch's onDead
    // callback. If any PTY-spawning path (the create RPC, or one of the three
    // recovery branches: suspended / snapshot / no-scrollback) forgets to
    // watch, an orphan daemon whose parent UI has died would hold that
    // 'detached' session forever and never self-reap — the orphan-
    // accumulation symptom this lock guards. Pin that every spawn path is
    // paired with a watch, and that a watch callback can mark a session dead.
    const watchCalls = src.match(/processMonitor\.watch\(/g) ?? [];
    expect(watchCalls.length).toBeGreaterThanOrEqual(4);
    expect(src).toMatch(/processMonitor\.watch\([\s\S]{0,500}?state = 'dead'/);
  });
});
