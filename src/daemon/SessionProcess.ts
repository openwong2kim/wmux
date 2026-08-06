/**
 * Transport-agnostic process handle behind a daemon session.
 *
 * A daemon session is NOT necessarily a local node-pty child. The data plane
 * (RingBuffer, OscParser, AgentDetector, ActivityMonitor, PromptEventLog,
 * DaemonPTYBridge's data handler, snapshot dump) operates entirely on the byte
 * stream and exit signal this surface exposes, so any transport that can
 * satisfy it can drive a pane. Today there are two implementations:
 *
 *   - local node-pty (`IPty`) — ConPTY on Windows, forkpty on POSIX. The
 *     original and still only kind a session could be before this interface.
 *   - `SshChannelSession` — an SSH channel to a remote box the operator owns
 *     (`ssh2`), used when a wmux.json leaf declares `kind: 'ssh'`.
 *
 * Why an interface and not a union: the bridge, the ring buffer, and the
 * session manager treat every session identically once it is created. The ONLY
 * places that care about the kind are the factory (`createSession`, which picks
 * the transport from `meta.kind`) and the resize/kill call sites (node-pty
 * injects SIGWINCH; an SSH channel sends a window-change request). Those
 * differences live inside the implementation, not at the call site.
 *
 * Structural compatibility: `IPty` satisfies this interface without an adapter
 * because node-pty's `onData`/`onExit` already return an `{ dispose(): void }`
 * and its exit payload shape matches `SessionExitEvent`. The local spawn site
 * therefore needs no wrapper — widening the stored type from `IPty` to
 * `SessionProcess` is the whole refactor at the data plane.
 *
 * The `kind` discriminator lets callers that genuinely must branch on transport
 * (recovery replay, capability advertisement) do so without `instanceof`.
 */
export interface SessionDisposable {
  dispose(): void;
}

/** Exit payload. node-pty emits `{ exitCode, signal }` with the same shape. */
export interface SessionExitEvent {
  exitCode: number;
  signal?: number | string;
}

/**
 * The minimal surface a daemon session's process exposes. Both `IPty`
 * (node-pty) and `SshChannelSession` (ssh2) implement this.
 */
export interface SessionProcess {
  /** Transport-specific identifier. Local: the OS pid. SSH: a synthetic id. */
  readonly pid: number;
  /** stdout/stderr bytes as a UTF-8 string (matches node-pty's string data). */
  onData(listener: (data: string) => void): SessionDisposable;
  /** Fired once when the underlying process/stream ends. */
  onExit(listener: (e: SessionExitEvent) => void): SessionDisposable;
  /** Write bytes to the child's stdin / SSH channel stdin. */
  write(data: string): void;
  /**
   * Deliver a geometry change. Local: SIGWINCH via ConPTY/TIOCSWINSZ. SSH: a
   * `window-change` request on the channel. Callers floor the geometry before
   * calling; the implementation applies it verbatim.
   */
  resize(cols: number, rows: number): void;
  /** Terminate the child / close the channel. Idempotent: a second call is a no-op. */
  kill(): void;
}

/**
 * The kind of transport a session runs over. Persisted on `DaemonSession` so
 * recovery replay, capability advertisement, and the factory can branch without
 * sniffing. `'local'` is the default for every record written before this
 * field existed, which is why the daemon treats an absent value as local.
 */
export type SessionKind = 'local' | 'ssh';

/**
 * Connection parameters for an SSH session. Carried on a wmux.json leaf and
 * threaded through createSession → SshChannelSession. Auth fields are pointers
 * (a key PATH, an agent flag), never secrets in the config — a password, when
 * used, is supplied in-memory at request time and never persisted.
 */
export interface SshSessionParams {
  host: string;
  port?: number;
  username: string;
  /** Path on the OPERATOR's machine to a private key file. Never a key's bytes. */
  privateKeyPath?: string;
  /** Use the SSH agent (SSH_AUTH_SOCK). Defaults to true when no other auth set. */
  agent?: boolean;
  /** Optional remote command to exec instead of an interactive shell. */
  remoteCommand?: string;
}

