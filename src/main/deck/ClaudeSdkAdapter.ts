// ─── Command Deck — Claude Agent SDK brain adapter (Phase 2, P2b) ────────────
//
// The one concrete BrainAdapter Phase 2 ships. Drives the fleet through the
// `@anthropic-ai/claude-agent-sdk` `query()` — running in the MAIN process
// (subprocess spawn + file access), NOT the renderer.
//
// Phase 0 proved the three load-bearing facts this adapter relies on:
//   1. `query()` runs on SUBSCRIPTION auth when ANTHROPIC_API_KEY is absent
//      (apiKeySource=none) — zero-API, the wmux moat. We force this by scrubbing
//      the key from the spawned env.
//   2. `options.mcpServers = { wmux: { type:'stdio', command:'node', args:[<mcp
//      bundle>] } }` + `allowedTools:['mcp__wmux__…']` gives the brain the live
//      fleet as hands.
//   3. `options.resume: sessionId` threads turns across subprocesses — the
//      process-crossing continuity Phase 3's reboot survival will build on.
//
// Turn model: each `send()` is ONE `query()` call. The first turn launches
// fresh (system prompt + one-shot fleet context prepended to the prompt);
// every later turn passes `resume: this._sessionId`, so the transcript is
// recalled from disk rather than re-sent. The session manager guarantees one
// turn at a time, so a single `_active` handle is enough for `interrupt()`.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import {
  type BrainAdapter,
  type BrainEvent,
  type BrainStartOptions,
  type RawSdkMessage,
  createNormalizeState,
  normalizeSdkMessage,
} from './BrainAdapter';

// ─── Injectable SDK seam ─────────────────────────────────────────────────────

/** The shape the adapter needs from an SDK `query()` result: an async iterable
 *  of raw messages plus a best-effort `interrupt()`. The real `Query` satisfies
 *  this; a test passes a fake. */
export interface SdkQueryHandle extends AsyncIterable<RawSdkMessage> {
  interrupt?: () => Promise<unknown> | void;
}

export type SdkQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => SdkQueryHandle;

// ─── SDK loading (dev vs packaged) ───────────────────────────────────────────
//
// The packaged app ships NO node_modules (forge `ignore` keeps only /.vite), so
// a static import of the SDK — marked `external` in vite.main.config because it
// self-spawns a CLI — would crash the main bundle at load. Instead the SDK is
// copied to resources/claude-agent-sdk via forge extraResource (3.8 MB of pure
// JS, zero runtime deps) and loaded lazily:
//   dev      → import('@anthropic-ai/claude-agent-sdk') resolves from
//              node_modules as usual;
//   packaged → dynamic import of resources/claude-agent-sdk/sdk.mjs.
// Lazy also means the deck costs nothing until the first brain turn.
let cachedSdkQueryFn: SdkQueryFn | null = null;

export async function loadSdkQueryFn(): Promise<SdkQueryFn> {
  if (cachedSdkQueryFn) return cachedSdkQueryFn;
  if (app.isPackaged) {
    const sdkPath = path.join(process.resourcesPath, 'claude-agent-sdk', 'sdk.mjs');
    const mod = (await import(pathToFileURL(sdkPath).href)) as { query: SdkQueryFn };
    cachedSdkQueryFn = mod.query;
    return cachedSdkQueryFn;
  }
  const mod = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as { query: SdkQueryFn };
  cachedSdkQueryFn = mod.query;
  return cachedSdkQueryFn;
}

// ─── claude executable resolution ────────────────────────────────────────────
//
// The SDK's platform package (claude-agent-sdk-win32-x64 et al.) vendors a
// ~240 MB claude binary — far too heavy to ship inside the wmux installer. The
// deck instead targets the USER'S OWN claude install (the zero-API premise
// already assumes one: the fleet's worker panes run it). Verified end-to-end in
// Phase 0 probe #4: `pathToClaudeCodeExecutable` pointed at the installed
// claude.exe runs on subscription auth with no platform package present.
//
// NOTE: a `claude.cmd` npm shim is NOT spawnable (Node 20+ EINVAL without
// shell:true) — only real executables or JS entrypoints (SDK runs .js via
// node) may be returned here.
export function resolveClaudeExecutable(): string | null {
  const home = os.homedir();
  const candidates: string[] = [
    // Native installer (preferred — self-updating).
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude'),
  ];
  const appData = process.env.APPDATA;
  if (appData) {
    // npm global: modern versions ship a native exe; older ones a JS cli.
    candidates.push(
      path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    );
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* inaccessible path — keep scanning */
    }
  }
  return null;
}

