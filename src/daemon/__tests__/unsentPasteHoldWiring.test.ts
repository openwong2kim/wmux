// Wiring guard for #3393's unsent-paste hold (unsentPasteHold.ts).
//
// Source-shape assertions, following paneDeliveryLockWiring.test.ts: the
// writers, the RPC and the tracker's listener live inside registerRpcHandlers
// and startDaemon, which cannot be constructed in a unit test. The hold's
// behaviour is covered in unsentPasteHold.test.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isAppOnlyDaemonMethod } from '../../shared/daemonFirstParty';

describe('unsent-paste hold daemon wiring', () => {
  // A Windows checkout has CRLF line ends (core.autocrlf): the line matches below need LF.
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8').replace(/\r\n/g, '\n');

  function block(start: string, length = 2_000): string {
    const at = src.indexOf(start);
    if (at < 0) throw new Error(`not found: ${start}`);
    return src.slice(at, at + length);
  }

  function listenerBody(): string {
    const lines = src.split('\n');
    const startIdx = lines.findIndex((l) => l.includes('agentProcessTracker.setStateChangeListener('));
    const endIdx = lines.findIndex((l, i) => i > startIdx && l === '  });');
    return lines.slice(startIdx, endIdx).join('\n');
  }

  it("the tracker's edges reach the hold with one call, and the listener broadcasts what it did before", () => {
    const body = listenerBody();
    expect(body.match(/unsentPasteHolds\?\.agentState\(sessionId, state\.alive\);/g)).toHaveLength(1);
    expect(body.match(/unsentPasteHolds/g)).toHaveLength(1);
    // The one broadcast, unchanged: the death edge's agent.processExit.
    expect(body.match(/broadcast\(/g)).toHaveLength(1);
    expect(body).toMatch(/const exitEvent = agentProcessExitEvent\(sessionId, state\);\s*if \(exitEvent\) pipeServer\.broadcast\(exitEvent\);/);
  });

  it('keys the daemon types into a dialog over the box pass over a hold instead of clearing it', () => {
    // Stepwise keys (approvals, prompts, the headless answer's digit).
    expect(block('function writeStepKeyOf(', 400)).toContain("passedOverByDialogKey(sessionId, revision, 'a dialog key');");
    // An approval's answer, and the usage-limit menu's Esc.
    expect(src).toContain("passedOverByDialogKey(sessionId, managed.bridge.getKeyInputRevision(), 'an approval answer');");
    expect(src).toContain("passedOverByDialogKey(sessionId, managed.bridge.noteInput('\\x1b', { selfWrite: true }), 'the usage-limit menu key');");
  });

  it('a session ending clears its hold', () => {
    expect(src).toContain("sessionManager.on('session:died', (payload: { id: string }) => unsentPasteHolds?.sessionEnded(payload.id));");
    expect(src).toContain("sessionManager.on('session:destroyed', (payload: { id: string }) => unsentPasteHolds?.sessionEnded(payload.id));");
  });

  it("main's report is first-party only, in the lock methods' budget, and taken only while main holds the pane", () => {
    const rpc = block("pipeServer.onRpc('daemon.session.unsentPasteV1'", 700);
    expect(rpc).toContain("firstPartyOnly(ctx.clientId, 'daemon.session.unsentPasteV1')");
    expect(rpc.indexOf('paneLocks.holds(id, token, ctx.clientId)')).toBeLessThan(rpc.indexOf('unsentPasteHolds?.record('));
    expect(isAppOnlyDaemonMethod('daemon.session.unsentPasteV1')).toBe(true);
  });

  it('the agent state read carries the hold, its clears applied', () => {
    expect(block('function agentStateFor(id: string)', 3_000)).toContain('unsentPasteHeld: unsentPasteHolds?.held(id) === true,');
  });

  it('the funnel runs under the hold, which takes back or records a paste it left unsubmitted, under the pane lock', () => {
    const funnel = block('const deliverPromptToSessionNow = async (', 2_000);
    const locked = funnel.slice(funnel.indexOf('paneLocks.runLocked('));
    expect(locked).toMatch(/^paneLocks\.runLocked\(id, `daemon:\$\{writer\}`, PANE_LOCK_DAEMON_WAIT_MS, \(\) => deliverUnderHold\(\{/);
    expect(locked).toContain('holds: unsentPasteHolds,');
    expect(locked).toContain('text: prompt,');
    expect(locked).toContain('deliver: (onWrite) => deliverPromptToSessionLocked(id, agentSlug, incarnationId, prompt, { ...opts, onWrite }, writer, author, trust),');
    expect(locked).toContain('...(opts.onWrite ? { onWrite: opts.onWrite } : {}),');
    // Its own-text check is the delivery presence at the Enter, the wake nudge's; the erase is one counted Ctrl+U.
    expect(locked).toContain('presence: (check) => deliveryPresence(presenceDeps, id, agentSlug, check),');
    expect(locked).toMatch(/managed\.ptyProcess\.write\('\\x15'\);\s*managed\.bridge\.noteInput\('\\x15'\);/);
  });

  it('the chat sends and the wake nudge consult the hold', () => {
    expect(block("paneLock: (id, send) => paneLocks.runLocked(id, 'hermes-chat'", 300)).toContain('unsentPaste: { held: (id) => unsentPasteHolds?.held(id) === true');
    expect(block("paneLock: (id, send) => paneLocks.runLocked(id, 'native-chat'", 300)).toContain('unsentPaste: { held: (id) => unsentPasteHolds?.held(id) === true');
    expect(block('channelWakeWorkerRef = new ChannelWakeWorker({', 900)).toContain("unsentPaste: { held: (id) => unsentPasteHolds?.heldFor(id, 'channel wake nudge') === true");
  });
});
