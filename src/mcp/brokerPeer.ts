// Whether the MCP broker hosts a shim's session, from the OS's own answer for
// the process at the other end of the socket (shared/peerPid.ts).
//
// A shim names its pid and parent pid in its handshake, and the session's
// identity walk starts from them. The broker hosts the session only when the
// kernel's peer is that pid and runs as this user, and it takes the parent pid
// from the OS, never from the handshake. Anything it cannot read is refused:
// the native shim then runs the full bundle, which talks to main directly.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import type { PeerPid } from '../shared/peerPid';
import { psPath } from '../shared/psPath';

/** Why the broker refused a session. It logs the reason and closes the connection with no ack line. */
export type PeerRefusal = 'peer' | 'peer-unverified';

export type PeerDecision =
  | { ok: true; callerPid: number }
  | { ok: false; reason: PeerRefusal; detail: string };

export interface PeerCheckInput {
  /** The broker's startup self-check passed (peer pids can be read here). */
  selfCheckOk: boolean;
  /** What the OS reported for the accepted socket. */
  peer: PeerPid;
  /** The pid the handshake claims. */
  claimedPid: unknown;
  /** This process's uid; null where there is none (Windows). */
  ownUid: number | null;
}

/** The pid check, before the parent pid is read. */
export function checkPeer(input: PeerCheckInput): PeerDecision {
  if (!input.selfCheckOk) return { ok: false, reason: 'peer-unverified', detail: 'peer pids cannot be read in this process' };
  const { peer } = input;
  if (peer.pid === null) return { ok: false, reason: 'peer-unverified', detail: peer.reason };
  if (peer.uid === undefined || input.ownUid === null) return { ok: false, reason: 'peer-unverified', detail: `no uid for peer ${peer.pid}` };
  if (peer.uid !== input.ownUid) return { ok: false, reason: 'peer', detail: `peer ${peer.pid} runs as uid ${peer.uid}` };
  if (input.claimedPid !== peer.pid) {
    return { ok: false, reason: 'peer', detail: `claimed pid ${String(input.claimedPid)}, peer ${peer.pid}` };
  }
  return { ok: true, callerPid: peer.pid };
}

/**
 * How long the broker waits for a peer's parent pid. With the self-check's own
 * 2 s this stays under the native shim's 5 s ack deadline.
 */
export const PARENT_READ_TIMEOUT_MS = 1500;

/** The parent of a live pid, as the OS reports it; null when it cannot be read. */
export function osParentPid(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(psPath(), ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: PARENT_READ_TIMEOUT_MS }, (err, stdout) => {
      const ppid = err ? NaN : Number.parseInt(stdout.trim(), 10);
      resolve(Number.isInteger(ppid) && ppid > 0 ? ppid : null);
    });
  });
}

export type HostDecision =
  | { ok: true; callerPid: number; callerPpid: number }
  | { ok: false; reason: PeerRefusal; detail: string };

/** The full decision: the pid check, then the parent pid from the OS. */
export async function decidePeer(
  input: PeerCheckInput,
  parentOf: (pid: number) => Promise<number | null> = osParentPid,
): Promise<HostDecision> {
  const checked = checkPeer(input);
  if (!checked.ok) return checked;
  const callerPpid = await parentOf(checked.callerPid);
  if (callerPpid === null) return { ok: false, reason: 'peer-unverified', detail: `no parent pid for peer ${checked.callerPid}` };
  return { ok: true, callerPid: checked.callerPid, callerPpid };
}

/**
 * A self-check failure that load can cause and that clears by itself: out of
 * descriptors or memory, or a check that ran out of time. The broker keeps
 * checking through these however long they last; any other failure (no koffi,
 * no libc, a pid or uid it cannot read right) does not clear while the
 * process lives.
 */
export function isTransientSelfCheckFailure(verdict: string): boolean {
  return /\b(EMFILE|ENFILE|EAGAIN|ENOMEM|ENOBUFS|EINTR)\b|timed out/.test(verdict);
}

/** The waits between self-checks after one that did not come back available. */
export const SELF_CHECK_RETRY_MS = [1000, 2000, 5000, 15000, 30000];

export interface PeerSelfCheck {
  /** The latest verdict. A session that arrives while a check runs waits for
   *  it; one that finds the last check failed starts a check and waits for that. */
  verdict(): Promise<string | null>;
  /** No check starts after this. */
  stop(): void;
}

/**
 * The broker's peer self-check, run again with backoff for as long as it is
 * not available (a transient EMFILE, say), and at once when a session finds it
 * failed. A null verdict (no peer pids on this platform) is final. `onVerdict`
 * sees every verdict with its attempt number, from 1.
 *
 * `onGiveUp`, when given, ends a check that has never come back available:
 * once every delay in `delays` has run out and the check after it still failed
 * for a reason that is not transient (`isTransientSelfCheckFailure`), no
 * further check starts and `onGiveUp` gets that verdict. Only the backoff
 * timer counts toward it, so sessions that arrive in a burst and each start a
 * check cannot end it early, and since a session's check leaves that timer
 * running, sessions that keep arriving cannot hold it off either. (An available check is never run again.)
 */
