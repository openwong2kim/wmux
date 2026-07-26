// ─── ClaudePtyBrainAdapter — the interactive Claude Code TUI as a brain ──────
//
// Vendor id: `claude-pty`. A hedge against the headless `claude -p` / Agent SDK
// path becoming metered: the mode that is unambiguously covered by a Claude
// subscription is the INTERACTIVE TUI. So this adapter runs the user's own
// `claude` binary as a real terminal program inside a daemon pty session and
// drives it by typing, exactly as a human would.
//
// Three decisions shape everything below (all validated by the 2026-07-26 PoC):
//
//  1. NO OUTPUT PARSING. A TUI's screen is a rendering, not a protocol. Every
//     structured fact this adapter needs — turn boundaries, the session id, the
//     final assistant text — comes from Claude Code's HOOK system instead, via
//     the bundled `wmux-bridge.mjs` the fleet already uses. The one exception is
//     a single stale-resume substring probe on the spawn banner (see
//     STALE_RESUME_MARKER), which is a startup soft-fail, not turn state.
//
//  2. THE TUI *IS* THE CONVERSATION VIEW. The deck embeds this pty (a terminal
//     attached by ptyId) instead of re-synthesising streamed bubbles, so there
//     is deliberately no `text-delta` streaming here: one final `text-delta`
//     plus one `turn-end` per turn, read off the transcript.
//
//  3. THE SPAWN ENV MUST BE SCRUBBED. Inheriting main's `CLAUDE*` environment
//     into a nested claude (notably CLAUDE_CODE_CHILD_SESSION) silently turns
//     transcript persistence OFF — which kills both the Stop hook's
//     `transcript_path` and `--resume`. See scrubBrainSpawnEnv.
//
// Contract: BrainAdapter, with the CommanderSessionManager lifecycle — exactly
// one `turn-end` per clean turn, a live `sessionId` getter, and a dispose() that
// terminates an in-flight iterator instead of hanging it.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWmuxDir } from '../../daemon/config';
import { COMMANDER_MODE_ARG, COMMANDER_TOOL_SURFACE } from '../../shared/commanderSurface';
import { ENV_KEYS, BRAIN_PTY_ID_PREFIX } from '../../shared/constants';
import { mintCommanderToken, revokeCommanderToken } from './commanderTrust';
import { registerBrainPty } from './brainPtyHookBus';
import { readLastAssistantMessage } from '../claude/lastAssistantMessage';
import { resolveClaudeExecutable, resolveMcpBundlePath, DISALLOWED_TOOLS } from './ClaudeSdkAdapter';
import type { AgentSignal } from '../../shared/hooks/signal-types';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from './BrainAdapter';

// ─── Tunables ────────────────────────────────────────────────────────────────

/** How long to wait for the spawned TUI's `SessionStart` hook before typing
 *  the first prompt anyway. The hook is the only reliable "the TUI is ready to
 *  accept input" signal; the fallback exists so a user whose claude build does
 *  not fire SessionStart still gets a usable (if racier) first turn. */
const SESSION_START_TIMEOUT_MS = 20_000;
/** Ceiling on one turn. An agentic turn legitimately runs for many minutes, so
 *  this is a stuck-session backstop, not a latency budget. */
const TURN_TIMEOUT_MS = 30 * 60_000;
/** Window after spawn during which the banner is watched for a dead `--resume`.
 *  The message appears immediately or not at all. */
const STALE_RESUME_WINDOW_MS = 4_000;
/** Pause between the prompt write and the submitting Enter. Writing them in one
 *  chunk makes the TUI's paste detection swallow the trailing `\r` as pasted
 *  content — the prompt lands in the input box but never submits (dogfood
 *  2026-07-26; the PoC proved a short gap fixes it). */
const SUBMIT_DELAY_MS = 400;
/** Claude Code's own wording when `--resume <id>` names a transcript it cannot
 *  find. Matched case-insensitively on the spawn banner only. */
const STALE_RESUME_MARKER = 'no conversation found';

/** Env prefixes/keys stripped from the spawned brain. See scrubBrainSpawnEnv. */
const SCRUBBED_ENV_PREFIXES = ['CLAUDE', 'ANTHROPIC'] as const;
const SCRUBBED_ENV_KEYS = ['AI_AGENT'] as const;

