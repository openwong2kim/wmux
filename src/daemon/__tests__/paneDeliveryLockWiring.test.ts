// Wiring guard for the per-pane delivery lock (paneDeliveryLock.ts).
//
// Source-shape assertions, following agentProcessExitWiring.test.ts: the
// writers and the RPCs live inside registerRpcHandlers, which cannot be
// constructed in a unit test. The lock's behaviour is covered in
// paneDeliveryLock.test.ts and main's deliveryOrder.race.test.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isAppOnlyDaemonMethod } from '../../shared/daemonFirstParty';

describe('pane delivery lock daemon wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  function block(start: string, length = 2_000): string {
    const at = src.indexOf(start);
    if (at < 0) throw new Error(`not found: ${start}`);
    return src.slice(at, at + length);
  }

  it("the daemon's writer funnel holds the lock from before its first look at the pane through its Enter", () => {
    const funnel = block('const deliverPromptToSessionNow = async (', 900);
    expect(funnel).toMatch(/paneLocks\.runLocked\(id, `daemon:\$\{writer\}`, PANE_LOCK_DAEMON_WAIT_MS,\s*\(\) => deliverPromptToSessionLocked\(/);
    expect(funnel).toContain("return result ?? 'busy';");
    // Only the funnel calls the locked body: every writer goes through the lock.
    expect(src.match(/deliverPromptToSessionLocked\(/g)).toHaveLength(1);
  });

  it('the chat writers that send prompts outside the funnel take a sticky hold before each write', () => {
    for (const key of ['chat-v2', 'hermes-chat', 'native-chat']) {
      const at = src.indexOf(`paneLocks.holdSticky(id, '${key}')`);
      expect(at).toBeGreaterThan(0);
      expect(src.slice(at, at + 200)).toMatch(/\) return false;\s*\n\s*(pane|managed)\.ptyProcess\.write\(data\);/);
    }
  });

  it('the Hermes and native-bridge sends hold the pane through their Enter; the wake nudge takes it without waiting', () => {
    expect(src).toContain("paneLock: (id, send) => paneLocks.runLocked(id, 'hermes-chat', PANE_LOCK_DAEMON_WAIT_MS, send),");
    expect(src).toContain("paneLock: (id, send) => paneLocks.runLocked(id, 'native-chat', PANE_LOCK_DAEMON_WAIT_MS, send),");
    expect(block('channelWakeWorkerRef = new ChannelWakeWorker({', 600)).toContain("paneLocks.acquire(id, { key: 'daemon:channel wake' }, 0)");
  });

  it("a hold ends with its client's control pipe and with its session", () => {
    expect(src).toContain('pipeServer.onClientClose((clientId) => paneLocks.releaseClient(clientId));');
    expect(src).toContain("sessionManager.on('session:died', (payload: { id: string }) => paneLocks.dropSession(payload.id));");
    expect(src).toContain("sessionManager.on('session:destroyed', (payload: { id: string }) => paneLocks.dropSession(payload.id));");
  });

  it("main's lock and held-write RPCs are first-party only, and the held write is the shared check-and-write", () => {
    for (const method of ['daemon.session.deliveryLockV1', 'daemon.session.deliveryUnlockV1', 'daemon.session.writeHeldV1']) {
      expect(block(`pipeServer.onRpc('${method}'`, 300)).toContain(`firstPartyOnly(ctx.clientId, '${method}')`);
    }
    expect(block("pipeServer.onRpc('daemon.session.writeHeldV1'", 900)).toContain('return writeUnderLock(paneLocks, id, token, ctx.clientId,');
    // App-only on the pipe too, so main identifies again and retries on a refusal.
    for (const method of ['daemon.session.deliveryLockV1', 'daemon.session.deliveryUnlockV1', 'daemon.session.writeHeldV1']) {
      expect(isAppOnlyDaemonMethod(method)).toBe(true);
    }
  });
});
