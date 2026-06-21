// === LanLinkServer — isolated net.Server + per-connection state machine (PR-4) ===
//
// The INBOUND network surface. An ISOLATED net.Server (its OWN admission counters,
// NEVER shared with the control-pipe DaemonPipeServer — sharing would let an
// unpaired attacker starve local control RPC, G1) bound to the configured NIC.
// Per-connection lifecycle: ADMITTED -> HANDSHAKE (PAKE or reconnect) -> AEAD.
// AEAD-GATES-ALL-BYTES (G7): zero app/router/inbox processing before the
// handshake completes. Inbound app records terminate in the durable inbox
// (decode -> router -> sanitize -> dedup -> inbox.append -> nudge); there is NO
// RpcContext, NO RpcRouter, NO execute path — the daemon execute-wall (source
// scan over src/daemon/**) proves it structurally.
//
// Imports node builtins + sibling lanlink files + shared types ONLY. No src/main.

import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LANLINK_CONFIG_CHANGED, type LanLinkController } from './controller';
import { pairWithPeer, sendToPeer } from './client';
import { assertLanBindAddress, enumerateNics } from './bindGuard';
import type { LanLinkInbox } from './inbox';
import { PeerStore } from './peers';
import { FrameReader, encodeFrame, decodeAppMessage, type FrameType } from './wire';
import { AeadSealer, AeadOpener, type Direction, type SessionKeys } from './aead';
import {
  PairingResponder,
  reconnectResponder,
  parseReconnectHello,
  deterministicUuid,
  PAIR_TTL_MS,
  PAIR_FAIL_BURN,
  PIN_LEN,
} from './pairing';
import { admitKind } from './router';
import { sanitizeRemoteText, sanitizeRemotePeerName, hasResidualControl } from './sanitize';
import { applyLanLinkFirewall, removeLanLinkFirewall } from './firewall';
import type { InboxRecord, LanLinkNic, NicInfo } from '../../shared/lanlink';

export const DEFAULT_PORT = 45651;

const HANDSHAKE_TIMEOUT_MS = 5_000; // absolute, NOT reset by byte arrival (slow-loris)
const IDLE_TIMEOUT_MS = 60_000;
const MAX_CONNECTIONS_TOTAL = 8;
const MAX_CONNECTIONS_PER_IP = 2;
const MAX_NEW_CONN_PER_SEC = 10;
const MAX_RECORDS_PER_SEC = 50; // post-AEAD per-connection record-rate cap (paired-peer flood)

const PAKE_HELLO: FrameType = 0x01;
const PAKE2: FrameType = 0x02;
const CONFIRM: FrameType = 0x03;
const RECONNECT_HELLO: FrameType = 0x04;
const RECONNECT2: FrameType = 0x05;
const AEAD_RECORD: FrameType = 0x10;

export type NetCategory = 'Private' | 'Public' | 'Domain' | 'Unknown';

export interface LanLinkServerDeps {
  inbox: LanLinkInbox;
  controller: LanLinkController;
  nudge: (seq: number) => void;
  peers: PeerStore;
  selfName: string;
  /** Injectable interface snapshot source (tests). Defaults to a live read. */
  ifaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** Injectable NLM lookup (C15). Default returns 'Unknown' (no sync shell-out); the
   *  enforced exposure gate is the Windows Public/Domain BLOCK firewall rule. */
  netCategory?: (ip: string) => NetCategory;
  /** Injectable net.createServer (tests). */
  createServer?: (onConn: (s: net.Socket) => void) => net.Server;
  /** Injectable firewall apply/remove (tests). */
  firewall?: {
    apply: (port: number, exe: string) => Promise<void>;
    remove: () => Promise<void>;
  };
}

// 'handshake-reconnect' is intentionally absent: the reconnect path is fully
// synchronous (no scrypt, no event-loop yield), so a connection never rests in an
// intermediate reconnect state — onReconnectHello goes admitted -> aead in one tick.
type ConnState = 'admitted' | 'handshake-pake' | 'aead' | 'dead';

