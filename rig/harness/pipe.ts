// Verification rig — daemon pipe client (design §5 / G6)
//
// Connects to daemon control pipe via line-delimited JSON-RPC. Protocol refined by reading server source of truth
// `src/daemon/DaemonPipeServer.ts`:
//   - Framing: request·response both JSON one line delimited by `\n` (:398 split('\n'),
//     :478 write(JSON+'\n')). Responses correlated by `id` (broadcast event lines may interleave —
//     unmatched id·event lines ignored — dogfood rpcCall convention).
//   - Auth: every request has `token` field (:438-447 timingSafeEqual). Mismatch destroys socket.
//     Token read from `{home}/.wmux{suffix}/daemon-auth-token` (minted by daemon at boot).
//   - Dual ok layers (trap explicit in dogfood a2a-symmetric-reply-dogfood.mjs:92-109):
//     · Transport envelope `{id, ok, result}` — always ok:true if handler does not throw.
//     · Handler payload `result` — channel ops use `result.ok` (ChannelService Result<T>
//       discriminated union) for actual success/failure. `channelRpc()` promotes `result.ok===false` to throw.
//
// Persistent socket: dogfood per-call new socket hits daemon connection rate cap
// (`MAX_NEW_CONNECTIONS_PER_SEC = 20`, DaemonPipeServer:57), causing EPIPE storms under flood load
// (smoke verified: 32 of 80 posts dropped). So PipeClient keeps one long-lived socket and multiplexes RPCs by id —
// eliminates connection churn, only faces per-socket cap (50/sec) (1 socket per persona → 8ws=400/sec headroom). Reconnects lazily on disconnect.
//
// ── G6 honest-main rules (review reflected: bypass blocked) ─────────────────────────────────
// Public surface is exactly 2 — `rpc()` (unstamped) and `channelRpc()` (stamped). Raw send path
// (send/transact) is private so scenarios cannot bypass hygiene checks.
//   - `channelRpc()`: stamps only constructor-bound workspaceId as `verifiedWorkspaceId`.
//     Foreign ws self-claim·nested smuggling·`sender.workspaceId` mismatch → throw.
//   - `rpc()`: always enforces identity hygiene — `verifiedWorkspaceId` key anywhere in params tree → throw
//     (only channelRpc may stamp that key), reserved identity values in identity-class keys → throw.
//   - Reserved identities (ws-human/local-ui) rejected at constructor binding itself.
//
// Note (review confirmed judgment): blanket "all workspaceId == bound" ban is wrong — A2A's
// `to.workspaceId`, invite targets (invitedMember.workspaceId), create's members[] legitimately point at other ws.
// Harness forbids exactly two things:
//   (1) Caller identity fields — `verifiedWorkspaceId`(smuggling at any depth forbidden) +
//       `sender.workspaceId`(bound mismatch forbidden),
//   (2) Reserved identity values globally — `ws-human`/`local-ui` in identity-class keys
//       (workspaceId/memberId/*WorkspaceId/*MemberId).
//
// Zero test-only paths in product. Daemon trusts pre-stamped verifiedWorkspaceId verbatim
// (`channelCallerIdentity.ts:92-94` Rule 1) so SIM only mimics "honest main"; router gates not covered
// are honestly declared in §2.5 coverage map (rig blind spot).

import net from 'node:net';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Transport envelope — daemon pipe wraps every response with this. */
interface RpcEnvelope {
  id: string;
  ok: boolean;
  /** Handler return value when ok:true. Channel ops embed their own { ok, ... } Result. */
  result?: unknown;
  /** Transport-level error string when ok:false (unauthenticated·unknown method etc.). */
  error?: string;
}