// ─── Daemon seam ─────────────────────────────────────────────────────────────

/** The slice of the daemon client this adapter needs. Injected so the whole
 *  turn machinery unit-tests against a fake pty with no daemon and no claude. */
export interface BrainPtyHost {
  createSession(params: {
    id: string;
    cwd: string;
    env: Record<string, string>;
    command: string;
    cols: number;
    rows: number;
  }): Promise<void>;
  /** Attach + connect the session's data pipe (the renderer embed reattaches
   *  on its own; this is what makes main see output for the stale-resume probe). */
  attach(id: string): Promise<void>;
  write(id: string, data: string): void;
  destroy(id: string): Promise<void>;
  /** Subscribe to this session's raw output. Returns an unsubscribe. */
  onData(id: string, cb: (chunk: string) => void): () => void;
}

/** Minimal structural view of DaemonClient — avoids importing the concrete
 *  class (and its Electron/net dependencies) into this module's graph. */
export interface DaemonClientLike {
  rpc(method: string, params?: unknown): Promise<unknown>;
  connectSessionPipe(sessionId: string, opts?: { forceFresh?: boolean }): Promise<void>;
  writeToSession(sessionId: string, data: string | Buffer): boolean;
  on(event: 'session:data', listener: (payload: { sessionId: string; data: Buffer }) => void): unknown;
  off(event: 'session:data', listener: (payload: { sessionId: string; data: Buffer }) => void): unknown;
}

/** Build the production host from a live DaemonClient. */
export function createBrainPtyHost(client: DaemonClientLike): BrainPtyHost {
  return {
    async createSession(params) {
      await client.rpc('daemon.createSession', {
        id: params.id,
        // The claude TUI IS the pane's root process (X8 exec unit): when it
        // exits the pty exits, so a crashed brain is observable instead of
        // leaving a live shell that looks healthy.
        cmd: '',
        exec: { command: params.command },
        cwd: params.cwd,
        cols: params.cols,
        rows: params.rows,
        env: params.env,
      });
    },
    async attach(id) {
      await client.rpc('daemon.attachSession', { id });
      await client.connectSessionPipe(id);
    },
    write(id, data) {
      client.writeToSession(id, data);
    },
    async destroy(id) {
      try {
        await client.rpc('daemon.destroySession', { id });
      } catch {
        /* already gone */
      }
    },
    onData(id, cb) {
      const listener = (payload: { sessionId: string; data: Buffer }): void => {
        if (payload.sessionId !== id) return;
        cb(payload.data.toString('utf8'));
      };
      client.on('session:data', listener);
      return () => {
        client.off('session:data', listener);
      };
    },
  };
}

// ─── Pure builders (exported for unit tests) ─────────────────────────────────

/**
 * Strip every `CLAUDE*` / `ANTHROPIC*` variable plus `AI_AGENT` from the base
 * environment.
 *
 * This is the single most load-bearing line in the adapter. wmux's main process
 * is itself routinely launched from inside a Claude Code session, so its env
 * carries `CLAUDE_CODE_CHILD_SESSION` (and friends). A claude that sees that
 * marker treats itself as a NESTED invocation and stops persisting a
 * transcript — with no error, no banner, nothing. The Stop hook then fires with
 * no `transcript_path` (no final text) and `--resume` can never find the
 * session again. Empirically confirmed in the PoC: with the marker present
 * resume was 100% broken, with it scrubbed 100% reliable.
 *
 * `ANTHROPIC*` goes for the zero-API reason ClaudeSdkAdapter documents (an
 * ambient key would flip the brain onto metered auth), and `AI_AGENT` because
 * some shells set it as an "I am inside an agent" marker that agents branch on.
 *
 * WMUX_* stamps are deliberately KEPT — the daemon adds `WMUX_PTY_ID` on top,
 * and that id is how the hook bridge's signals find their way back here.
 */
export function scrubBrainSpawnEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (SCRUBBED_ENV_PREFIXES.some((p) => upper.startsWith(p))) continue;
    if ((SCRUBBED_ENV_KEYS as readonly string[]).includes(upper)) continue;
    out[key] = value;
  }
  return out;
}

