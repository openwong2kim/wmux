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
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

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

  it('the funnel records a paste it left unsubmitted, under the pane lock', () => {
    const funnel = block('const deliverPromptToSessionNow = async (', 2_000);
    const locked = funnel.slice(funnel.indexOf('paneLocks.runLocked('));
    expect(locked).toContain("if (stage === 'paste') pasted = true;");
    expect(locked).toContain("if (sent !== 'sent' && pasted) unsentPasteHolds?.record(id, writer);");
  });

  it('the chat sends and the wake nudge consult the hold', () => {
    expect(block("paneLock: (id, send) => paneLocks.runLocked(id, 'hermes-chat'", 300)).toContain('unsentPaste: { held: (id) => unsentPasteHolds?.held(id) === true');
    expect(block("paneLock: (id, send) => paneLocks.runLocked(id, 'native-chat'", 300)).toContain('unsentPaste: { held: (id) => unsentPasteHolds?.held(id) === true');
    expect(block('channelWakeWorkerRef = new ChannelWakeWorker({', 900)).toContain("unsentPaste: { held: (id) => unsentPasteHolds?.heldFor(id, 'channel wake nudge') === true");
  });
});