/** One pending RPC correlated by id. */
interface Pending {
  resolve: (env: RpcEnvelope) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/** Reserved identities forbidden on daemon pipe (G6) — renderer-path-only seats. */
const RESERVED_WORKSPACE_IDS = new Set(['ws-human', 'local-ui']);

/** Identity-class key detection — keys scanned for reserved identity values (see header note block (2)). */
const isIdentityKey = (key: string): boolean =>
  key === 'workspaceId' ||
  key === 'memberId' ||
  key.endsWith('WorkspaceId') ||
  key.endsWith('MemberId');

/**
 * G6 identity hygiene walk — traverses full params tree to catch (a) `verifiedWorkspaceId` smuggling,
 * (b) reserved identity values in identity-class keys, and throw.
 *
 * @param allowRootVerified channelRpc path: true — top-level `verifiedWorkspaceId` exempt from walk because
 *   caller (channelRpc) already verified·stamped bound match. Nested positions still throw (no handler reads
 *   nested verifiedWorkspaceId; presence itself is smuggling attempt).
 */
function walkIdentityHygiene(node: unknown, nodePath: string, allowRootVerified: boolean): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkIdentityHygiene(v, `${nodePath}[${i}]`, allowRootVerified));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const p = nodePath ? `${nodePath}.${key}` : key;
    if (key === 'verifiedWorkspaceId' && !(allowRootVerified && nodePath === '')) {
      throw new Error(
        `[rig/pipe] G6: caller-supplied verifiedWorkspaceId at "${p}" — ` +
          'only channelRpc() owns the stamp (bound ws only). smuggling via rpc() or nested positions is forbidden',
      );
    }
    if (isIdentityKey(key) && typeof value === 'string' && RESERVED_WORKSPACE_IDS.has(value)) {
      throw new Error(
        `[rig/pipe] G6: reserved identity "${value}" in identity field "${p}" — ` +
          'persona must not claim or assign ws-human/local-ui in any position',
      );
    }
    walkIdentityHygiene(value, p, allowRootVerified);
  }
}

export interface PipeClientOptions {
  /** RPC response wait timeout (ms). Default 8s (dogfood convention). */
  readonly timeoutMs?: number;
}

/**
 * Daemon pipe RPC client. Keeps one persistent socket and multiplexes RPCs by id.
 *
 * Honest-main rules (G6): this client represents exactly one workspaceId. Public surface is only
 * `rpc()`/`channelRpc()` and both enforce identity hygiene — persona attempting other ws or reserved
 * identity throws before socket (not product bypass — harness contract).
 */
export class PipeClient {
  private readonly pipePath: string;
  private readonly tokenPath: string;
  private readonly workspaceId: string;
  private readonly timeoutMs: number;

  private sock: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buf = '';
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  /**
   * @param pipePath      Daemon control pipe address (RigContext.daemonPipePath).
   * @param tokenPath     Daemon auth token file path (RigContext.daemonTokenPath).
   * @param workspaceId   Persona workspaceId this client represents (G6 binding).
   *                      Rejects reserved identities (ws-human/local-ui) at construction.
   */
  constructor(pipePath: string, tokenPath: string, workspaceId: string, opts: PipeClientOptions = {}) {
    if (RESERVED_WORKSPACE_IDS.has(workspaceId)) {
      throw new Error(
        `[rig/pipe] G6: refusing to bind PipeClient to reserved identity "${workspaceId}" ` +
          '(persona mimics honest-main — reserved identity impersonation forbidden)',
      );
    }
    if (!workspaceId || !workspaceId.trim()) {
      throw new Error('[rig/pipe] PipeClient requires a non-empty workspaceId (G6 honest-main binding)');
    }
    this.pipePath = pipePath;
    this.tokenPath = tokenPath;
    this.workspaceId = workspaceId;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /** Bound workspaceId (read-only exposure — for assertion correlation). */
  get ws(): string {
    return this.workspaceId;
  }

  /** Closes socket and rejects all pending RPCs (recommended on teardown). */
  close(): void {
    this.closed = true;
    const s = this.sock;
    this.sock = null;
    if (s) {
      try {
        s.destroy();
      } catch {
        /* noop */
      }
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('[rig/pipe] client closed'));
    }
    this.pending.clear();
  }

