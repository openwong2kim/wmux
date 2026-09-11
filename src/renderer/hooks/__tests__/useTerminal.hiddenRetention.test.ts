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
    expect(body).toMatch(/st\.buffer\.push\(payload\)/);
    expect(body).toMatch(/RESYNC_BUFFER_MAX_CHARS/);
    // …otherwise the scheduler write carries the retention option (evaluated
    // per event, logged once for the first hidden pane — the dogfood gate
    // diagnostic).
    expect(body).toMatch(/const retain = hiddenRetentionActive\(\)/);
    expect(body).toMatch(/retainWhenHidden:\s*retain/);
    expect(body).toMatch(/logRetentionGateOnce\(retain\)/);
  });

  it('both pty.onData listener sites use the shared routing', () => {
    const matches = src.match(/routePtyData\(payload\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('resync completion resets BEFORE writing the held replay (no early-parse race)', () => {
    const idx = src.indexOf('const completeResyncFromFlush');
    expect(idx).toBeGreaterThan(0);
    // The source-labelled writer mutes only replay chunks. The ordering
    // contract this test exists for — reset BEFORE held bytes parse — remains.
    const body = src.slice(idx, idx + 2400);
    const resetIdx = body.indexOf('terminal.reset()');
    const writeIdx = body.indexOf('writePtyDataImmediately(terminal, chunk');
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

  it('reveal branches on dirtiness: resync for dirty, cap-then-resync or flush for clean', () => {
    const idx = src.indexOf('if (isTerminalDirty(terminalRef.current))');
    expect(idx).toBeGreaterThan(0);
    // Window widened for the P0-5 retained-catchup mechanism log AND the
    // reveal-backlog-cap branch (2026-07-21) between the dirty check and the flush.
    const body = src.slice(idx, idx + 3400);
    expect(body).toMatch(/startResync\('dirty-reveal'\)/);
    expect(body).toMatch(/flushTerminalOutput\(terminalRef\.current\)/);
    // Reveal-backlog-cap two-part gate (review-team 2026-07-21): per-pane
    // isTerminalRetained (byte provenance — daemon-sourced, in the RingBuffer)
    // AND isDaemonModeActive (current reachability — resync can actually
    // replace what we discard). Neither alone is sufficient; both guard against
    // data loss on a non-retained/local pane or a since-disconnected daemon.
    expect(body).toMatch(/queued > REVEAL_FLUSH_MAX_CHARS/);
    expect(body).toMatch(/isTerminalRetained\(terminalRef\.current\)/);
    expect(body).toMatch(/isDaemonModeActive\(\)/);
    expect(body).toMatch(/startResync\('reveal-backlog-cap'\)/);
    // Large NON-retained backlog can't be discarded (no daemon authority) but
    // must not burst — hand it to the budgeted priority drain instead.
    expect(body).toMatch(/promoteTerminalToPriorityDrain\(terminalRef\.current\)/);
  });

  it('resync degrades without ever clearing the ptyId (dead pane keeps its last screen)', () => {
    // reconnectPtyWithRetry clears ptyIds on fatal errors — the resync path
    // must not: it calls pty.reconnect directly. App-weight P0-2 changed the
    // degrade contract: abortResync now KEEPS the pane dirty (stale is never
    // blessed as clean) and rate-limits retries via degradedUntil — see
    // useTerminal.appWeightP0.test.ts for the full P0-2 assertions.
    const idx = src.indexOf('const startResync');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 3600);
    expect(body).toMatch(/window\.electronAPI\.pty\.reconnect\(id\)/);
    expect(body).not.toMatch(/clearSurfacePtyIdByPty|reconnectPtyWithRetry/);
    const abortIdx = src.indexOf('const abortResync');
    const abortBody = src.slice(abortIdx, abortIdx + 1600);
    expect(abortBody).not.toMatch(/markTerminalClean\(term\)/);
    expect(abortBody).toMatch(/degradedUntil/);
  });

  it('exposes hydrate-before-read and cleans it up on unmount', () => {
    expect(src).toMatch(/export\s+async\s+function\s+hydrateTerminalForRead/);
    expect(src).toMatch(/hydrateRegistry\.set\(ptyId,\s*hydrateForRead\)/);
    expect(src).toMatch(/hydrateRegistry\.get\(ptyId\)\s*===\s*hydrateForRead[\s\S]{0,120}hydrateRegistry\.delete\(ptyId\)/);
    // Hydration ends with a parse barrier so callers read a settled buffer —
    // a BOUNDED one, so a wedged xterm write buffer (a handler that threw
    // mid-drain strands every queued callback) cannot hang the read instead.
    const idx = src.indexOf('const hydrateForRead');
    const body = src.slice(idx, idx + 900);
    expect(body).toMatch(/await\s+awaitParseBarrier\(terminal\)/);
    expect(src).toMatch(/import\s+\{\s*awaitParseBarrier\s*\}\s+from\s+'\.\.\/terminal\/parseBarrier'/);
    // Teardown silences any in-flight resync.
    // Cleanup cancels with the effect's CAPTURED ptyId (not the mutable ref —
    // a PTY swap could clear the wrong pane's badge; CodeRabbit PR #470).
    expect(src).toMatch(/cancelResync\(ptyId\);/);
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
    // Window widened for #1256's scroll-preservation block; the ordering
    // contract below is unchanged.
    const paint = src.slice(idx, idx + 3000);
    // discard stale backlog → reset → write payload → write held bytes → clean.
    // The payload write is writeReplayed() since #998 (clipboard bridge muted
    // while stored bytes are parsed); the order is what this locks.
    const discard = paint.indexOf('discardTerminalOutput(term)');
    const reset = paint.indexOf('term.reset()');
    const write = paint.indexOf('writeReplayed(term, bytes');
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

  it('#1256: a resync repaint preserves the scroll position across reset()', () => {
    // reset() snaps the viewport to the bottom; without preservation, showing
    // a hidden pane yanked a scrolled-up user to the bottom. Both repaint
    // paths (dead snapshot + live flush-complete) capture the distance from
    // the bottom BEFORE the reset and restore it after the recovered screen
    // is parsed — a trailing empty write is the parse barrier, the same
    // shape as hydrateForRead.
    for (const [name, fn] of [['dead-snapshot', 'const paintDeadSnapshot'], ['flush-complete', 'const completeResyncFromFlush']] as const) {
      const idx = src.indexOf(fn);
      expect(idx).toBeGreaterThan(0);
      const body = src.slice(idx, idx + 2600);
      const capture = body.indexOf('fromBottom = Math.max(0,');
      const reset = body.indexOf('.reset()');
      // `term.write` (dead-snapshot) / `terminal.write` (flush-complete) —
      // match on the trailing parse-barrier write itself.
      const barrier = body.indexOf(".write('', () =>");
      const restore = body.indexOf('scrollToLine(Math.max(0,');
      expect(capture).toBeGreaterThan(0);
      expect(reset).toBeGreaterThan(capture);
      expect(barrier).toBeGreaterThan(reset);
      expect(restore).toBeGreaterThan(barrier);
      expect(body).toMatch(/baseY - fromBottom/);
      // Restoration is cosmetic and must never take the mount down on a
      // terminal disposed mid-restore.
      expect(body.slice(barrier, restore + 400)).toMatch(/catch/);
      void name;
    }
  });

  it('#1256: the live terminal instance is published as state for snapshot consumers', () => {
    // terminalRef is populated by mutation inside the mount effect — no
    // re-render follows, so a consumer reading terminalRef.current at render
    // time keeps null (fresh mount) or a detached instance (adoption swap).
    // Both assignment sites publish identity through state so Terminal.tsx
    // can bind the scroll button / bookmark indicator to the real instance.
    expect(src).toMatch(/const \[terminalInstance, setTerminalInstance\] = useState<Terminal \| null>\(null\)/);
    const publish = src.match(/terminalRef\.current = terminal;\s*\n\s*\/\/ #1256[\s\S]{0,200}setTerminalInstance\(terminal\)/);
    expect(publish).not.toBeNull();
    const clearIdx = src.indexOf('terminalRef.current = null;');
    const clearBody = src.slice(clearIdx, clearIdx + 400);
    expect(clearBody).toMatch(/setTerminalInstance\(null\)/);
    expect(src).toMatch(/return \{ terminal: terminalRef, terminalInstance,/);
  });
});