/** GLM / Z.ai (or any Anthropic-compatible) endpoint profile. When set, the
 *  same adapter targets a different backend purely via env — the review-team
 *  pattern. Phase 2 exposes only the default Claude profile; this exists so the
 *  swap is an env choice, not a code fork. */
export interface BrainEndpointProfile {
  baseUrl?: string;
  authToken?: string;
}

export interface ClaudeSdkAdapterDeps {
  /** SDK `query` — injected so the normalization can be tested with a fake and
   *  no live model / subprocess. Defaults to the real SDK. */
  queryFn?: SdkQueryFn;
  /** Absolute path to the wmux MCP stdio bundle. Defaults to the resolver. */
  mcpBundlePath?: string | null;
  /** Tool allow-list (see DEFAULT_ALLOWED_TOOLS / D2). */
  allowedTools?: string[];
  /** Model id; defaults to the SDK default (subscription's default model). */
  model?: string;
  /** Per-turn ceiling on agentic tool loops. */
  maxTurns?: number;
  /** Non-default backend (GLM/Z.ai). Omit for Claude subscription. */
  profile?: BrainEndpointProfile;
}

// ─── Permission defaults (D2) ────────────────────────────────────────────────
//
// D2: auto-allow every READ tool + pane_split + terminal_send/read + the
// channel/A2A messaging tools. The DESTRUCTIVE tools a commander did not create
// (pane_close / surface_close / workspace teardown) are DELIBERATELY OMITTED:
// a tool absent from `allowedTools` is auto-DENIED by the SDK, which for Phase 2
// is exactly the guardrail we want. The inline approval UI that would let the
// human grant those case-by-case is DEFERRED TO PHASE 3 (see the impl plan's
// "deferred" section) — until then the brain simply cannot close panes.
//
// company_* (paid "wmux max") and the browser_* automation suite are out of
// scope and intentionally excluded — the deck orchestrates the terminal fleet,
// not the paid company surface or headless browsers.
const WMUX = (t: string): string => `mcp__wmux__${t}`;

export const DEFAULT_ALLOWED_TOOLS: string[] = [
  // Read / observe — the whole family.
  WMUX('pane_list'),
  WMUX('pane_get_metadata'),
  WMUX('surface_list'),
  WMUX('workspace_list'),
  WMUX('terminal_read'),
  WMUX('terminal_read_events'),
  WMUX('wmux_search_panes'),
  WMUX('wmux_events_poll'),
  WMUX('channel_list'),
  WMUX('channel_read'),
  WMUX('channel_unread'),
  WMUX('channel_get_members'),
  WMUX('a2a_discover'),
  WMUX('a2a_whoami'),
  WMUX('a2a_task_query'),
  // Spawn + drive panes (create is allowed; close/teardown is NOT — P3 gate).
  WMUX('pane_split'),
  WMUX('pane_focus'),
  WMUX('pane_set_metadata'),
  WMUX('surface_new'),
  WMUX('terminal_send'),
  WMUX('terminal_send_key'),
  // Channel + A2A messaging — the orchestrator's comms bus.
  WMUX('channel_create'),
  WMUX('channel_post'),
  WMUX('channel_join'),
  WMUX('channel_leave'),
  WMUX('channel_invite'),
  WMUX('channel_ack'),
  WMUX('channel_mission_start'),
  WMUX('channel_mission_close'),
  WMUX('a2a_task_send'),
  WMUX('a2a_task_update'),
  WMUX('a2a_task_cancel'),
  WMUX('a2a_broadcast'),
  WMUX('a2a_set_skills'),
  WMUX('send_message'),
];

/** Spawn ceiling the system prompt instructs the brain to respect (D2 = 8).
 *  Phase 2 states it as an instruction; a HARD cap (counting pane_split calls
 *  and revoking the tool) is a deferred follow-up — noted in the impl plan. */
export const DEFAULT_SPAWN_CAP = 8;

const DEFAULT_MAX_TURNS = 48;

