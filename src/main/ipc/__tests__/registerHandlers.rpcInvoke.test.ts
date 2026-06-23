// Regression guard: the RPC_INVOKE ipcMain handler must be cleared with
// removeHandler(), NOT removeAllListeners().
//
// Why this matters (the bug this guards against):
//   `ipcMain.handle(channel, fn)` registers a HANDLE handler, which is removed
//   only by `ipcMain.removeHandler(channel)`. `ipcMain.removeAllListeners(channel)`
//   removes `.on()` listeners and is a NO-OP for a handle handler. The original
//   code pre-cleared RPC_INVOKE with removeAllListeners, so the SECOND
//   registerAllHandlers() (fired on every daemon reconnect/respawn) threw
//   "Attempted to register a second handler for 'rpc:invoke'". That throw
//   aborted the connect bootstrap BEFORE it re-wired DaemonNotificationRouter
//   onto the new DaemonClient — silently killing every daemon→main EventBus tee
//   (channel.message live delivery, agent.lifecycle, …) until an app restart.
//
// Source-scan (the file pulls in the full Electron main graph, which the
// node-env vitest can't import), mirroring wrapHandler.rollout.test.ts.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(process.cwd(), 'src/main/ipc/registerHandlers.ts'), 'utf8');

describe('registerHandlers — RPC_INVOKE handler is reconnect-safe', () => {
  it('clears RPC_INVOKE with removeHandler before (re)registering the handle', () => {
    // The register site must removeHandler first so a second registerAllHandlers
    // (daemon reconnect) does not throw "second handler".
    expect(SRC).toMatch(/removeHandler\(IPC\.RPC_INVOKE\)[\s\S]{0,120}handle\(IPC\.RPC_INVOKE/);
  });

  it('never uses removeAllListeners on RPC_INVOKE (no-op for a handle handler)', () => {
    expect(SRC).not.toMatch(/removeAllListeners\(IPC\.RPC_INVOKE\)/);
  });

  it('the cleanup teardown also removes the RPC_INVOKE handle', () => {
    // Two occurrences: the register-site pre-clear + the cleanup teardown.
    const count = (SRC.match(/removeHandler\(IPC\.RPC_INVOKE\)/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
