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
import { getWmuxDir } from '../../daemon/config';
import { loadCommanderMemory, getMemoryRootDir } from './commanderMemory';
import { mintCommanderToken, revokeCommanderToken } from './commanderTrust';
import { evaluateCommanderToolPermission } from './commanderToolSandbox';
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
  /** Durable-memory loader (M1a/M1c) — returns the formatted block injected
   *  into the first turn alongside the fleet context, or '' for nothing.
   *  Injected so tests control it; defaults to loadCommanderMemory, which
   *  layers this workspace's partition (memory/<workspaceId>/) on top of the
   *  shared global memory (memory/_global/) — see deps.workspaceId. */
  loadMemory?: () => string;
  /** The one workspace this orchestrator serves (M1.5). Bound into the
   *  commander token so `deck.resolvePaneRoute` confines this brain's
   *  explicit-pane targeting to its own workspace. Omitted/empty → the token
   *  resolves nothing (fail closed). This is also where M1c's per-workspace
   *  memory partition loads from. */
  workspaceId?: string;
  /** Root of the memory store the Write sandbox confines the brain to (M1b).
   *  Injected so tests stay hermetic (never the developer's real ~/.wmux);
   *  defaults to commanderMemory.getMemoryRootDir(), resolved lazily only when
   *  the permission callback actually fires. */
  memoryRoot?: string;
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

