// === LanLink outbound client (PR-4) — pairing-join + message-send ===
//
// The OUTBOUND half: connect to a peer daemon's LanLinkServer to JOIN a pairing
// (initiator side of the PIN-EKE) or to SEND a read-only message (reconnect +
// AEAD record). The crypto lives in pairing.ts/aead.ts; this is the net plumbing.
// connect is injectable so the handshake can be exercised in-memory against a
// LanLinkServer without a real socket (the bind guard forbids loopback).
//
// Imports node:net/stream + sibling lanlink files only — execute-wall clean.

import net from 'node:net';
import type { EventEmitter } from 'node:events';
import { FrameReader, encodeFrame, type FrameType } from './wire';
import { PairingInitiator, ReconnectInitiator, deterministicUuid, type PairResult } from './pairing';
import { AeadSealer, AeadOpener } from './aead';
import type { PeerStore } from './peers';
import type { TaskState } from '../../shared/types';

const HELLO: FrameType = 0x01;
const PAKE2: FrameType = 0x02;
const CONFIRM: FrameType = 0x03;
const RECONNECT_HELLO: FrameType = 0x04;
const RECONNECT2: FrameType = 0x05;
const AEAD_RECORD: FrameType = 0x10;

const FRAME_TIMEOUT_MS = 6_000;

/** Minimal socket surface this client needs — satisfied by net.Socket and by an
 *  in-memory fake in tests (the bind guard forbids real loopback). */
export type LanLinkSocket = Pick<EventEmitter, 'on'> & {
  write(data: Buffer): unknown;
  destroy(): void;
};
export type ConnectFn = (host: string, port: number) => LanLinkSocket;

const defaultConnect: ConnectFn = (host, port) => net.connect({ host, port });

/** Ordered async frame reader over a socket, with timeout + error/close failure. */
class FrameStream {
  private reader = new FrameReader();
  private queue: { type: FrameType; body: Buffer }[] = [];
  private waiters: { resolve: (f: { type: FrameType; body: Buffer }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private failed: Error | null = null;

  constructor(socket: LanLinkSocket) {
    socket.on('data', (chunk: Buffer) => {
      try {
        this.reader.push(chunk);
        let f: { type: FrameType; body: Buffer } | null;
        while ((f = this.reader.next()) !== null) {
          const w = this.waiters.shift();
          if (w) {
            clearTimeout(w.timer);
            w.resolve(f);
          } else {
            this.queue.push(f);
          }
        }
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on('error', (err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    socket.on('close', () => this.fail(new Error('connection closed')));
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = err;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  next(expected: FrameType): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const done = (f: { type: FrameType; body: Buffer }) => {
        if (f.type !== expected) reject(new Error(`expected frame 0x${expected.toString(16)}, got 0x${f.type.toString(16)}`));
        else resolve(f.body);
      };
      const queued = this.queue.shift();
      if (queued) return done(queued);
      if (this.failed) return reject(this.failed);
      const timer = setTimeout(() => reject(new Error('LanLink client: frame timeout')), FRAME_TIMEOUT_MS);
      this.waiters.push({ resolve: done, reject, timer });
    });
  }
}

export interface PairJoinOptions {
  host: string;
  port: number;
  pin: string;
  selfName: string;
  peers: PeerStore;
  connect?: ConnectFn;
}

/** JOIN a pairing the peer armed with `enterPairingMode`. Persists on success. */
export async function pairWithPeer(opts: PairJoinOptions): Promise<PairResult> {
  const socket = (opts.connect ?? defaultConnect)(opts.host, opts.port);
  const stream = new FrameStream(socket);
  try {
    const ini = new PairingInitiator(opts.pin, opts.selfName);
    socket.write(encodeFrame(HELLO, ini.hello()));
    const pake2 = await stream.next(PAKE2);
    const { confirm, pending } = await ini.onPake2(pake2);
    socket.write(encodeFrame(CONFIRM, confirm));
    const firstAead = await stream.next(AEAD_RECORD);
    // Responder sends respMac via the s2c direction; joiner opens it as s2c.
    const respMac = new AeadOpener(pending.sessionKeys.s2cKey, 2).open(firstAead);
    const result = ini.verifyRespMac(respMac, pending);
    opts.peers.upsertPaired(result);
    return result;
  } finally {
    socket.destroy();
  }
}

export interface SendOptions {
  host: string;
  port: number;
  peerUuid: string;
  peers: PeerStore;
  selfName: string;
  text: string;
  kind?: 'msg.text' | 'state.update';
  state?: TaskState;
  connect?: ConnectFn;
}

/** Reconnect (no scrypt) + send one read-only AEAD record; await the app ACK. */
export async function sendToPeer(opts: SendOptions): Promise<{ delivered: boolean }> {
  const secret = opts.peers.secretOf(opts.peerUuid);
  if (!secret) throw new Error(`sendToPeer: unknown or burned peer ${opts.peerUuid}`);
  const socket = (opts.connect ?? defaultConnect)(opts.host, opts.port);
  const stream = new FrameStream(socket);
  try {
    const recon = new ReconnectInitiator(opts.peerUuid, secret);
    socket.write(encodeFrame(RECONNECT_HELLO, recon.hello()));
    const r2 = await stream.next(RECONNECT2);
    const keys = recon.onReconnect2(r2);
    const sealer = new AeadSealer(keys.c2sKey, 1); // joiner -> host (c2s)
    const opener = new AeadOpener(keys.s2cKey, 2);
    // Reserve the senderSeq immediately so two concurrent sends can't collide on
    // one seq (which the receiver's dedup would silently drop) — codex P1.
    const senderSeq = opts.peers.nextSendSeq(opts.peerUuid);
    const appMsg = JSON.stringify({
      kind: opts.kind ?? 'msg.text',
      peerName: opts.selfName,
      text: opts.text,
      senderSeq,
      ...(opts.state !== undefined ? { state: opts.state } : {}),
    });
    socket.write(encodeFrame(AEAD_RECORD, sealer.seal(Buffer.from(appMsg, 'utf8'))));
    const ack = await stream.next(AEAD_RECORD);
    const ackPlain = opener.open(ack); // authenticate the ACK (throws on tamper/replay)
    // Confirm the ACK is FOR THIS message, not just any authentic frame (codex): the
    // server ACKs with { ack: deterministicUuid(peerUuid:senderSeq) }. Only commit
    // the send seq when the id matches, so a stray/other frame can't mark a failed
    // delivery as confirmed.
    const expectedId = deterministicUuid(`${opts.peerUuid}:${senderSeq}`);
    let ackObj: unknown;
    try {
      ackObj = JSON.parse(ackPlain.toString('utf8'));
    } catch {
      throw new Error('LanLink sendToPeer: malformed ACK');
    }
    if (typeof ackObj !== 'object' || ackObj === null || (ackObj as Record<string, unknown>)['ack'] !== expectedId) {
      throw new Error('LanLink sendToPeer: ACK does not match the sent message');
    }
    return { delivered: true };
  } finally {
    socket.destroy();
  }
}