interface Conn {
  socket: net.Socket;
  ip: string;
  state: ConnState;
  reader: FrameReader;
  pumping: boolean;
  deadline: NodeJS.Timeout | null;
  pairing: PairingResponder | null;
  sealer: AeadSealer | null;
  opener: AeadOpener | null;
  peerUuid: string | null;
  recordCount: number;
  recordResetAt: number;
}

function monoNow(): number {
  return performance.now();
}

export class LanLinkServer {
  private readonly deps: LanLinkServerDeps;
  private readonly ifaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  private readonly netCategory: (ip: string) => NetCategory;
  private readonly createServer: (onConn: (s: net.Socket) => void) => net.Server;
  private readonly fw: { apply: (port: number, exe: string) => Promise<void>; remove: () => Promise<void> };

  private status: { enabled: boolean; nic: LanLinkNic | null; port: number | null };
  private server: net.Server | null = null;
  private boundIp: string | null = null;
  private boundPort: number | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private reconcileChain: Promise<void> = Promise.resolve();
  // Firewall mutations run on their OWN serialized chain so an async `apply`
  // (netsh add) can NEVER land after a later `remove` and resurrect a stale rule
  // with no listener behind it (C14 race fix).
  private fwChain: Promise<void> = Promise.resolve();
  private disposed = false;

  // Admission (ISOLATED — never the control pipe's counters).
  private readonly conns = new Set<Conn>();
  private readonly connsByIp = new Map<string, number>();
  private newConnWindow = { count: 0, resetAt: 0 };

  // Pairing window (server-global; MAX_PAKE_IN_FLIGHT = 1).
  private pairingPin: string | null = null;
  private pairingDeadlineMono: number | null = null;
  private windowFailCount = 0;
  private pakeInFlight = false;

  constructor(deps: LanLinkServerDeps) {
    this.deps = deps;
    this.ifaces = deps.ifaces ?? (() => os.networkInterfaces());
    this.netCategory = deps.netCategory ?? (() => 'Unknown');
    this.createServer = deps.createServer ?? ((onConn) => net.createServer(onConn));
    this.fw = deps.firewall ?? { apply: applyLanLinkFirewall, remove: removeLanLinkFirewall };

    const s = deps.controller.getStatus(); // 'changed' does NOT fire at boot — read initial state
    this.status = { enabled: s.enabled, nic: s.nic, port: s.port };
    deps.controller.on(LANLINK_CONFIG_CHANGED, (cfg: { enabled: boolean; nic: LanLinkNic | null; port?: number }) => {
      this.status = { enabled: cfg.enabled, nic: cfg.nic, port: cfg.port ?? null };
      this.scheduleReconcile();
    });
    if (this.status.enabled) this.scheduleReconcile();
  }

  // ── lifecycle (serialized, C14) ─────────────────────────────────────────────

  private scheduleReconcile(): void {
    this.reconcileChain = this.reconcileChain.then(() => this.doReconcile()).catch((err) => {
      console.error('[LanLinkServer] reconcile failed:', err);
    });
  }

  /** Serialize a firewall mutation so apply/remove can never reorder (C14). */
  private queueFirewall(op: () => Promise<void>): void {
    this.fwChain = this.fwChain.then(op).catch((err) => {
      console.warn('[LanLinkServer] firewall op failed:', err instanceof Error ? err.message : err);
    });
  }

  private async doReconcile(): Promise<void> {
    if (this.disposed) {
      await this.closeServer();
      return;
    }
    if (!this.status.enabled) {
      await this.closeServer();
      this.queueFirewall(() => this.fw.remove());
      return;
    }
    // Enabled: (re)bind. Always close first so a NIC/port change rebinds cleanly.
    await this.closeServer();
    try {
      this.bindOrThrow();
    } catch (err) {
      // assertLanBindAddress / listen pre-conditions failed -> stay stopped (C2).
      console.warn('[LanLinkServer] bind aborted, staying stopped:', err instanceof Error ? err.message : err);
      await this.closeServer();
    }
    // If we ended up with NO listener while enabled (no NIC / no live IP / Public /
    // assert threw), remove any firewall rule a previous successful bind left behind
    // so a stale ALLOW never outlives the listener (CodeRabbit).
    if (!this.server) {
      this.queueFirewall(() => this.fw.remove());
    }
  }