/**
 * Resolve the wmux MCP stdio bundle the brain mounts. Mirrors
 * McpRegistrar.getMcpScriptPath: packaged → resources/mcp-bundle/index.js (with
 * the legacy fallback); dev → dist/mcp/mcp/index.js, walking up a few parents so
 * a worktree / nested cwd still finds the repo's build output. Returns null when
 * no bundle exists (the deck then runs the brain with NO fleet tools, rather
 * than crashing — surfaced as a startup warning by the caller).
 */
export function resolveMcpBundlePath(): string | null {
  if (app.isPackaged) {
    const bundlePath = path.join(process.resourcesPath, 'mcp-bundle', 'index.js');
    if (fs.existsSync(bundlePath)) return bundlePath;
    const legacyPath = path.join(process.resourcesPath, 'mcp', 'mcp', 'index.js');
    if (fs.existsSync(legacyPath)) return legacyPath;
    return null;
  }
  const appPath = app.getAppPath();
  const devPath = path.join(appPath, 'dist', 'mcp', 'mcp', 'index.js');
  if (fs.existsSync(devPath)) return devPath;
  let current = appPath;
  for (let i = 0; i < 5; i++) {
    const parent = path.resolve(current, '..');
    if (parent === current) break;
    const candidate = path.join(parent, 'dist', 'mcp', 'mcp', 'index.js');
    if (fs.existsSync(candidate)) return candidate;
    current = parent;
  }
  return null;
}

/** Default system prompt (identity + policy). The fleet snapshot is appended
 *  separately at the first turn (token-budgeted). */
