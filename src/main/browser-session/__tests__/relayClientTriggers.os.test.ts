// When main ends relay clients: each trigger, against a real relay serving a
// fake Chrome, with the real event source behind it where main has one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CdpPipeMux, type CallerIdentity } from '../CdpPipeMux';
import { CdpPipeRelay, type RelayGrant, type RelayRoute } from '../CdpPipeRelay';
import { BrowserPolicyStore } from '../BrowserPolicyStore';
import { wireRelayClientTriggers, type RelayClientTriggers } from '../relayClientTriggers';
import { FakeBrowser } from './fakePipeBrowser';
import { WorkspaceMirror } from '../../workspace/WorkspaceMirror';
import type { WorkspaceListEntry } from '../../../shared/workspaceMirror';
import type { ChromePaneBindings } from '../../../shared/chromePaneBinding';
import {
  __resetWorkspaceClaimTrustForTesting,
  claimTokenForPane,
  onPaneClaimChange,
  revokeWorkspaceClaimTokensFor,
} from '../../workspace/workspaceClaimTrust';

const posix = process.platform !== 'win32';
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  __resetWorkspaceClaimTrustForTesting();
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(posix ? '/tmp' : os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Rig {
  route: RelayRoute;
  triggers: RelayClientTriggers;
  mirror: WorkspaceMirror;
  store: BrowserPolicyStore;
  bindings: ChromePaneBindings;
  surfaces: Map<string, string>;
}

function rig(): Rig {
  const relay = new CdpPipeRelay({ roots: posix ? [tempDir('wmux-rt-')] : [] });
  const browser = new FakeBrowser();
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux);
  const route = relay.serve(mux);
  const mirror = new WorkspaceMirror();
  const store = new BrowserPolicyStore(tempDir('wmux-rt-policy-'));
  const bindings: ChromePaneBindings = {};
  const surfaces = new Map<string, string>();
  const triggers = wireRelayClientTriggers({
    closeClients: (match, reason) => relay.closeClients(match, reason),
    policy: store,
    paneBindings: () => bindings,
    mirror,
    surfaceWorkspace: (surfaceId) => surfaces.get(surfaceId),
    onPaneClaimChange,
  });
  cleanup.push(async () => {
    triggers.dispose();
    await relay.close();
    mux.close();
  });
  return { route, triggers, mirror, store, bindings, surfaces };
}

function dial(grant: RelayGrant): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(grant.endpoint, { headers: { ...grant.headers } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

/** A connected client, with whether it has been closed. */
async function client(route: RelayRoute, identity: CallerIdentity): Promise<{ ws: WebSocket; closed: () => boolean; gone: Promise<void> }> {
  const ws = await dial(await route.grant(identity));
  cleanup.push(() => ws.terminate());
  let isClosed = false;
  const gone = new Promise<void>((resolve) => ws.once('close', () => { isClosed = true; resolve(); }));
  return { ws, closed: () => isClosed, gone };
}

/** Whether `ws` still drives its Chrome: an answered command, not just an open socket. */
function answers(ws: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as { id?: number; result?: unknown };
      if (frame.id !== id) return;
      ws.off('message', onMessage);
      resolve(frame.result !== undefined);
    };
    ws.on('message', onMessage);
    ws.once('close', () => resolve(false));
    ws.send(JSON.stringify({ id, method: 'Test.ping' }));
  });
}

function push(mirror: WorkspaceMirror, entries: WorkspaceListEntry[]): void {
  mirror.setSnapshot({ ts: 0, entries, fleets: [] });
}

const hosts = (allow: string[]) => ({ mode: 'allowlist' as const, allow, block: [] });

