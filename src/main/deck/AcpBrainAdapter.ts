// ─── AcpBrainAdapter — generic ACP brain (BYOB M2, first target: Hermes) ────
//
// Speaks the Agent Client Protocol (agentclientprotocol.com): JSON-RPC 2.0
// over the agent subprocess's stdio, newline-delimited. ACP is the Zed /
// JetBrains editor-agent standard; Hermes Agent (Nous Research) implements it
// natively (`hermes acp`), and any other ACP-speaking agent plugs into this
// SAME adapter — the "connect an agent" picker grows by configuration, not by
// new adapter code.
//
// Contract mapping (BrainAdapter 5-event vocabulary):
//   session/update agent_message_chunk      → text-delta
//   session/update tool_call                → tool-start
//   session/update tool_call_update(done)   → tool-end
//   session/prompt response (stopReason)    → turn-end  (sessionId for resume)
//   JSON-RPC error / spawn failure          → error
//
// Fleet hands: the wmux MCP bundle is injected PER SESSION via ACP
// `session/new`'s mcpServers parameter — command args carry `--commander`
// (P4 Layer 1: reduced tool surface, arg not env) and the env carries the
// per-spawn commander token (P4 Layer 2 / allow lane: this is what lets a
// non-first-party host operate under production enforce mode). Token
// lifecycle follows the adapter contract from the P4 review: minted in the
// constructor, revoked on dispose — a dead brain's child fails closed at the
// router on its stale token.
//
// Zero-API stance: wmux never handles the brain's model credentials. ACP
// `initialize` advertises authMethods; when the agent is unauthenticated the
// turn surfaces a clear error telling the user to run the vendor's own setup
// (the connect UX opens a pane for that).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { BrainAdapter, BrainEvent, BrainSendOptions, BrainStartOptions, BrainUsage } from './BrainAdapter';
import { mintBotToken, mintCommanderToken, revokeCommanderToken } from './commanderTrust';
import { writeBotTokenHandoff, type BotTokenHandoff } from '../factory/botTokenHandoff';
import type { BotBinding } from '../../shared/bot';
import { COMMANDER_MODE_ARG } from '../../shared/commanderSurface';
import { getWmuxDir } from '../../daemon/config';
import { stopAgentTree } from './agentTreeStop';
import { HERMES_MCP_MISSING_LEAD, HERMES_TOOLS_CHANGED_LEAD } from '../factory/engineError';

// ── wire types (structural subset of ACP; validated defensively) ────────────

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

export interface AcpSpawnSpec {
  /** Executable (e.g. 'hermes'). Resolved against PATH by spawn. */
  command: string;
  /** Arguments that put the agent into ACP stdio mode (e.g. ['acp']). */
  args: string[];
}

export interface AcpBrainAdapterDeps {
  /** How to launch the ACP agent. */
  spawnSpec: AcpSpawnSpec;
  /** The one workspace this brain serves (M1.5 confinement; commander token
   *  binding). Empty/omitted mints an unroutable token — fail closed. */
  workspaceId?: string;
  /** Absolute path to the wmux MCP stdio bundle, or null for no fleet hands. */
  mcpBundlePath?: string | null;
  /** Injected spawner for tests (returns a fake child). */
  spawnFn?: (command: string, args: string[]) => ChildProcessWithoutNullStreams;
  /** Per-request timeout (initialize / session lifecycle), ms. */
  requestTimeoutMs?: number;
  /** session/prompt timeout override (tests). See PROMPT_TIMEOUT_MS. */
  promptTimeoutMs?: number;
  /** Fresh-session settle override (tests: 0). See NEW_SESSION_SETTLE_MS. */
  newSessionSettleMs?: number;
  /** Own mode: the cancel bound override (tests). See OWN_CANCEL_BOUND_MS. */
  ownCancelBoundMs?: number;
  /** Own mode, POSIX: how the agent and what it started are stopped
   *  (default agentTreeStop.ts stopAgentTree; tests). */
  stopAgentTree?: (pid: number) => Promise<void>;
  /** Agent factory bot mode: the session runs as this bot. The token is a
   *  bot token, handed to each MCP child in a fresh 0600 file named in its
   *  args (`--bot=<role>`, `--bot-token-file=`), never in its environment;
   *  the agent process and its sessions run in `cwd` (the bot's own folder).
   *  `workspaceId` is ignored. */
  bot?: { binding: BotBinding; cwd: string; wmuxDir?: string };
  /** Extra environment for the agent process (e.g. ELECTRON_RUN_AS_NODE for
   *  a node script run on the Electron binary). */
  spawnEnv?: Record<string, string>;
  /** The Hermes preset (main/factory/hermesHost.ts). Absent: a generic ACP
   *  agent, whose permission requests are refused. */
  hermes?: AcpHermesPolicy;
}

/** What the Hermes preset changes in the adapter. Hermes runs each turn in a
 *  gateway process the ACP child only views (killing the child does not stop
 *  the turn), so a stop is a `session/cancel` that waits for the turn to
 *  settle, and an unanswered permission request stays live until answered. */
export interface AcpHermesPolicy {
  /** `own`: the owner's own Hermes profile (main/factory/myHermesHost.ts),
   *  whose gateway wmux never stops. Absent: wmux's managed Hermes. */
  mode?: 'managed' | 'own';
  /** Before each agent spawn: readiness, the settings read back and the
   *  gateway check. `env` replaces the agent's whole environment; `args`,
   *  when given, replace spawnSpec's. */
  prepare(): Promise<{ ok: true; env: Record<string, string>; exe?: string; args?: string[] } | { ok: false; message: string }>;
  /** After session/new or session/load: an error that ends the turn, or null. */
  sessionStarted(): string | null;
  /** The owner's answer to the agent's permission request (an approval
   *  card); false on deny, expiry or `signal` aborting. */
  askOwner(req: { title: string; command: string }, signal: AbortSignal): Promise<boolean>;
  /** Whether the bot may hold the tool `name`. */
  toolAllowed(name: string): boolean;
  /** Resolves true once the session's MCP child called main with `token`
   *  after `since` (ms). */
  mcpReady(token: string, since: number): Promise<boolean>;
  /** A turn did not settle after a cancel: stop the gateway that runs it.
   *  Own mode: the turn did not end within OWN_CANCEL_BOUND_MS and wmux let
   *  its own agent process go (the gateway is never stopped); tell the owner. */
  unsettled(): Promise<void>;
  /** The adapter is gone (unregister from quit). */
  disposed?(adapter: AcpBrainAdapter): void;
  /** Own mode: the bot's turn gate, shared by every adapter the bot gets (a
   *  new session waits for the last one's turn too). Absent: the adapter's own. */
  turnGate?: { ended: Promise<void> | null };
}