export function buildCommanderSystemPrompt(spawnCap = DEFAULT_SPAWN_CAP): string {
  return [
    'You are the wmux fleet commander: a headless orchestrator that drives a fleet',
    'of terminal panes (each running an AI coding agent or a shell) on behalf of a',
    'human operator, using ONLY the wmux MCP tools.',
    '',
    'How you work:',
    '- To see the fleet, call pane_list / workspace_list. To inspect a pane, use',
    '  terminal_read. To act, use pane_split (spawn), terminal_send (instruct), and',
    '  the channel_* / a2a_* tools (coordinate).',
    '- Prefer delegating work to worker panes over doing it yourself. Split work into',
    '  parallel panes when it genuinely parallelizes; keep the human informed with a',
    '  short summary at the end of each turn.',
    `- Do NOT spawn more than ${spawnCap} panes in a session unless the operator asks.`,
    '- You cannot close panes or tear down workspaces in this version; if cleanup is',
    '  needed, tell the operator what to remove.',
    '- Be concise. The operator reads your prose in a chat dock, and every tool call',
    '  shows up as a chip — narrate intent, not mechanics.',
  ].join('\n');
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class ClaudeSdkAdapter implements BrainAdapter {
  private readonly queryFn: SdkQueryFn | null;
  private readonly mcpBundlePath: string | null;
  private readonly allowedTools: string[];
  private readonly model?: string;
  private readonly maxTurns: number;
  private readonly profile?: BrainEndpointProfile;

  private _sessionId: string | null = null;
  private _systemPrompt?: string;
  private _fleetContext?: string;
  private _fleetContextInjected = false;
  private _active: SdkQueryHandle | null = null;
  private _disposed = false;

  constructor(deps: ClaudeSdkAdapterDeps = {}) {
    this.queryFn = deps.queryFn ?? null;
    this.mcpBundlePath =
      deps.mcpBundlePath !== undefined ? deps.mcpBundlePath : resolveMcpBundlePath();
    this.allowedTools = deps.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    this.model = deps.model;
    this.maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
    this.profile = deps.profile;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Whether a wmux MCP bundle was resolved (fleet tools available). The caller
   *  surfaces a warning when false. */
  get hasFleetTools(): boolean {
    return !!this.mcpBundlePath;
  }

  start(opts: BrainStartOptions): void {
    this._systemPrompt = opts.systemPrompt ?? buildCommanderSystemPrompt();
    this._fleetContext = opts.fleetContext;
    this._fleetContextInjected = false;
  }

  /**
   * Build the spawn environment. Forces subscription auth by DROPPING
   * ANTHROPIC_API_KEY (Options.env replaces the child env, so we spread
   * process.env then unset the key). A GLM/Z.ai profile injects the compatible
   * base-url / auth-token overrides.
   */
  private buildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    // Zero-API: never let an ambient key flip the session onto metered API auth.
    delete env.ANTHROPIC_API_KEY;
    if (this.profile?.baseUrl) env.ANTHROPIC_BASE_URL = this.profile.baseUrl;
    if (this.profile?.authToken) env.ANTHROPIC_AUTH_TOKEN = this.profile.authToken;
    return env;
  }

  private buildOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {
      env: this.buildEnv(),
      maxTurns: this.maxTurns,
      allowedTools: this.allowedTools,
      // Only the wmux MCP server; no ambient project/user MCP config is loaded.
      strictMcpConfig: true,
    };
    if (this._systemPrompt) options.systemPrompt = this._systemPrompt;
    if (this.model) options.model = this.model;
    if (this.mcpBundlePath) {
      // Spawn the MCP bundle with wmux's own Electron binary in Node mode
      // (ELECTRON_RUN_AS_NODE) instead of assuming a `node` on the END USER'S
      // PATH — the packaged app cannot rely on one existing. Works identically
      // in dev (execPath = the dev electron binary).
      // WMUX_DATA_SUFFIX must be threaded EXPLICITLY: the MCP subprocess is
      // spawned by the claude CLI, whose stdio-server spawner only inherits a
      // fixed default env list on win32 — the suffix is not on it. Without
      // this, a suffix-isolated wmux instance's brain would resolve the
      // DEFAULT pipe name and drive the wrong (or a dead) instance.
      const suffixEnv = process.env.WMUX_DATA_SUFFIX
        ? { WMUX_DATA_SUFFIX: process.env.WMUX_DATA_SUFFIX }
        : {};
      options.mcpServers = {
        wmux: {
          type: 'stdio',
          command: process.execPath,
          args: [this.mcpBundlePath],
          env: { ELECTRON_RUN_AS_NODE: '1', ...suffixEnv },
        },
      };
    }
    // Resume threads later turns onto the same transcript.
    if (this._sessionId) options.resume = this._sessionId;
    return options;
  }

  /** Prepend the one-shot fleet context to the first turn's prompt only. */
  private composePrompt(text: string): string {
    if (this._fleetContext && !this._fleetContextInjected) {
      this._fleetContextInjected = true;
      return `${this._fleetContext}\n\n---\n\n${text}`;
    }
    return text;
  }

  async *send(text: string): AsyncIterable<BrainEvent> {
    if (this._disposed) {
      yield { type: 'error', message: 'commander session disposed' };
      return;
    }
    const state = createNormalizeState();
    state.sessionId = this._sessionId;
    let handle: SdkQueryHandle;
    try {
      const queryFn = this.queryFn ?? (await loadSdkQueryFn());
      const options = this.buildOptions();
      // Packaged builds must target the user's own claude install (the SDK's
      // default resolution needs its 240 MB platform package, which we do not
      // ship). Dev keeps the SDK default (platform package in node_modules)
      // unless the user install is present.
      if (options.pathToClaudeCodeExecutable === undefined) {
        const exe = resolveClaudeExecutable();
        if (exe) {
          options.pathToClaudeCodeExecutable = exe;
        } else if (app.isPackaged) {
          yield {
            type: 'error',
            message:
              'Claude Code not found — the commander needs a claude install (native installer or npm global). Install it, then retry.',
          };
          return;
        }
      }
      handle = queryFn({ prompt: this.composePrompt(text), options });
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    }
    this._active = handle;
    try {
      for await (const msg of handle) {
        for (const ev of normalizeSdkMessage(msg as RawSdkMessage, state)) {
          if (ev.type === 'turn-end' && ev.sessionId) this._sessionId = ev.sessionId;
          yield ev;
        }
      }
      // Some SDK error paths end the stream without a `result` frame; make sure
      // the session id captured mid-stream is persisted for resume regardless.
      if (state.sessionId) this._sessionId = state.sessionId;
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    } finally {
      if (this._active === handle) this._active = null;
    }
  }

  interrupt(): void {
    const h = this._active;
    if (h?.interrupt) {
      try {
        // interrupt() may reject asynchronously (e.g. subprocess already
        // exited) — an unobserved rejection would crash the main process.
        void Promise.resolve(h.interrupt()).catch(() => {
          /* best-effort — the turn may already be tearing down */
        });
      } catch {
        /* best-effort — the turn may already be tearing down */
      }
    }
  }

  dispose(): void {
    this._disposed = true;
    this.interrupt();
    this._active = null;
  }
}
