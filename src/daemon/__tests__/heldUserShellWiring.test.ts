/**
 * #3049 — the daemon wiring of a held user shell, pinned structurally (house
 * pattern: pty.handler.promote.test.ts). index.ts runs main() on import, so the
 * closures that decide these paths exist only inside a running daemon; the
 * decisions they call are behaviour-tested in heldUserShellStart.test.ts,
 * recoverySelector.test.ts, promoteOnce.test.ts and
 * recoveredUserShellCredentials.os.test.ts.
 *
 * NOT covered here (needs a running daemon): an actual restart with a real
 * client identifying, or not, before the fallback fires.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readSourceText } from '../../test-utils/sourceText';

const daemon = readSourceText(path.join(__dirname, '..', 'index.ts'));
const between = (from: string, to: string, start = 0): string => {
  const a = daemon.indexOf(from, start);
  expect(a, `${from} not found`).toBeGreaterThanOrEqual(0);
  const b = daemon.indexOf(to, a + from.length);
  expect(b, `${to} not found after ${from}`).toBeGreaterThan(a);
  return daemon.slice(a, b);
};

describe('boot recovery holds a listed plain user shell', () => {
  const recovery = between('async function recoverSessions(', '\n}\n');

  it('reads the hold list main writes, from the wmux data dir', () => {
    expect(recovery).toMatch(/const holds = readUserShellHolds\(path\.join\(wmuxDir, USER_SHELL_HOLDS_FILE\)\);/);
  });

  it('holds it after the cap check and before both respawn branches, once its previous shell is stopped', () => {
    const capAt = recovery.indexOf('if (!recoverableIds.has(session.id)) continue;');
    const heldAt = recovery.indexOf('if (heldForCredentials(session, holds)) {');
    const suspendedAt = recovery.indexOf("if (session.state === 'suspended' && session.bufferDumpPath) {");
    expect(capAt).toBeGreaterThan(0);
    expect(heldAt).toBeGreaterThan(capAt);
    expect(suspendedAt).toBeGreaterThan(heldAt);
    const branch = recovery.slice(heldAt, suspendedAt);
    expect(branch.indexOf('await leftoverShells.get(session.id);')).toBeLessThan(branch.indexOf('sessionManager.holdForStart(session);'));
    // Its scrollback is read when it starts.
    expect(branch).toMatch(/session\.bufferDumpPath \?\?= stateWriter\.getBufferDumpPath\(session\.id\);/);
    expect(branch).toMatch(/continue;/);
  });

  it('ends every respawned pane through the helper a held shell\'s promote shares, after the spool ingest', () => {
    const ingestAt = recovery.indexOf('ingestResumeSpool(sessionManager, stateWriter);');
    const finishAt = recovery.indexOf('for (const recoveredId of recoveredIds) finishRecoveredPane(sessionManager, recoveredId);');
    expect(ingestAt).toBeGreaterThan(0);
    expect(finishAt).toBeGreaterThan(ingestAt);
  });
});

describe('a held user shell starts only through main\'s promote, or the fallback', () => {
  it('daemon.attachSession answers pending for it and starts nothing', () => {
    const attach = between("pipeServer.onRpc('daemon.attachSession'", 'sessionManager.attachSession(p.id);');
    const pendingAt = attach.indexOf('if (sessionManager.isStartPending(p.id)) return { ok: false, pending: true };');
    expect(pendingAt).toBeGreaterThan(0);
    expect(pendingAt).toBeLessThan(attach.indexOf('promoteOnce(p.id)'));
  });

  it('daemon.promoteSession refuses credentials, and a held shell before the fallback, to anyone but the first-party client', () => {
    const refusal = between('const firstPartyPromoteRefusal = ', '};');
    expect(refusal).toMatch(/promoteNeedsFirstParty\(\{ credentialEnv: credentialEnv !== undefined, startPending: sessionManager\.isStartPending\(id\), fallbackFired: heldStartFallback\?\.fired\(\) === true \}\)/);
    expect(refusal).toMatch(/if \(!needed \|\| pipeServer\.isFirstParty\(clientId\)\) return null;/);
    const rpc = between("pipeServer.onRpc('daemon.promoteSession'", '});');
    const joinOnlyAt = rpc.indexOf("if (params?.['joinOnly'] === true)");
    const refusedAt = rpc.indexOf('firstPartyPromoteRefusal(id, credentialEnv, ctx.clientId)');
    expect(joinOnlyAt).toBeGreaterThan(0);
    expect(refusedAt).toBeGreaterThan(joinOnlyAt);
    expect(refusedAt).toBeLessThan(rpc.indexOf('touchPendingRecovery(id)'));
    expect(rpc).toMatch(/return promoteOnce\(id, params\?\.\['fresh'\] === true, 'rpc', false, credentialEnv as Record<string, string> \| undefined\);/);
  });

  it('a create never takes credentials: only the promote of a suspended session does', () => {
    expect(between('const createSessionRpc = async', "pipeServer.onRpc('daemon.createSession'")).not.toMatch(/credentialEnv/);
  });

  it('the fallback is fixed and uncancellable: armed once the pipe listens, never stored or cleared', () => {
    const at = daemon.indexOf("markDaemonBoot('pipe-listening');");
    expect(daemon.slice(at, at + 300)).toMatch(/setTimeout\(\(\) => \{ void heldStartFallback\?\.fire\(\); \}, HELD_START_FALLBACK_MS\)\.unref\?\.\(\);/);
    expect(daemon.match(/heldStartFallback\?\.fire\(\)/g)).toHaveLength(1);
    // It starts what is still held with the background origin and no credentials.
    expect(between('heldStartFallback = createHeldStartFallback({', '});')).toMatch(/start: \(id\) => promoteOnce\(id, false, 'background'\),/);
  });
});

describe('promoting a held user shell', () => {
  const promote = between('const promoteSession = async', 'const promoteOnce = createPromoteOnce(');

  it('cleans the credentials, refuses them for an exec unit or a supervised session, and spawns with them', () => {
    expect(promote).toMatch(/sanitizeCredentialEnv\(params\['credentialEnv'\]\)/);
    expect(promote).toMatch(/if \(credentialEnv === null \|\| \(credentialEnv && \(session\.exec \|\| session\.supervision\)\)\) \{/);
    expect(promote).toMatch(/\.\.\.\(credentialEnv \? \{ credentialEnv \} : \{\}\),/);
    expect(promote).toMatch(/credentialsApplied: true as const/);
  });

  it('gets boot recovery\'s retry budget', () => {
    expect(promote).toMatch(/const PROMOTE_RETRIES = heldStart \? RECOVERY_PTY_RETRIES : 4;/);
  });

  it('finishes as boot recovery does, so its resume offer is the one boot would have given', () => {
    const held = promote.slice(promote.indexOf('if (!startFresh && heldStart) {'), promote.indexOf('} else if (!startFresh) {'));
    expect(held).toMatch(/if \(recordWasMidTurn\(session, Date\.now\(\)\)\) promotedSession\.meta\.resumeContinuePending = true;/);
    expect(held.indexOf('ingestResumeSpool(sessionManager, stateWriter);')).toBeLessThan(held.indexOf('finishRecoveredPane(sessionManager, sessionId);'));
    expect(held.indexOf('finishRecoveredPane(sessionManager, sessionId);')).toBeGreaterThan(0);
  });

  it('a start that fails leaves a dead record and tells main the pane died', () => {
    const failed = promote.slice(promote.indexOf('if (heldStart && !shuttingDown && sessionManager.isStartPending(sessionId)) {'));
    expect(failed).toMatch(/const record = sessionManager\.dropPendingRecovery\(sessionId\);/);
    expect(failed).toMatch(/state: 'dead', exitCode: null/);
    expect(failed).toMatch(/sessionManager\.emit\('session:died', \{ id: sessionId, exitCode: null, reason: 'recovery' \}\);/);
  });
});

describe('the start hold is never persisted', () => {
  it('is on the listing reply only, from the manager\'s in-memory set', () => {
    expect(between("pipeServer.onRpc('daemon.listSessions'", "pipeServer.onRpc('daemon.promoteSession'"))
      .toMatch(/\.\.\.\(sessionManager\.isStartPending\(s\.id\) \? \{ startPending: true as const \} : \{\}\)/);
    expect(readSourceText(path.join(__dirname, '..', 'types.ts'))).not.toMatch(/startPending/);
  });
});