/** How long a cancelled Hermes turn may take to settle before its gateway is stopped. */
const HERMES_SETTLE_MS = 10_000;
/** Own mode: how long a cancelled turn may take to end in Hermes before wmux
 *  lets go of the `hermes acp` process it spawned for the bot (never the
 *  owner's gateway). Hermes's cancel interrupts the agent and its running
 *  tools, so a turn that heeds it ends within seconds; past this bound it is
 *  taken as wedged. It holds the bot (and its profile's turn gate) at most
 *  this long after a stop, a timeout or a dispose. */
const OWN_CANCEL_BOUND_MS = 60_000;

/** The tool name in a Hermes tool_call title (`<tool>: <preview>`, or the
 *  bare name; Hermes acp_adapter/tools.py build_tool_title). Pure. */
export function hermesToolName(title: unknown): string {
  if (typeof title !== 'string') return '';
  const i = title.indexOf(': ');
  return (i >= 0 ? title.slice(0, i) : title).trim();
}

/** The tool names in Hermes's `/tools` answer ("Available tools (N):" then
 *  "  <toolset>: a, b" lines), or null when it does not read so: no header,
 *  or a name count other than N (a changed format reads as unknown). Pure. */
export function parseHermesToolsList(text: string): string[] | null {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => /^Available tools \(\d+\):/.test(l.trim()));
  if (head < 0) return null;
  const count = Number(/\((\d+)\)/.exec(lines[head])?.[1]);
  const names: string[] = [];
  for (const line of lines.slice(head + 1)) {
    const m = /^\s+[^:]+:\s*(.+)$/.exec(line);
    if (!m) continue;
    for (const n of m[1].split(',')) if (n.trim()) names.push(n.trim());
  }
  return names.length > 0 && names.length === count ? names : null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** A prompt turn can legitimately run for minutes (agentic tool loops). */
const PROMPT_TIMEOUT_MS = 10 * 60_000;
/** Fresh-session settle before the first prompt — see the spawn-race note in
 *  ensureSession. Empirically sufficient on the dogfood machine (probes with
 *  a gap always passed; immediate prompts always wedged). */
const NEW_SESSION_SETTLE_MS = 5_000;
/** stdout framing cap — see onStdout. */
const MAX_STDOUT_BUFFER_CHARS = 8 * 1024 * 1024;

