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
import type { BrainAdapter, BrainEvent, BrainStartOptions, BrainUsage } from './BrainAdapter';
import { mintCommanderToken, revokeCommanderToken } from './commanderTrust';
import { COMMANDER_MODE_ARG } from '../../shared/commanderSurface';

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
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** A prompt turn can legitimately run for minutes (agentic tool loops). */
const PROMPT_TIMEOUT_MS = 10 * 60_000;

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
    if (opts.resumeSessionId) this._sessionId = opts.resumeSessionId;
  }

  // ── subprocess + JSON-RPC plumbing ─────────────────────────────────────

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const spawnFn =
      this.deps.spawnFn ??
      ((cmd: string, args: string[]) =>
        spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    const child = spawnFn(this.deps.spawnSpec.command, this.deps.spawnSpec.args);
    this.child = child;
    this._initialized = false;
    this.stdoutBuf = '';
    child.stdout.on('data', (d: Buffer) => this.onStdout(d.toString('utf8')));
    child.on('error', (err: Error) => {
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
      // event instead of a hung turn.
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
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // non-protocol noise on stdout — ignore defensively
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
      return;
    }
    // Agent → client REQUEST (has id + method): answer the small surface we
    // support; refuse the rest. Permission prompts for the agent's own tools
    // are its product's domain (wmux gates its OWN tools server-side, P4), so
    // a blanket allow here cannot widen wmux's surface.
    if (msg.id !== undefined && msg.method !== undefined) {
      if (msg.method === 'session/request_permission') {
        const options = (msg.params?.options ?? []) as Array<Record<string, unknown>>;
        const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
        this.writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: allow
            ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
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
    if (this._sessionId) {
      // Resume the persisted conversation; a dead/unknown id falls back to a
      // fresh session rather than bricking the commander (same soft-resume
      // contract as ClaudeSdkAdapter P3a).
      const loaded = await this.request('session/load', {
        sessionId: this._sessionId,
        cwd: process.cwd(),
        mcpServers: this.mcpServersParam(),
      });
      if (!loaded.error) return this._sessionId;
      this._sessionId = null;
    }
    const created = await this.request('session/new', {
      cwd: process.cwd(),
      mcpServers: this.mcpServersParam(),
    });
    const sid = created.result?.sessionId;
    if (created.error || typeof sid !== 'string' || sid.length === 0) {
      return { error: `ACP session/new failed: ${created.error?.message ?? 'no sessionId'}` };
    }
    this._sessionId = sid;
    return sid;
  }

  // ── the turn ────────────────────────────────────────────────────────────

  async *send(text: string): AsyncIterable<BrainEvent> {
    if (this._disposed) {
      yield { type: 'error', message: 'commander session disposed' };
      return;
    }
    const session = await this.ensureSession();
    if (typeof session !== 'string') {
      yield { type: 'error', message: session.error };
      return;
    }

    // One-shot context injection on the first turn (system prompt + fleet
    // snapshot ride the prompt — ACP has no separate system-prompt channel).
    const parts: string[] = [];
    if (this._startOptions.systemPrompt) {
      parts.push(this._startOptions.systemPrompt);
      this._startOptions = { ...this._startOptions, systemPrompt: undefined };
    }
    if (this._startOptions.fleetContext) {
      parts.push(this._startOptions.fleetContext);
      this._startOptions = { ...this._startOptions, fleetContext: undefined };
    }
    const prompt = parts.length > 0 ? `${parts.join('\n\n---\n\n')}\n\n---\n\n${text}` : text;

    // Buffer + pull: session/update notifications arrive on the socket while
    // we await the prompt response; queue them and drain into the generator.
    const queue: BrainEvent[] = [];
    let wake: (() => void) | null = null;
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
        yield queue.shift() as BrainEvent;
      }
      const response = await promptDone;
      if (response.error) {
        yield { type: 'error', message: response.error.message ?? 'ACP prompt failed' };
        return;
      }
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
    } finally {
      this.turnSink = null;
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
    try {
      this.child?.kill();
    } catch {
      /* already dead */
    }
    this.child = null;
  }
}