  /** The ONLY place net.Server.listen() appears. One pinned ifaces snapshot (C14). */
  private bindOrThrow(): void {
    if (this.disposed) return; // never (re)bind after teardown, even if a reconcile was queued
    const snap = this.ifaces();
    const nic = this.status.nic;
    if (!nic) return; // no NIC selected -> stay stopped
    const ip = this.resolveIp(enumerateNics(snap), nic);
    if (!ip) {
      console.warn('[LanLinkServer] selected NIC has no live external IPv4 — staying stopped');
      return;
    }
    if (this.netCategory(ip) === 'Public') {
      console.warn('[LanLinkServer] refusing to listen on a Public-category network');
      return;
    }
    assertLanBindAddress(ip, snap); // C2 fail-closed — throws to abort, caught by doReconcile
    const port = this.status.port ?? DEFAULT_PORT;
    const server = this.createServer((s) => this.onConn(s));
    // OS-level accept throttle so libuv stops accepting past the cap BEFORE the
    // app-level admission gate allocates a socket + runs onConn — mitigates an
    // accept-flood that would otherwise churn the event loop (G1). Mirrors
    // DaemonPipeServer.maxConnections.
    server.maxConnections = MAX_CONNECTIONS_TOTAL;
    server.on('error', (err) => {
      // C14: wired BEFORE listen; any listen error -> stop, never wildcard/retry-loop.
      console.warn('[LanLinkServer] listen error, staying stopped:', err.message);
      void this.closeServer();
      this.queueFirewall(() => this.fw.remove()); // don't leave a rule with no listener
    });
    server.listen(port, ip);
    this.server = server;
    this.boundIp = ip;
    this.boundPort = port;
    this.queueFirewall(() => this.fw.apply(port, process.execPath));
    this.startLiveness(nic, ip);
  }

  private resolveIp(nics: NicInfo[], nic: LanLinkNic): string | null {
    const match = nics.find((n) => n.name === nic.name && n.mac === nic.mac);
    if (!match) return null;
    // Deterministic pick: exclude link-local 169.254/16, then lowest address — so
    // the pairing-time and listen-time addresses agree.
    const usable = match.addresses.filter((a) => !a.startsWith('169.254.')).sort();
    return usable[0] ?? null;
  }

  private startLiveness(nic: LanLinkNic, boundIp: string): void {
    this.clearLiveness();
    this.livenessTimer = setInterval(() => {
      const snap = this.ifaces();
      const ip = this.resolveIp(enumerateNics(snap), nic);
      if (ip !== boundIp) {
        // The bound IP changed (DHCP renew) OR the NIC vanished. Reconcile rather
        // than hard-stop: doReconcile closes the old listener and bindOrThrow
        // re-resolves the NIC's live IPv4 — rebinding to the new address if the
        // NIC still has one, or staying stopped if resolveIp returns null (NIC
        // gone). Never a wildcard; bindOrThrow re-asserts the address (C2/C14).
        console.warn('[LanLinkServer] bound NIC address changed — reconciling');
        this.scheduleReconcile();
        return;
      }
      // Re-evaluate the network category too (codex): a NIC can be re-classified
      // Private -> Public while keeping the same IP. Reconcile so bindOrThrow's
      // Public refusal stops the listener + removes the firewall rule.
      if (this.netCategory(boundIp) === 'Public') {
        console.warn('[LanLinkServer] bound NIC became Public — reconciling (will stay stopped)');
        this.scheduleReconcile();
      }
    }, 10_000);
    this.livenessTimer.unref?.();
  }