/** Extract the plain-text pieces of an ACP content block array. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  const blocks = Array.isArray(content) ? content : [content];
  let out = '';
  for (const b of blocks) {
    if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text') {
      const t = (b as Record<string, unknown>).text;
      if (typeof t === 'string') out += t;
    }
  }
  return out;
}

export class AcpBrainAdapter implements BrainAdapter {
  private readonly deps: AcpBrainAdapterDeps;
  private readonly _commanderToken: string;
  private readonly _workspaceId: string;
  /** Bot mode: the hand-off files written for MCP children, removed on dispose. */
  private readonly handoffs: BotTokenHandoff[] = [];

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (r: JsonRpcMessage) => void; timer: NodeJS.Timeout }>();
  private stdoutBuf = '';
  /** Events pushed by session/update notifications during the in-flight turn. */
  private turnSink: ((ev: BrainEvent) => void) | null = null;
  /** tool_call id → name, so tool_call_update can emit a named tool-end. */
  private toolNames = new Map<string, string>();
  private _sessionId: string | null = null;
  /** Whether _sessionId is attached to the CURRENT child process. Reset on
   *  respawn — session/load runs once per child, never per send (a load
   *  replays the whole transcript on some agents; re-loading every turn made
   *  latency grow with history — Codex review P2). */
  private _sessionAttached = false;
  /** A disk-seeded resume id is unvalidated until a prompt succeeds against
   *  it; some agents report an unknown id as a SUCCESSFUL empty load, so the
   *  failure only surfaces at prompt time (Codex review P2). */
  private _resumeUnvalidated = false;
  private _startOptions: BrainStartOptions = {};
  private _initialized = false;
  private _disposed = false;
  /** Hermes: the environment `prepare` gave the next spawn. */
  private hermesEnv: Record<string, string> | null = null;
  /** Hermes: the executable `prepare` verified, spawned instead of spawnSpec's. */
  private hermesExe: string | null = null;
  /** Hermes: the args `prepare` gave, used instead of spawnSpec's. */
  private hermesArgs: string[] | null = null;
  /** Hermes: the in-flight session/prompt, so a stop can wait for it. */
  private promptInFlight: Promise<JsonRpcMessage> | null = null;
  /** Hermes: the one permission request waiting for the owner. */
  private pendingPermission: { id: number | string; rejectId: string | null; abort: AbortController } | null = null;
  /** Hermes: a tool outside the allowlist started in this turn. */
  private drift: string | null = null;
  /** Hermes: sessions whose tools were checked after their first turn. */
  private toolsChecked = new Set<string>();
  private shutdownPromise: Promise<void> | null = null;
  /** Own mode: prompts whose request timed out, still waiting for Hermes's
   *  answer (id → the end of that turn). */
  private late = new Map<number | string, () => void>();
  /** Own mode: the end of the last prompt's turn, until Hermes reports it
   *  (its answer, or the agent going). A new turn waits for it. The policy's
   *  gate when it has one (AcpHermesPolicy.turnGate). */
  private localGate: { ended: Promise<void> | null } = { ended: null };
  /** Own mode: bumped by every stop (interrupt, dispose). A send that was
   *  waiting for the last turn's end when the bot was stopped sends nothing. */
  private ownEpoch = 0;
  /** Own mode: sends waiting at the gate, woken by a stop. */
  private ownStopWaiters = new Set<() => void>();
  /** Own mode: the end of this adapter's turn still running in Hermes, until
   *  Hermes reports it (the gate's `ended` while this adapter holds it). */
  private ownTurn: Promise<void> | null = null;
  /** Own mode: the turn whose cancel is being watched (watchOwnCancel). */
  private ownCancelWatched: Promise<void> | null = null;

  constructor(deps: AcpBrainAdapterDeps) {
    this.deps = deps;
    this._workspaceId = deps.bot ? deps.bot.binding.workspaceId : deps.workspaceId ?? '';
    // P4 token lifecycle contract: mint at construction, revoke at dispose.
    // My Hermes: the bot's token reaches room.post only (RpcRouter), and
    // its MCP child lists room_post only.
    this._commanderToken = deps.bot ? mintBotToken(deps.bot.binding, deps.hermes?.mode === 'own' ? 'room-post' : undefined) : mintCommanderToken(this._workspaceId);
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Own mode: the bot's turn gate. */
  private gate(): { ended: Promise<void> | null } {
    return this.deps.hermes?.turnGate ?? this.localGate;
  }

  /** The owner's own Hermes (own mode): the gateway is never stopped. */
  private own(): boolean {
    return this.deps.hermes?.mode === 'own';
  }

  start(opts: BrainStartOptions): void {
    this._startOptions = opts;
    if (opts.resumeSessionId) {
      this._sessionId = opts.resumeSessionId;
      this._resumeUnvalidated = true;
    }
  }

  // ── subprocess + JSON-RPC plumbing ─────────────────────────────────────

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const spawnFn =
      this.deps.spawnFn ??
      ((cmd: string, args: string[]) =>
        spawn(cmd, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // The agent's PROCESS cwd, not just the ACP session cwd: agents
          // gather workspace context (git probes) from their own cwd, and
          // inheriting electron main's cwd hands them the wmux repo — where
          // a git probe raced hermes's own spawn handling into a permanent
          // post-kill communicate() deadlock (py-spy, 2026-07-17). A non-repo
          // data-dir cwd makes the workspace probe a no-op.
          cwd: this.sessionCwd(),
          // Hermes: an allowlisted environment, never main's (hermesEngine.ts hermesEnv).
          ...(this.hermesEnv ? { env: { ...this.hermesEnv } } : this.deps.spawnEnv ? { env: { ...process.env, ...this.deps.spawnEnv } } : {}),
        }));
    const child = spawnFn(this.hermesExe ?? this.deps.spawnSpec.command, this.hermesArgs ?? this.deps.spawnSpec.args);
    this.child = child;
    this._initialized = false;
    this._sessionAttached = false;
    this.stdoutBuf = '';
    // StringDecoder keeps a multi-byte UTF-8 character split across chunk
    // boundaries intact (Buffer.toString would emit replacement chars and
    // corrupt the JSON frame — CodeRabbit, PR #477).
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (d: Buffer) => this.onStdout(decoder.write(d)));
    // The agent's stderr is its diagnostic channel (ACP reserves stdout for
    // JSON-RPC). Mirror it into the main log, truncated + line-capped, so a
    // wedged brain leaves evidence instead of a silent 10-minute timeout.
    let stderrLines = 0;
    child.stderr.on('data', (d: Buffer) => {
      if (stderrLines > 400) return;
      for (const line of d.toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        stderrLines++;
        if (stderrLines <= 400) {
          console.warn(`[acp-brain:${this.deps.spawnSpec.command}] ${t.slice(0, 300)}`);
        } else if (stderrLines === 401) {
          // In-loop cap check so a single huge chunk can't blow past the
          // limit, and the truncation is visible instead of silent.
          console.warn(`[acp-brain:${this.deps.spawnSpec.command}] (stderr mirror capped at 400 lines)`);
          break;
        }
      }
    });
    child.on('error', (err: Error) => {
      // Spawn/IO error: mark the child unusable so the next turn respawns
      // deterministically (an 'error' without 'exit' would otherwise leave a
      // half-alive handle that ensureChild considers healthy).
      if (this.child === child) {
        this.child = null;
        this.endLateTurns();
      }
      // Spawn failure (agent binary not installed / not on PATH) must surface
      // as a fast, readable error — not a 30s request timeout. The connect UX
      // keys its "not installed" hint off this message.
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ error: { message: `failed to launch ${this.deps.spawnSpec.command}: ${err.message}` } });
      }
      this.pending.clear();
    });
    child.on('exit', () => {
      // Fail every in-flight request so a crashed agent surfaces as an error
      // event instead of a hung turn — but ONLY while this child is still the
      // current one. A killed/replaced child's DELAYED exit must not clear
      // the replacement's pending requests (CodeRabbit, PR #477); after
      // killChildTree detached it, its stragglers are already handled.
      if (this.child !== child) return;
      this.child = null;
      // Its permission request went with it: the card stops waiting.
      this.dropPendingPermission();
      this.endLateTurns();
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ error: { message: 'ACP agent process exited' } });
      }
      this.pending.clear();
    });
    return child;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    // Framing-edge guard: a buggy agent emitting an enormous newline-less
    // line (or binary noise) must not grow main-process memory unboundedly —
    // the orchestrator brain must never be able to OOM the whole app (GLM
    // review). Well past any legitimate ACP frame.
    if (this.stdoutBuf.length > MAX_STDOUT_BUFFER_CHARS) {
      this.stdoutBuf = '';
      console.error(
        `[acp-brain:${this.deps.spawnSpec.command}] stdout frame exceeded ` +
        `${MAX_STDOUT_BUFFER_CHARS} chars without a newline — killing the agent (protocol violation)`,
      );
      this.killChildTree();
      return;
    }
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        const parsed: unknown = JSON.parse(line);
        // JSON.parse happily returns null / numbers / arrays — dereferencing
        // those as a message object would throw inside the stdout data
        // handler and crash main (CodeRabbit, PR #477).
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        msg = parsed as JsonRpcMessage;
      } catch {
        continue; // non-protocol noise on stdout — ignore defensively
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests: judged by result/error presence AND a
    // matching pending id — never by the absence of `method` (some agents
    // echo it on responses, which would misroute the response as a
    // notification and hang the turn until the prompt timeout — GLM review).
    if (
      msg.id !== undefined &&
      (msg.result !== undefined || msg.error !== undefined) &&
      this.pending.has(msg.id)
    ) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
      return;
    }
    // Own mode: Hermes answers a prompt whose request had timed out: that
    // turn has ended now.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.late.has(msg.id)) {
      const ended = this.late.get(msg.id);
      this.late.delete(msg.id);
      ended?.();
      return;
    }
    // Agent → client REQUEST (has id + method): answer the small surface we
    // support; refuse the rest. Permission prompts are DENIED: an ACP agent
    // asks permission precisely when IT considers an action dangerous (its
    // own terminal/process/file tools, delegation), and this brain runs
    // headless — there is no human on this channel to consent, and a blanket
    // allow would let pane-output prompt injection reach the agent's native
    // shell outside every wmux gate (Codex review P1). The wmux fleet tools
    // ride MCP, which does not pass through here — denying costs the brain
    // nothing it is supposed to have.
    if (msg.id !== undefined && msg.method !== undefined) {
      if (msg.method === 'session/request_permission' && this.deps.hermes) {
        this.onHermesPermission(msg.id, msg.params ?? {});
      } else if (msg.method === 'session/request_permission') {
        const options = (msg.params?.options ?? []) as Array<Record<string, unknown>>;
        const reject = options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
        console.warn(
          `[acp-brain:${this.deps.spawnSpec.command}] denied a native-tool permission request (headless commander)`,
        );
        this.writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: reject
            ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
            : { outcome: { outcome: 'cancelled' } },
        });
      } else {
        this.writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `client does not support ${msg.method}` },
        });
      }
      return;
    }
    // Notification.
    if (msg.method === 'session/update') this.onSessionUpdate(msg.params ?? {});
  }

  /** A Hermes permission request. Under Hermes's gateway a cancelled or
   *  dropped answer is no answer: the request stays live (and is shown again
   *  to the next viewer) until Hermes's own timeout, so every request gets an
   *  explicit reject unless the owner approves it on its card. Only command
   *  and edit approvals reach the owner; Hermes's clarify questions and model
   *  confirmations are rejected at once, as is a second request while one
   *  waits. The owner's card cannot be enforced inside Hermes: another viewer
   *  of the same Hermes home could answer the request first. */
  private onHermesPermission(id: number | string, params: Record<string, unknown>): void {
    const options = (Array.isArray(params.options) ? params.options : []) as Array<Record<string, unknown>>;
    const optionId = (kind: string): string | null => {
      const o = options.find((x) => x && x.kind === kind && typeof x.optionId === 'string');
      return o ? (o.optionId as string) : null;
    };
    const rejectId = optionId('reject_once') ?? optionId('reject_always');
    const reject = (): void => this.writeMessage({
      jsonrpc: '2.0',
      id,
      result: rejectId ? { outcome: { outcome: 'selected', optionId: rejectId } } : { outcome: { outcome: 'cancelled' } },
    });
    const tc = (params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : {}) as Record<string, unknown>;
    const toolCallId = typeof tc.toolCallId === 'string' ? tc.toolCallId : '';
    const kind = typeof tc.kind === 'string' ? tc.kind : '';
    const asksOwner = toolCallId.startsWith('perm-check-') || kind === 'execute' || kind === 'edit';
    if (!asksOwner || this.pendingPermission || this._disposed) {
      reject();
      return;
    }
    const allowId = optionId('allow_once');
    const raw = (tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {}) as Record<string, unknown>;
    const title = typeof tc.title === 'string' ? tc.title : '';
    const command = typeof raw.command === 'string' && raw.command ? raw.command : title;
    const abort = new AbortController();
    const pending = { id, rejectId, abort };
    this.pendingPermission = pending;
    const hermes = this.deps.hermes as AcpHermesPolicy;
    void hermes.askOwner({ title, command }, abort.signal).catch(() => false).then((approved) => {
      if (this.pendingPermission !== pending) return; // answered (rejected) by a stop already
      this.pendingPermission = null;
      if (approved && allowId) this.writeMessage({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: allowId } } });
      else reject();
    });
  }

  /** Forget the waiting permission request (its agent is gone): the card is withdrawn. */
  private dropPendingPermission(): void {
    const p = this.pendingPermission;
    this.pendingPermission = null;
    p?.abort.abort();
  }

  /** Reject the permission request waiting for the owner, if any. */
  private rejectPendingPermission(): void {
    const p = this.pendingPermission;
    if (!p) return;
    this.pendingPermission = null;
    p.abort.abort();
    this.writeMessage({
      jsonrpc: '2.0',
      id: p.id,
      result: p.rejectId ? { outcome: { outcome: 'selected', optionId: p.rejectId } } : { outcome: { outcome: 'cancelled' } },
    });
  }

  private onSessionUpdate(params: Record<string, unknown>): void {
    const sink = this.turnSink;
    if (!sink) return; // update outside a turn — nothing to render into
    const update = (params.update ?? params) as Record<string, unknown>;
    const kind = update.sessionUpdate ?? update.session_update;
    switch (kind) {
      case 'agent_message_chunk': {
        const text = textOfContent(update.content);
        if (text) sink({ type: 'text-delta', text });
        return;
      }
      case 'tool_call': {
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
        // Hermes: a started tool outside the allowlist ends the turn. A
        // permission card's own tool_call (`perm-check-*`) is not a tool.
        if (this.deps.hermes && !(toolCallId ?? '').startsWith('perm-check-')) {
          // A tool call without a title cannot be checked: it counts as drift.
          const tool = hermesToolName(update.title) || '(untitled tool)';
          if (!this.deps.hermes.toolAllowed(tool) && !this.drift) {
            this.drift = tool;
            console.warn(`[acp-brain:${this.deps.spawnSpec.command}] tool outside the allowlist started: ${tool.slice(0, 80)}`);
            this.interrupt();
          }
        }
        const name =
          (typeof update.title === 'string' && update.title) ||
          (typeof update.kind === 'string' && update.kind) ||
          'tool';
        if (toolCallId) this.toolNames.set(toolCallId, name);
        sink({
          type: 'tool-start',
          name,
          inputSummary: typeof update.title === 'string' ? update.title : '',
          ...(toolCallId ? { toolId: toolCallId } : {}),
        });
        return;
      }
      case 'tool_call_update': {
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
        const status = update.status;
        // Only terminal states close the chip; in_progress updates are noise
        // for the deck's chip model.
        if (status !== 'completed' && status !== 'failed') return;
        sink({
          type: 'tool-end',
          name: (toolCallId && this.toolNames.get(toolCallId)) || 'tool',
          ok: status === 'completed',
          ...(toolCallId ? { toolId: toolCallId } : {}),
        });
        return;
      }
      default:
        return; // plan / thought chunks — not part of the 5-event vocabulary yet
    }
  }

  private writeMessage(msg: JsonRpcMessage): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin.write(JSON.stringify(msg) + '\n');
    } catch {
      /* a dead pipe surfaces via the exit handler */
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    /** Own mode, a prompt: told when its turn really ends (the answer, even
     *  one that arrives after the request timed out, or the agent going). */
    onEnded?: () => void,
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Own mode: the answer can still come while the agent runs; with no
        // agent (it went before the prompt was written) none ever will.
        if (onEnded) {
          if (this.child) this.late.set(id, onEnded);
          else onEnded();
        }
        resolve({ error: { message: `ACP request timed out: ${method}` } });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => {
          resolve(m);
          // Answered in time: the turn ended with it. (A timed-out request is
          // resolved by its timer, never here.)
          onEnded?.();
        },
        timer,
      });
      this.writeMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Own mode: every turn still waiting for Hermes's answer ends (the agent
   *  went, or the adapter was disposed). */
  private endLateTurns(): void {
    for (const [, ended] of this.late) ended();
    this.late.clear();
  }

  // ── session lifecycle ───────────────────────────────────────────────────

  /** The agent's process and session cwd: the bot's folder, else the data dir. */
  private sessionCwd(): string {
    return this.deps.bot?.cwd ?? getWmuxDir();
  }

  private mcpServersParam(): Array<Record<string, unknown>> {
    if (!this.deps.mcpBundlePath) return [];
    const suffixEnv = process.env.WMUX_DATA_SUFFIX
      ? [{ name: 'WMUX_DATA_SUFFIX', value: process.env.WMUX_DATA_SUFFIX }]
      : [];
    if (this.deps.bot) {
      // One hand-off per MCP child: every session/new or session/load starts one.
      // Hermes starts this command twice per session (discovery, then its
      // turns), so the file stays until dispose.
      const handoff = writeBotTokenHandoff(this.deps.bot.binding, this._commanderToken, { dir: this.deps.bot.wmuxDir, keep: !!this.deps.hermes, ...(this.own() ? { surface: 'room-post' as const } : {}) });
      this.handoffs.push(handoff);
      return [
        {
          name: 'wmux',
          command: process.execPath,
          args: [this.deps.mcpBundlePath, ...handoff.mcpArgs],
          env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, ...suffixEnv],
        },
      ];
    }
    return [
      {
        name: 'wmux',
        command: process.execPath,
        // P4 Layer 1: --commander is an ARG so an env-stripping host cannot
        // widen the tool surface; the token env below is the workspace
        // binding + the enforce-mode allow lane (Layer 2).
        args: [this.deps.mcpBundlePath, COMMANDER_MODE_ARG],
        env: [
          { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
          { name: 'WMUX_COMMANDER_TOKEN', value: this._commanderToken },
          ...suffixEnv,
        ],
      },
    ];
  }

  private async ensureSession(): Promise<string | { error: string }> {
    const hermes = this.deps.hermes;
    if (hermes && !(this.child && this.child.exitCode === null && !this.child.killed)) {
      const prepared = await hermes.prepare();
      if (!prepared.ok) return { error: prepared.message };
      this.hermesEnv = prepared.env;
      this.hermesExe = prepared.exe ?? null;
      this.hermesArgs = prepared.args ? [...prepared.args] : null;
    }
    this.ensureChild();
    if (!this._initialized) {
      const init = await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      if (init.error) return { error: `ACP initialize failed: ${init.error.message ?? 'unknown'}` };
      this._initialized = true;
    }
    if (this._sessionId && this._sessionAttached) return this._sessionId;
    if (this._sessionId) {
      // Resume the persisted conversation ONCE per child; a dead/unknown id
      // falls back to a fresh session rather than bricking the commander
      // (same soft-resume contract as ClaudeSdkAdapter P3a). Some agents
      // report an unknown id as a successful empty load — that case is
      // caught at prompt time via _resumeUnvalidated (send()'s retry).
      const since = Date.now();
      const loaded = await this.request('session/load', {
        sessionId: this._sessionId,
        cwd: this.sessionCwd(),
        mcpServers: this.mcpServersParam(),
      });
      if (!loaded.error) {
        this._sessionAttached = true;
        const refused = await this.hermesSessionCheck(since);
        if (refused) return { error: refused };
        return this._sessionId;
      }
      this._sessionId = null;
    }
    // cwd is pinned to the wmux DATA dir, mirroring ClaudeSdkAdapter's P3a
    // stable-cwd rationale — and deliberately NOT a git repo. Live-debug
    // finding (py-spy, 2026-07-17): an ACP agent that gathers git "coding
    // workspace" context at prompt time can deadlock on Windows when its git
    // subprocess races the MCP child spawn (pipe handle inherited by the
    // concurrently-spawned child → git exits but its stdout never EOFs, the
    // agent joins that reader thread forever). A non-repo cwd ends the git
    // probe in milliseconds, closing the race window — and the brain's
    // workspace is the wmux FLEET, not whatever directory main happens to
    // run from.
    const since = Date.now();
    const created = await this.request('session/new', {
      cwd: this.sessionCwd(),
      mcpServers: this.mcpServersParam(),
    });
    const sid = created.result?.sessionId;
    if (created.error || typeof sid !== 'string' || sid.length === 0) {
      return { error: `ACP session/new failed: ${created.error?.message ?? 'no sessionId'}` };
    }
    this._sessionId = sid;
    this._sessionAttached = true;
    this._resumeUnvalidated = false;
    const refused = await this.hermesSessionCheck(since);
    if (refused) return { error: refused };
    // Windows spawn-race guard (live-debug finding, py-spy 2026-07-17): at
    // session start the agent boots its own MCP server subprocesses; a prompt
    // arriving IMMEDIATELY makes the agent's first-turn context gathering
    // (e.g. a `git` probe) spawn concurrently with those still-starting
    // long-lived children, and CPython's Windows Popen handle-inheritance
    // race can leak the short-lived probe's pipe handle into one of them —
    // the probe exits but its stdout never EOFs and the agent's turn thread
    // joins that reader forever (observed stack: coding_context._git →
    // communicate → join). Letting the spawn burst settle before the first
    // prompt closes the observed window; later turns reuse the session and
    // never hit it. Cost: one-time +settle on a brand-new brain session.
    const settle = this.deps.newSessionSettleMs ?? NEW_SESSION_SETTLE_MS;
    if (settle > 0) await new Promise((r) => setTimeout(r, settle));
    return sid;
  }

  /** Hermes, after session/new or session/load: the gateway check, then the
   *  session's MCP child must call main with this adapter's token (Hermes
   *  starts the session's servers while it opens the session; without its
   *  `mcp` extra it skips them and the bot would run without its tools). */
  private async hermesSessionCheck(since: number): Promise<string | null> {
    const hermes = this.deps.hermes;
    if (!hermes || !this.deps.mcpBundlePath) return null;
    const refused = hermes.sessionStarted();
    if (refused) {
      this._sessionAttached = false;
      return refused;
    }
    if (await hermes.mcpReady(this._commanderToken, since)) return null;
    this._sessionAttached = false;
    return `${HERMES_MCP_MISSING_LEAD} its session started, but the wmux tools never connected (if Hermes was installed without its MCP support, run \`hermes pm install --extra mcp\`)`;
  }

  /** Hermes, after a session's first completed turn: the tools it really
   *  holds (`/tools`, answered by Hermes without a model turn) must all be
   *  allowed. Null when they are; else the error that ends the bot's turn. */
  private async hermesToolsCheck(sessionId: string): Promise<string | null> {
    const hermes = this.deps.hermes;
    if (!hermes || this.toolsChecked.has(sessionId)) return null;
    let text = '';
    this.turnSink = (ev) => {
      if (ev.type === 'text-delta') text += ev.text;
    };
    try {
      const r = await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/tools' }] });
      if (r.error) return `${HERMES_TOOLS_CHANGED_LEAD} wmux could not read the tools of this Hermes session (${r.error.message ?? 'no answer'})`;
    } finally {
      this.turnSink = null;
    }
    const names = parseHermesToolsList(text);
    if (!names) return `${HERMES_TOOLS_CHANGED_LEAD} wmux could not read the tools of this Hermes session`;
    const outside = names.filter((n) => !hermes.toolAllowed(n));
    if (outside.length > 0) return `${HERMES_TOOLS_CHANGED_LEAD} ${outside.slice(0, 5).join(', ')}`;
    this.toolsChecked.add(sessionId);
    return null;
  }

  // ── the turn ────────────────────────────────────────────────────────────

  async *send(rawText: string, sendOpts?: BrainSendOptions): AsyncIterable<BrainEvent> {
    // This engine is not shown pictures: the text says the owner sent some.
    const photos = sendOpts?.images?.length ?? 0;
    const text = photos > 0
      ? `${rawText}\n\n(The owner attached ${photos === 1 ? 'a photo' : `${photos} photos`} to this message; this engine cannot show pictures. Say so if the photo matters.)`
      : rawText;
    if (this._disposed) {
      yield { type: 'error', message: 'commander session disposed' };
      return;
    }
    const own = this.own();
    const epoch = this.ownEpoch;
    if (own) {
      // The bot stays blocked while a cancelled turn has not ended in Hermes.
      // A stop while waiting ends this send: it never prompts afterwards.
      while (this.gate().ended && epoch === this.ownEpoch && !this._disposed) {
        const gate = this.gate().ended;
        if (!gate) break;
        let woke: () => void = () => undefined;
        await new Promise<void>((r) => {
          woke = r;
          this.ownStopWaiters.add(r);
          void gate.then(r, r);
        });
        this.ownStopWaiters.delete(woke);
      }
      if (this._disposed || epoch !== this.ownEpoch) return;
      // Fail closed: an own bot answers through its one wmux tool.
      if (!this.deps.mcpBundlePath) {
        yield { type: 'error', message: `${HERMES_MCP_MISSING_LEAD} the wmux tools are not available in this build` };
        return;
      }
    }

    // One-shot context injection on the first SUCCESSFUL turn (system prompt
    // + fleet snapshot ride the prompt — ACP has no separate system-prompt
    // channel). Composed once here; CONSUMED only when the turn completes,
    // so a failed first turn (agent not installed, spawn error, dead resume)
    // doesn't strip the brain of its policy for the next attempt
    // (CodeRabbit, PR #477).
    const parts: string[] = [];
    if (this._startOptions.systemPrompt) parts.push(this._startOptions.systemPrompt);
    if (this._startOptions.fleetContext) parts.push(this._startOptions.fleetContext);
    // Own mode: the owner's own message, nothing else (BotRuntime's own-mode
    // input boundary decides which messages reach here), with the line that
    // says a photo was not passed on.
    const prompt = own ? text : parts.length > 0 ? `${parts.join('\n\n---\n\n')}\n\n---\n\n${text}` : text;

    // At most two attempts: the first may run against a disk-seeded session
    // id that the agent no longer knows. Some agents report an unknown id as
    // a SUCCESSFUL empty load, so the failure only surfaces when the prompt
    // errors (Codex review P2) — mirror ClaudeSdkAdapter's resume fallback:
    // when an UNVALIDATED resume dies before producing any event, drop the
    // dead id and retry once on a fresh session.
    for (let attempt = 0; attempt < 2; attempt++) {
      const resumingUnvalidated = this._resumeUnvalidated && !!this._sessionId;
      const session = await this.ensureSession();
      if (typeof session !== 'string') {
        yield { type: 'error', message: session.error };
        return;
      }
      // Own mode: stopped while the session started; nothing is sent.
      if (own && (this._disposed || epoch !== this.ownEpoch)) return;

      // Buffer + pull: session/update notifications arrive on the socket
      // while we await the prompt response; queue them and drain into the
      // generator.
      const queue: BrainEvent[] = [];
      let wake: (() => void) | null = null;
      let producedContent = false;
      this.drift = null;
      const sink = (ev: BrainEvent): void => {
        queue.push(ev);
        wake?.();
      };
      this.turnSink = sink;
      // Own mode: the turn's real end (Hermes's answer, even after the request
      // timed out, or the agent going) unblocks the bot.
      let endTurn: (() => void) | undefined;
      let turnEnded: Promise<void> | null = null;
      if (own) {
        const ended = new Promise<void>((r) => {
          endTurn = r;
        });
        turnEnded = ended;
        this.gate().ended = ended;
        this.ownTurn = ended;
        const clear = (): void => {
          if (this.gate().ended === ended) this.gate().ended = null;
          if (this.ownTurn === ended) this.ownTurn = null;
        };
        void ended.then(clear, clear);
      }
      const promptDone = this.request(
        'session/prompt',
        { sessionId: session, prompt: [{ type: 'text', text: prompt }] },
        this.deps.promptTimeoutMs ?? PROMPT_TIMEOUT_MS,
        endTurn,
      ).finally(() => {
        wake?.();
      });
      this.promptInFlight = promptDone;
      void promptDone.finally(() => {
        if (this.promptInFlight === promptDone) this.promptInFlight = null;
      });
      let settled = false;
      void promptDone.then(() => {
        settled = true;
        wake?.();
      });

      try {
        while (!settled || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              wake = r;
            });
            wake = null;
            continue;
          }
          producedContent = true;
          yield queue.shift() as BrainEvent;
        }
        const response = await promptDone;
        // Late-arrival drain: an agent that emits updates after (or racing)
        // its prompt response must not lose them silently (GLM review).
        while (queue.length > 0) {
          producedContent = true;
          yield queue.shift() as BrainEvent;
        }
        if (this.drift) {
          // A tool outside the allowlist started: the turn was cancelled;
          // the next turn starts on a fresh agent process.
          const tool = this.drift;
          this.drift = null;
          this.killChildTree();
          yield { type: 'error', message: `${HERMES_TOOLS_CHANGED_LEAD} ${tool}` };
          return;
        }
        if (response.error) {
          const message = response.error.message ?? 'ACP prompt failed';
          // Own mode: a timed-out prompt may still run in Hermes; it is never
          // sent again.
          if (resumingUnvalidated && !producedContent && attempt === 0 && !(own && /timed out/i.test(message))) {
            // Dead persisted session (possibly reported as a successful
            // empty load): drop it and retry once on a fresh session.
            this._sessionId = null;
            this._sessionAttached = false;
            this._resumeUnvalidated = false;
            continue;
          }
          // A timed-out prompt means the agent-side turn may STILL be
          // running: cancel it and kill the process tree so it cannot keep
          // burning model budget as a zombie — the next turn respawns
          // cleanly (GLM review).
          if (/timed out/i.test(message)) {
            if (own) {
              // The owner's gateway is never stopped: cancel the turn and
              // stay blocked until Hermes reports that it ended, or the
              // cancel bound lets wmux's own agent process go.
              this.cancelOwnTurn();
              if (turnEnded) await turnEnded;
            } else if (this.deps.hermes) {
              // The timed-out request can no longer show the turn settling:
              // cancel it, then stop the gateway that may still run it.
              await this.cancelAndSettle();
              await this.deps.hermes.unsettled().catch(() => undefined);
            } else {
              this.interrupt();
              this.killChildTree();
            }
          }
          yield { type: 'error', message };
          return;
        }
        // A completed turn validates whatever session it ran on, and consumes
        // the one-shot bootstrap context (it is now part of the transcript).
        this._resumeUnvalidated = false;
        this._startOptions = {
          ...this._startOptions,
          systemPrompt: undefined,
          fleetContext: undefined,
        };
        const stopReason = response.result?.stopReason;
        if (stopReason !== 'cancelled') {
          const toolsRefused = await this.hermesToolsCheck(session);
          if (toolsRefused) {
            this.killChildTree();
            yield { type: 'error', message: toolsRefused };
            return;
          }
        }
        if (stopReason === 'refusal') {
          yield { type: 'error', message: 'the brain refused the turn' };
          return;
        }
        const usage: BrainUsage = {};
        const u = response.result?.usage as Record<string, unknown> | undefined;
        if (typeof u?.inputTokens === 'number') usage.inputTokens = u.inputTokens;
        if (typeof u?.outputTokens === 'number') usage.outputTokens = u.outputTokens;
        yield {
          type: 'turn-end',
          sessionId: this._sessionId,
          ...(Object.keys(usage).length > 0 ? { usage } : {}),
        };
        return;
      } finally {
        // An abandoned turn's generator can end after the next turn started
        // (own mode keeps the session): it never clears that turn's sink or
        // tool table. A null sink is this turn's (the tools check cleared it).
        if (this.turnSink === sink || this.turnSink === null) {
          this.turnSink = null;
          // Per-turn tool-call id table: agents may reuse ids across turns, and
          // a stale entry would mislabel a later tool-end chip (GLM review).
          this.toolNames.clear();
        }
      }
    }
  }

  /** Kill the agent AND its process tree. Windows `kill()` (TerminateProcess
   *  on the root) leaves grandchildren (the agent's own MCP subprocesses,
   *  probes) alive — exactly the population whose leaked pipe handles caused
   *  the dogfood deadlock — so use a tree kill there (GLM review). */
  private killChildTree(): void {
    // A request waiting on the owner is answered before its agent goes.
    if (this.deps.hermes) this.rejectPendingPermission();
    const child = this.child;
    this.child = null;
    // Own mode: the detached child's exit no longer ends its turns (the exit
    // handler ignores a child that is not current), so they end here: else
    // the bot would wait for that turn forever.
    if (this.own() && child) {
      const late = [...this.late.values()];
      this.late.clear();
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const entry of pending) clearTimeout(entry.timer);
      const end = (): void => {
        for (const ended of late) ended();
        for (const entry of pending) entry.resolve({ error: { message: 'ACP agent process exited' } });
      };
      // POSIX: the agent's tool commands run in sessions of their own, so the
      // tree is stopped by its snapshot (agentTreeStop.ts), and the turn ends
      // (opening the bot's turn gate) only once what it started is gone.
      if (process.platform !== 'win32' && child.pid && child.exitCode === null) {
        void (this.deps.stopAgentTree ?? stopAgentTree)(child.pid).catch(() => undefined).then(end);
        return;
      }
      end();
    }
    if (!child || child.exitCode !== null) return;
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        }).on('error', () => child.kill());
      } else {
        child.kill();
      }
    } catch {
      /* already dead */
    }
  }

  interrupt(): void {
    if (this._sessionId) {
      // Fire-and-forget notification per ACP (no response expected).
      this.writeMessage({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: this._sessionId },
      });
    }
    // Hermes: the gateway owns the turn. A permission request waiting for the
    // owner is rejected (a cancelled turn would leave it live), and a turn
    // that does not settle has its gateway stopped (own mode: never; the bot
    // waits for the turn's end, ownTurnEnded).
    if (this.own()) {
      this.rejectPendingPermission();
      this.stopOwnWaiters();
      this.watchOwnCancel();
    } else if (this.deps.hermes) {
      this.rejectPendingPermission();
      const inFlight = this.promptInFlight;
      if (inFlight) void this.watchSettle(inFlight);
    }
  }

  /** Hermes: wait for a cancelled turn to settle; past HERMES_SETTLE_MS kill
   *  the agent and stop the gateway that runs the turn. */
  private async watchSettle(inFlight: Promise<JsonRpcMessage>): Promise<void> {
    const settled = await Promise.race([inFlight.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), HERMES_SETTLE_MS))]);
    if (settled) return;
    console.warn(`[acp-brain:${this.deps.spawnSpec.command}] a cancelled turn did not settle in ${HERMES_SETTLE_MS} ms; stopping its gateway`);
    this.killChildTree();
    // The detached child's exit no longer fails its requests: end the turn now.
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ error: { message: 'the cancelled turn did not settle' } });
    }
    this.pending.clear();
    try {
      await this.deps.hermes?.unsettled();
    } catch {
      /* logged by the host */
    }
  }

  /** Own mode: a stop. A send still waiting for the last turn's end sends
   *  nothing; the turn itself stays Hermes's to end. */
  private stopOwnWaiters(): void {
    this.ownEpoch++;
    for (const wake of this.ownStopWaiters) wake();
    this.ownStopWaiters.clear();
  }

  /** Own mode: cancel the running turn and reject the request waiting for
   *  the owner; the gateway keeps running and ends the turn itself. */
  private cancelOwnTurn(): void {
    if (this._sessionId) this.writeMessage({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this._sessionId } });
    this.rejectPendingPermission();
    this.watchOwnCancel();
  }

  /** Own mode, after a cancel: wait for this adapter's turn to end, at most
   *  OWN_CANCEL_BOUND_MS from the first cancel. Past it, the turn is taken as
   *  wedged: wmux lets go of the agent process it spawned (killChildTree
   *  ends the turn's request, which opens the bot's turn gate) and tells the
   *  owner (`unsettled`). The owner's gateway is never touched. The next
   *  message spawns a new agent, which resumes the conversation by
   *  session/load when Hermes accepts it, else starts a new one. */
  private watchOwnCancel(): void {
    const turn = this.ownTurn;
    if (!turn || this.ownCancelWatched === turn) return;
    this.ownCancelWatched = turn;
    const boundMs = this.deps.ownCancelBoundMs ?? OWN_CANCEL_BOUND_MS;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), boundMs);
    });
    const letGo = (why: string): void => {
      console.warn(`[acp-brain:${this.deps.spawnSpec.command}] a cancelled My Hermes turn ${why}; closing wmux's own agent process (the gateway is not stopped)`);
      this.killChildTree();
      void this.deps.hermes?.unsettled().catch(() => undefined);
    };
    void Promise.race([turn.then(() => true), bound]).then(
      (ended) => {
        clearTimeout(timer);
        if (ended || this.ownTurn !== turn) return;
        letGo(`did not end in ${boundMs} ms`);
      },
      (err: unknown) => {
        // Whether Hermes ended the turn cannot be told: as at the bound,
        // what wmux started is stopped before the gate opens.
        clearTimeout(timer);
        letGo(`failed (${String(err)})`);
      },
    );
  }

  /** Hermes: cancel the running turn, wait for it to settle, then kill the agent. */
  private async cancelAndSettle(): Promise<void> {
    if (this.own()) {
      // App quit or dispose: cancel, then hold this adapter's turn (and so
      // the profile's turn gate) until Hermes ends it or the cancel bound
      // lets wmux's own agent process go; only then may another session of
      // the profile prompt. The owner's gateway is not stopped.
      const turn = this.ownTurn;
      this.cancelOwnTurn();
      if (turn) await turn.catch(() => undefined);
      this.killChildTree();
      return;
    }
    const inFlight = this.promptInFlight;
    if (this._sessionId) this.writeMessage({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this._sessionId } });
    this.rejectPendingPermission();
    if (inFlight) await this.watchSettle(inFlight);
    this.killChildTree();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.own()) this.stopOwnWaiters();
    // P4 token lifecycle: revoke FIRST so any straggling RPC from the child
    // fails closed at the router before the process winds down.
    revokeCommanderToken(this._commanderToken);
    for (const h of this.handoffs.splice(0)) h.dispose();
    if (this.deps.hermes) {
      // The turn lives in Hermes's gateway: cancel it and let it settle
      // before the agent goes (shutdown()). Requests still waiting on the
      // agent end now.
      void this.shutdown();
      return;
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ error: { message: 'adapter disposed' } });
    }
    this.pending.clear();
    this.killChildTree();
  }

  /** The bot this adapter runs, or null (a workspace commander). */
  botId(): string | null {
    return this.deps.bot?.binding.botId ?? null;
  }

  /** Whether the agent process is running (a Hermes viewer attached to its
   *  gateway). */
  agentLive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /** Hermes: dispose and wait until the turn settled and the agent is gone
   *  (app quit awaits it). Resolves at once for a generic agent. */
  shutdown(): Promise<void> {
    if (!this._disposed) this.dispose();
    if (!this.deps.hermes) return Promise.resolve();
    if (!this.shutdownPromise) {
      this.shutdownPromise = (async () => {
        try {
          await this.cancelAndSettle();
        } finally {
          for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.resolve({ error: { message: 'adapter disposed' } });
          }
          this.pending.clear();
          this.killChildTree();
          this.endLateTurns();
          this.deps.hermes?.disposed?.(this);
        }
      })();
    }
    return this.shutdownPromise;
  }
}