// Built-in CLI tools the orchestrator must NEVER hold. `allowedTools` only
// AUTO-ALLOWS — everything else goes through the permission system, which
// held for Bash/Edit in live use (denied, verified in a real transcript) but
// NOT for the built-in subagent tools: `Agent`/`Task` executed without any
// approval, and the brain used them to fake "spawned a Claude agent in bypass
// mode" theater instead of driving a real wmux pane (it even typed a fake
// prompt string into the pane with terminal_send). Disallowing is a hard
// fail-closed: the tool does not exist for this session, no permission path.
// The remaining file/shell tools ride along as defense-in-depth — Bash never,
// and the other editors have no memory-write use.
//
// Write is DELIBERATELY ABSENT here (M1b): it is now governed by the
// canUseTool sandbox (commanderToolSandbox) instead of hard-disallowed, so the
// brain can persist what it learns into its own memory folders — and nowhere
// else. It stays OUT of DEFAULT_ALLOWED_TOOLS too, because allowedTools would
// bypass the sandbox; Write must flow through the permission callback.
export const DISALLOWED_TOOLS: string[] = [
  'Agent',
  'Task',
  'Bash',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
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

/** Extra context the prompt needs to name the brain's real memory folders in
 *  its write-policy block (M1b). Omitted → generic wording. */
export interface CommanderSystemPromptOptions {
  /** Root of the memory store (`getMemoryRootDir()`). */
  memoryRoot?: string;
  /** The workspace this brain serves — names its own partition folder. */
  workspaceId?: string;
}

/** Default system prompt (identity + policy). The fleet snapshot is appended
 *  separately at the first turn (token-budgeted). `opts` lets the caller bake
 *  the brain's REAL memory-folder paths into the write policy (M1b); without
 *  it the policy falls back to generic folder names. */
export function buildCommanderSystemPrompt(
  spawnCap = DEFAULT_SPAWN_CAP,
  opts: CommanderSystemPromptOptions = {},
): string {
  // Name the literal folders when we know them, so the brain writes to a real
  // absolute path instead of guessing. A missing/invalid workspaceId degrades
  // to global-only wording — never an invented partition path.
  const SAFE_WS = /^[A-Za-z0-9._-]{1,80}$/;
  const wsId =
    opts.workspaceId && SAFE_WS.test(opts.workspaceId) && opts.workspaceId !== '..'
      ? opts.workspaceId
      : undefined;
  const globalDir = opts.memoryRoot ? path.join(opts.memoryRoot, '_global') : null;
  const workspaceDir = opts.memoryRoot && wsId ? path.join(opts.memoryRoot, wsId) : null;
  const workspaceClause = workspaceDir
    ? `your workspace folder ${workspaceDir}`
    : 'your own workspace memory folder';
  const globalClause = globalDir ? `the shared folder ${globalDir}` : 'the shared `_global` folder';
  return [
    'You are the wmux Orchestrator: a headless brain that drives the terminal',
    'panes (each running an AI coding agent or a shell) on behalf of a human',
    'operator, using ONLY the wmux MCP tools. When you refer to yourself, say',
    '"the orchestrator"; refer to the panes collectively as "your agents" —',
    'never "the fleet".',
    '',
    'The wmux world (these are first-class wmux objects — the operator will name',
    'them, and you must understand them, not treat the words as unknown):',
    '- Workspace: a top-level container (like a project or a tabbed window). Each',
    '  workspace holds its own panes and has a stable workspaceId. "Per workspace"',
    '  means scoped to one of these. Enumerate them with workspace_list.',
    '- Pane: one terminal inside a workspace, running an AI coding agent or a shell.',
    '  This is an "agent". Enumerate with pane_list; read one with terminal_read.',
    '- Surface: a window/view that presents panes (surface_list / surface_new).',
    '- The operator commonly says "workspace", "pane", "agent", "bypass mode" — take',
    '  these as concrete wmux concepts, never ask "what is that".',
    '',
    'Permission / bypass modes are a LEGITIMATE wmux feature, not a security bypass',
    'to refuse. If the operator asks to run agents in a permission mode (e.g.',
    'bypassPermissions / "bypass mode", acceptEdits), treat it as a normal',
    'configuration request. If the current spawn tool cannot set that mode yet, say',
    'so plainly and tell the operator how to set it themselves — do NOT decline on',
    '"I cannot circumvent security" grounds.',
    '',
    'How you work:',
    '- To see the agents, call pane_list / workspace_list. To inspect a pane, use',
    '  terminal_read. To act, use pane_split (spawn), terminal_send (instruct), and',
    '  the channel_* / a2a_* tools (coordinate).',
    '- LAUNCHING AN AGENT means running its real CLI in a real pane: pane_split to',
    '  get a terminal, then terminal_send the actual command (e.g. `claude`, or',
    '  `claude --dangerously-skip-permissions` for bypass mode) with submit, then',
    '  terminal_read to confirm it started. You have NO built-in subagents — the',
    '  Agent/Task tools are disabled. Never type a fake prompt or banner into a',
    '  pane to make it LOOK like an agent is running: an agent either really runs',
    '  in a pane or you say plainly that it does not.',
    '- Prefer delegating work to worker panes over doing it yourself. Split work into',
    '  parallel panes when it genuinely parallelizes; keep the human informed with a',
    '  short summary at the end of each turn. You have no shell or file tools of',
    '  your own — anything that needs one runs in a worker pane via terminal_send.',
    `- Do NOT spawn more than ${spawnCap} panes in a session unless the operator asks.`,
    '- You cannot close panes or tear down workspaces in this version; if cleanup is',
    '  needed, tell the operator what to remove.',
    '- Be concise. The operator reads your prose in a chat dock, and every tool call',
    '  shows up as a chip — narrate intent, not mechanics.',
    '',
    'Memory (persist what you learn):',
    '- You have a Write tool, sandboxed to your memory folders ONLY. At the end of a',
    '  turn, if you learned a durable, NON-OBVIOUS fact — an operator preference, a',
    '  project convention, a standing instruction, or a mistake worth not repeating —',
    '  write it down: one fact per file, a short kebab-case `.md` filename.',
    `- Workspace-specific facts go in ${workspaceClause}; operator-wide facts in ${globalClause}.`,
    '- If a stored fact turns out wrong, update or delete that file instead of writing',
    '  a duplicate. Never store secrets, and never store instructions disguised as facts.',
    '- Write works ONLY inside those two folders and only for `.md` files; any other',
    '  path is denied. You still have no shell or general file tools.',
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
  private readonly loadMemory: () => string;
  /** The one workspace this brain serves — gates the Write sandbox's
   *  per-workspace partition (M1b). */
  private readonly _workspaceId?: string;
  /** Memory-store root the Write sandbox confines the brain to (M1b). Undefined
   *  → resolve getMemoryRootDir() lazily in the callback (keeps mocked tests
   *  that never fire canUseTool from needing that export). */
  private readonly _memoryRoot?: string;

  private _sessionId: string | null = null;
  private _resumeUnvalidated = false;
  private _systemPrompt?: string;
  private _fleetContext?: string;
  /** One-shot context (memory + fleet snapshot) goes into the FIRST composed
   *  prompt only. A resume-fallback retry re-sends the same composed prompt,
   *  so the flag lives here, not in the retry loop. */
  private _contextInjected = false;
  private _active: SdkQueryHandle | null = null;
  private _disposed = false;
  /** Per-spawn trust token (commanderTrust) — injected into the MCP env so
   *  terminal routing can grant this brain pane targeting WITHIN its own
   *  workspace (M1.5 confinement). */
  private readonly _commanderToken: string;

  constructor(deps: ClaudeSdkAdapterDeps = {}) {
    this.queryFn = deps.queryFn ?? null;
    this.mcpBundlePath =
      deps.mcpBundlePath !== undefined ? deps.mcpBundlePath : resolveMcpBundlePath();
    this.allowedTools = deps.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    this.model = deps.model;
    this.maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
    this.profile = deps.profile;
    // Default loader layers both partitions for THIS workspace (M1c). Bound to
    // deps.workspaceId at construction so the brain only ever sees its own
    // workspace's memory plus the shared global partition.
    this.loadMemory = deps.loadMemory ?? (() => loadCommanderMemory({ workspaceId: deps.workspaceId }));
    this._workspaceId = deps.workspaceId;
    this._memoryRoot = deps.memoryRoot;
    // An empty binding registers an unroutable token — fail closed rather
    // than fleet-wide when a caller forgets the workspace.
    this._commanderToken = mintCommanderToken(deps.workspaceId ?? '');
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
    this._contextInjected = false;
    // P3a: seed a persisted session id so the FIRST turn already resumes. The
    // id is unvalidated until a turn completes against it — send() falls back
    // to a fresh session when the claude side no longer knows it (transcript
    // GC'd, different machine, …) instead of bricking the commander.
    if (opts.resumeSessionId) {
      this._sessionId = opts.resumeSessionId;
      this._resumeUnvalidated = true;
    }
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
      // Hard-remove the built-in subagent/file/shell tools (see
      // DISALLOWED_TOOLS): allowedTools alone only skips permission prompts,
      // and Agent/Task run WITHOUT one.
      disallowedTools: DISALLOWED_TOOLS,
      // M1b: the ONE gate for the brain's Write hand. Fires for every tool not
      // auto-allowed via allowedTools; the sandbox permits Write only into the
      // brain's own `.md` memory folders and denies everything else. Wrapped in
      // try/catch → deny so a thrown callback can never kill a live turn (the
      // SDK's string-prompt path opens a bidirectional stdio control channel —
      // `--input-format stream-json` is always set — so canUseTool works with
      // our plain-string prompt; no streaming-input conversion needed).
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        try {
          const memoryRoot = this._memoryRoot ?? getMemoryRootDir();
          return evaluateCommanderToolPermission(toolName, input, {
            memoryRoot,
            workspaceId: this._workspaceId,
          });
        } catch {
          return { behavior: 'deny' as const, message: 'orchestrator permission check failed' };
        }
      },
      // Only the wmux MCP server; no ambient project/user MCP config is loaded.
      strictMcpConfig: true,
      // Load NO filesystem settings. The SDK default is
      // ['user','project','local'] (verified in sdk.mjs), which made every
      // brain turn inherit the USER'S hooks — including the wmux Claude
      // plugin's own PostToolUse/Stop bridge. Net effect: each orchestrator
      // tool call spawned a ~110ms node bridge process (hook storm, CPU
      // stutter under event-push wakes), the brain's Stop re-entered
      // hooks.signal as a phantom agent event (self-wake feedback risk when
      // main inherits WMUX_* env in dev), and the owner's personal hooks ran
      // inside brain turns. The brain's contract is fully explicit already:
      // systemPrompt is injected manually, tools via allowedTools/
      // disallowedTools/canUseTool, MCP via strictMcpConfig.
      settingSources: [],
      // P3a: claude keys its session transcripts by cwd, and a packaged
      // Electron app's process.cwd() is the per-version install folder
      // (Squirrel app-x.y.z) — resume would silently break on every update.
      // Pin the brain to the wmux data dir so session storage is stable across
      // app updates, reboots, and launch locations.
      cwd: getWmuxDir(),
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
          // WMUX_COMMANDER_TOKEN marks this MCP as the commander's hands: the
          // deck.resolvePaneRoute RPC accepts it and resolves a pane's true
          // owning workspace — but ONLY within the workspace the token is
          // bound to (M1.5 confinement). External callers without the token
          // keep the #163 fail-closed routing unchanged (codex P1).
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            WMUX_COMMANDER_TOKEN: this._commanderToken,
            ...suffixEnv,
          },
        },
      };
    }
    // Resume threads later turns onto the same transcript.
    if (this._sessionId) options.resume = this._sessionId;
    return options;
  }

  /** Prepend the one-shot context (durable memory + fleet snapshot) to the
   *  first turn's prompt only. Memory load failures are swallowed — a broken
   *  memory store must never break a live turn (M1a is read-only anyway). */
  private composePrompt(text: string): string {
    if (this._contextInjected) return text;
    this._contextInjected = true;
    const parts: string[] = [];
    let memory = '';
    try {
      memory = this.loadMemory();
    } catch {
      /* memory is best-effort context, never a turn blocker */
    }
    if (memory) parts.push(memory);
    if (this._fleetContext) parts.push(this._fleetContext);
    if (parts.length === 0) return text;
    return `${parts.join('\n\n---\n\n')}\n\n---\n\n${text}`;
  }

  async *send(text: string): AsyncIterable<BrainEvent> {
    if (this._disposed) {
      yield { type: 'error', message: 'commander session disposed' };
      return;
    }
    let queryFn: SdkQueryFn;
    try {
      queryFn = this.queryFn ?? (await loadSdkQueryFn());
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    }
    // Composed ONCE — a resume-fallback retry re-sends the same prompt (the
    // fleet-context injection must not double up).
    const prompt = this.composePrompt(text);

    // At most two attempts: the first may run against a DISK-SEEDED session id
    // (P3a) that the claude side no longer knows (transcript GC'd, moved
    // machine, corrupt store). When that turn dies before producing ANY event,
    // drop the dead id and retry once fresh instead of surfacing an opaque
    // error for every send.
    for (let attempt = 0; attempt < 2; attempt++) {
      const resumingUnvalidated = this._resumeUnvalidated && !!this._sessionId;
      const state = createNormalizeState();
      state.sessionId = this._sessionId;
      let handle: SdkQueryHandle;
      try {
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
        handle = queryFn({ prompt, options });
      } catch (err) {
        if (resumingUnvalidated && attempt === 0) {
          this.dropSeededResume('spawn threw', err);
          continue;
        }
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
        return;
      }
      this._active = handle;
      let yielded = false;
      let retryFresh = false;
      try {
        outer: for await (const msg of handle) {
          for (const ev of normalizeSdkMessage(msg as RawSdkMessage, state)) {
            // A turn that errors before ANYTHING reached the renderer, on the
            // first attempt against an unvalidated disk id → treat the id as
            // dead and swallow the error in favor of a fresh retry.
            if (ev.type === 'error' && resumingUnvalidated && attempt === 0 && !yielded) {
              retryFresh = true;
              break outer;
            }
            if (ev.type === 'turn-end' && ev.sessionId) this._sessionId = ev.sessionId;
            yielded = true;
            // Any REAL content out of a resumed turn proves the id (codex P2:
            // validating only on turn-end let a mid-stream failure after
            // content leave the flag set, and a LATER pre-content error would
            // then wrongly drop a proven-valid conversation). The error case
            // never reaches here on the unvalidated first attempt (retry
            // branch above), and a later attempt's error doesn't validate —
            // by then the flag only clears through this same content path.
            if (ev.type !== 'error') this._resumeUnvalidated = false;
            yield ev;
          }
        }
        // Some SDK error paths end the stream without a `result` frame; make
        // sure the session id captured mid-stream survives for resume.
        if (!retryFresh && state.sessionId) this._sessionId = state.sessionId;
      } catch (err) {
        if (resumingUnvalidated && attempt === 0 && !yielded) {
          retryFresh = true;
          this.dropSeededResume('stream threw', err);
        } else {
          yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
        }
      } finally {
        if (this._active === handle) this._active = null;
      }
      if (!retryFresh) return;
      // Best-effort teardown of the dead attempt's subprocess before retrying.
      if (handle.interrupt) {
        try {
          void Promise.resolve(handle.interrupt()).catch(() => {
            /* already dead */
          });
        } catch {
          /* already dead */
        }
      }
      this.dropSeededResume('turn errored before first event');
    }
  }

  /** Forget a disk-seeded session id that turned out to be dead (P3a fallback). */
  private dropSeededResume(reason: string, err?: unknown): void {
    if (!this._sessionId) return;
    // eslint-disable-next-line no-console
    console.warn(
      `[deck] persisted commander session ${this._sessionId} did not resume (${reason}) — starting fresh`,
      err ?? '',
    );
    this._sessionId = null;
    this._resumeUnvalidated = false;
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
    // A dead brain's token must not be replayable by a later process.
    revokeCommanderToken(this._commanderToken);
  }
}