describe('relay client triggers', () => {
  it('(a) a policy epoch move ends, on every lane, the clients whose epoch is not their profile\'s current one', async () => {
    const { route, store, bindings } = rig();
    bindings['pane-a'] = { workspaceId: 'ws-1', profile: 'pa' };
    // Minted while the profile was not protected yet: it carries no epoch.
    const before = await client(route, { lane: 'operator', workspaceId: 'ws-1', profile: 'pa' });
    const unprotected = await client(route, { lane: 'engine', workspaceId: 'ws-1', profile: 'other' });

    const first = await store.write({ workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', protected: true, hosts: hosts(['a.test']), expectedEpoch: 0 }, 'pa', true);
    await before.gone;
    const current = await client(route, { lane: 'engine', workspaceId: 'ws-1', profile: 'pa', protectedEpoch: first });
    const script = await client(route, { lane: 'pane-script', workspaceId: 'ws-1', profile: 'pa', protectedEpoch: first, ptyId: 'pty-a' });
    expect(await answers(current.ws)).toBe(true);

    await store.write({ workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', protected: true, hosts: hosts(['b.test']), expectedEpoch: first }, 'pa', true);
    await Promise.all([current.gone, script.gone]);
    // A profile that is not protected keeps its clients through every move.
    expect(unprotected.closed()).toBe(false);
    expect(await answers(unprotected.ws)).toBe(true);
  });

  it('(b) a pane that closes or moves to another workspace ends its pane-script clients only', async () => {
    const { route, mirror } = rig();
    push(mirror, [
      { id: 'ws-1', name: 'one', ptyIds: ['pty-1', 'pty-2', 'pty-3'] },
      { id: 'ws-2', name: 'two', ptyIds: ['pty-4'] },
    ]);
    const closing = await client(route, { lane: 'pane-script', workspaceId: 'ws-1', ptyId: 'pty-1' });
    const moving = await client(route, { lane: 'pane-script', workspaceId: 'ws-1', ptyId: 'pty-2' });
    const staying = await client(route, { lane: 'pane-script', workspaceId: 'ws-1', ptyId: 'pty-3' });
    const engine = await client(route, { lane: 'engine', workspaceId: 'ws-1', ptyId: 'pty-1' });

    push(mirror, [
      { id: 'ws-1', name: 'one', ptyIds: ['pty-3'] },
      // A pane the earlier push did not show is new, not moved.
      { id: 'ws-2', name: 'two', ptyIds: ['pty-4', 'pty-2', 'pty-9'] },
    ]);
    await Promise.all([closing.gone, moving.gone]);
    expect(await answers(staying.ws)).toBe(true);
    expect(await answers(engine.ws)).toBe(true);
  });

  it('(c) a workspace that closes ends every client of that workspace, on every lane', async () => {
    const { route, mirror } = rig();
    push(mirror, [{ id: 'ws-1', name: 'one', ptyIds: ['pty-1'] }, { id: 'ws-2', name: 'two', ptyIds: ['pty-2'] }]);
    const gone = await Promise.all([
      client(route, { lane: 'engine', workspaceId: 'ws-1' }),
      client(route, { lane: 'operator', workspaceId: 'ws-1', everyTarget: true }),
      client(route, { lane: 'pane-script', workspaceId: 'ws-1', ptyId: 'pty-x' }),
    ]);
    const other = await client(route, { lane: 'engine', workspaceId: 'ws-2' });

    push(mirror, [{ id: 'ws-2', name: 'two', ptyIds: ['pty-2'] }]);
    await Promise.all(gone.map((c) => c.gone));
    expect(await answers(other.ws)).toBe(true);
  });

  it('(d) a user hold on a surface ends the pane-script clients of its workspace, or of every workspace when its workspace is unknown', async () => {
    const { route, triggers, surfaces } = rig();
    surfaces.set('surface-1', 'ws-1');
    const held = await client(route, { lane: 'pane-script', workspaceId: 'ws-1', ptyId: 'pty-1' });
    const elsewhere = await client(route, { lane: 'pane-script', workspaceId: 'ws-2', ptyId: 'pty-2' });
    const engine = await client(route, { lane: 'engine', workspaceId: 'ws-1' });

    triggers.userHold('surface-1');
    await held.gone;
    expect(await answers(elsewhere.ws)).toBe(true);
    expect(await answers(engine.ws)).toBe(true);

    triggers.userHold('surface-unknown');
    await elsewhere.gone;
    expect(await answers(engine.ws)).toBe(true);
  });

  it('(e) a pane claim that is revoked or re-issued ends that pane\'s pane-script clients; a repeat walk keeps them', async () => {
    const { route } = rig();
    const token = claimTokenForPane('ws-1', 'pty-1');
    claimTokenForPane('ws-2', 'pty-2');
    const revoked = await client(route, { lane: 'pane-script', workspaceId: 'ws-1', ptyId: 'pty-1' });
    const moved = await client(route, { lane: 'pane-script', workspaceId: 'ws-2', ptyId: 'pty-2' });
    const engine = await client(route, { lane: 'engine', workspaceId: 'ws-1', ptyId: 'pty-1' });

    // The same pane walked again in the same workspace keeps its token.
    expect(claimTokenForPane('ws-1', 'pty-1')).toBe(token);
    expect(await answers(revoked.ws)).toBe(true);

    revokeWorkspaceClaimTokensFor('ws-1');
    await revoked.gone;
    // The pane now in another workspace: its claim is issued anew.
    claimTokenForPane('ws-3', 'pty-2');
    await moved.gone;
    expect(await answers(engine.ws)).toBe(true);
  });
});