/** The `mcp__wmux__*` allow-list, derived from the commander surface SSOT so it
 *  cannot drift from what the `--commander` MCP child actually registers. */
export const BRAIN_PTY_ALLOWED_TOOLS: string[] = COMMANDER_TOOL_SURFACE.map((t) => `mcp__wmux__${t}`);

/**
 * The generated `--settings` profile.
 *
 * An interactive session has no `canUseTool` callback, so `permissions.deny` is
 * the ONLY gate on the built-in tools — it re-expresses the SDK adapter's
 * DISALLOWED_TOOLS (plus Write, which in this mode has no memory-sandbox path
 * to flow through). A `PreToolUse` hook that exits 2 backstops the deny list:
 * the PoC verified both layers independently, and doubling up costs one process
 * spawn on a tool the brain should never have called anyway.
 *
 * The `Stop` / `SessionStart` hooks are the adapter's entire turn protocol.
 */
export function buildBrainSettingsProfile(opts: {
  /** Absolute path to the bundled `wmux-bridge.mjs`, or null to omit the
   *  signal hooks (the adapter then has no turn protocol and refuses to run). */
  bridgePath: string | null;
  /** Node-compatible executable used to run the bridge and the deny backstop. */
  nodePath: string;
}): Record<string, unknown> {
  const denied = [...DISALLOWED_TOOLS, 'Write'];
  const hooks: Record<string, unknown> = {
    // Fail-closed backstop for the deny list above: exit code 2 is Claude
    // Code's "block this tool call" contract.
    PreToolUse: denied.map((tool) => ({
      matcher: tool,
      hooks: [
        {
          type: 'command',
          command: `${quoteArg(opts.nodePath)} -e "process.exit(2)"`,
        },
      ],
    })),
  };
  if (opts.bridgePath) {
    for (const event of ['Stop', 'SessionStart'] as const) {
      hooks[event] = [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `${quoteArg(opts.nodePath)} ${quoteArg(opts.bridgePath)} ${event}`,
            },
          ],
        },
      ];
    }
  }
  return {
    // The user's own ~/.claude settings are NOT loaded (see --settings +
    // --strict-mcp-config in buildBrainLaunchCommand): this profile is the
    // brain's whole configuration, exactly like the SDK adapter's raw mode.
    permissions: {
      deny: denied,
      // The wmux MCP surface is pre-approved so the brain never sits on a
      // permission prompt no human is watching. Everything not listed — and
      // every denied built-in above — still prompts or is refused.
      allow: BRAIN_PTY_ALLOWED_TOOLS,
    },
    hooks,
  };
}

/** The generated `--mcp-config` document: only the wmux bundle, mounted in
 *  commander mode with this spawn's trust token. Mirrors ClaudeSdkAdapter's
 *  `mcpServers` block and AcpBrainAdapter's `mcpServersParam`. */
export function buildBrainMcpConfig(opts: {
  bundlePath: string;
  execPath: string;
  commanderToken: string;
  dataSuffix?: string;
}): Record<string, unknown> {
  return {
    mcpServers: {
      wmux: {
        type: 'stdio',
        command: opts.execPath,
        // --commander is an ARG, not an env var, so an env-stripping host
        // cannot widen the tool surface (BYOB P4 Layer 1).
        args: [opts.bundlePath, COMMANDER_MODE_ARG],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          WMUX_COMMANDER_TOKEN: opts.commanderToken,
          ...(opts.dataSuffix ? { [ENV_KEYS.DATA_SUFFIX]: opts.dataSuffix } : {}),
        },
      },
    },
  };
}

/** Quote one argv token for the daemon's exec wrapper shell. The wrapper is a
 *  POSIX shell (`-lc`) or cmd/pwsh (`/c`, `-Command`); double quotes with
 *  escaped inner quotes are the one form all three read the same way, and every
 *  value we pass is a path or an id (never a shell metacharacter soup). */
export function quoteArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * The launch command line. Deliberately SHORT: no `--append-system-prompt`.
 * The commander identity rides the first turn's prompt text instead (the
 * AcpBrainAdapter pattern) — it lands in the transcript, so `--resume` carries
 * it forward, and it never has to survive cross-platform shell quoting.
 */
