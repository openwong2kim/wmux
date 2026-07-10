import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase 3 PR-A — hidden-pane retention wiring in useTerminal. Like the other
// useTerminal suites, this verifies the load-bearing wiring at the source
// level (the hook needs a full xterm/electron bootstrap for behavioral tests);
// the retention POLICY itself is behaviorally covered by
// terminalOutputScheduler.retention.test.ts, and the end-to-end resync is a
// packaged-app dogfood + perf-bench (hiddenFlood) gate.
describe('Phase 3 PR-A — useTerminal hidden-pane retention wiring (source-level)', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');

  it('gates retention on daemon mode AND the settings flag', () => {
    // Retention without a daemon RingBuffer would make dirtiness unrecoverable.
    expect(src).toMatch(
      /function\s+hiddenRetentionActive\(\)[\s\S]{0,200}isDaemonModeActive\(\)\s*&&\s*useStore\.getState\(\)\.hiddenPaneRetentionEnabled/,
    );
  });

  it('routes pty:data through the resync hold-out before the scheduler', () => {
    const idx = src.indexOf('const routePtyData');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 1500);
    // In-flight resync buffers bytes out of xterm entirely…
    expect(body).toMatch(/st\.buffer\.push\(data\)/);
    expect(body).toMatch(/RESYNC_BUFFER_MAX_CHARS/);
    // …otherwise the scheduler write carries the retention option (evaluated
    // per event, logged once for the first hidden pane — the dogfood gate
    // diagnostic).
    expect(body).toMatch(/const retain = hiddenRetentionActive\(\)/);
    expect(body).toMatch(/retainWhenHidden:\s*retain/);
    expect(body).toMatch(/logRetentionGateOnce\(retain\)/);
  });

  it('both pty.onData listener sites use the shared routing', () => {
    const matches = src.match(/routePtyData\(data\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('resync completion resets BEFORE writing the held replay (no early-parse race)', () => {
    const idx = src.indexOf('const completeResyncFromFlush');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 1200);
    const resetIdx = body.indexOf('terminal.reset()');
    const writeIdx = body.indexOf('for (const chunk of st.buffer) terminal.write(chunk)');
    expect(resetIdx).toBeGreaterThan(0);
    expect(writeIdx).toBeGreaterThan(resetIdx);
    // Stale retained backlog + dirty flag die with the old screen state.
    expect(body).toMatch(/discardTerminalOutput\(terminal\)/);
  });

  it('both flush-complete handlers settle a resync first, then defer when hidden', () => {
    const settles = src.match(/if\s*\(completeResyncFromFlush\(recoveredBytes\)\)\s*return;/g) ?? [];
    expect(settles.length).toBe(2);
    const deferrals = src.match(/!isVisibleRef\.current\s*&&\s*hiddenRetentionActive\(\)/g) ?? [];
    expect(deferrals.length).toBe(2);
    // The deferral marks dirty ONLY when the daemon actually replayed bytes.
    expect(src).toMatch(/if\s*\(recoveredBytes\s*>\s*0\)\s*markTerminalDirty\(terminal\);/);
  });

  it('reveal branches on dirtiness: resync for dirty, flush for clean', () => {
    const idx = src.indexOf('if (isTerminalDirty(terminalRef.current))');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 300);
    expect(body).toMatch(/startResync\('dirty-reveal'\)/);
    expect(body).toMatch(/flushTerminalOutput\(terminalRef\.current\)/);
  });

  it('resync degrades without ever clearing the ptyId (dead pane keeps its last screen)', () => {
    // reconnectPtyWithRetry clears ptyIds on fatal errors — the resync path
    // must not: it calls pty.reconnect directly and aborts into markClean.
    const idx = src.indexOf('const startResync');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 3000);
    expect(body).toMatch(/window\.electronAPI\.pty\.reconnect\(id\)/);
    expect(body).not.toMatch(/clearSurfacePtyIdByPty|reconnectPtyWithRetry/);
    const abortIdx = src.indexOf('const abortResync');
    const abortBody = src.slice(abortIdx, abortIdx + 1200);
    expect(abortBody).toMatch(/markTerminalClean\(term\)/);
  });

  it('exposes hydrate-before-read and cleans it up on unmount', () => {
    expect(src).toMatch(/export\s+async\s+function\s+hydrateTerminalForRead/);
    expect(src).toMatch(/hydrateRegistry\.set\(ptyId,\s*hydrateForRead\)/);
    expect(src).toMatch(/hydrateRegistry\.get\(ptyId\)\s*===\s*hydrateForRead[\s\S]{0,120}hydrateRegistry\.delete\(ptyId\)/);
    // Hydration ends with a parse barrier so callers read a settled buffer.
    const idx = src.indexOf('const hydrateForRead');
    const body = src.slice(idx, idx + 900);
    expect(body).toMatch(/terminal\.write\(''\s*,\s*resolve\)/);
    // Teardown silences any in-flight resync.
    expect(src).toMatch(/cancelResync\(\);/);
  });

  it('exit markers ride the retention policy too (no hidden parse via onExit)', () => {
    const exitWrites = src.match(/terminal\.exitedBracket[\s\S]{0,220}?retainWhenHidden:\s*hiddenRetentionActive\(\)/g) ?? [];
    expect(exitWrites.length).toBe(2);
  });
});