  /**
   * Unstamped RPC (identity-agnostic calls like daemon.ping). **Identity hygiene always enforced** (G6):
   * `verifiedWorkspaceId` anywhere in params tree → throw — only channelRpc() may carry that key.
   * Reserved identity values in identity-class keys → throw.
   * Strips transport envelope and returns handler payload (result).
   */
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    walkIdentityHygiene(params, '', /* allowRootVerified */ false);
    return this.send(method, { ...params });
  }

  /**
   * Channel/principal RPC. Stamps bound workspaceId as `verifiedWorkspaceId`, then checks handler payload
   * discriminated union: `result.ok===false` → throw as ChannelError (test sees failure reason immediately),
   * ok:true → returns full payload.
   *
   * G6 enforcement: (1) top-level `verifiedWorkspaceId` must match bound (foreign ws self-claim → throw),
   * (2) nested smuggling → throw, (3) if `sender.workspaceId` present, bound mismatch → throw
   * (same direction as source post sender-pin gate — harness catches first),
   * (4) reserved identity values globally → throw.
   */
  async channelRpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const finalParams: Record<string, unknown> = { ...params };

    // (1) Top-level verifiedWorkspaceId — only bound match allowed (equivalent to stamp), other values are G6 violation.
    const claimed = finalParams['verifiedWorkspaceId'];
    if (typeof claimed === 'string' && claimed.length > 0 && claimed !== this.workspaceId) {
      throw new Error(
        `[rig/pipe] G6: persona bound to "${this.workspaceId}" attempted to stamp foreign ` +
          `verifiedWorkspaceId "${claimed}"`,
      );
    }

    // (3) Caller identity field sender.workspaceId — bound mismatch is G6 violation.
    //     (createdBy/member pinned by daemon via verifiedWorkspaceId (D5) — no separate ban needed;
    //      sender is post sender-pin gate input so harness explicitly rejects first.)
    const sender = finalParams['sender'];
    if (sender !== null && typeof sender === 'object' && !Array.isArray(sender)) {
      const sws = (sender as Record<string, unknown>)['workspaceId'];
      if (typeof sws === 'string' && sws.length > 0 && sws !== this.workspaceId) {
        throw new Error(
          `[rig/pipe] G6: sender.workspaceId "${sws}" disagrees with bound workspace ` +
            `"${this.workspaceId}" — persona may only send as its own identity`,
        );
      }
    }

    // (2)+(4) Tree hygiene — nested verifiedWorkspaceId smuggling·reserved identity values.
    walkIdentityHygiene(finalParams, '', /* allowRootVerified */ true);

    // Stamp (confirm with bound value).
    finalParams['verifiedWorkspaceId'] = this.workspaceId;

    const result = await this.send(method, finalParams);
    if (result === null || typeof result !== 'object') {
      throw new Error(`[rig/pipe] ${method} returned non-object payload: ${JSON.stringify(result)}`);
    }
    const payload = result as Record<string, unknown>;
    if (payload['ok'] === false) {
      const err = payload['error'];
      const detail =
        err && typeof err === 'object' ? JSON.stringify(err) : String(err ?? 'unknown channel error');
      throw new Error(`[rig/pipe] ${method} rejected: ${detail}`);
    }
    return payload;
  }

  private readToken(): string {
    try {
      return fs.readFileSync(this.tokenPath, 'utf8').trim();
    } catch {
      return '';
    }
  }

  /**
   * Raw send (private — no public path bypassing hygiene checks). Strips transport envelope,
   * returns `result`; envelope-level failure (unauthenticated·unknown method) → throw.
   */
  private async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const envelope = await this.transact(method, params);
    if (!envelope.ok) {
      throw new Error(`[rig/pipe] transport failure on ${method}: ${envelope.error ?? 'unknown'}`);
    }
    return envelope.result;
  }

  /**
   * Ensures persistent socket (connects if missing). Shares same Promise while connecting. On disconnect,
   * rejects pending RPCs and clears socket so next call reconnects.
   */
  private ensureSocket(): Promise<net.Socket> {
    if (this.closed) return Promise.reject(new Error('[rig/pipe] client closed'));
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection(this.pipePath);
      sock.setEncoding('utf8');
      const onConnectErr = (e: Error): void => {
        this.connecting = null;
        reject(e);
      };
      sock.once('error', onConnectErr);
      sock.once('connect', () => {
        sock.removeListener('error', onConnectErr);
        this.sock = sock;
        this.connecting = null;
        this.attach(sock);
        resolve(sock);
      });
    });
    return this.connecting;
  }

  /** Attaches data/close handlers to socket (response framing + connection teardown cleanup). */
  private attach(sock: net.Socket): void {
    sock.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg: RpcEnvelope;
        try {
          msg = JSON.parse(line) as RpcEnvelope;
        } catch {
          continue;
        }
        // Ignore broadcast event lines (no id) or unmatched ids.
        if (typeof msg.id !== 'string') continue;
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    });
    const onGone = (): void => {
      if (this.sock === sock) this.sock = null;
      this.buf = '';
      // Reject all pending RPCs on this socket → caller decides retry/failure.
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error(`[rig/pipe] connection lost before ${p.method} responded`));
      }
    };
    sock.once('close', onGone);
    sock.once('error', onGone);
  }

  /** Sends one RPC over persistent socket and waits for id-matched response. */
  private async transact(method: string, params: Record<string, unknown>): Promise<RpcEnvelope> {
    const sock = await this.ensureSocket();
    const token = this.readToken();
    const id = randomUUID();
    return new Promise<RpcEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[rig/pipe] rpc timeout (${this.timeoutMs}ms): ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        sock.write(JSON.stringify({ id, method, params, token }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }
}
