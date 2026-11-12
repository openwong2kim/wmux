// Headless mode reads the pipe server's own "the app is here" state, so an
// app that identifies turns it off at that moment, even when its attach
// could not be recorded in the data dir. Wired as daemon/index.ts wires it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonPipeServer } from '../DaemonPipeServer';
import { APP_ATTACHED_FILE, applyAppHostAtBoot, registerClientIdentify } from '../appHostMarker';
import { HeadlessMode, headlessFlagPath } from '../a2aRemote/headlessMode';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-app-'));
  fs.mkdirSync(path.join(dir, 'a2a'));
  fs.writeFileSync(headlessFlagPath(path.join(dir, 'a2a')), 'on\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function wire(dataDir: string, spawnedByApp = false): { server: DaemonPipeServer; mode: HeadlessMode; identify: (role: string, clientId: string) => Promise<unknown> } {
  const server = new DaemonPipeServer(`wmux-headless-app-${process.pid}`);
  applyAppHostAtBoot(server, dataDir, spawnedByApp);
  let handler: ((params: Record<string, unknown>, ctx: { clientId: string }) => Promise<unknown>) | undefined;
  // The real identify, on the real server's state; only its registration is captured to call it here.
  registerClientIdentify({
    onRpc: (_m, h) => { handler = h as typeof handler; },
    markFirstParty: (clientId) => server.markFirstParty(clientId),
  }, dataDir, () => undefined);
  const mode = new HeadlessMode({
    a2aDir: path.join(dir, 'a2a'),
    appHostAtBoot: server.appAttached(),
    appSeen: () => server.appAttached() || fs.existsSync(path.join(dataDir, APP_ATTACHED_FILE)),
  });
  return { server, mode, identify: (role, clientId) => handler!({ role }, { clientId }) };
}

describe('headless mode and the app attaching', () => {
  it('the app identifying while its attach cannot be written turns headless mode off from that moment', async () => {
    // A data dir nothing can be written into: a path below a regular file.
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    const { mode, identify } = wire(path.join(blocker, 'data'));
    expect(mode.active()).toBe(true);
    expect(await identify('main', 'c1')).toEqual({ ok: true });
    expect(fs.existsSync(path.join(blocker, 'data', APP_ATTACHED_FILE))).toBe(false);
    expect(mode.active()).toBe(false);
  });

  it('a caller that does not claim the app role changes nothing', async () => {
    const { mode, identify } = wire(dir);
    expect(await identify('cli', 'c1')).toEqual({ ok: false });
    expect(mode.active()).toBe(true);
  });

  it('a daemon the app launcher started is never headless', () => {
    expect(wire(dir, true).mode.active()).toBe(false);
  });
});