export function buildBrainLaunchCommand(opts: {
  executable: string;
  settingsPath: string;
  mcpConfigPath: string | null;
  allowedTools?: string[];
  resumeSessionId?: string | null;
}): string {
  const parts = [quoteArg(opts.executable), '--settings', quoteArg(opts.settingsPath)];
  if (opts.mcpConfigPath) {
    parts.push('--mcp-config', quoteArg(opts.mcpConfigPath), '--strict-mcp-config');
  }
  const tools = opts.allowedTools ?? BRAIN_PTY_ALLOWED_TOOLS;
  if (tools.length > 0) parts.push('--allowedTools', quoteArg(tools.join(',')));
  if (opts.resumeSessionId) parts.push('--resume', quoteArg(opts.resumeSessionId));
  return parts.join(' ');
}

/** Flatten a prompt into ONE line. The TUI submits on Enter, so an embedded
 *  newline would send a half-written prompt. Control characters are dropped for
 *  the same reason (a stray ESC would open the TUI's own menus). */
export function flattenPromptForPty(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export interface ClaudePtyBrainAdapterDeps {
  /** The one workspace this brain serves (token binding / M1.5 confinement). */
  workspaceId?: string;
  /** Daemon pty host. Required in production; injected as a fake in tests. */
  host: BrainPtyHost;
  /** Absolute path to the user's claude binary. Defaults to the resolver. */
  claudeExecutable?: string | null;
  /** Absolute path to the wmux MCP stdio bundle. Defaults to the resolver. */
  mcpBundlePath?: string | null;
  /** Absolute path to the bundled `wmux-bridge.mjs` (the turn protocol). */
  bridgePath?: string | null;
  /** Directory the generated profile is written to, and the pty's cwd. */
  wmuxDir?: string;
  /** Node-compatible executable for the generated hook commands. */
  nodePath?: string;
  /** Fired with the daemon session id the moment the pty exists, so the deck
   *  can embed the live terminal. */
  onPtySpawned?: (ptyId: string) => void;
  /** Reader for the final assistant text (injected in tests). */
  readTranscript?: typeof readLastAssistantMessage;
  sessionStartTimeoutMs?: number;
  turnTimeoutMs?: number;
  staleResumeWindowMs?: number;
  /** Pause between writing the prompt and writing the submitting Enter.
   *  Tests shrink this to keep the suite fast. */
  submitDelayMs?: number;
}

/** One pending waiter — resolved by a hook signal, a timeout, or dispose(). */
interface Waiter<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createWaiter<T>(): Waiter<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export class ClaudePtyBrainAdapter implements BrainAdapter {
  private readonly deps: ClaudePtyBrainAdapterDeps;
  private readonly _commanderToken: string;
  private readonly _workspaceId: string;
  private readonly wmuxDir: string;

  private _sessionId: string | null = null;
  /** A disk-seeded resume id is unproven until the spawned TUI accepts it. */
  private _resumeUnvalidated = false;
  private _startOptions: BrainStartOptions = {};
  private _contextInjected = false;
  private _disposed = false;

  /** Live daemon session id (the ptyId) while the TUI runs. */
  private ptyId: string | null = null;
  private profilePaths: string[] = [];
  private unregisterHooks: (() => void) | null = null;
  private unsubscribeData: (() => void) | null = null;
  /** Resolved by the SessionStart hook of the CURRENT pty. */
  private sessionStarted: Waiter<void> | null = null;
  /** True once the CURRENT pty's SessionStart hook landed. Reset per spawn. */
  private sessionStartSeen = false;
  /** Set only between a send()'s keystroke and its accepted Stop. A second
   *  Stop for the same turn finds it null and is ignored — the "exactly one
   *  turn-end" half of the manager contract. */
  private turnStop: Waiter<AgentSignal | null> | null = null;
  /** Spawn-banner buffer, kept only for the stale-resume probe window. */
  private banner = '';
  private bannerWatching = false;

  constructor(deps: ClaudePtyBrainAdapterDeps) {
    this.deps = deps;
    this._workspaceId = deps.workspaceId ?? '';
    this.wmuxDir = deps.wmuxDir ?? getWmuxDir();
    // Same token lifecycle as every other adapter: mint at construction,
    // revoke at dispose so a dead brain's child fails closed at the router.
    this._commanderToken = mintCommanderToken(this._workspaceId);
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /** The live pty the deck embeds, or null before the first turn spawned one. */
  get brainPtyId(): string | null {
    return this.ptyId;
  }

  start(opts: BrainStartOptions): void {
    this._startOptions = opts;
    if (opts.resumeSessionId) {
      this._sessionId = opts.resumeSessionId;
      this._resumeUnvalidated = true;
    }
  }

  // ── hook ingest ─────────────────────────────────────────────────────────

  /** Every hook signal from THIS pty. Only two kinds carry turn meaning. */
  private onHookSignal(signal: AgentSignal): void {
    if (signal.kind === 'agent.session_start') {
      this.sessionStartSeen = true;
      this.sessionStarted?.resolve();
      return;
    }
    if (signal.kind !== 'agent.stop') return;
    // A Stop with no waiter is a duplicate (or a stop the human triggered in
    // the embedded TUI directly) — deliberately dropped, so the open turn
    // still ends exactly once.
    const waiter = this.turnStop;
    if (!waiter) return;
    this.turnStop = null;
    waiter.resolve(signal);
  }

  // ── spawn ───────────────────────────────────────────────────────────────

  /** Write the generated profile + MCP config, returning their paths. */
  private writeProfile(): { settingsPath: string; mcpConfigPath: string | null } {
    const dir = path.join(this.wmuxDir, 'brain-profiles');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = randomUUID();
    const settingsPath = path.join(dir, `settings-${stamp}.json`);
    const bridgePath = this.deps.bridgePath ?? null;
    const nodePath = this.deps.nodePath ?? process.execPath;
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(buildBrainSettingsProfile({ bridgePath, nodePath }), null, 2),
      'utf8',
    );
    this.profilePaths.push(settingsPath);

    const bundlePath =
      this.deps.mcpBundlePath !== undefined ? this.deps.mcpBundlePath : resolveMcpBundlePath();
    let mcpConfigPath: string | null = null;
    if (bundlePath) {
      mcpConfigPath = path.join(dir, `mcp-${stamp}.json`);
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify(
          buildBrainMcpConfig({
            bundlePath,
            execPath: process.execPath,
            commanderToken: this._commanderToken,
            ...(process.env[ENV_KEYS.DATA_SUFFIX]
              ? { dataSuffix: process.env[ENV_KEYS.DATA_SUFFIX] as string }
              : {}),
          }),
          null,
          2,
        ),
        'utf8',
      );
      this.profilePaths.push(mcpConfigPath);
    }
    return { settingsPath, mcpConfigPath };
  }

  private buildSpawnEnv(): Record<string, string> {
    const env = scrubBrainSpawnEnv(process.env);
    // Force the hook bridge onto MAIN's pipe (`hooks.signal`), not the
    // daemon's. That RPC is where deliverBrainPtyHookSignal claims this pty's
    // signals BEFORE they can reach the fleet ledger — routing them through
    // the daemon instead would fan a notification and, worse, push an
    // agent.lifecycle event that wakes this very brain on its own turn end.
    // (WMUX_PIPE_NAME is NOT used: the bridge maps that override to the
    // daemon's `daemon.hooks.signal` method, which main does not serve.)
    env.WMUX_HOOKS_TO_MAIN = '1';
    // The generated hook commands run the bridge with the Electron binary
    // (nodePath defaults to process.execPath — the packaged app ships no bare
    // node). Hooks inherit the SESSION env, and without this flag Electron
    // launches as a GUI app instead of executing the script: the Stop signal
    // silently never fires and the deck stays busy forever (dogfood
    // 2026-07-26). Harmless for the claude binary itself and for non-Electron
    // node paths; the MCP server child sets it per-server as well.
    env.ELECTRON_RUN_AS_NODE = '1';
    // Marks the session as a brain pty for the pane-listing filter — a brain
    // is not a worker pane and must not appear in the fleet's pane list.
    env[ENV_KEYS.BRAIN_PTY] = '1';
    if (this._workspaceId) env[ENV_KEYS.WORKSPACE_ID] = this._workspaceId;
    return env;
  }

  /** Spawn the TUI. Resolves once SessionStart landed (or its timeout).
   *
   *  `blockedOnTui` is the timeout half of that race REPORTED, not swallowed:
   *  the TUI printed something but never fired SessionStart, which is what a
   *  blocking startup dialog (folder trust, a permission prompt, /login) looks
   *  like from out here. See the caller for what it does with it. */
  private async spawn(
    resumeSessionId: string | null,
  ): Promise<{ ok: true; blockedOnTui: boolean } | { error: string }> {
    const executable =
      this.deps.claudeExecutable !== undefined
        ? this.deps.claudeExecutable
        : resolveClaudeExecutable();
    if (!executable) {
      return {
        error:
          'Claude Code not found — the terminal brain needs a claude install (native installer or npm global). Install it, then retry.',
      };
    }
    if (!this.deps.bridgePath) {
      return {
        error:
          'the wmux hook bridge could not be located — the terminal brain has no way to observe turn boundaries.',
      };
    }
    let settingsPath: string;
    let mcpConfigPath: string | null;
    try {
      ({ settingsPath, mcpConfigPath } = this.writeProfile());
    } catch (err) {
      return { error: `could not write the brain settings profile: ${String(err)}` };
    }

    const ptyId = `${BRAIN_PTY_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const command = buildBrainLaunchCommand({
      executable,
      settingsPath,
      mcpConfigPath,
      resumeSessionId,
    });
    // Held locally as well as on the instance: a dispose() racing this spawn
    // nulls the field (killPty), and awaiting the field would then throw
    // inside the turn instead of unwinding it.
    const started = createWaiter<void>();
    this.sessionStarted = started;
    this.sessionStartSeen = false;
    this.banner = '';
    this.bannerWatching = true;
    try {
      await this.deps.host.createSession({
        id: ptyId,
        // claude keys its transcripts by cwd, so this must be STABLE across app
        // updates and launch locations — the same reason ClaudeSdkAdapter pins
        // it. A packaged Electron app's own cwd is the per-version install dir.
        cwd: this.wmuxDir,
        env: this.buildSpawnEnv(),
        command,
        cols: 120,
        rows: 32,
      });
      await this.deps.host.attach(ptyId);
    } catch (err) {
      this.bannerWatching = false;
      return { error: `could not start the terminal brain: ${String(err)}` };
    }
    this.ptyId = ptyId;
    this.unregisterHooks = registerBrainPty(ptyId, (s) => this.onHookSignal(s));
    this.unsubscribeData = this.deps.host.onData(ptyId, (chunk) => {
      if (!this.bannerWatching) return;
      this.banner += chunk;
      if (this.banner.length > 64 * 1024) this.bannerWatching = false;
    });
    try {
      this.deps.onPtySpawned?.(ptyId);
    } catch {
      /* the embed is cosmetic — never fail a spawn on it */
    }
    await Promise.race([
      started.promise,
      delay(this.deps.sessionStartTimeoutMs ?? SESSION_START_TIMEOUT_MS),
    ]);
    // No SessionStart but the pty DID print: the binary is alive and stopped on
    // something. A silent pty is a different (slower) failure — a cold start on
    // a big install, or a claude build that never fires the hook — and typing
    // the prompt anyway is still the better bet there.
    return { ok: true, blockedOnTui: !this.sessionStartSeen && this.banner.length > 0 };
  }

  /** True when the spawn banner says the `--resume` id is dead. */
  private async sawStaleResume(): Promise<boolean> {
    const seen = (): boolean => this.banner.toLowerCase().includes(STALE_RESUME_MARKER);
    if (seen()) return true;
    // The message races the SessionStart hook, so give the banner the rest of
    // its window before concluding the resume took.
    await delay(this.deps.staleResumeWindowMs ?? STALE_RESUME_WINDOW_MS);
    return seen();
  }

  /** Tear down the live pty (profile files survive for the next spawn). */
  private async killPty(): Promise<void> {
    const id = this.ptyId;
    this.ptyId = null;
    this.bannerWatching = false;
    this.unregisterHooks?.();
    this.unregisterHooks = null;
    this.unsubscribeData?.();
    this.unsubscribeData = null;
    this.sessionStarted = null;
    if (id) await this.deps.host.destroy(id);
  }

  // ── the turn ────────────────────────────────────────────────────────────

  /** Prepend the one-shot bootstrap context to the first turn (see
   *  buildBrainLaunchCommand for why it rides the prompt, not an argv flag). */
  private composePrompt(text: string): string {
    if (this._contextInjected) return text;
    this._contextInjected = true;
    const parts: string[] = [];
    if (this._startOptions.systemPrompt) parts.push(this._startOptions.systemPrompt);
    if (this._startOptions.fleetContext) parts.push(this._startOptions.fleetContext);
    if (parts.length === 0) return text;
    return `${parts.join('\n\n---\n\n')}\n\n---\n\n${text}`;
  }

  async *send(text: string): AsyncIterable<BrainEvent> {
    if (this._disposed) {
      yield { type: 'error', message: 'commander session disposed' };
      return;
    }

    if (!this.ptyId) {
      let spawned = await this.spawn(this._sessionId);
      if ('error' in spawned) {
        yield { type: 'error', message: spawned.error };
        return;
      }
      if (this._disposed) return;
      // Soft-fail resume (same contract as the SDK/ACP adapters): a persisted
      // id the claude side no longer knows must start a fresh conversation,
      // not brick the commander.
      if (this._sessionId && this._resumeUnvalidated && (await this.sawStaleResume())) {
        console.warn(
          `[deck] persisted commander session ${this._sessionId} did not resume ` +
          '(no conversation found) — starting fresh',
        );
        this._sessionId = null;
        this._resumeUnvalidated = false;
        await this.killPty();
        if (this._disposed) return;
        const fresh = await this.spawn(null);
        if ('error' in fresh) {
          yield { type: 'error', message: fresh.error };
          return;
        }
        if (this._disposed) return;
        spawned = fresh;
      }
      // A validated `--resume` means the transcript ALREADY contains the
      // commander identity from the conversation's first turn — re-injecting
      // it would blast the multi-KB preamble into the TUI on every app
      // restart (adapter instances don't outlive the app; the conversation
      // does). Fresh conversations still get the full first-turn injection.
      if (this._sessionId) this._contextInjected = true;
      this.bannerWatching = false;
      // The TUI stopped on a dialog before it ever reached a prompt. Typing
      // into that dialog would answer it with the user's message (arrow keys
      // and Enter are its controls) and no Stop hook would ever fire, so the
      // turn would hang for the full TURN_TIMEOUT_MS with the composer
      // disabled — the deadlock this branch exists to break. Hand the turn
      // back instead and point at the embedded terminal, which is now typable
      // (BrainTerminalEmbed). We deliberately do NOT answer the dialog for the
      // user: trusting a folder and granting permissions are their calls, and
      // the pty stays alive so the next send() reuses the answered session.
      if (spawned.blockedOnTui) {
        yield {
          type: 'error',
          message:
            'Claude Code is waiting on a prompt of its own (folder trust, permissions, or sign-in). ' +
            'Answer it in the terminal above, then send your message again.',
        };
        return;
      }
    }

    const ptyId = this.ptyId;
    if (!ptyId) {
      yield { type: 'error', message: 'the terminal brain is not running' };
      return;
    }

    const prompt = flattenPromptForPty(this.composePrompt(text));
    if (!prompt) {
      yield { type: 'error', message: 'the prompt was empty after sanitisation' };
      return;
    }

    const waiter = createWaiter<AgentSignal | null>();
    this.turnStop = waiter;
    try {
      // Two writes with a gap, never `prompt\r` in one chunk: the TUI's paste
      // detection would absorb the trailing Enter as pasted content and the
      // prompt would sit unsubmitted in the input box (see SUBMIT_DELAY_MS).
      this.deps.host.write(ptyId, prompt);
      await delay(this.deps.submitDelayMs ?? SUBMIT_DELAY_MS);
      if (this._disposed) return;
      this.deps.host.write(ptyId, '\r');
      // Belt-and-braces second Enter: the first can still be swallowed when it
      // lands during a TUI redraw right after the previous turn (observed in
      // dogfood). If the first one DID submit, the input box is empty by now
      // and an Enter on an empty box is a no-op — so the retry is harmless.
      await delay((this.deps.submitDelayMs ?? SUBMIT_DELAY_MS) * 2);
      if (this._disposed) return;
      this.deps.host.write(ptyId, '\r');
    } catch (err) {
      this.turnStop = null;
      yield { type: 'error', message: `could not reach the terminal brain: ${String(err)}` };
      return;
    }

    const timeout = delay(this.deps.turnTimeoutMs ?? TURN_TIMEOUT_MS).then(() => 'timeout' as const);
    const stop = await Promise.race([waiter.promise, timeout]);
    // dispose() resolves the waiter with null so this iterator TERMINATES
    // rather than hanging the manager's for-await on app quit.
    if (stop === null || this._disposed) return;
    if (stop === 'timeout') {
      this.turnStop = null;
      yield { type: 'error', message: 'the terminal brain did not finish its turn' };
      return;
    }

    // A completed turn proves whatever session it ran on, and consumes the
    // one-shot bootstrap context (it is part of the transcript now).
    this._resumeUnvalidated = false;
    this._startOptions = { ...this._startOptions, systemPrompt: undefined, fleetContext: undefined };
    // The bridge derives agentSessionId from the transcript basename — the
    // #12235-safe id `--resume` accepts.
    if (stop.agentSessionId) this._sessionId = stop.agentSessionId;

    const transcriptPath =
      typeof stop.payload?.transcript_path === 'string' ? stop.payload.transcript_path : null;
    if (transcriptPath) {
      const read = this.deps.readTranscript ?? readLastAssistantMessage;
      let last: { text: string } | null = null;
      try {
        last = read(transcriptPath);
      } catch {
        /* a transcript we cannot read costs the bubble, never the turn */
      }
      if (last?.text) yield { type: 'text-delta', text: last.text };
    }
    yield { type: 'turn-end', sessionId: this._sessionId };
  }

  interrupt(): void {
    const id = this.ptyId;
    if (!id) return;
    try {
      // ESC is the TUI's own cancel key — the interactive equivalent of the
      // SDK handle's interrupt().
      this.deps.host.write(id, '\u001b');
    } catch {
      /* best-effort — the pty may already be tearing down */
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // Revoke FIRST so a straggling MCP call from the dying child fails closed.
    revokeCommanderToken(this._commanderToken);
    // Terminate any in-flight iterator (see the null branch in send()).
    this.turnStop?.resolve(null);
    this.turnStop = null;
    this.sessionStarted?.resolve();
    void this.killPty();
    for (const p of this.profilePaths) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone / never written */
      }
    }
    this.profilePaths = [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Locate the bundled `wmux-bridge.mjs` the generated profile points at. Walks
 *  the same candidate list `wmux setup-hooks` uses, plus the already-installed
 *  stable copy at `~/.wmux/hooks/`. Returns null when none exists. */
export function resolveBrainBridgePath(startDir = __dirname): string | null {
  // Prefer OUR OWN copy of the bridge (the bundle walk below) over the
  // user-installed ~/.wmux/hooks one: the installed copy belongs to whatever
  // release last wrote it and may predate fixes this build depends on (the
  // instance-suffix pipe routing did exactly that — the prod copy delivered a
  // dev brain's signals to the production pipe). The installed copy remains
  // the fallback for exotic packagings where the walk finds nothing.
  const candidates = [
    'wmux-bridge.mjs',
    path.join('cli-bundle', 'wmux-bridge.mjs'),
    path.join('dist', 'cli-bundle', 'wmux-bridge.mjs'),
    path.join('integrations', 'claude', 'bin', 'wmux-bridge.mjs'),
  ];
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    for (const rel of candidates) {
      const candidate = path.join(dir, rel);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* keep scanning */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const installed = path.join(os.homedir(), '.wmux', 'hooks', 'wmux-bridge.mjs');
  try {
    if (fs.existsSync(installed)) return installed;
  } catch {
    /* no installed copy either */
  }
  return null;
}