  private clearLiveness(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private closeServer(): Promise<void> {
    this.clearLiveness();
    for (const conn of [...this.conns]) this.destroy(conn);
    const server = this.server;
    this.server = null;
    this.boundIp = null;
    this.boundPort = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPairing();
    void this.closeServer();
    this.queueFirewall(() => this.fw.remove());
  }

  // ── pairing window (C6) ─────────────────────────────────────────────────────

  enterPairingMode(pin: string, ttlMs: number = PAIR_TTL_MS): void {
    this.pairingPin = pin;
    this.pairingDeadlineMono = monoNow() + ttlMs;
    this.windowFailCount = 0;
  }

  cancelPairing(): void {
    this.pairingPin = null;
    this.pairingDeadlineMono = null;
    this.windowFailCount = 0;
  }

  isPairingActive(): boolean {
    return (
      this.pairingPin !== null &&
      this.pairingDeadlineMono !== null &&
      monoNow() < this.pairingDeadlineMono &&
      this.windowFailCount < PAIR_FAIL_BURN
    );
  }

  pairingStatus(): { active: boolean; expiresInMs: number | null; failCount: number } {
    const active = this.isPairingActive();
    const expiresInMs =
      active && this.pairingDeadlineMono !== null ? Math.max(0, Math.round(this.pairingDeadlineMono - monoNow())) : null;
    return { active, expiresInMs, failCount: this.windowFailCount };
  }

  private noteWindowFailure(): void {
    this.windowFailCount += 1;
    if (this.windowFailCount >= PAIR_FAIL_BURN) this.cancelPairing(); // disarm entirely (C6)
  }

  /** Revoke + destroy live connections of that peer (C13). */
  revokePeer(peerUuid: string): void {
    this.deps.peers.revoke(peerUuid);
    for (const conn of [...this.conns]) {
      if (conn.peerUuid === peerUuid) this.destroy(conn);
    }
  }

  // ── control surface (driven by the daemon control pipe) ─────────────────────

  /** Mint a fresh 6-digit PIN and arm the pairing window. */
  beginPairing(): { pin: string; expiresInMs: number | null } {
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(PIN_LEN, '0');
    this.enterPairingMode(pin);
    return { pin, expiresInMs: this.pairingStatus().expiresInMs };
  }

  /** Paired peers, secrets stripped (for lanlink.peers.list). */
  listPeers(): Array<{ peerUuid: string; peerName: string; pairedAt: number; lastSeenAt: number; burned: boolean }> {
    return this.deps.peers.list().map((p) => ({
      peerUuid: p.peerUuid,
      peerName: p.peerName,
      pairedAt: p.pairedAt,
      lastSeenAt: p.lastSeenAt,
      burned: p.burned,
    }));
  }

  /** OUTBOUND: join a pairing the peer armed (initiator side). */
  joinPeer(host: string, port: number, pin: string): Promise<{ peerUuid: string; peerName: string }> {
    return pairWithPeer({ host, port, pin, selfName: this.deps.selfName, peers: this.deps.peers }).then((r) => ({
      peerUuid: r.peerUuid,
      peerName: r.peerName,
    }));
  }

  /** OUTBOUND: send one read-only message to a paired peer (reconnect + AEAD). */
  async sendMessage(host: string, port: number, peerUuid: string, text: string): Promise<void> {
    await sendToPeer({ host, port, peerUuid, peers: this.deps.peers, selfName: this.deps.selfName, text });
  }

  // ── connection handling ─────────────────────────────────────────────────────

  private onConn(socket: net.Socket): void {
    const ip = socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    if (now > this.newConnWindow.resetAt) this.newConnWindow = { count: 0, resetAt: now + 1000 };
    this.newConnWindow.count += 1;
    if (this.newConnWindow.count > MAX_NEW_CONN_PER_SEC) {
      socket.destroy();
      return;
    }
    if (this.conns.size >= MAX_CONNECTIONS_TOTAL) {
      socket.destroy();
      return;
    }
    if ((this.connsByIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
      socket.destroy();
      return;
    }

    const conn: Conn = {
      socket,
      ip,
      state: 'admitted',
      reader: new FrameReader(),
      pumping: false,
      deadline: null,
      pairing: null,
      sealer: null,
      opener: null,
      peerUuid: null,
      recordCount: 0,
      recordResetAt: 0,
    };
    this.conns.add(conn);
    this.connsByIp.set(ip, (this.connsByIp.get(ip) ?? 0) + 1);
    // ABSOLUTE handshake deadline — not reset by byte arrival (slow-loris, G1).
    conn.deadline = setTimeout(() => this.destroy(conn), HANDSHAKE_TIMEOUT_MS);
    conn.deadline.unref?.();

    socket.on('data', (chunk: Buffer) => {
      try {
        conn.reader.push(chunk);
      } catch {
        this.destroy(conn); // backlog / frame-size violation (G1)
        return;
      }
      void this.pump(conn);
    });
    socket.on('close', () => this.destroy(conn));
    socket.on('error', () => this.destroy(conn));
  }

  /** Read conn.state through a function boundary so TS does not narrow the literal
   *  across await points (destroy() can flip it to 'dead' during a scrypt await). */
  private isDead(conn: Conn): boolean {
    return conn.state === 'dead';
  }

  private async pump(conn: Conn): Promise<void> {
    if (conn.pumping || this.isDead(conn)) return;
    conn.pumping = true;
    try {
      let frame: { type: FrameType; body: Buffer } | null;
      while (!this.isDead(conn) && (frame = conn.reader.next()) !== null) {
        await this.handleFrame(conn, frame);
      }
    } catch {
      // Broad wall (C11): WireError / any unexpected throw -> destroy, never crash.
      this.destroy(conn);
    } finally {
      conn.pumping = false;
    }
  }

  private async handleFrame(conn: Conn, frame: { type: FrameType; body: Buffer }): Promise<void> {
    switch (conn.state) {
      case 'admitted':
        if (frame.type === PAKE_HELLO) return this.onPakeHello(conn, frame.body);
        if (frame.type === RECONNECT_HELLO) return this.onReconnectHello(conn, frame.body);
        this.destroy(conn); // G7: only handshake-init frames in ADMITTED
        return;
      case 'handshake-pake':
        if (frame.type === CONFIRM) return this.onConfirm(conn, frame.body);
        this.destroy(conn);
        return;
      case 'aead':
        if (frame.type === AEAD_RECORD) return this.onAeadRecord(conn, frame.body);
        this.destroy(conn); // G7: no cleartext handshake frame after AEAD
        return;
      default:
        this.destroy(conn);
    }
  }

  private async onPakeHello(conn: Conn, body: Buffer): Promise<void> {
    // Window-gated BEFORE any crypto (C5/G7): no scrypt on unauthenticated bytes
    // outside an armed window, and only one scrypt in flight.
    if (!this.isPairingActive() || this.pakeInFlight) {
      this.destroy(conn);
      return;
    }
    // Hold pakeInFlight for the ENTIRE scrypt lifetime (C5 fix): a mid-scrypt
    // socket close must NOT free the slot early, or an attacker could close-and-
    // retry to pile unbounded concurrent scrypt jobs onto the libuv pool and
    // starve the machine-local control pipe (G1). The slot is released only after
    // the scrypt promise settles, below — never in destroy().
    this.pakeInFlight = true;
    conn.state = 'handshake-pake';
    conn.pairing = new PairingResponder(this.pairingPin as string, this.deps.selfName);
    let pake2: Buffer;
    try {
      pake2 = await conn.pairing.onHello(body); // scrypt runs here (async threadpool)
    } catch {
      // bad point / DH throw / malformed hello -> unified failure (window-burn).
      this.pakeInFlight = false;
      this.noteWindowFailure();
      this.destroy(conn);
      return;
    }
    this.pakeInFlight = false; // scrypt settled -> the next PAKE may start
    if (this.isDead(conn)) {
      // Closed mid-scrypt: count the abandoned handshake so churn burns the window.
      this.noteWindowFailure();
      return;
    }
    // Re-check the window AFTER the async scrypt (codex): it may have expired (TTL)
    // or been disarmed while scrypt ran — don't continue a handshake into a closed
    // window.
    if (!this.isPairingActive()) {
      this.destroy(conn);
      return;
    }
    this.send(conn, PAKE2, pake2);
  }

  private onConfirm(conn: Conn, body: Buffer): void {
    if (!conn.pairing) {
      this.destroy(conn);
      return;
    }
    let r: ReturnType<PairingResponder['onConfirm']>;
    try {
      r = conn.pairing.onConfirm(body);
    } catch {
      this.noteWindowFailure(); // wrong PIN / MAC mismatch
      this.destroy(conn);
      return;
    }
    // Success: persist the peer, establish AEAD, send respMac as the first record.
    // (The PAKE slot was already released when onHello's scrypt settled.)
    this.deps.peers.upsertPaired(r.result);
    this.establishAead(conn, r.result.peerUuid, r.sessionKeys);
    this.send(conn, AEAD_RECORD, conn.sealer!.seal(r.respMac));
  }

  private onReconnectHello(conn: Conn, body: Buffer): void {
    let parsed: ReturnType<typeof parseReconnectHello>;
    try {
      parsed = parseReconnectHello(body);
    } catch {
      this.destroy(conn);
      return;
    }
    const secret = this.deps.peers.secretOf(parsed.peerUuid); // null if missing/burned/revoked
    if (!secret) {
      this.destroy(conn); // before any crypto (C3)
      return;
    }
    try {
      const { sessionKeys, reconnect2Body } = reconnectResponder(secret, parsed.ephPubRaw, parsed.connNonce);
      this.establishAead(conn, parsed.peerUuid, sessionKeys);
      this.send(conn, RECONNECT2, reconnect2Body);
    } catch {
      this.destroy(conn);
    }
  }

  private establishAead(conn: Conn, peerUuid: string, keys: SessionKeys): void {
    // Responder: opens c2s (joiner->host), seals s2c (host->joiner).
    const c2s: Direction = 1;
    const s2c: Direction = 2;
    conn.opener = new AeadOpener(keys.c2sKey, c2s);
    conn.sealer = new AeadSealer(keys.s2cKey, s2c);
    conn.peerUuid = peerUuid;
    conn.state = 'aead';
    if (conn.deadline) {
      clearTimeout(conn.deadline);
      conn.deadline = null;
    }
    conn.socket.setTimeout(IDLE_TIMEOUT_MS, () => this.destroy(conn));
  }

  private onAeadRecord(conn: Conn, body: Buffer): void {
    // Post-AEAD per-connection record-rate cap: even an authenticated, paired peer
    // cannot spin synchronous fsync'd inbox appends past this rate.
    const now = Date.now();
    if (now > conn.recordResetAt) {
      conn.recordCount = 0;
      conn.recordResetAt = now + 1000;
    }
    if (++conn.recordCount > MAX_RECORDS_PER_SEC) {
      this.destroy(conn);
      return;
    }
    const peerUuid = conn.peerUuid as string;
    // C13 live-revoke gate: a peer revoked mid-stream stops delivering immediately.
    if (!this.deps.peers.get(peerUuid)) {
      this.destroy(conn);
      return;
    }
    let pt: Buffer;
    try {
      pt = conn.opener!.open(body);
    } catch {
      // crypto failure (tag/replay/short) on an authenticated channel: drop the
      // connection. NOT a per-peer burn — could be transient corruption, and a
      // real peer must not be burned for it.
      this.destroy(conn);
      return;
    }
    let msg: ReturnType<typeof decodeAppMessage>;
    let kind: string;
    try {
      msg = decodeAppMessage(pt);
      kind = admitKind(msg.kind);
    } catch {
      // An AUTHENTICATED peer sent a disallowed/malformed app message -> misbehaving.
      // Bounded by the per-peer steady-state burn (C6) so a paired-but-hostile peer
      // cannot flood garbage indefinitely.
      this.deps.peers.noteSteadyStateAuthFail(peerUuid);
      this.destroy(conn);
      return;
    }
    void kind; // admitted; the inbox stores text only, not the kind
    const text = sanitizeRemoteText(msg.text);
    const peerName = sanitizeRemotePeerName(msg.peerName);
    if (hasResidualControl(text) || hasResidualControl(peerName)) {
      return; // C16 defense-in-depth: drop the record, keep the connection
    }
    const id = deterministicUuid(`${peerUuid}:${msg.senderSeq}`);
    // C8 cross-connection dedup: a duplicate/replayed senderSeq is not re-delivered
    // (the AEAD counter is intra-connection only). Re-ACK with the SAME id so a
    // retrying sender (who didn't get the first ACK) still commits — idempotent.
    if (msg.senderSeq <= this.deps.peers.highWater(peerUuid)) {
      this.send(conn, AEAD_RECORD, conn.sealer!.seal(Buffer.from(JSON.stringify({ ack: id }), 'utf8')));
      return;
    }
    const rec: Omit<InboxRecord, 'seq'> = {
      id,
      origin: 'remote',
      peerName,
      text,
      receivedAt: Date.now(),
      ...(msg.state !== undefined ? { state: msg.state } : {}),
    };
    // Ack ordering (non-negotiable): durable append+fsync BEFORE high-water bump,
    // app-ACK, and nudge.
    const { seq } = this.deps.inbox.append(rec);
    this.deps.peers.bumpHighWater(peerUuid, msg.senderSeq);
    this.deps.peers.noteSeen(peerUuid);
    // App-level AEAD-sealed ACK (after the durable write).
    this.send(conn, AEAD_RECORD, conn.sealer!.seal(Buffer.from(JSON.stringify({ ack: id }), 'utf8')));
    this.deps.nudge(seq);
  }

  private send(conn: Conn, type: FrameType, body: Buffer): void {
    if (conn.state === 'dead' || conn.socket.destroyed) return;
    try {
      conn.socket.write(encodeFrame(type, body));
    } catch {
      this.destroy(conn);
    }
  }

  private destroy(conn: Conn): void {
    if (conn.state === 'dead') return;
    conn.state = 'dead';
    // NOTE: destroy() deliberately does NOT touch pakeInFlight — the slot is owned
    // by onPakeHello for the scrypt lifetime and released there (C5 fix). Freeing
    // it here on a mid-scrypt close is exactly the close-and-retry starvation hole.
    if (conn.deadline) {
      clearTimeout(conn.deadline);
      conn.deadline = null;
    }
    try {
      conn.socket.destroy();
    } catch {
      /* ignore */
    }
    if (this.conns.delete(conn)) {
      const n = (this.connsByIp.get(conn.ip) ?? 1) - 1;
      if (n <= 0) this.connsByIp.delete(conn.ip);
      else this.connsByIp.set(conn.ip, n);
    }
  }

  /** True if a paired peer has a live AEAD connection (PeerStore eviction guard). */
  hasLiveConn(peerUuid: string): boolean {
    for (const c of this.conns) {
      if (c.peerUuid === peerUuid && c.state === 'aead') return true;
    }
    return false;
  }

  // ── test/diagnostic accessors ───────────────────────────────────────────────

  /** Whether the listener is currently bound (test/diagnostics). */
  isListening(): boolean {
    return this.server !== null;
  }

  boundAddress(): { ip: string; port: number } | null {
    return this.boundIp && this.boundPort ? { ip: this.boundIp, port: this.boundPort } : null;
  }
}
