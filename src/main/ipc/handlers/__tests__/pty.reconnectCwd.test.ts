import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-level regression lock (owner-reported 2026-07-19):
 *
 * After an app restart, reconnecting to the daemon's persistent session
 * (PTY_RECONNECT) shows only the name in the workspace sidebar — no branch/port/PR.
 * Cause: the metadata poll only handles panes present in cwdMap, and
 * buildMetadataPayload returns null immediately without a cwd, so the entire context
 * line disappears when there's no cwd. The create path seeds cwd, but reconnect threw
 * away the cwd the daemon included in the listSessions response. After-the-fact prompt
 * scraping only catches PowerShell/bash prompts, not macOS's default zsh ("works on
 * win but not mac"), so reconnect must seed it.
 *
 * The reconnect handler is deeply coupled to daemonClient RPC, so unit isolation is
 * hard (mocking it all is fragile). Like the imeCopyPaste / macCtrlPassthrough locks,
 * we pin it at the source level.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'),
  'utf8',
);

// Slice out only the PTY_RECONNECT handler body (so it doesn't mix with the create path's updateCwd).
const reconnectStart = SRC.indexOf('IPC.PTY_RECONNECT, wrapHandler');
const RECONNECT = reconnectStart > -1 ? SRC.slice(reconnectStart) : '';

describe('PTY_RECONNECT seeds cwd (source-level lock)', () => {
  it('locates the reconnect handler', () => {
    expect(reconnectStart).toBeGreaterThan(-1);
  });

  it('the listSessions response type includes cwd', () => {
    expect(RECONNECT).toMatch(/cwd\?: string/);
  });

  it('calls updateCwd with the session cwd on reconnect', () => {
    expect(RECONNECT).toMatch(/if \(session\.cwd\) updateCwd\(id, session\.cwd\)/);
  });
});

describe('PTY_RECONNECT carries dead-session recovery metadata (#650)', () => {
  it('reads spawnCwd and guarded resume metadata from listSessions', () => {
    expect(RECONNECT).toMatch(/spawnCwd\?: string/);
    expect(RECONNECT).toMatch(/resumeBinding\?: ResumeBinding/);
  });

  it('returns a recovery descriptor only when the dead record still exists', () => {
    expect(RECONNECT).toMatch(/session \? \{ recovery: createDeadPaneRecovery\(session\) \} : \{\}/);
  });
});

describe('PTY_RECONNECT reports the session geometry (#1847)', () => {
  it('returns the stored cols/rows so a hidden pane can adopt them', () => {
    expect(RECONNECT).toMatch(/cols\?: number;\s+rows\?: number;/);
    expect(RECONNECT).toMatch(/return \{ success: true, id: session\.id, shell: session\.cmd, cols: session\.cols, rows: session\.rows[,} ]/);
  });
});

/**
 * Source-level regression lock (dogfood 2026-07-22, 30-session scaling branch):
 *
 * A recovered pane sat BLANK until it was clicked. Root cause: attachSession
 * makes the daemon replay the session's historical RingBuffer (the only paint
 * an idle recovered shell gets — no new output is coming), but the reconnect
 * handler registered the session:data forwarder AFTER attach+connect. Under
 * boot load (many sessions recovering, busy event loop) DaemonClient could
 * read+emit that replay before a handler existed, dropping it; the pane then
 * stayed blank until a focus/reveal forced a resync.
 *
 * Fix: register setSessionDataListener BEFORE daemon.attachSession so no replay
 * byte can arrive without a handler. This lock pins that ordering — the handler
 * is deeply coupled to daemonClient RPC (electron import), so like the cwd lock
 * above we assert it at the source level.
 */
