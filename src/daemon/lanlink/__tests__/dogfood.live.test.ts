// LIVE 1-machine real-net dogfood (gated on LANLINK_DOGFOOD_IP so CI skips it).
// Runs a REAL net.Server bound to a REAL LAN IPv4 (C2 assertLanBindAddress must
// actually pass) and drives it with the REAL net.connect client — exercising
// PIN-EKE pairing, the AEAD channel, the allow-list router, durable inbox append,
// and execute-impossibility over an actual TCP socket (not the in-memory fake).
//
//   LANLINK_DOGFOOD_IP=192.168.x.y npx vitest run src/daemon/lanlink/__tests__/dogfood.live.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LanLinkServer } from '../server';
import { pairWithPeer, sendToPeer } from '../client';
import { PeerStore } from '../peers';
import { LanLinkInbox } from '../inbox';
import { ReconnectInitiator } from '../pairing';
import { encodeFrame } from '../wire';
import { AeadSealer } from '../aead';
import type { PairResult } from '../pairing';

const LAN_IP = process.env['LANLINK_DOGFOOD_IP'];
const suite = LAN_IP ? describe : describe.skip;
const PORT = 45000 + Math.floor(Math.random() * 1000);
const PIN = '314159';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seam = { reHarden: () => true, secureWrite: (p: string, d: string) => fs.writeFileSync(p, d) };

function mockController(nic: { name: string; mac: string }) {
  return Object.assign(new EventEmitter(), {
    getStatus: () => ({ enabled: true, nic, port: PORT, nics: [] }),
  });
}

suite('LanLink LIVE real-net dogfood (1-machine, LAN IP)', () => {
  let root: string;
  let hostInboxDir: string;
  let server: LanLinkServer;
  let hostInbox: LanLinkInbox;
  let hostPeers: PeerStore;
  let joinPeers: PeerStore;
  let nudges: number[];
  let nic: { name: string; mac: string };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanlink-live-'));
    hostInboxDir = fs.mkdtempSync(path.join(root, 'host-'));
    const ifs = os.networkInterfaces();
    let found: { name: string; mac: string } | null = null;
    for (const [name, addrs] of Object.entries(ifs)) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal && a.address === LAN_IP) found = { name, mac: a.mac };
      }
    }
    if (!found) throw new Error(`LANLINK_DOGFOOD_IP ${LAN_IP} is not a live external IPv4`);
    nic = found;
    hostInbox = new LanLinkInbox(hostInboxDir);
    hostPeers = new PeerStore(hostInboxDir, seam);
    joinPeers = new PeerStore(fs.mkdtempSync(path.join(root, 'join-')), seam);
    nudges = [];
    server = new LanLinkServer({
      inbox: hostInbox,
      controller: mockController(nic) as never,
      peers: hostPeers,
      selfName: 'host-A',
      nudge: (s) => nudges.push(s),
      netCategory: () => 'Private',
      firewall: { apply: async () => undefined, remove: async () => undefined },
    });
    await delay(80); // reconcile -> real listen on LAN_IP:PORT
  });

  afterAll(async () => {
    server?.dispose();
    await delay(50);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('D7: the server is actually listening on the LAN IP (not loopback/wildcard)', () => {
    const addr = server.boundAddress();
    expect(addr).not.toBeNull();
    expect(addr!.ip).toBe(LAN_IP);
    expect(addr!.port).toBe(PORT);
    expect(server.isListening()).toBe(true);
  });

  let paired: PairResult;
  it('D1: pairs over a real TCP socket (PIN-EKE), both sides agree on the peer', async () => {
    server.enterPairingMode(PIN);
    paired = await pairWithPeer({ host: LAN_IP!, port: PORT, pin: PIN, selfName: 'joiner-B', peers: joinPeers });
    expect(hostPeers.get(paired.peerUuid)).not.toBeNull();
    expect(joinPeers.secretOf(paired.peerUuid)!.equals(hostPeers.secretOf(paired.peerUuid)!)).toBe(true);
  });

  it('D2: a read-only message lands in the durable inbox (origin:remote, sanitized) + nudge', async () => {
    const before = hostInbox.size;
    await sendToPeer({ host: LAN_IP!, port: PORT, peerUuid: paired.peerUuid, peers: joinPeers, selfName: 'joiner-B', text: 'live hello\x1b[31m!' });
    await delay(60);
    expect(hostInbox.size).toBe(before + 1);
    const items = hostInbox.poll(before).items;
    expect(items[0].origin).toBe('remote');
    expect(items[0].text).toBe('live hello[31m!'); // ESC stripped
    expect(nudges.length).toBeGreaterThan(0);
  });

  it('D7-persist: the inbox record survives a fresh LanLinkInbox load (daemon restart)', () => {
    const reloaded = new LanLinkInbox(hostInboxDir);
    expect(reloaded.size).toBeGreaterThan(0);
    expect(reloaded.poll(0).items.some((r) => r.text.startsWith('live hello'))).toBe(true);
  });

  it('D5: an execute-kind message is rejected — never appended', async () => {
    const before = hostInbox.size;
    const secret = joinPeers.secretOf(paired.peerUuid)!;
    const sock = net.connect({ host: LAN_IP!, port: PORT });
    await new Promise<void>((res, rej) => {
      sock.once('connect', () => res());
      sock.once('error', rej);
    });
    const recon = new ReconnectInitiator(paired.peerUuid, secret);
    const frames: Buffer[] = [];
    sock.on('data', (c: Buffer) => frames.push(c));
    sock.write(encodeFrame(0x04, recon.hello()));
    await delay(80); // receive RECONNECT2
    // parse the single RECONNECT2 frame
    const buf = Buffer.concat(frames);
    const len = buf.readUInt32BE(0);
    const r2body = buf.subarray(5, 4 + len);
    const keys = recon.onReconnect2(r2body);
    const sealer = new AeadSealer(keys.c2sKey, 1);
    const hostile = JSON.stringify({ kind: 'a2a.task.send', peerName: 'B', text: 'rm -rf /', senderSeq: 1, execute: true });
    sock.write(encodeFrame(0x10, sealer.seal(Buffer.from(hostile))));
    await delay(80);
    sock.destroy();
    expect(hostInbox.size).toBe(before); // execute kind never reached the inbox
  });

  it('D3: a wrong PIN is rejected over the real socket', async () => {
    server.enterPairingMode(PIN);
    await expect(
      pairWithPeer({ host: LAN_IP!, port: PORT, pin: '000000', selfName: 'evil', peers: new PeerStore(fs.mkdtempSync(path.join(root, 'evil-')), seam) }),
    ).rejects.toThrow();
    expect(server.pairingStatus().failCount).toBeGreaterThan(0);
  });

  it('D8/G7: a first frame of 0x10 (no handshake) is dropped, inbox untouched', async () => {
    const before = hostInbox.size;
    const sock = net.connect({ host: LAN_IP!, port: PORT });
    await new Promise<void>((res, rej) => {
      sock.once('connect', () => res());
      sock.once('error', rej);
    });
    sock.write(encodeFrame(0x10, Buffer.alloc(40)));
    await delay(60);
    sock.destroy();
    expect(hostInbox.size).toBe(before);
  });
});
