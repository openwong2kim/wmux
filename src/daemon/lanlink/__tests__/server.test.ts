import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LanLinkServer } from '../server';
import { pairWithPeer, sendToPeer } from '../client';
import { PeerStore } from '../peers';
import { FrameReader, encodeFrame, type FrameType } from '../wire';
import { ReconnectInitiator } from '../pairing';
import { AeadSealer, AeadOpener } from '../aead';
import type { InboxRecord } from '../../../shared/lanlink';

// ── in-memory cross-wired socket pair ─────────────────────────────────────────
class FakeSocket extends EventEmitter {
  destroyed = false;
  remoteAddress = '192.168.1.50';
  peer: FakeSocket | null = null;
  write(buf: Buffer): boolean {
    const copy = Buffer.from(buf);
    if (this.peer && !this.peer.destroyed) {
      const p = this.peer;
      setImmediate(() => {
        if (!p.destroyed) p.emit('data', copy);
      });
    }
    return true;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
    if (this.peer && !this.peer.destroyed) this.peer.destroy();
  }
  setTimeout(): void {
    /* no-op */
  }
  setEncoding(): void {
    /* no-op */
  }
  setNoDelay(): void {
    /* no-op */
  }
}
function pair(): [FakeSocket, FakeSocket] {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

const MOCK_IFACES = () => ({
  eth0: [
    {
      address: '192.168.1.10',
      family: 'IPv4',
      internal: false,
      mac: 'aa:bb:cc:dd:ee:ff',
      netmask: '255.255.255.0',
      cidr: '192.168.1.10/24',
      scopeid: 0,
    },
  ],
}) as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

const NIC = { name: 'eth0', mac: 'aa:bb:cc:dd:ee:ff' };

function mockController(enabled: boolean) {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    getStatus: () => ({ enabled, nic: NIC, port: null, nics: [] }),
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmpRoot: string;
function mkPeers(): PeerStore {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'peers-'));
  // Skip the slow win32 PowerShell owner-DACL shell-out so the handshake tests
  // stay well under the default test timeout even under full-suite parallelism.
  return new PeerStore(dir, { reHarden: () => true, secureWrite: (p, d) => fs.writeFileSync(p, d) });
}

interface Harness {
  server: LanLinkServer;
  onConn: (s: FakeSocket) => void;
  serverPeers: PeerStore;
  appended: Omit<InboxRecord, 'seq'>[];
  nudges: number[];
}

async function makeServer(): Promise<Harness> {
  const serverPeers = mkPeers();
  const appended: Omit<InboxRecord, 'seq'>[] = [];
  const nudges: number[] = [];
  let seq = 0;
  let onConn: ((s: FakeSocket) => void) | null = null;
  const fakeNetServer = {
    on() {
      /* no-op */
    },
    listen() {
      /* no-op */
    },
    close(cb?: () => void) {
      cb?.();
    },
  };
  const server = new LanLinkServer({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inbox: { append: (rec: Omit<InboxRecord, 'seq'>) => { appended.push(rec); return { seq: ++seq }; } } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller: mockController(true) as any,
    nudge: (s: number) => nudges.push(s),
    peers: serverPeers,
    selfName: 'A-host',
    ifaces: MOCK_IFACES,
    netCategory: () => 'Private',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createServer: (cb: (s: any) => void) => { onConn = cb as (s: FakeSocket) => void; return fakeNetServer as any; },
    firewall: {
      apply: async () => {
        /* no-op */
      },
      remove: async () => {
        /* no-op */
      },
    },
  });
  await delay(30); // let the reconcile chain create the server + capture onConn
  return { server, onConn: (s) => onConn!(s), serverPeers, appended, nudges };
}

/** Drive a happy-path pairing from a fresh client against the armed server. */
async function doPair(h: Harness, clientPeers: PeerStore, pin: string) {
  const [clientSock, serverSock] = pair();
  h.onConn(serverSock);
  return pairWithPeer({ host: 'x', port: 1, pin, selfName: 'B-joiner', peers: clientPeers, connect: () => clientSock });
}

// minimal client-side frame collector for crafting hostile records
class Collector {
  private reader = new FrameReader();
  private q: { type: FrameType; body: Buffer }[] = [];
  private waiter: ((f: { type: FrameType; body: Buffer }) => void) | null = null;
  constructor(sock: FakeSocket) {
    sock.on('data', (c: Buffer) => {
      this.reader.push(c);
      let f;
      while ((f = this.reader.next()) !== null) {
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w(f);
        } else this.q.push(f);
      }
    });
  }
  next(): Promise<{ type: FrameType; body: Buffer }> {
    const queued = this.q.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((res) => (this.waiter = res));
  }
}

