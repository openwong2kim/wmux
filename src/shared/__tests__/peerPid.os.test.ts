// The OS's answer for who connected to a unix socket (shared/peerPid.ts),
// read against real sockets and a real child process.
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { peerPidOf, selfCheckPeerPid, type PeerPid } from '../peerPid';

const supported = process.platform === 'darwin' || process.platform === 'linux';

const servers: net.Server[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const s of servers.splice(0)) s.close();
});

/** Listen on a fresh socket and resolve with what peerPidOf reads for the first connection. */
function firstPeer(): { socketPath: string; peer: Promise<PeerPid>; listening: Promise<void> } {
  const socketPath = path.join(os.tmpdir(), `wmux-peer-test-${crypto.randomBytes(4).toString('hex')}.sock`);
  let resolvePeer: (peer: PeerPid) => void = () => undefined;
  const peer = new Promise<PeerPid>((resolve) => { resolvePeer = resolve; });
  const server = net.createServer((socket) => {
    resolvePeer(peerPidOf(socket));
    socket.destroy();
  });
  servers.push(server);
  const listening = new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return { socketPath, peer, listening };
}

describe.runIf(supported)('peerPidOf on a unix socket', () => {
  it('names the process that connected', async () => {
    const { socketPath, peer, listening } = firstPeer();
    await listening;
    const child = spawn(process.execPath, ['-e', `require('net').connect(${JSON.stringify(socketPath)}); setTimeout(() => {}, 5000)`], { stdio: 'ignore' });
    children.push(child);
    const read = await peer;
    expect(read.pid).toBe(child.pid);
    if (process.platform === 'linux') expect(read).toMatchObject({ uid: process.getuid?.() });
  });

  it('names this process when it connects to itself', async () => {
    const { socketPath, peer, listening } = firstPeer();
    await listening;
    const client = net.connect(socketPath);
    client.on('error', () => undefined);
    expect((await peer).pid).toBe(process.pid);
    client.destroy();
  });

  it('has no answer for a socket with no descriptor', () => {
    expect(peerPidOf(new net.Socket())).toEqual({ pid: null, reason: 'no fd' });
  });

  it('passes its startup self-check', async () => {
    expect(await selfCheckPeerPid()).toBe('available');
  });
});

describe.runIf(!supported)('peerPidOf where the platform has no answer yet', () => {
  it('reports the platform as unsupported', async () => {
    expect(peerPidOf(new net.Socket())).toMatchObject({ pid: null, reason: expect.stringMatching(/unsupported platform/) });
    expect(await selfCheckPeerPid()).toMatch(/^unavailable \(unsupported platform/);
  });
});
