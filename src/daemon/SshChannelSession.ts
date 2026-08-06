import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SessionProcess, SessionDisposable, SessionExitEvent } from './SessionProcess';

/**
 * A daemon session whose process lives on a REMOTE box the operator reached
 * over SSH, instead of a local node-pty child.
 *
 * Why this exists: the data plane (`RingBuffer`, `OscParser`, `AgentDetector`,
 * `DaemonPTYBridge`) is transport-agnostic — it consumes a byte stream and an
 * exit signal. This class is the SSH-side producer of both: stdout bytes from
 * the channel's `data` event, and an exit signal when the channel closes.
 *
 * Construction is synchronous on purpose. `createSession` is a synchronous
 * factory across the daemon (it returns `meta` with a `pid` immediately, and
 * dozens of call sites depend on that). So this object exposes the
 * `SessionProcess` surface the moment it is created. Listeners attached before
 * the connection completes are REGISTERED but receive bytes only once the
 * channel streams (pre-ready bytes are not queued — same as node-pty, where
 * onData is a subscription, not a buffer). An onExit attached after an exit
 * fires immediately (see fireExit/lastExit) so the sync fail path can never
 * strand the session as a deathless zombie.
 *
 * `pid` is synthetic: an SSH channel has no OS pid on the operator's machine.
 * A negative monotonic counter keeps it distinct from every real (positive)
 * local pid, and `ProcessMonitor`'s pid-polling liveness (tasklist / kill -0)
 * is meaningless for it by design — remote liveness is event-driven through
 * `onExit` (the channel's own `close`/`error`), not pid-polled. P0a does NOT
 * route SSH sessions through `PaneSupervisor` (supervised reconnect is P0b),
 * so no pid-based restart path touches this id.
 *
 * Auth: the operator's key material is NEVER read from wmux.json. The config
 * carries at most a path to a private key file (resolved and read here) or a
 * reference to the SSH agent; passwords live only in the in-memory request.
 * This keeps the checked-in wmux.json free of secrets, the same trust boundary
 * `wmuxProjectConfig` already enforces on commands.
 */
export interface SshChannelAuth {
  /** Path to a private key file on the operator's machine. Read here, never stored. */
  privateKeyPath?: string;
  /** Passphrase for an encrypted private key. In-memory only. */
  passphrase?: string;
  /** Use the running SSH agent (SSH_AUTH_SOCK). Default true when no other auth given. */
  agent?: boolean;
  /** Password auth (fallback). In-memory only. */
  password?: string;
}

export interface SshChannelOptions {
  host: string;
  port?: number;
  username: string;
  auth?: SshChannelAuth;
  cols: number;
  rows: number;
  /**
   * Optional command to exec instead of an interactive shell. When omitted the
   * channel opens an interactive shell (the common case — a remote agent pane).
   * When set, the channel runs that command and `onExit` carries its exit code.
   */
  remoteCommand?: string;
  /** Optional keepalive interval (seconds). Default 30. */
  keepaliveIntervalSec?: number;
  /** Connect timeout (ms). Default 15_000. */
  readyTimeoutMs?: number;
}

let sshPidCounter = -1;

export class SshChannelSession implements SessionProcess {
  readonly pid: number;
  private readonly client = new Client();
  private stream: SshChannelStream | null = null;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(e: SessionExitEvent) => void>();
  private exited = false;
  private disposed = false;
  // Last exit payload — kept so a listener attached AFTER exit (the bridge's
  // onExit lands right after construction, but the sync fail path can fireExit
  // before it) still observes the exit instead of leaving the session a zombie.
  private lastExit: SessionExitEvent | null = null;

  constructor(private readonly opts: SshChannelOptions) {
    this.pid = sshPidCounter--;
    this.connect();
  }

