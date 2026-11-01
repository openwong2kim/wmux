/**
 * Fix B — cap-skipped suspended session promote.
 *
 * Boot recovery honours a session cap, so a workspace beyond the cap came back
 * with its ptyId absent; reconcile then destructively cleared it and the pane
 * lost both its identity and its scrollback. `daemon.promoteSession` spawns
 * exactly the one session the renderer still needs, keeping the ptyId stable so
 * the daemon's ring buffer restores.
 *
 * Structural test (house pattern: pty.handler.surfaceIdExposure.test.ts,
 * appLayout.sessionSaveInvariants.test.ts). The chain crosses three untyped
 * hops (renderer IPC → daemon RPC → node-pty spawn) and the daemon half only
 * exists inside a running daemon process, so tsc and unit tests cannot catch a
 * dropped guard. These scans fail if a refactor removes the idempotency check,
 * the suspended-only lookup, the transient-spawn retry bound, or the
 * error-shape the renderer branches on.
 *
 * NOT covered here (needs a live daemon): the actual PTY spawn, the scrollback
 * dump replay, and the session-cap RESOURCE_EXHAUSTED path.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readSourceText } from '../../../test-utils/sourceText';

const srcRoot = path.join(__dirname, '..', '..', '..');

describe('pty.handler PTY_PROMOTE — renderer→daemon hop', () => {
  const source = readSourceText(path.join(__dirname, '..', 'handlers', 'pty.handler.ts'));

  function promoteRegion(): string {
    const start = source.indexOf('ipcMain.handle(IPC.PTY_PROMOTE');
    expect(start, 'PTY_PROMOTE handler not found').toBeGreaterThanOrEqual(0);
    return source.slice(start, start + 1200);
  }

  it('is registered only in daemon mode (local mode has no daemon to promote in)', () => {
    const promoteAt = source.indexOf('ipcMain.handle(IPC.PTY_PROMOTE');
    const guardAt = source.lastIndexOf('if (useDaemon && daemonClient)', promoteAt);
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(promoteAt);
  });

  it('rejects an empty id before touching the daemon', () => {
    expect(promoteRegion()).toMatch(/if \(!id\) return \{ success: false/);
  });

  it('forwards to daemon.promoteSession and normalizes the reply the renderer reads', () => {
    const region = promoteRegion();
    expect(region).toMatch(/daemonClient\.rpc\('daemon\.promoteSession', \{ id, \.\.\.\(fresh \? \{ fresh: true \} : \{\}\) \}, \{ timeoutMs: WSL_RPC_TIMEOUT_MS \}\)/);
    expect(region).toMatch(/if \(res\.ok\) return \{ success: true \}/);
    // A failure must carry a message, or reconcile logs `undefined` and the
    // operator cannot tell a cap hit from a spawn crash.
    expect(region).toMatch(/success: false, error: res\.error\?\.message \?\? 'promote failed'/);
  });

  // #1305 — the start-fresh action. `fresh` only ever travels when the user
  // pressed it (never a default), and the renderer decides whether to OFFER it
  // from the daemon's error code, never by reading the distro's message.
  it('sends the fresh flag only when asked, and normalizes CWD_MISSING for the renderer', () => {
    const region = promoteRegion();
    expect(region).toMatch(/const fresh = opts\?\.fresh === true;/);
    expect(region).toMatch(/cwdMissing: res\.error\?\.code === 'CWD_MISSING'/);
  });

  it('carries the same code out of the reconnect path, where the banner is actually raised', () => {
    const start = source.indexOf("ipcMain.handle(IPC.PTY_RECONNECT");
    const region = source.slice(start, start + 7000);
    expect(region).toMatch(/recoveryPending: true[\s\S]*?cwdMissing: result\.error\?\.code === 'CWD_MISSING'/);
  });

  it('removes the handler on cleanup so a daemon reconnect cannot double-register', () => {
    const removals = source.match(/removeHandler\(IPC\.PTY_PROMOTE\)/g) ?? [];
    expect(removals.length).toBeGreaterThanOrEqual(2);
  });

  it('PTY_LIST threads includeSuspended through to the daemon', () => {
    const start = source.indexOf('ipcMain.handle(IPC.PTY_LIST');
    const region = source.slice(start, start + 1500);
    expect(region).toMatch(/opts\?\.includeSuspended === true/);
    expect(region).toMatch(/daemonClient\.rpc\('daemon\.listSessions', \{ includeSuspended \}\)/);
  });
});

describe('daemon.promoteSession — guards', () => {
  const source = readSourceText(path.join(srcRoot, 'daemon', 'index.ts'));

  function promoteRegion(): string {
    const start = source.indexOf("const promoteSession = async");
    expect(start, 'daemon.promoteSession not registered').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('pipeServer.onRpc(', start + 1);
    return source.slice(start, end > 0 ? end : start + 6000);
  }

  it('is idempotent — an already-active session succeeds without respawning', () => {
    const region = promoteRegion();
    const existingAt = region.indexOf('sessionManager.getSession(sessionId)');
    const createAt = region.indexOf('sessionManager.createSession');
    expect(existingAt).toBeGreaterThanOrEqual(0);
    expect(existingAt).toBeLessThan(createAt);
    expect(region).toMatch(/return \{ ok: true, alreadyActive: true \}/);
  });

  it('only promotes a session the persisted state records as SUSPENDED', () => {
    const region = promoteRegion();
    expect(region).toMatch(/s\.id === sessionId && s\.state === 'suspended'/);
    expect(region).toMatch(/code: 'NOT_FOUND'/);
  });

  it('validates the id parameter', () => {
    expect(promoteRegion()).toMatch(/code: 'INVALID_PARAMS'/);
  });

  it('retries ONLY the known transient ConPTY spawn race, and with a bound', () => {
    const region = promoteRegion();
    expect(region).toMatch(/PROMOTE_RETRIES = \d+/);
    // A non-transient failure must break immediately rather than burn the budget.
    expect(region).toMatch(/if \(!msg\.includes\('error code: 87'\)\) break;/);
  });

  it('reuses the persisted geometry and identity rather than inventing new ones', () => {
    const region = promoteRegion();
    for (const field of ['id:', 'cmd:', 'cols:', 'rows:', 'agent:', 'createdAt:', 'supervision:']) {
      expect(region, `createSession must pass ${field}`).toContain(field);
    }
    // The ptyId is the whole point: a new id would lose the pane binding.
    expect(region).toMatch(/id: session\.id/);
  });

  it('falls back to the home directory when the recorded cwd is gone', () => {
    // #1729 — through the wrapper that warns when a WSL pane falls back to home.
    expect(promoteRegion()).toMatch(/recoveryCwdLogged\(session\)/);
  });

  it('reports a spawn failure as a structured error instead of throwing at the pipe', () => {
    expect(promoteRegion()).toMatch(/return \{ ok: false, error: \{ code: [^\n]*'SPAWN_FAILED', message: msg \} \}/);
  });

  // #1305 — a missing directory is the one failure a Retry cannot clear, and
  // the renderer offers the start-fresh action on this code alone. Classified
  // from the probe's own marker (see shared/wsl.ts), never from the message.
  it('separates a missing working directory from every other spawn failure', () => {
    expect(promoteRegion()).toMatch(/code: isWslCwdMissingError\(err\) \? 'CWD_MISSING' : 'SPAWN_FAILED'/);
  });

  it('a fresh start drops the directory AND the resume, and never happens by default', () => {
    const region = promoteRegion();
    // Explicit: nothing infers it from a failure.
    expect(region).toMatch(/const startFresh = params\['fresh'\] === true;/);
    // Home instead of the missing directory — '~' for WSL, because only the
    // distribution knows where its home is.
    expect(region).toMatch(/startFresh\s*\?\s*\(isWslShell\(session\.cmd\) \? '~' : os\.homedir\(\)\)/);
    // The original command, not a --resume of a conversation that lived in the
    // directory that is gone; and the old spawn dir must not be carried into
    // the next recovery.
    expect(region).toMatch(/execLaunchCommand: startFresh \? undefined :/);
    expect(region).toMatch(/spawnCwd: startFresh \? undefined : session\.spawnCwd/);
    // The binding is dropped too: the cwd guard below it already refuses one,
    // but the meta assignment did not.
    expect(region).toMatch(/if \(!startFresh\) \{/);
  });

  it('starts process monitoring for the promoted session', () => {
    // Without this the promoted pane would never be marked dead when it exits.
    expect(promoteRegion()).toMatch(/processMonitor\.watch\(/);
  });

  it('restores a non-WSL cap-skipped session with the same parity as boot recovery', () => {
    const region = promoteRegion();
    const createAt = region.indexOf('sessionManager.createSessionAsync(');
    const armAt = region.indexOf('paneSupervisor.arm(sessionId');
    const saveAt = region.indexOf('stateWriter.saveImmediate(buildState(sessionManager))');
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(armAt).toBeGreaterThan(createAt);
    expect(saveAt).toBeGreaterThan(armAt);
    // Exec units replay `--resume <id>` like boot recovery does (unless the
    // user explicitly asked for a fresh start — #1305).
    expect(region).toMatch(/execLaunchCommand: startFresh \? undefined : resumeLaunchCommand\(session, /);
    // The resume binding is exposed off-WSL too, gated on a live transcript.
    expect(region).toMatch(/isWslShell\(session\.cmd\) \|\| bindingTranscriptLives\(session\.resumeBinding\)/);
    // None of the above is fenced behind a WSL-only branch.
    expect(region.slice(createAt, saveAt)).not.toMatch(/if \(isWslShell\(session\.cmd\)\)/);
  });

  // #1305 — the pending-recovery TTL only works because of WHERE the restamp
  // lives. A client asking for the pane renews it; the boot background retry
  // must not, or every boot would renew every entry and nothing could ever age
  // out. Neither half is reachable from a unit test (both live inside a running
  // daemon), and getting it wrong silently restores the unbounded growth, so
  // pin the split structurally.
  it('a client retry renews the pending entry but the boot background retry does not', () => {
    const rpcAt = source.indexOf("pipeServer.onRpc('daemon.promoteSession'");
    expect(rpcAt, 'daemon.promoteSession not registered').toBeGreaterThanOrEqual(0);
    const rpcRegion = source.slice(rpcAt, rpcAt + 1200);
    expect(rpcRegion).toMatch(/touchPendingRecovery\(id\)/);
    // Before the attempt: a promote that fails on a path with no save must
    // still have recorded that the user asked for this pane.
    expect(rpcRegion.indexOf('touchPendingRecovery(id)'))
      .toBeLessThan(rpcRegion.indexOf("promoteOnce(id, params?.['fresh']"));

    // The attach path is the other client-initiated entry point.
    const attachAt = source.indexOf("pipeServer.onRpc('daemon.attachSession'");
    expect(source.slice(attachAt, attachAt + 600)).toMatch(/touchPendingRecovery\(p\.id\)/);

    // The boot background retry (setImmediate, after the RPC registration)
    // must stay untouched.
    const bootAt = source.indexOf('WSL background recovery');
    expect(bootAt, 'boot background recovery not found').toBeGreaterThan(rpcAt);
    const bootRegion = source.slice(source.lastIndexOf('setImmediate(', bootAt), bootAt);
    expect(bootRegion).toMatch(/promoteOnce\(session\.id, false, 'background'\)/);
    expect(bootRegion).not.toMatch(/touchPendingRecovery/);
  });

  it('daemon.listSessions appends suspended entries ONLY when asked', () => {
    const start = source.indexOf("pipeServer.onRpc('daemon.listSessions'");
    const region = source.slice(start, source.indexOf("pipeServer.onRpc('daemon.promoteSession'"));
    expect(region).toMatch(/includeSuspended = params\['includeSuspended'\] === true/);
    expect(region).toMatch(/if \(includeSuspended\) \{/);
    // No duplicates: an id already in the active list must not be re-added.
    expect(region).toMatch(/!activeIdSet\.has\(s\.id\)/);
    // And the default (unscoped) reply must stay exactly the active list
    // (`reply` only wraps it when the caller asks `withRecovery`, #2393).
    expect(region).toMatch(/return reply\(activeSessions\);/);
    expect(region).toMatch(/withRecovery \? \{ sessions, recoveryDone: [^}]+\} : sessions/);
  });
});

// #2398 — a hidden pane attaches without promoting: its suspended session is a
// spawn, and a cold start with many restored workspaces spawned one per pane
// nobody had opened. The pane promotes it when first shown.
describe('attach without promote (#2398)', () => {
  const handler = readSourceText(path.join(__dirname, '..', 'handlers', 'pty.handler.ts'));
  const daemon = readSourceText(path.join(srcRoot, 'daemon', 'index.ts'));

  it('pty:reconnect answers a suspended session deferred, before any promote, unless the action says promote', () => {
    const start = handler.indexOf('ipcMain.handle(IPC.PTY_RECONNECT');
    const region = handler.slice(start, start + 5000);
    expect(region).toMatch(/opts\?: \{ promote\?: boolean; joinOnly\?: boolean \}/);
    const heldAt = region.indexOf('const held = (');
    const deferAt = region.indexOf("if (action === 'hold') return held(");
    const promoteAt = region.indexOf("daemonClient.rpc('daemon.promoteSession'");
    expect(heldAt).toBeGreaterThan(0);
    expect(deferAt).toBeGreaterThan(region.indexOf("session.state === 'suspended'"));
    expect(deferAt).toBeGreaterThan(heldAt);
    expect(deferAt).toBeLessThan(promoteAt);
    // The answer itself: heldReconnectAnswer, behaviour-tested in shared.
    expect(region.slice(heldAt, deferAt)).toMatch(/return heldReconnectAnswer\(listed\);/);
  });

  // Second-model P2-1 — a stop key (join-only) to an exec or supervised unit
  // joins a start in flight but never spawns one: the daemon is asked
  // join-only, and its "nothing in flight" is answered like a hold, not as a
  // recovery failure (which would raise the Retry banner).
  it('pty:reconnect asks the daemon join-only for a join-only caller and holds when nothing is in flight', () => {
    const start = handler.indexOf('ipcMain.handle(IPC.PTY_RECONNECT');
    const region = handler.slice(start, start + 9000);
    const promoteAt = region.indexOf("daemonClient.rpc('daemon.promoteSession'");
    expect(region.slice(promoteAt, promoteAt + 200)).toMatch(/\{ id, \.\.\.\(action === 'join-only' \? \{ joinOnly: true \} : \{\}\) \}/);
    // The mapping itself: promoteOutcome, behaviour-tested in shared.
    const outcomeAt = region.indexOf('const outcome = promoteOutcome(result);');
    const heldAt = region.indexOf("if (outcome === 'held') return held(");
    expect(outcomeAt).toBeGreaterThan(promoteAt);
    expect(heldAt).toBeGreaterThan(outcomeAt);
    expect(heldAt).toBeLessThan(region.indexOf("if (outcome === 'failed') return"));
  });

  it('daemon.promoteSession answers a join-only call without starting or renewing anything', () => {
    const start = daemon.indexOf("pipeServer.onRpc('daemon.promoteSession'");
    const region = daemon.slice(start, start + 1200);
    const joinOnlyAt = region.indexOf("if (params?.['joinOnly'] === true)");
    expect(joinOnlyAt).toBeGreaterThan(0);
    expect(joinOnlyAt).toBeLessThan(region.indexOf('touchPendingRecovery(id)'));
    // The answer itself: createPromoteOnce, behaviour-tested in promoteOnce.test.ts.
    expect(region).toMatch(/return promoteOnce\(id, false, 'rpc', true\);/);
  });

  // Second-model P3-1 — the attach promoted whatever the caller: a daemon
  // restart between the list and the attach turns a live WSL session back
  // into a pending recovery, and a hidden pane's attach then started it
  // (with `promoted` unset). It promotes only as the action says, and a
  // pending answer is held.
  it('pty:reconnect attaches with promote only as the action says, and holds a session pending again', () => {
    const start = handler.indexOf('ipcMain.handle(IPC.PTY_RECONNECT');
    const region = handler.slice(start, start + 12000);
    expect(region.indexOf('const action = suspendedReconnectAction(session, opts);'))
      .toBeLessThan(region.indexOf("if (session.state === 'suspended')"));
    // The attach itself is in the pipe step (reconnectSessionPipe.ts).
    expect(region).toMatch(/reconnectSessionPipe\(daemonClient, id, \{\s*promote: action === 'promote' \|\| action === 'join',/);
    expect(region).toMatch(/if \(pipe\.kind === 'pending'\) return held\('pending again at attach'\);/);
    const pipeStep = readSourceText(path.join(__dirname, '..', 'handlers', 'reconnectSessionPipe.ts'));
    expect(pipeStep).toMatch(/client\.rpc\('daemon\.attachSession', \{ id, promote: opts\.promote \}\)/);
    const attachAt = pipeStep.indexOf("client.rpc('daemon.attachSession'");
    expect(pipeStep.slice(attachAt, attachAt + 400)).toMatch(/if \(attached\?\.pending\) return \{ kind: 'pending' \};/);
  });

  // Review item 2 — the reconnect asks the same predicate the daemon's boot
  // promote uses, so an exec unit or supervised session the daemon starts in
  // the background falls through to promoteSession (which joins that start)
  // instead of leaving its pane deferred.
  it('pty:reconnect reads exec and supervision, the fields recoversInBackground decides on', () => {
    const start = handler.indexOf('ipcMain.handle(IPC.PTY_RECONNECT');
    const region = handler.slice(start, start + 2500);
    expect(region).toMatch(/exec\?: unknown;\s*supervision\?: unknown;/);
    expect(handler).toMatch(/import \{ heldReconnectAnswer, promoteOutcome, promoteStartedSession, suspendedReconnectAction \} from '\.\.\/\.\.\/\.\.\/shared\/suspendedSession';/);
  });

  // Review item 1 — a held session is in use: every hold tells the daemon,
  // which renews it against the suspended TTL.
  it('a held reconnect tells the daemon the session is held, and pty:hold forwards the renderer holds', () => {
    const heldAt = handler.indexOf('const held = (');
    expect(handler.slice(heldAt, heldAt + 700)).toMatch(/daemonClient\.rpc\('daemon\.holdSession', \{ ids: \[id\] \}\)/);
    const holdAt = handler.indexOf('ipcMain.handle(IPC.PTY_HOLD');
    expect(holdAt).toBeGreaterThan(0);
    expect(handler.slice(holdAt, holdAt + 500)).toMatch(/daemonClient\.rpc\('daemon\.holdSession', \{ ids: held \}\)/);
    expect((handler.match(/removeHandler\(IPC\.PTY_HOLD\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  // Round-5 P3 — the reconnect answer says when it started the session, so a
  // stop key that joined that attempt is not delivered into the new shell.
  it('pty:reconnect answers promoted when it promoted a suspended session', () => {
    const start = handler.indexOf('ipcMain.handle(IPC.PTY_RECONNECT');
    const region = handler.slice(start, start + 9000);
    const promoteAt = region.indexOf("daemonClient.rpc('daemon.promoteSession'");
    // Round 7: from what the daemon did (promoteStartedSession, unit-tested
    // in shared), never from the action label.
    expect(region.slice(promoteAt, promoteAt + 1600)).toMatch(/promoted = promoteStartedSession\(result\);/);
    expect(region).not.toMatch(/promoted = suspendedReconnectAction/);
    expect(handler).toMatch(/return \{ success: true, id: session\.id,[^\n]*\.\.\.startedHere\(\) \};/);
  });

  // Round-6 P3 — an attach that fails after the promote still says so: the
  // renderer's retry attaches a session that runs by then.
  it('pty:reconnect carries promoted on the failed attaches after a promote too', () => {
    expect(handler).toMatch(/let promoted = false;\s*const startedHere = \(\) => \(promoted \? \{ promoted: true \} : \{\}\);\s*try \{/);
    expect(handler).toMatch(/code: 'pipe-not-writable', transient: true, \.\.\.startedHere\(\) \};/);
    expect(handler).toMatch(/code: 'rpc-error', transient: true, \.\.\.startedHere\(\) \};/);
    expect(handler).toMatch(/recoveryPending: true, error: err instanceof Error \? err\.message : String\(err\), \.\.\.startedHere\(\) \};/);
  });

  it('daemon.holdSession stamps the pending recovery or disk-only record and saves', () => {
    const start = daemon.indexOf("pipeServer.onRpc('daemon.holdSession'");
    expect(start).toBeGreaterThan(0);
    const region = daemon.slice(start, start + 800);
    expect(region).toMatch(/sessionManager\.getPendingRecovery\(id\) \?\? diskOnlySessions\.find/);
    expect(region).toMatch(/stampHeld\(record, now\)/);
    expect(region).toMatch(/stateWriter\.saveDebounced\(buildState\(sessionManager\)\)/);
  });

  it('daemon.attachSession leaves a pending recovery pending with promote:false', () => {
    const start = daemon.indexOf("pipeServer.onRpc('daemon.attachSession'");
    const region = daemon.slice(start, start + 1200);
    const deferAt = region.indexOf('if (p.promote === false) return');
    expect(deferAt).toBeGreaterThan(0);
    expect(deferAt).toBeLessThan(region.indexOf('promoteOnce(p.id)'));
  });

  it('the boot-time WSL background promote starts only exec units and supervised sessions', () => {
    const start = daemon.indexOf('// Defer cold WSL starts until RPC registration');
    const region = daemon.slice(start, start + 1500);
    expect(region).toMatch(/recoversInBackground\(placeholder\)/);
  });
});

// #2398 §6-4 option B: a hidden suspended session that would resume an agent
// conversation is promoted at boot by the renderer when resume-on-start is on,
// so the deferred answer and the suspended list carry its guarded binding.
describe('resume on start for a suspended session (#2398 §6-4 option B)', () => {
  const handler = readSourceText(path.join(__dirname, '..', 'handlers', 'pty.handler.ts'));
  const daemon = readSourceText(path.join(srcRoot, 'daemon', 'index.ts'));

  it('the deferred reconnect answer carries the session binding', () => {
    const start = handler.indexOf('const held = (');
    const region = handler.slice(start, start + 1200);
    // heldReconnectAnswer carries it (behaviour-tested in shared).
    expect(region).toMatch(/return heldReconnectAnswer\(listed\);/);
  });

  it('a cap-skipped suspended entry carries its binding only while its transcript lives', () => {
    const start = daemon.indexOf('const suspendedEntries = persistedState.sessions');
    const region = daemon.slice(start, start + 1400);
    expect(region).toMatch(/isUsableResumeBinding\(s\.resumeBinding\) && bindingTranscriptLives\(s\.resumeBinding\)/);
  });
});
