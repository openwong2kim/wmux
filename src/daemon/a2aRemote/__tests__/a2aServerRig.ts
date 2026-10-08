// Shared rig for the A2A listener tests: one wmux "PC" = a temp data dir, a
// controller, a peer store, a remote-host store and an A2aServer on loopback.
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DaemonConfig } from '../../types';
import { A2aRemoteController } from '../controller';
import { PeerStore } from '../peerStore';
import { RemoteHostStore } from '../remoteHostStore';
import { A2aServer, type A2aServerDeps } from '../server';

export interface Pc {
  dir: string;
  config: DaemonConfig;
  controller: A2aRemoteController;
  peers: PeerStore;
  remoteHosts: RemoteHostStore;
  server: A2aServer;
  /** hostIds the listener ran its revoke cascade for. */
  cascaded: string[];
}

const made: Pc[] = [];

export async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/**
 * `name` deliberately fails the invite host grammar (a space), so invites fall
 * back to the loopback IPv4 — a CI runner's own host name may not resolve.
 */
export async function makePc(
  name: string,
  opts: { enabled?: boolean; port?: number; deps?: Partial<A2aServerDeps> } = {},
): Promise<Pc> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-pc-'));
  const port = opts.port ?? (await freePort());
  const config = { a2aRemote: { enabled: opts.enabled ?? true, port } } as unknown as DaemonConfig;
  const controller = new A2aRemoteController({ config, persist: () => undefined });
  const a2aDir = path.join(dir, 'a2a');
  const peers = new PeerStore({ dir: a2aDir, scheduleHarden: () => undefined });
  const remoteHosts = new RemoteHostStore({ dir: a2aDir });
  const cascaded: string[] = [];
  const server = new A2aServer({
    controller,
    identityDir: a2aDir,
    peers,
    onPeerRevoked: (hostId) => cascaded.push(hostId),
    hostname: () => name,
    ipv4s: () => ['127.0.0.1'],
    bindHost: '127.0.0.1',
    log: () => undefined,
    ...opts.deps,
  });
  await server.whenIdle();
  const pc = { dir, config, controller, peers, remoteHosts, server, cascaded };
  made.push(pc);
  return pc;
}

export async function disposeAll(): Promise<void> {
  for (const pc of made.splice(0)) {
    pc.server.dispose();
    await pc.server.whenIdle();
    fs.rmSync(pc.dir, { recursive: true, force: true });
  }
}

export interface RawAnswer {
  status: number;
  json: Record<string, unknown> | null;
}

/** Unpinned HTTPS request for probing the listener's edges. */
export function raw(
  port: number,
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: opts.headers, rejectUnauthorized: false, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

export function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => resolve(true));
  });
}
