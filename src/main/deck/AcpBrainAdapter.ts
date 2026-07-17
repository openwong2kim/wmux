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
import type { BrainAdapter, BrainEvent, BrainStartOptions, BrainUsage } from './BrainAdapter';
import { mintCommanderToken, revokeCommanderToken } from './commanderTrust';
import { COMMANDER_MODE_ARG } from '../../shared/commanderSurface';
import { getWmuxDir } from '../../daemon/config';

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
  /** Fresh-session settle override (tests: 0). See NEW_SESSION_SETTLE_MS. */
  newSessionSettleMs?: number;
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

  constructor(deps: AcpBrainAdapterDeps) {
    this.deps = deps;
    this._workspaceId = deps.workspaceId ?? '';
    // P4 token lifecycle contract: mint at construction, revoke at dispose.
    this._commanderToken = mintCommanderToken(this._workspaceId);
  }

  get sessionId(): string | null {
    return this._sessionId;
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
          cwd: getWmuxDir(),
        }));
    const child = spawnFn(this.deps.spawnSpec.command, this.deps.spawnSpec.args);
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
      if (this.child === child) this.child = null;
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
      if (msg.method === 'session/request_permission') {
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
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `ACP request timed out: ${method}` } });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.writeMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  // ── session lifecycle ───────────────────────────────────────────────────

  private mcpServersParam(): Array<Record<string, unknown>> {
    if (!this.deps.mcpBundlePath) return [];
    const suffixEnv = process.env.WMUX_DATA_SUFFIX
      ? [{ name: 'WMUX_DATA_SUFFIX', value: process.env.WMUX_DATA_SUFFIX }]
      : [];
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
      const loaded = await this.request('session/load', {
        sessionId: this._sessionId,
        cwd: getWmuxDir(),
        mcpServers: this.mcpServersParam(),
      });
      if (!loaded.error) {
        this._sessionAttached = true;
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
    const created = await this.request('session/new', {
      cwd: getWmuxDir(),
      mcpServers: this.mcpServersParam(),
    });
    const sid = created.result?.sessionId;
    if (created.error || typeof sid !== 'string' || sid.length === 0) {
      return { error: `ACP session/new failed: ${created.error?.message ?? 'no sessionId'}` };
    }
    this._sessionId = sid;
    this._sessionAttached = true;
    this._resumeUnvalidated = false;
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

  // ── the turn ────────────────────────────────────────────────────────────

  async *send(text: string): AsyncIterable<BrainEvent> {
    if (this._disposed) {
      yield { type: 'error', message: 'commander session disposed' };
      return;
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
    const prompt = parts.length > 0 ? `${parts.join('\n\n---\n\n')}\n\n---\n\n${text}` : text;

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

      // Buffer + pull: session/update notifications arrive on the socket
      // while we await the prompt response; queue them and drain into the
      // generator.
      const queue: BrainEvent[] = [];
      let wake: (() => void) | null = null;
      let producedContent = false;
      this.turnSink = (ev) => {
        queue.push(ev);
        wake?.();
      };
      const promptDone = this.request(
        'session/prompt',
        { sessionId: session, prompt: [{ type: 'text', text: prompt }] },
        PROMPT_TIMEOUT_MS,
      ).finally(() => {
        wake?.();
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
        if (response.error) {
          const message = response.error.message ?? 'ACP prompt failed';
          if (resumingUnvalidated && !producedContent && attempt === 0) {
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
            this.interrupt();
            this.killChildTree();
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
        this.turnSink = null;
        // Per-turn tool-call id table: agents may reuse ids across turns, and
        // a stale entry would mislabel a later tool-end chip (GLM review).
        this.toolNames.clear();
      }
    }
  }

  /** Kill the agent AND its process tree. Windows `kill()` (TerminateProcess
   *  on the root) leaves grandchildren (the agent's own MCP subprocesses,
   *  probes) alive — exactly the population whose leaked pipe handles caused
   *  the dogfood deadlock — so use a tree kill there (GLM review). */
  private killChildTree(): void {
    const child = this.child;
    this.child = null;
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
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // P4 token lifecycle: revoke FIRST so any straggling RPC from the child
    // fails closed at the router before the process winds down.
    revokeCommanderToken(this._commanderToken);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ error: { message: 'adapter disposed' } });
    }
    this.pending.clear();
    this.killChildTree();
  }
}