export function retryingSelfCheck(
  run: () => Promise<string | null>,
  onVerdict: (verdict: string | null, attempt: number) => void,
  delays: readonly number[] = SELF_CHECK_RETRY_MS,
  onGiveUp?: (verdict: string, attempts: number) => void,
): PeerSelfCheck {
  let attempt = 0;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let failed = false;
  let stopped = false;
  /** Backoff retries that came due, as opposed to checks a session started. */
  let timedRetries = 0;
  let current: Promise<string | null>;
  // The backoff runs on its own: a session's check never clears or restarts
  // it, so sessions that keep arriving cannot hold off the give-up.
  const scheduleRetry = (n: number): void => {
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || !failed) return;
      timedRetries++;
      // A session's check already running counts as this retry.
      if (!running) start();
    }, delays[Math.min(n - 1, delays.length - 1)]);
    timer.unref?.();
  };
  const start = (): void => {
    running = true;
    const n = ++attempt;
    current = Promise.resolve()
      .then(run)
      .catch((err: unknown) => `unavailable (${err instanceof Error ? err.message : String(err)})`)
      .then((verdict) => {
        running = false;
        failed = verdict !== 'available' && verdict !== null;
        onVerdict(verdict, n);
        if (verdict !== null && failed && !stopped && onGiveUp && timedRetries >= delays.length && !isTransientSelfCheckFailure(verdict)) {
          stopped = true;
          clearTimeout(timer);
          onGiveUp(verdict, n);
          return verdict;
        }
        if (failed && !stopped && timer === undefined) scheduleRetry(n);
        return verdict;
      });
  };
  start();
  return {
    verdict: () => {
      if (failed && !running && !stopped) start();
      return current;
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Windows: the native named-pipe listener (src/mcp/nativePipe.ts).
//
// The broker reads the client's facts from two places: the process at the
// other end of the pipe (NativePipeSocket.peer: its pid, session, creation
// time and parent), and the client's own token, read by impersonating it once
// the handshake line has arrived (NativePipeSocket.tokenFacts). The user and
// the integrity level come from the token, so a client that runs elevated is
// read as well as one that does not. Every refusal here closes the connection
// with no ack line: the shim takes that as "no session" and runs the full
// bundle. The reason stays in the broker's log.

/** Why the broker refused a session on Windows (logged only). */
export type Win32PeerRefusal =
  /** The broker's own self-check has not passed. */
  | 'peer-unverified'
  /** The client's token could not be read (or not in time). */
  | 'token-unreadable'
  /** The client's token names another user. */
  | 'other-user'
  /** The client runs below Medium integrity. */
  | 'integrity-low'
  /** The client runs in another logon session. */
  | 'other-session'
  /** The client process could not be read, or its pid names a newer process. */
  | 'process-unreadable'
  /** The handshake names another pid than the client's. */
  | 'pid-mismatch'
  /** The client's parent could not be read. */
  | 'no-parent';

/** SECURITY_MANDATORY_MEDIUM_RID: the lowest integrity level the broker hosts. */
export const MEDIUM_INTEGRITY_RID = 0x2000;

/**
 * How long the broker waits for a client's token facts. With the self-check's
 * own 2 s this stays under the native shim's 5 s ack deadline.
 */
export const TOKEN_FACTS_TIMEOUT_MS = 1500;

/** What the native listener reported for the client process (NativePipePeer). */
export interface Win32PeerFacts {
  pid: number;
  sameSession: boolean;
  ppid: number | null;
  reason: string | null;
}

/** The client's token facts, or why they were not read (TokenFactsResult). */
export type Win32TokenFacts =
  | { ok: true; sameUser: boolean; integrityRid: number; elevated: boolean }
  | { ok: false; reason: string };

export interface Win32PeerInput {
  /** The broker's startup self-check passed. */
  selfCheckOk: boolean;
  peer: Win32PeerFacts;
  facts: Win32TokenFacts;
  /** The pid the handshake claims. */
  claimedPid: unknown;
}

export type Win32HostDecision =
  | { ok: true; callerPid: number; callerPpid: number }
  | { ok: false; reason: Win32PeerRefusal; detail: string };

/**
 * Peer reasons that leave the pid itself in doubt. 'token-unreadable' is not
 * one: it says only that the process token could not be opened from here (an
 * elevated client), which the client's own token facts answer instead.
 */
const PID_IN_DOUBT: ReadonlySet<string> = new Set(['process-unreadable', 'created-after-accept']);

/**
 * The Windows decision: the client's own token (same user, Medium integrity
 * or above, elevated or not), its session, the pid it claims, and its parent
 * as the native listener read it (alive and created no later than the
 * client). The parent pid is advisory among processes of one user.
 */
export function decideWin32Peer(input: Win32PeerInput): Win32HostDecision {
  if (!input.selfCheckOk) return { ok: false, reason: 'peer-unverified', detail: 'the broker could not read its own connection' };
  const { peer, facts } = input;
  if (!facts.ok) return { ok: false, reason: 'token-unreadable', detail: `token facts for peer ${peer.pid}: ${facts.reason}` };
  if (!facts.sameUser) return { ok: false, reason: 'other-user', detail: `peer ${peer.pid} runs as another user` };
  if (!Number.isInteger(facts.integrityRid) || facts.integrityRid < MEDIUM_INTEGRITY_RID) {
    return { ok: false, reason: 'integrity-low', detail: `peer ${peer.pid} integrity 0x${Number(facts.integrityRid).toString(16)}` };
  }
  if (!peer.sameSession) return { ok: false, reason: 'other-session', detail: `peer ${peer.pid} runs in another session` };
  if (peer.reason !== null && PID_IN_DOUBT.has(peer.reason)) {
    return { ok: false, reason: 'process-unreadable', detail: `peer ${peer.pid}: ${peer.reason}` };
  }
  if (input.claimedPid !== peer.pid) {
    return { ok: false, reason: 'pid-mismatch', detail: `claimed pid ${String(input.claimedPid)}, peer ${peer.pid}` };
  }
  if (peer.ppid === null) return { ok: false, reason: 'no-parent', detail: `no parent pid for peer ${peer.pid}` };
  return { ok: true, callerPid: peer.pid, callerPpid: peer.ppid };
}

/** The most connections that may wait for their handshake at once (Windows). */
export const WIN32_PRE_AUTH_CAP = 32;

/**
 * Counts the connections that have not finished their handshake, so idle
 * clients cannot hold every pipe instance. `admit()` gives a release
 * function (idempotent) to call once the connection is hosted, refused or
 * closed, or null when the cap is reached.
 */
export class PreAuthGate {
  private waiting = 0;

  constructor(private readonly cap: number = WIN32_PRE_AUTH_CAP) {}

  /** Connections admitted and not yet released. */
  get size(): number {
    return this.waiting;
  }

  admit(): (() => void) | null {
    if (this.waiting >= this.cap) return null;
    this.waiting++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.waiting--;
    };
  }
}

/** A connection the native self-check accepts: a stream with the client's facts. */
export interface SelfCheckSocket {
  readonly peer: { pid: number };
  once(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  pause(): unknown;
  destroy(): unknown;
  tokenFacts(timeoutMs: number): Promise<Win32TokenFacts>;
}

/** What the self-check needs from listenNativePipe. Throws as it does. */
export type SelfCheckListen = (
  name: string,
  options: { maxInstances: number; onConnection(socket: SelfCheckSocket): void; onFailure?(reason: string): void },
) => { close(): void };

/** A private pipe name beside the broker's, for its self-check. */
export function win32SelfCheckPipeName(
  brokerPipe: string,
  pid: number = process.pid,
  nonce: string = crypto.randomBytes(4).toString('hex'),
): string {
  return `${brokerPipe}-pc-${pid}-${nonce}`;
}

/**
 * The broker's Windows self-check: it listens on a private name with the
 * native listener, connects to it from this process, sends one line, and
 * checks that the listener reads this process's pid and, from the token,
 * this user. 'available' when it does; otherwise 'unavailable (...)', and a
 * timeout says "timed out" (isTransientSelfCheckFailure).
 */
export function selfCheckNativePipe(
  listen: SelfCheckListen,
  name: string,
  timeoutMs = 2000,
  connect: (name: string) => net.Socket = (n) => net.connect(n),
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let server: { close(): void } | undefined;
    /** The client end, once connecting started. */
    const ends: { client?: net.Socket } = {};
    let accepted: SelfCheckSocket | undefined;
    const finish = (verdict: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ends.client?.destroy();
      accepted?.destroy();
      try {
        server?.close();
      } catch { /* closing is best-effort */ }
      resolve(verdict);
    };
    const timer = setTimeout(() => finish('unavailable (self-check timed out)'), timeoutMs);
    timer.unref?.();
    try {
      server = listen(name, {
        maxInstances: 1,
        onConnection: (socket) => {
          if (accepted || settled) {
            socket.destroy();
            return;
          }
          accepted = socket;
          socket.on('error', (error) => finish(`unavailable (${error.message})`));
          socket.once('data', () => {
            socket.pause();
            void socket.tokenFacts(timeoutMs).then((facts) => {
              if (socket.peer.pid !== process.pid) finish(`unavailable (read pid ${socket.peer.pid}, expected ${process.pid})`);
              else if (!facts.ok) finish(facts.reason === 'timed-out' ? 'unavailable (token facts timed out)' : `unavailable (token facts: ${facts.reason})`);
              else if (!facts.sameUser) finish('unavailable (the token read names another user)');
              else finish('available');
            });
          });
        },
        onFailure: (reason) => finish(`unavailable (listener: ${reason})`),
      });
    } catch (error) {
      finish(`unavailable (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (settled) return;
    const client = connect(name);
    ends.client = client;
    client.on('error', (error) => finish(`unavailable (${error.message})`));
    client.once('connect', () => client.write('self-check\n'));
  });
}