/** Reconnect manually and return a sealer/opener so a test can craft any record. */
async function openAeadChannel(h: Harness, peerUuid: string, secret: Buffer) {
  const [clientSock, serverSock] = pair();
  h.onConn(serverSock);
  const col = new Collector(clientSock);
  const recon = new ReconnectInitiator(peerUuid, secret);
  clientSock.write(encodeFrame(0x04, recon.hello()));
  const r2 = await col.next();
  const keys = recon.onReconnect2(r2.body);
  return {
    sealer: new AeadSealer(keys.c2sKey, 1),
    opener: new AeadOpener(keys.s2cKey, 2),
    sendRaw: (obj: unknown) => clientSock.write(encodeFrame(0x10, new AeadSealer(keys.c2sKey, 1).seal(Buffer.from(JSON.stringify(obj))))),
    clientSock,
    col,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lanlink-srv-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('LanLinkServer — inbound responder state machine', () => {
  it('pairs and both sides agree on the peer; secrets match', async () => {
    const h = await makeServer();
    h.server.enterPairingMode('123456');
    const clientPeers = mkPeers();
    const result = await doPair(h, clientPeers, '123456');
    const onServer = h.serverPeers.get(result.peerUuid);
    expect(onServer).not.toBeNull();
    expect(h.serverPeers.secretOf(result.peerUuid)!.equals(result.longTermSecret)).toBe(true);
    h.server.dispose();
  });

  it('delivers a message into the durable inbox as origin:remote, sanitized, with a deterministic id + nudge', async () => {
    const h = await makeServer();
    h.server.enterPairingMode('123456');
    const clientPeers = mkPeers();
    const result = await doPair(h, clientPeers, '123456');
    await sendToPeer({ host: 'x', port: 1, peerUuid: result.peerUuid, peers: clientPeers, selfName: 'B', text: 'hi\x1b[31m there', connect: () => { const [c, s] = pair(); h.onConn(s); return c; } });
    expect(h.appended.length).toBe(1);
    const rec = h.appended[0];
    expect(rec.origin).toBe('remote');
    expect(rec.text).toBe('hi[31m there'); // ESC stripped, CSI body remains as text
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.nudges.length).toBe(1);
    h.server.dispose();
  });

  it('REJECTS an execute-kind app message — never appended, peer burn-bounded (C1/router)', async () => {
    const h = await makeServer();
    h.server.enterPairingMode('123456');
    const clientPeers = mkPeers();
    const result = await doPair(h, clientPeers, '123456');
    const ch = await openAeadChannel(h, result.peerUuid, clientPeers.secretOf(result.peerUuid)!);
    ch.sendRaw({ kind: 'a2a.task.send', peerName: 'B', text: 'rm -rf', senderSeq: 1, execute: true });
    await delay(40);
    expect(h.appended.length).toBe(0); // never reaches the inbox
    h.server.dispose();
  });

  it('REJECTS a file/data part (text-only subset) — never appended', async () => {
    const h = await makeServer();
    h.server.enterPairingMode('123456');
    const clientPeers = mkPeers();
    const result = await doPair(h, clientPeers, '123456');
    const ch = await openAeadChannel(h, result.peerUuid, clientPeers.secretOf(result.peerUuid)!);
    ch.sendRaw({ kind: 'msg.text', peerName: 'B', text: 'x', senderSeq: 1, file: { bytes: 'AAAA' } });
    await delay(40);
    expect(h.appended.length).toBe(0);
    h.server.dispose();
  });

  it('drops a cross-connection replay (senderSeq <= highWater) — no duplicate inbox row (C8)', async () => {
    const h = await makeServer();
    h.server.enterPairingMode('123456');
    const clientPeers = mkPeers();
    const result = await doPair(h, clientPeers, '123456');
    const secret = clientPeers.secretOf(result.peerUuid)!;
    const ch1 = await openAeadChannel(h, result.peerUuid, secret);
    ch1.sendRaw({ kind: 'msg.text', peerName: 'B', text: 'first', senderSeq: 1 });
    await delay(40);
    expect(h.appended.length).toBe(1);
    // fresh connection, SAME senderSeq → dropped
    const ch2 = await openAeadChannel(h, result.peerUuid, secret);
    ch2.sendRaw({ kind: 'msg.text', peerName: 'B', text: 'replay', senderSeq: 1 });
    await delay(40);
    expect(h.appended.length).toBe(1); // still 1
    h.server.dispose();
  });

  it('a first frame of 0x10 (no handshake) is destroyed before any inbox touch (G7)', async () => {
    const h = await makeServer();
    const [clientSock, serverSock] = pair();
    h.onConn(serverSock);
    clientSock.write(encodeFrame(0x10, Buffer.alloc(40)));
    await delay(40);
    expect(h.appended.length).toBe(0);
    expect(serverSock.destroyed).toBe(true);
    h.server.dispose();
  });

  it('revoke destroys the live connection and refuses the next reconnect (C13)', async () => {
    const h = await makeServer();
    h.server.enterPairingMode('123456');
    const clientPeers = mkPeers();
    const result = await doPair(h, clientPeers, '123456');
    const secret = clientPeers.secretOf(result.peerUuid)!;
    h.server.revokePeer(result.peerUuid);
    // a reconnect with the (now revoked) peerUuid is refused before any AEAD
    const [clientSock, serverSock] = pair();
    h.onConn(serverSock);
    const recon = new ReconnectInitiator(result.peerUuid, secret);
    clientSock.write(encodeFrame(0x04, recon.hello()));
    await delay(40);
    expect(serverSock.destroyed).toBe(true);
    h.server.dispose();
  });

  it('wrong PIN fails the join and increments the window fail count', async () => {
    const h = await makeServer();
    h.server.enterPairingMode('123456');
    const clientPeers = mkPeers();
    await expect(doPair(h, clientPeers, '000000')).rejects.toThrow();
    expect(h.server.pairingStatus().failCount).toBe(1);
    h.server.dispose();
  });

  it('a closed pairing window destroys a PAKE_HELLO before scrypt (no pairing)', async () => {
    const h = await makeServer();
    // window NOT armed
    const clientPeers = mkPeers();
    await expect(doPair(h, clientPeers, '123456')).rejects.toThrow();
    expect(h.serverPeers.list().length).toBe(0);
    h.server.dispose();
  });
});
