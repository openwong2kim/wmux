import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateWriter } from '../StateWriter';
import type { DaemonState } from '../types';

// X6 ② reboot-survival durability regression lock.
//
// Bug: after a REAL OS reboot, the "▶ Resume Claude" pill did not appear on
// recovered agent panes. Root cause (confirmed by an expert panel + live test):
//   - The pill is gated entirely on the PERSISTED lastDetectedAgent
//     (resumeOfferForRecovered, src/shared/agentResume.ts:156 — reads it off the
//     persisted session, since the recovered live meta is a fresh shell).
//   - The session:agent handler (src/daemon/index.ts) set meta.lastDetectedAgent
//     but persisted it via stateWriter.saveDebounced (30s, in-memory pendingState).
//   - A real reboot SIGKILLs the daemon; flush()/process.on('exit') never run, so
//     a fresh detection with no other state-changing event to opportunistically
//     flush it is lost -> empty recovery offer -> no pill.
//   - meta.cwd was STRICTLY WORSE: the session:cwd handler persisted NOTHING, so a
//     reboot restored the pane to a stale cwd and `claude --continue` (cwd-scoped)
//     resumed the wrong/none conversation.
//
// Why the original dogfood missed it: scripts/x6-pill-offer-isolated.mjs MANUALLY
// SEEDS lastDetectedAgent into sessions.json before respawning the daemon, which
// bypasses the detect->persist step entirely and so could never hit the race.
//
// Fix: both handlers now persist via saveImmediate (agent detection is bounded to
// one write per slug transition by the !== slug guard; cwd is bounded to actual
// `cd` by a change-guard in DaemonSessionManager's bridge 'cwd' handler).
describe('X6 ② reboot-survival durability', () => {
  let tmpDir: string;
  let writer: StateWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-x6dur-test-'));
    writer = new StateWriter(tmpDir);
  });

  afterEach(() => {
    writer.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- The race the fix closes (behavioral proof) ---------------------------

  it('saveDebounced does NOT write synchronously — a SIGKILL in the window loses it', () => {
    const filePath = path.join(tmpDir, 'sessions.json');
    expect(fs.existsSync(filePath)).toBe(false);
    // This is exactly what the OLD session:agent handler did. With a 30s debounce
    // the payload sits only in memory; a reboot here drops lastDetectedAgent.
    writer.saveDebounced({ version: 1, sessions: [] });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('saveImmediate writes synchronously — survives an instant SIGKILL (the fix)', () => {
    const filePath = path.join(tmpDir, 'sessions.json');
    writer.saveImmediate({
      version: 1,
      sessions: [
        {
          id: 'x6dur-agent',
          state: 'attached',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          pid: 4242,
          cmd: 'pwsh.exe',
          cwd: 'D:\\proj',
          env: {},
          cols: 80,
          rows: 24,
          deadTtlHours: 24,
          lastDetectedAgent: 'claude',
        },
      ] as DaemonState['sessions'],
    });
    // No await, no timer fire — the field must already be on disk.
    expect(fs.existsSync(filePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DaemonState;
    expect(persisted.sessions[0]?.lastDetectedAgent).toBe('claude');
  });

  // --- Source-level guards (lock the handlers against a regress to debounce) -
  //
  // The behavioral tests above prove StateWriter semantics but do not invoke the
  // production handlers (they live inside main() in index.ts). These static
  // guards read the daemon entrypoint and lock the two handlers to saveImmediate,
  // mirroring createSessionPersistence.test.ts's source-guard approach. A refactor
  // that reverts either to saveDebounced (re-opening the reboot race) fails here.

  function extractEventHandlerBody(src: string, event: string): string {
    const lines = src.split('\n');
    const startIdx = lines.findIndex((l) => l.includes(`sessionManager.on('${event}'`));
    if (startIdx < 0) throw new Error(`Handler not found: ${event}`);
    // Body runs until the next sessionManager.on( registration, exclusive.
    const nextIdx = lines.findIndex(
      (l, i) => i > startIdx && /sessionManager\.on\(/.test(l),
    );
    const endIdx = nextIdx > 0 ? nextIdx : lines.length;
    return lines.slice(startIdx, endIdx).join('\n');
  }

  const daemonIndexPath = path.join(__dirname, '..', 'index.ts');

  it('session:agent handler persists via saveImmediate, not saveDebounced', () => {
    const src = fs.readFileSync(daemonIndexPath, 'utf-8');
    const body = extractEventHandlerBody(src, 'session:agent');
    expect(body).toMatch(/stateWriter\.saveImmediate\(/);
    // The bug: this used to be saveDebounced. Lock it out.
    expect(body).not.toMatch(/stateWriter\.saveDebounced\(/);
    expect(body).not.toMatch(/setImmediate\([^)]*saveImmediate/);
  });

  it('cwd candidates use the exact asynchronous transaction policy', () => {
    // Cwd remains nonblocking at the bridge boundary, but publication waits
    // for the transaction owner's exact ASAP write.
    const src = fs.readFileSync(daemonIndexPath, 'utf-8');
    const body = extractEventHandlerBody(src, 'session:locationCandidate');
    expect(body).toMatch(/submitDaemonSessionLocationCandidate/);
    const transactionSource = fs.readFileSync(
      path.join(__dirname, '..', 'sessionLocationPersistence.ts'),
      'utf-8',
    );
    expect(transactionSource).toMatch(
      /input\.reason === 'enriched' \? 'immediate-retry' : 'asap'/,
    );
    expect(body).not.toMatch(/saveDebounced|saveImmediate/);
  });

  it('useTerminal onData guards clearResumeHint against focus reports (CSI I / CSI O)', () => {
    // The renderer retracts the resume pill when the user drives the shell
    // (terminal.onData). But xterm emits focus-tracking reports (CSI I / CSI O)
    // through the SAME onData on every pane mount/refocus — a recovered agent
    // pane fires CSI I on mount, which cleared the pill the instant it hydrated
    // (the bug that made the pill invisible after every reboot). The handler must
    // exclude those reports so only real input retracts the offer.
    const utPath = path.join(__dirname, '..', '..', 'renderer', 'hooks', 'useTerminal.ts');
    const src = fs.readFileSync(utPath, 'utf-8');
    const idx = src.indexOf('terminal.onData((data)');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 1400);
    expect(body).toMatch(/clearResumeHint/);
    // focus reports must be excluded from the clear path
    expect(body).toMatch(/\\x1b\[I/);
    expect(body).toMatch(/\\x1b\[O/);
  });

  it('bridge cwd handler deduplicates against producer order, not committed state', () => {
    const mgrPath = path.join(__dirname, '..', 'DaemonSessionManager.ts');
    const src = fs.readFileSync(mgrPath, 'utf-8');
    const lines = src.split('\n');
    const startIdx = lines.findIndex((l) => l.includes("bridge.on('cwd'"));
    expect(startIdx).toBeGreaterThan(-1);
    const body = lines.slice(startIdx, startIdx + 12).join('\n');
    // Committed meta intentionally lags durability. Deduplicating against the
    // producer cursor preserves /old → /new → /old reversals.
    expect(body).toMatch(
      /if \(managed\.locationProducerCwd === payload\.cwd\) return;/,
    );
    expect(body).not.toMatch(/if \(meta\.cwd === payload\.cwd\) return;/);
  });

  // --- X6 ③ all-pane reliability guards (Rung 0/1/3) ------------------------

  it('Rung 1: the resume-binding applier ALSO arms lastDetectedAgent (pill 2nd writer)', () => {
    // The pill must not be hostage to the once-per-session live banner. A
    // captured hook binding proves the pane ran claude, so it sets the pill gate
    // too — otherwise a banner-missed-but-hook-landed pane holds the exact uuid
    // yet shows NO pill after reboot. Lock the write into the applier.
    //
    // M1 moved this body out of the `daemon.setResumeBinding` RPC callback and
    // into a named `applyResumeBinding`, because the daemon-side hook ingest
    // has to make the same capture as a LOCAL call (after M1 the bridge talks
    // to the daemon directly and main never relays). Anchor on the applier —
    // the RPC is now a two-line wrapper around it.
    const src = fs.readFileSync(daemonIndexPath, 'utf-8');
    const idx = src.indexOf('const applyResumeBinding =');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 4200);
    expect(body).toMatch(/lastDetectedAgent\s*=\s*next\.agent/);
    expect(body).toMatch(/KNOWN_AGENT_SLUGS/);
    // ...and the RPC must still route through it, or the wire path silently
    // stops persisting bindings for older (main-relaying) bridges.
    expect(src).toMatch(/onRpc\('daemon\.setResumeBinding'[\s\S]{0,220}applyResumeBinding\(/);
  });

  it('Rung 0: the daemon stamps WMUX_PTY_ID into each pane env (per-pane routing key)', () => {
    // surfaceId is never injected (the renderer mints a surface after pty.create),
    // so the daemon's own session id is the one reliable per-pane key the hook
    // bridge can echo back. Without it, every split-pane hook collapses to the
    // workspace's active surface and bindings clobber each other.
    const mgrPath = path.join(__dirname, '..', 'DaemonSessionManager.ts');
    const src = fs.readFileSync(mgrPath, 'utf-8');
    expect(src).toMatch(/env\[ENV_KEYS\.PTY_ID\]\s*=\s*params\.id/);
  });

  it('Rung 3: recoverSessions drains the resume-binding spool before surfacing the pill', () => {
    const src = fs.readFileSync(daemonIndexPath, 'utf-8');
    // The ingest must run inside recovery so a binding lost to a failed live RPC
    // (main pipe down at capture) is reconciled and drives an EXACT-session pill.
    const recIdx = src.indexOf('async function recoverSessions');
    expect(recIdx).toBeGreaterThan(-1);
    const recEnd = src.indexOf('\n}', src.indexOf('cleanOrphanedBuffers', recIdx));
    const recBody = src.slice(recIdx, recEnd);
    expect(recBody).toMatch(/ingestResumeSpool\(sessionManager, stateWriter\)/);
    // And the pill markers are read off the LIVE recovered meta (which reflects
    // carry-forward + spool ingest + Rung-1 gate), not the stale persisted record.
    expect(recBody).toMatch(/for \(const recoveredId of recoveredIds\)/);
    // CodeRabbit: a spool-only binding must reach the exec REPLAY launch (which
    // runs before ingest), so resumeLaunchCommand consults the pre-read spool map.
    expect(recBody).toMatch(/readResumeSpoolMap\(\)/);
    expect(recBody).toMatch(/resumeLaunchCommand\(session, spoolBindings\.get\(session\.id\)\)/);
  });

  it('Rung 3: spool ingest guards — F7 cwd-match, D5 existence-probe, no stale clobber', () => {
    const src = fs.readFileSync(daemonIndexPath, 'utf-8');
    const idx = src.indexOf('function ingestResumeSpool');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 4200);
    // Attribute by EXACT pane id, not cwd guessing.
    expect(body).toMatch(/sessionManager\.getSession\(ptyId\)/);
    // F7: origin cwd must match the recovered pane cwd (normalized — codex P2).
    expect(body).toMatch(
      /resumeBindingMatchesLocation\(\s*binding,\s*managed\.meta\.cwd,\s*managed\.meta\.location,\s*process\.platform/,
    );
    // Never let an older spooled capture overwrite a newer live one, and skip a
    // same-conversation spool (codex P2).
    expect(body).toMatch(/prev\.ts >= binding\.ts/);
    expect(body).toMatch(/prev\.sessionId === binding\.sessionId/);
    // D5: purged transcript → drop, never offer a dead --resume.
    expect(body).toMatch(/bindingTranscriptLives\(binding, managed\.meta\)/);
  });
});