// Phase 3 PR-B — snapshot resync ladder wiring. The behavioral halves live in
// the daemon suites (HeadlessSnapshot / SessionPipe.reflush) and the main
// scanner suite; this pins the renderer's ladder ordering the same way the
// PR-A block above pins retention wiring.
describe('Phase 3 PR-B — useTerminal snapshot-resync ladder (source-level)', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');
  const startIdx = src.indexOf('const startResync');
  const body = src.slice(startIdx, startIdx + 4600);

  it('prefers the non-disruptive pty.resync, guarded against stale preloads', () => {
    // A packaged app updated under a running renderer may lack pty.resync —
    // the typeof guard degrades straight to the PR-A reconnect path.
    expect(body).toMatch(/typeof window\.electronAPI\.pty\.resync !== 'function'/);
    expect(body).toMatch(/window\.electronAPI\.pty\.resync\(id,\s*\{\s*scrollback:\s*scrollbackLines\s*\}\)/);
  });

  it('falls back to reconnect ONLY for transport-shaped failures', () => {
    // legacy-daemon / pipe-not-writable / rpc-error / local-mode → the raw
    // reconnect ladder; session-gone & serialize-unavailable mean no better
    // screen exists, so they degrade in place instead of tearing the socket.
    expect(body).toMatch(/'legacy-daemon'/);
    expect(body).toMatch(/'pipe-not-writable'/);
    expect(body).toMatch(/'rpc-error'/);
    expect(body).toMatch(/'local-mode'/);
    expect(body).toMatch(/abortResync\(`resync-failed:\$\{code\}`\)/);
    // The RPC rejecting entirely (IPC failure) also lands on reconnect.
    expect(body).toMatch(/\.catch\(\(\)\s*=>\s*\{\s*rpcSettled = true;\s*fallbackReconnect\(\);\s*\}\)/);
  });

  it('a live resync leaves settlement to the flush-complete handler (timer stays armed)', () => {
    // No paint and no settle on {success, mode: snapshot|raw} — the replay is
    // in flight on the session pipe; RESYNC_TIMEOUT still guards a wedge.
    const successBranch = body.slice(body.indexOf("res.mode === 'dead-snapshot'"));
    expect(successBranch).toMatch(/if \(res\?\.success\) \{[\s\S]{0,400}?return;/);
  });

  it('dead-snapshot paint mirrors the flush-complete contract', () => {
    const idx = src.indexOf('const paintDeadSnapshot');
    expect(idx).toBeGreaterThan(0);
    const paint = src.slice(idx, idx + 1600);
    // discard stale backlog → reset → write payload → write held bytes → clean.
    const discard = paint.indexOf('discardTerminalOutput(term)');
    const reset = paint.indexOf('term.reset()');
    const write = paint.indexOf('term.write(bytes)');
    const clean = paint.indexOf('markTerminalClean(term)');
    expect(discard).toBeGreaterThan(0);
    expect(reset).toBeGreaterThan(discard);
    expect(write).toBeGreaterThan(reset);
    expect(clean).toBeGreaterThan(write);
    // A dead process cannot own input-reporting modes — always neutralize
    // (same rationale as staleReplayModeReset, without the resumeAgent gate).
    expect(paint).toMatch(/STALE_REPLAY_INPUT_MODE_RESETS/);
    // No flush marker is coming: it settles the resync state itself.
    expect(paint).toMatch(/st\.resolvers\.splice\(0\)\.forEach/);
  });
});