describe('PTY_RECONNECT registers session:data before attachSession (source-level lock)', () => {
  // The attach itself lives in reconnectSessionPipe.ts; the handler hands it
  // the listener install.
  const PIPE = readFileSync(
    path.resolve(process.cwd(), 'src/main/ipc/handlers/reconnectSessionPipe.ts'),
    'utf8',
  );
  const installIdx = PIPE.indexOf('opts.installListener()');
  const attachIdx = PIPE.indexOf("daemon.attachSession', { id");

  it('the handler installs its session:data handler through the pipe step', () => {
    expect(RECONNECT).toMatch(/installListener: \(\) => setSessionDataListener\(id, onSessionData\)/);
  });

  it('calls attachSession in the reconnect pipe step', () => {
    expect(attachIdx).toBeGreaterThan(-1);
  });

  it('installs the handler BEFORE attachSession (closes the replay-drop window)', () => {
    expect(installIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(attachIdx);
  });

  it('installs the handler once per path (no duplicate)', () => {
    const matches = RECONNECT.match(/setSessionDataListener\(id, onSessionData\)/g) ?? [];
    expect(matches.length).toBe(1);
    // One install on the attach path, one where the create-time pipe is kept.
    expect(PIPE.match(/opts\.installListener\(\)/g)?.length).toBe(2);
    const keepAt = PIPE.indexOf('async function keepCreatePipe');
    expect(PIPE.indexOf('opts.installListener()', keepAt)).toBeGreaterThan(keepAt);
  });
});

/**
 * #2398 — a cap-skipped native session lives only in the daemon's persisted
 * state. pty:reconnect listed sessions without includeSuspended, so such a
 * pane read as absent → `session-dead` → the renderer cleared its id and
 * self-created a blank shell over it (its scrollback and binding lost). Listed
 * with includeSuspended it takes the promote branch instead. includeSuspended
 * makes the daemon read and parse sessions.json on its thread, so it is asked
 * only for an id the live list lacks. Source lock: the handler is a closure
 * inside registerPTYHandlers.
 */
describe('PTY_RECONNECT promotes a cap-skipped session instead of declaring it dead (#2398)', () => {
  it('lists live sessions first, and suspended ones only for an id the live list lacks', () => {
    expect(RECONNECT).toMatch(/let sessions = await daemonClient\.rpc\('daemon\.listSessions', \{\}\)/);
    expect(RECONNECT).toMatch(/if \(!sessions\.some\(s => s\.id === id\)\) \{\s*sessions = await daemonClient\.rpc\('daemon\.listSessions', \{ includeSuspended: true \}\)/);
  });

  it('a suspended entry goes down the promote branch, before any attach', () => {
    const suspendedAt = RECONNECT.indexOf("if (session.state === 'suspended')");
    const promoteAt = RECONNECT.indexOf("daemonClient.rpc('daemon.promoteSession', { id", suspendedAt);
    const attachAt = RECONNECT.indexOf('await reconnectSessionPipe(daemonClient, id');
    expect(suspendedAt).toBeGreaterThan(-1);
    expect(promoteAt).toBeGreaterThan(suspendedAt);
    expect(attachAt).toBeGreaterThan(promoteAt);
  });

  it('the daemon’s suspended entries carry `cmd`, which the reconnect records and returns', () => {
    const daemon = readFileSync(path.resolve(process.cwd(), 'src/daemon/index.ts'), 'utf8');
    const at = daemon.indexOf('if (includeSuspended) {');
    const mapper = daemon.slice(at, daemon.indexOf('return reply(', at));
    expect(mapper).toMatch(/\.map\(\(s\) => suspendedListEntry\(s,/);
    const entry = readFileSync(path.resolve(process.cwd(), 'src/daemon/suspendedListEntry.ts'), 'utf8');
    expect(entry).toMatch(/cmd: s\.cmd,[\s\S]*?state: 'suspended' as const,/);
    expect(RECONNECT).toMatch(/recordPtyShell\(session\.id, session\.cmd\)/);
  });
});

/**
 * A Terminal adopting a pane main created keeps the create-time session pipe
 * (reconnectSessionPipe.ts, behavior tested in reconnectSessionPipe.test.ts).
 * The mark that allows it is set by the daemon create, consumed by the first
 * reconnect, and dropped on death, supervised restart and dispose, so a
 * reconnect that must attach the daemon's new pipe never keeps an old socket.
 */
describe('PTY_RECONNECT keeps only a pipe the create attached (source-level lock)', () => {
  it('the daemon create marks the session once its listener is on the pipe', () => {
    expect(SRC).toMatch(/setSessionDataListener\(sessionId, onSessionData\);\s*createAttachedPipes\.add\(sessionId\);/);
  });

  it('the reconnect consumes the mark and hands it to the pipe step', () => {
    expect(RECONNECT).toMatch(/const ownsCreatePipe = createAttachedPipes\.delete\(id\);\s*const pipe = await reconnectSessionPipe\(daemonClient, id, \{[\s\S]*?ownsCreatePipe,/);
  });

  it('death, supervised restart and dispose drop the mark and the first-output hook', () => {
    expect(SRC).toMatch(/function forgetCreateState\(sessionId: string\): void \{\s*createAttachedPipes\.delete\(sessionId\);\s*firstOutputHooks\.delete\(sessionId\);/);
    expect(SRC).toMatch(/disconnectSessionPipe\(payload\.sessionId\)\.catch\(\(\) => \{\}\);\s*forgetCreateState\(payload\.sessionId\);/);
    expect(SRC).toMatch(/onDaemonSessionRestarted = \(payload\) => \{[\s\S]{0,500}?forgetCreateState\(payload\.sessionId\);/);
    expect(SRC).toMatch(/await daemonClient\.disconnectSessionPipe\(id\);\s*forgetCreateState\(id\);/);
  });

  it('the startup line hears the shell first speak through whichever listener the session has', () => {
    expect(SRC).toMatch(/firstOutputHooks\.set\(sessionId, initialCmd\.onFirstData\);/);
    expect(SRC).toMatch(/if \(payload\.sessionId !== sessionId\) return;\s*noteFirstOutput\(sessionId\);/);
    // A reconnect's listener counts live bytes only: a re-flush replay opens
    // with its own terminal reset, which is not the shell speaking.
    expect(RECONNECT).toMatch(/if \(payload\.sessionId !== id\) return;[\s\S]{0,400}?if \(!payload\.replay\) noteFirstOutput\(id\);/);
    // The create listener no longer calls the startup line directly.
    expect(SRC).not.toMatch(/return;\s*initialCmd\.onFirstData\(\);/);
  });

  it('pty:resync and the reconnect share one re-flush per session', () => {
    expect(RECONNECT).toMatch(/resync: resyncOf\(daemonClient\),/);
    expect(RECONNECT).toMatch(/return await resyncOf\(daemonClient\)\(id, scrollback\);/);
    // Only the shared helper calls the daemon's re-flush.
    expect(SRC).not.toMatch(/rpc\('daemon\.resyncSession'/);
    // A flush complete ends the episode for joiners.
    expect(SRC).toMatch(/onDaemonFlushComplete = \(payload[^\n]*\n[\s\S]{0,300}?sessionResync\?\.flushCompleted\(payload\.sessionId\);/);
  });
});