  private connect(): void {
    const { host, port = 22, username, auth = {}, cols, rows } = this.opts;
    // Build connect options lazily so a missing key file surfaces as a clean
    // connect error rather than a throw out of createSession.
    const connectOpts: ConnectConfig = {
      host,
      port,
      username,
      readyTimeout: this.opts.readyTimeoutMs ?? 15_000,
      keepaliveInterval: (this.opts.keepaliveIntervalSec ?? 30) * 1000,
      // Authentication is tried in order of safety: agent → key file → password.
      // ssh2 honors only the keys present, so omitting agent/password keeps
      // them from being attempted when the operator asked for key-only.
    };

    if (auth.privateKeyPath) {
      try {
        // Expand `~` — the schema explicitly accepts `~/.ssh/id_ed25519` as the
        // happy path, but fs.readFileSync reads a LITERAL `~` dir (ENOENT).
        // Mirrors DaemonSessionManager's expandTilde for cwd.
        const expanded = auth.privateKeyPath.replace(/^~(?=[\\/]|$)/, os.homedir());
        const key = fs.readFileSync(expanded, 'utf8');
        connectOpts.privateKey = key;
        if (auth.passphrase) connectOpts.passphrase = auth.passphrase;
      } catch (err) {
        this.fail(`cannot read privateKeyPath "${auth.privateKeyPath}": ${(err as Error).message}`);
        return;
      }
    } else if (auth.password) {
      connectOpts.password = auth.password;
    } else {
      // Default to the SSH agent. On POSIX that's SSH_AUTH_SOCK; on Windows the
      // agent is pageant/npipe, which ssh2 auto-detects when `agent` is the
      // literal string 'pageant' OR left for ssh2's platform default. Pass an
      // empty string only when SSH_AUTH_SOCK is set (POSIX); otherwise omit so
      // ssh2 uses its own Windows default rather than a dead socket path.
      const sock = process.env.SSH_AUTH_SOCK;
      if (sock) connectOpts.agent = sock;
    }

    // Host key verification (MITM defense). Without this, ssh2 accepts ANY
    // host key the peer presents — an attacker who can answer for the host
    // name collects the operator's auth (key signature / agent / password)
    // and proxies every byte. wmux.json's host is attacker-reachable (the file
    // is checked into the repo), so this gate is load-bearing, not cosmetic.
    //
    // TOFU (trust-on-first-use) against ~/.wmux/ssh-known_hosts: the first
    // connection to a host records its key's fingerprint; a later connection to
    // the SAME host with a DIFFERENT key fails closed. This matches openssh's
    // strict-host-key-checking=no first-use behavior — good enough for the
    // "operator's own box" threat model of P0a, and far better than silent
    // acceptance. A future P1 can wire ~/.ssh/known_hosts too.
    connectOpts.hostVerifier = (key: Buffer, verify: (verified: boolean) => void): void => {
      try {
        verify(this.verifyHostKey(key) ? true : false);
      } catch {
        verify(false);
      }
    };

    this.client.on('ready', () => {
      if (this.disposed) {
        this.client.end();
        return;
      }
      const shellOpts: Record<string, unknown> = {
        cols,
        rows,
        term: 'xterm-256color',
      };
      const onStream = (err: Error | undefined, stream: SshChannelStream): void => {
        if (err) {
          this.fail(`shell request failed: ${err.message}`);
          return;
        }
        if (this.disposed) {
          stream.close();
          this.client.end();
          return;
        }
        this.stream = stream;
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          for (const cb of this.dataListeners) cb(text);
        });
        // stderr (extended data) is rare for a shell but route it the same way
        // so an agent writing to fd 2 still appears on the pane.
        stream.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          for (const cb of this.dataListeners) cb(text);
        });
        stream.on('exit', (code: number | null, signal: string | null) => {
          this.fireExit({ exitCode: code ?? 0, signal: signal ?? undefined });
          // The channel may still flush buffered stdout after 'exit'; close it.
          stream.close();
          this.client.end();
        });
        stream.on('close', () => {
          // 'close' without a prior 'exit' = the channel died without an exit
          // code (network drop, server kill). Fail closed with a synthetic code
          // so the bridge's death handling runs exactly once.
          this.fireExit({ exitCode: 255, signal: 'REMOTE_CLOSE' });
        });
      };
      // ssh2's shell/exec callback signature uses its own ClientChannel type;
      // our SshChannelStream is a structural subset, so cast through unknown.
      const cb = onStream as unknown as (
        err: Error | undefined | null,
        stream: SshChannelStream,
      ) => void;
      if (this.opts.remoteCommand) {
        this.client.exec(this.opts.remoteCommand, shellOpts, cb as never);
      } else {
        this.client.shell(shellOpts, cb as never);
      }
    });

    this.client.on('error', (err: Error) => {
      this.fail(`ssh error: ${err.message}`);
    });
    this.client.on('close', () => {
      this.fireExit({ exitCode: 255, signal: 'CONNECTION_CLOSED' });
    });
    this.client.on('end', () => {
      this.fireExit({ exitCode: 255, signal: 'CONNECTION_ENDED' });
    });

    try {
      this.client.connect(connectOpts);
    } catch (err) {
      this.fail(`ssh connect threw: ${(err as Error).message}`);
    }
  }

  /** Surface a single terminal failure as an exit so the bridge tears the session down. */
  private fail(reason: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[SshChannelSession] ${this.opts.host}: ${reason}`);
    this.fireExit({ exitCode: 255, signal: reason });
  }

  /**
   * Per-host known_hosts file. Lives under ~/.wmux/ (not ~/.ssh/) so wmux owns
   * its lifecycle and a user's openssh known_hosts is never silently rewritten.
   * One line per trusted host: `<host>:<port> <sha256-fingerprint>`.
   */
  private knownHostsPath(): string {
    const dataDir = process.env.WMUX_DATA_DIR || path.join(os.homedir(), '.wmux');
    return path.join(dataDir, 'ssh-known_hosts');
  }

  /**
   * TOFU host-key check. Returns true when the presented key matches the
   * recorded fingerprint for this host, OR when no fingerprint is recorded yet
   * (first use — records it). Returns false on a MISMATCH (potential MITM).
   * The host:port key matches the openssh known_hosts single-line shape.
   */
  private verifyHostKey(key: Buffer): boolean {
    const crypto = require('node:crypto');
    const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64');
    const hostKey = `${this.opts.host}:${this.opts.port ?? 22}`;
    const khPath = this.knownHostsPath();
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(khPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    } catch {
      lines = [];
    }
    const existing = lines.find((l) => l.startsWith(hostKey + ' '));
    if (existing) {
      const recorded = existing.slice(hostKey.length + 1).trim();
      return recorded === fp;
    }
    // First use: record and accept. Best-effort write — a failure to persist
    // must NOT block the connection (the operator is here now), so fall back to
    // accept rather than strand them. The mismatch path above is the security-
    // critical half; first-use recording is opportunistic.
    try {
      fs.mkdirSync(path.dirname(khPath), { recursive: true });
      fs.appendFileSync(khPath, `${hostKey} ${fp}\n`);
    } catch {
      /* best-effort — see comment */
    }
    return true;
  }

  private fireExit(payload: SessionExitEvent): void {
    if (this.exited) return;
    this.exited = true;
    this.lastExit = payload;
    for (const cb of this.exitListeners) {
      try {
        cb(payload);
      } catch {
        /* a listener throwing must not block the others */
      }
    }
  }

  onData(listener: (data: string) => void): SessionDisposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (e: SessionExitEvent) => void): SessionDisposable {
    // If already exited, fire immediately. The bridge attaches onExit right
    // after construction, but the sync fail path (readFileSync / connect throw)
    // can fireExit BEFORE that attach — without this replay the session would
    // sit "alive" with no death path (SSH skips processMonitor.watch), a
    // permanent zombie. try/catch so one throwing listener can't block the add.
    this.exitListeners.add(listener);
    if (this.exited && this.lastExit) {
      try {
        listener(this.lastExit);
      } catch {
        /* ignore — listener error does not unblock the death either way */
      }
    }
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    if (this.stream && !this.exited) {
      this.stream.write(data);
    }
    // Pre-connection writes are silently dropped: keystrokes before the shell is
    // up would be lost anyway, and queueing them risks replaying a paste into
    // the wrong session on a slow connect.
  }

  resize(cols: number, rows: number): void {
    const stream = this.stream as (SshChannelStream & { setWindow?(r: number, c: number, h: number, w: number): void }) | null;
    if (stream && typeof stream.setWindow === 'function' && !this.exited) {
      // height/width pixels are informational for most terminals; send 0 and let
      // rows/cols (the cells ssh2 actually applies) drive layout.
      stream.setWindow(rows, cols, 0, 0);
    }
  }

  kill(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.stream) this.stream.close();
    } catch {
      /* already gone */
    }
    try {
      this.client.end();
    } catch {
      /* already gone */
    }
    this.fireExit({ exitCode: 255, signal: 'KILLED' });
  }
}

/** Minimal structural type for an ssh2 client stream (duplex). Defined locally
 * so this file does not depend on ssh2's internal type exports. */
interface SshChannelStream {
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'stderr', cb: (chunk: Buffer) => void): unknown;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  write(data: string): unknown;
  close(): unknown;
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): unknown };
}
