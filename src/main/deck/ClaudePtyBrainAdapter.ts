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
import { getAccountStore } from '../account/accountStore';
import { COMMANDER_MODE_ARG, COMMANDER_TOOL_SURFACE } from '../../shared/commanderSurface';
import { ENV_KEYS, BRAIN_PTY_ID_PREFIX } from '../../shared/constants';
import { mintCommanderToken, revokeCommanderToken } from './commanderTrust';
import { registerBrainPty, type BrainPtyHookBlock } from './brainPtyHookBus';
import { installBrainSkills } from './brainSkills';
import type { StopGateVerdict } from './stopGate';
import { readLastAssistantMessage } from '../claude/lastAssistantMessage';
import { resolveClaudeExecutable, resolveMcpBundlePath, DISALLOWED_TOOLS } from './ClaudeSdkAdapter';
import type { AgentSignal } from '../../shared/hooks/signal-types';
import type {
  BrainAdapter,
  BrainEvent,
  BrainSendOptions,
  BrainStartOptions,
} from './BrainAdapter';

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
/** How long after a TIMED-OUT turn a Stop hook is still assumed to belong to
 *  that dead turn rather than the next one. The adapter ESCs the TUI on
 *  timeout, so its Stop should arrive within seconds; the window bounds the
 *  damage if it never arrives at all (the credit would otherwise sit forever
 *  and swallow a healthy turn's Stop). */
const SUPERSEDED_STOP_WINDOW_MS = 60_000;
/** How long an AUTOMATION-origin send() waits before re-reading `busy`.
 *
 *  The human's Enter and the UserPromptSubmit hook that reports it are not
 *  simultaneous: the TUI accepts the keystroke, then claude spawns the hook
 *  command, which connects to main's pipe and sends `hooks.signal`. Measured at
 *  tens to a couple hundred milliseconds. An ambient turn that read `busy`
 *  inside that window saw idle and typed a second prompt into a TUI the human
 *  had just claimed. Sleeping one window and re-reading closes the common case
 *  cheaply — ambient turns are never latency-sensitive. */
const FOREIGN_TURN_RECHECK_MS = 250;
/** How long after a foreign turn opened a SECOND UserPromptSubmit still counts
 *  as the same submission rather than a new turn. Covers the two mechanical
 *  repeats — a duplicated hook delivery, and an ESC-then-resend of the same
 *  text — without swallowing the case that matters: a human who interrupted the
 *  agent and typed something else. Nobody composes a new instruction in 2 s;
 *  identical prompt text folds regardless of how much later it arrives. */
const FOREIGN_RESUBMIT_FOLD_MS = 2_000;
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
  /** Write keystrokes to the session. THROWS when the write could not be
   *  delivered (dead session, closed pipe) — send() turns that into an
   *  immediate turn error instead of waiting out a Stop that never comes. */
  write(id: string, data: string): void;
  destroy(id: string): Promise<void>;
  /** Subscribe to this session's raw output. Returns an unsubscribe. */
  onData(id: string, cb: (chunk: string) => void): () => void;
  /** Subscribe to this session ENDING — the claude process exited (crash, auth
   *  failure, a human typing `/quit` in the embed) or the daemon destroyed the
   *  session. An exited claude fires no Stop hook, so without this the open
   *  turn would wait out the full 30-minute timeout with the composer locked.
   *  Returns an unsubscribe. */
  onExit(id: string, cb: (exitCode: number | null) => void): () => void;
}

/** Minimal structural view of DaemonClient — avoids importing the concrete
 *  class (and its Electron/net dependencies) into this module's graph. */
export interface DaemonClientLike {
  rpc(method: string, params?: unknown): Promise<unknown>;
  connectSessionPipe(sessionId: string, opts?: { forceFresh?: boolean }): Promise<void>;
  writeToSession(sessionId: string, data: string | Buffer): boolean;
  on(event: 'session:data', listener: (payload: { sessionId: string; data: Buffer }) => void): unknown;
  on(
    event: 'session:died' | 'session:destroyed',
    listener: (payload: { sessionId: string; exitCode?: number | null }) => void,
  ): unknown;
  off(event: 'session:data', listener: (payload: { sessionId: string; data: Buffer }) => void): unknown;
  off(
    event: 'session:died' | 'session:destroyed',
    listener: (payload: { sessionId: string; exitCode?: number | null }) => void,
  ): unknown;
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
      // writeToSession returns false when the session (or its pipe) is gone.
      // Swallowing that verdict left the prompt undelivered while the turn sat
      // waiting for a Stop hook nothing would ever fire — the composer locked
      // for the full TURN_TIMEOUT_MS. Throwing surfaces it on this tick.
      if (!client.writeToSession(id, data)) {
        throw new Error(`the terminal brain's pty session is gone (write to ${id} was refused)`);
      }
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
    onExit(id, cb) {
      // BOTH daemon signals mean the same thing out here: this pty is gone.
      // `session:died` is the natural exit (the claude TUI IS the session's
      // root process, so its exit ends the session); `session:destroyed` is a
      // dispose from any other holder. The adapter unsubscribes before its own
      // destroy, so its teardown never re-enters through this callback.
      const listener = (payload: { sessionId: string; exitCode?: number | null }): void => {
        if (payload.sessionId !== id) return;
        cb(payload.exitCode ?? null);
      };
      client.on('session:died', listener);
      client.on('session:destroyed', listener);
      return () => {
        client.off('session:died', listener);
        client.off('session:destroyed', listener);
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
/** Same whitelist commanderMemory uses for its per-workspace partitions: a
 *  workspace id that could traverse (`../`), name a parent, or nest is treated
 *  as absent rather than thrown on. */
const SAFE_WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * The per-workspace home the brain's TUI runs in: `<wmuxDir>/brains/<wsId>`.
 *
 * Why per workspace (D4): claude keys transcripts AND project context by cwd.
 * One shared cwd meant every workspace's orchestrator shared one transcript
 * namespace and there was no place to give a single workspace its own
 * standing instructions. A per-workspace home gives each orchestrator its own
 * transcript partition and — because an interactive claude reads the cwd's
 * CLAUDE.md — an operator-editable `brains/<wsId>/CLAUDE.md` becomes that
 * workspace's persistent orchestrator instructions (create the file, no wmux
 * config needed). `--resume` stays stable: each home is as pinned as the old
 * shared dir was.
 *
 * A missing/unsafe workspace id falls back to `<wmuxDir>` itself — the
 * pre-D4 behavior, and where existing conversations already live.
 */
export function resolveBrainHomeDir(wmuxDir: string, workspaceId: string | undefined): string {
  if (!workspaceId || !SAFE_WORKSPACE_ID_RE.test(workspaceId)) return wmuxDir;
  return path.join(wmuxDir, 'brains', workspaceId);
}

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
 * Everything this brain may not call.
 *
 * `AskUserQuestion` is the terminal orchestrator's addition: it renders a
 * question box in the TUI that only a human sitting at that terminal can
 * answer, so an orchestrator that reaches for it stalls until someone notices.
 * wmux's replacement is already on the commander surface —
 * `mcp__wmux__deck_ask_decision`, with `deck_resolve_decision` and a durable
 * decision card behind it — so the deny is a redirect, not a removal.
 */
export const BRAIN_PTY_DENIED_TOOLS: string[] = [...DISALLOWED_TOOLS, 'Write', 'AskUserQuestion'];

/** Why each denied tool is denied, and what to reach for instead. This text is
 *  written to stderr by the deny script, which is the only channel that reaches
 *  the model — a bare exit 2 tells it a call failed and nothing else. */
const DENY_REASONS: Record<string, string> = {
  AskUserQuestion:
    'AskUserQuestion is disabled for the orchestrator: it draws a prompt in a terminal ' +
    'nobody is watching. Use mcp__wmux__deck_ask_decision instead — it raises a durable ' +
    'decision card the operator can answer from the deck.',
  Bash:
    'You have no shell. Split a worker pane (mcp__wmux__pane_split) and delegate the ' +
    'command to the agent running in it.',
  Write:
    'You cannot write files. Delegate the edit to a worker pane and state the acceptance ' +
    'check it must pass.',
  Edit:
    'You cannot edit files. Delegate the edit to a worker pane and state the acceptance ' +
    'check it must pass.',
  MultiEdit:
    'You cannot edit files. Delegate the edit to a worker pane and state the acceptance ' +
    'check it must pass.',
  NotebookEdit:
    'You cannot edit notebooks. Delegate the edit to a worker pane and state the ' +
    'acceptance check it must pass.',
  Agent:
    'You do not spawn subagents in-process. Your workers are wmux panes — split one and ' +
    'send it the task.',
  Task:
    'You do not spawn subagents in-process. Your workers are wmux panes — split one and ' +
    'send it the task.',
};

/**
 * The generated deny script: one file, invoked as `node deny.js <ToolName>`.
 *
 * A FILE rather than an inline `node -e "…"` payload because the hook command
 * is run by Claude Code's own shell — on Windows a PowerShell, which reads
 * neither of this module's quoters. A path argument carries no metacharacters
 * and no embedded quotes, so it survives both shells and the JSON encoding of
 * the settings file on top of them. The reasons live in the script, not the
 * command line, for the same reason.
 */
export function buildDenyScript(): string {
  return [
    '// Generated by wmux (ClaudePtyBrainAdapter). Regenerated on every brain',
    '// spawn and unlinked on dispose — edits here are lost.',
    `const REASONS = ${JSON.stringify(DENY_REASONS, null, 2)};`,
    'const tool = process.argv[2] || "this tool";',
    'const reason = REASONS[tool] || (tool + " is not available to the orchestrator.");',
    '// Exit 2 + stderr is Claude Code\'s "block this call and tell the model why".',
    'process.stderr.write(reason + "\\n");',
    'process.exit(2);',
    '',
  ].join('\n');
}

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
  /** Absolute path to the generated deny script (see buildDenyScript). Null
   *  falls back to a bare `exit 2`, which blocks the call but explains
   *  nothing — only reachable when the script could not be written. */
  denyScriptPath?: string | null;
}): Record<string, unknown> {
  const denied = BRAIN_PTY_DENIED_TOOLS;
  const denyScriptPath = opts.denyScriptPath ?? null;
  const hooks: Record<string, unknown> = {
    // Fail-closed backstop for the deny list above: exit code 2 is Claude
    // Code's "block this tool call" contract. The script also writes a reason
    // to stderr, which is what Claude Code shows the model — exit 2 on its own
    // tells it a call failed but not what to do instead.
    PreToolUse: denied.map((tool) => ({
      matcher: tool,
      hooks: [
        {
          type: 'command',
          command: denyScriptPath
            ? `${quoteArg(opts.nodePath)} ${quoteArg(denyScriptPath)} ${tool}`
            : `${quoteArg(opts.nodePath)} -e "process.exit(2)"`,
        },
      ],
    })),
  };
  if (opts.bridgePath) {
    // UserPromptSubmit is the human-typed-into-the-TUI signal: with no composer
    // in the dock's pty layout it is the only way the adapter learns a turn it
    // did not start is open, so automation can defer to it.
    for (const event of ['Stop', 'SessionStart', 'UserPromptSubmit'] as const) {
      // `Stop` runs the bridge in GATE mode: it reads the `hooks.signal`
      // response and exits 2 when the adapter refuses to end the turn. The
      // verdict has to travel on this one round trip — a second, independent
      // Stop hook would fire in PARALLEL with this one, so the turn would
      // already have ended by the time the block landed.
      const gateFlag = event === 'Stop' ? ' --gate' : '';
      hooks[event] = [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `${quoteArg(opts.nodePath)} ${quoteArg(opts.bridgePath)} ${event}${gateFlag}`,
            },
          ],
        },
      ];
    }
  }
  return {
    // The user's own ~/.claude settings are NOT loaded (see
    // --setting-sources + --strict-mcp-config in buildBrainLaunchCommand):
    // this profile is the
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

/** Quote one argv token for a POSIX exec wrapper shell (`-lc`): double quotes
 *  with escaped inner quotes. Every value we pass is a path or an id (never a
 *  shell metacharacter soup). */
export function quoteArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Quote one argv token for a PowerShell `-Command` string.
 *
 * NOT quoteArg: PowerShell does not read `\` as an escape inside quotes, so
 * quoteArg's backslash doubling would turn `C:\Users\me` into a literal
 * `C:\\Users\\me` and every path in the launch line would miss. Single quotes
 * with `''` doubling is PowerShell's own literal form — the same encoding
 * shell-integration.ts uses for its dot-source line.
 */
export function quotePwshArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Which of Claude Code's own settings files the spawned brain may load.
 *
 * `--settings <file>` only ADDS a source — the user's `~/.claude/settings.json`
 * still loads alongside it, which would drag `apiKeyHelper` (metered auth, the
 * exact thing scrubBrainSpawnEnv exists to prevent), the operator's own hooks,
 * and their plugins into a brain that is supposed to be configured entirely by
 * the generated profile. `project` is the narrowest source that keeps the
 * per-workspace `brains/<wsId>/CLAUDE.md` story intact.
 *
 * Verified empirically against the installed CLI on 2026-07-27
 * (`claude --debug hooks --debug-file …`, native install at ~/.local/bin):
 *   - `--setting-sources <user,project,local>` is a real flag on this build.
 *   - WITHOUT the flag the debug log lists the user-level SessionStart/Stop
 *     hooks; WITH `--setting-sources project` it lists none of them.
 *   - The generated `--settings` profile's own SessionStart hook fired in BOTH
 *     runs — an explicit `--settings` file is not one of the "sources" this
 *     flag gates, so the deny list + turn protocol survive.
 *   - A CLAUDE.md in the cwd was still obeyed under `--setting-sources project`
 *     (memory discovery is not a settings source), so D4 keeps working.
 */
const BRAIN_SETTING_SOURCES = 'project';

/**
 * The launch command line. Deliberately SHORT: no `--append-system-prompt`.
 * The commander identity rides the first turn's prompt text instead (the
 * AcpBrainAdapter pattern) — it lands in the transcript, so `--resume` carries
 * it forward, and it never has to survive cross-platform shell quoting.
 *
 * WINDOWS: the daemon's exec wrapper runs this string through
 * `pwsh -Command` (execWrapper.buildExecArgs — the Windows default shell is
 * always a PowerShell, never cmd). PowerShell parses a command that STARTS
 * with a quoted token as a STRING EXPRESSION, so the line would print the
 * claude path and exit 0 instead of running anything; the `&` call operator
 * is what makes it a command. Quoting switches to PowerShell's literal form
 * for the same reason (see quotePwshArg). POSIX is unchanged.
 */
export function buildBrainLaunchCommand(opts: {
  executable: string;
  settingsPath: string;
  mcpConfigPath: string | null;
  allowedTools?: string[];
  resumeSessionId?: string | null;
  /** Model override (`--model`), or empty/absent for the CLI default. */
  model?: string | null;
  /**
   * How the TUI is launched with respect to permission prompts — the workspace
   * AGENT MODE, expressed in claude's own flags (owner decision 2026-08-01):
   *   - `acceptEdits`        (mode `assist`) → `--permission-mode acceptEdits`:
   *     edits land without a prompt, everything else still stops.
   *   - `bypassPermissions`  (mode `danger`) → `--dangerously-skip-permissions`:
   *     nothing prompts at all.
   *   - absent/null → no flag, i.e. whatever the user's claude defaults to.
   *     Kept as a real case: non-deck embeddings (and the tests written before
   *     the mode existed) construct this command with no mode at all.
   * `off` never reaches here — the handler refuses to spawn a brain for it.
   */
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | null;
  /** Host platform the command will be wrapped for. Injected by tests. */
  platform?: NodeJS.Platform;
}): string {
  const isWindows = (opts.platform ?? process.platform) === 'win32';
  const q = isWindows ? quotePwshArg : quoteArg;
  const parts = [
    q(opts.executable),
    // BEFORE --settings: restrict the ambient sources, then add ours.
    '--setting-sources',
    q(BRAIN_SETTING_SOURCES),
    '--settings',
    q(opts.settingsPath),
  ];
  if (opts.mcpConfigPath) {
    parts.push('--mcp-config', q(opts.mcpConfigPath), '--strict-mcp-config');
  }
  const tools = opts.allowedTools ?? BRAIN_PTY_ALLOWED_TOOLS;
  if (tools.length > 0) parts.push('--allowedTools', q(tools.join(',')));
  // The orchestrator's model picker applies to this brain too: the TUI takes
  // the same `--model <alias|full-name>` flag the SDK adapter's option maps to.
  if (opts.model) parts.push('--model', q(opts.model));
  // The workspace mode, as a launch flag. Before `--resume` so the permission
  // posture is set for the whole session including the resumed transcript.
  if (opts.permissionMode === 'acceptEdits') {
    parts.push('--permission-mode', q('acceptEdits'));
  } else if (opts.permissionMode === 'bypassPermissions') {
    // Claude Code has no `--permission-mode bypassPermissions`; the bypass is
    // its own (deliberately loud) flag.
    parts.push('--dangerously-skip-permissions');
  }
  if (opts.resumeSessionId) parts.push('--resume', q(opts.resumeSessionId));
  const line = parts.join(' ');
  return isWindows ? `& ${line}` : line;
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
  /** Model override from the deck's model picker (`--model`). Empty/absent
   *  leaves the TUI on whatever model the user's claude defaults to. */
  model?: string;
  /**
   * This workspace's AGENT MODE, read fresh at every spawn.
   *
   * INJECTED, not imported: the adapter must not reach into deckAutonomyStore
   * itself — the deck owns that lookup (same rule the Stop gate follows), and
   * a function seam is what lets the whole spawn path unit-test with no store
   * on disk. Called per spawn rather than captured at construction so a mode
   * flip applies to the next TUI without a manager swap.
   *
   * Absent → no permission flag at all (the pre-mode behaviour, which is what
   * non-deck embeddings get).
   */
  resolvePermissionMode?: () => 'acceptEdits' | 'bypassPermissions' | null;
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
   *  can embed the live terminal, and with `null` on every teardown so the
   *  deck retires a terminal that no longer exists. */
  onPtySpawned?: (ptyId: string | null) => void;
  /** Fired when a turn the ADAPTER did not start begins. UserPromptSubmit carries
   *  the exact human prompt in `payload.prompt`; the deck uses it to create or
   *  extend the durable active-work record before the foreign turn can finish. */
  onForeignTurnStart?: (prompt: string) => void;
  /** Fired when a turn the ADAPTER did not start finishes — the human typed
   *  into the embedded TUI and their turn just ended. The workspace was
   *  reporting busy for its whole duration, so whatever accumulated in the
   *  deck's event coalescer meanwhile has no other trigger to flush it: without
   *  this the buffered events sat until some unrelated event arrived. Wired to
   *  the session manager's ordinary idle wake. */
  onForeignTurnEnd?: () => void;
  /** How the adapter reports a session id it learned from a FOREIGN turn's
   *  Stop. A human conversation held entirely in the TUI (or one that swapped
   *  the transcript via /resume there) never yields a `turn-end`, which is the
   *  only other place the manager persists the id — without this, a restart
   *  resumed the previous (or an empty) session and the TUI-only conversation
   *  was lost. */
  onForeignSessionId?: (sessionId: string) => void;
  /** Reader for the final assistant text (injected in tests). */
  readTranscript?: typeof readLastAssistantMessage;
  /** The Stop gate. Absent means no gating at all (every Stop ends its turn),
   *  which is what the SDK-era tests and any non-deck embedding get. Injected
   *  rather than imported so the adapter never reaches into the WorkspaceMirror
   *  itself — the deck owns that lookup. */
  evaluateStopGate?: (workspaceId: string, consecutiveBlocks: number) => StopGateVerdict;
  sessionStartTimeoutMs?: number;
  turnTimeoutMs?: number;
  staleResumeWindowMs?: number;
  /** Pause between writing the prompt and writing the submitting Enter.
   *  Tests shrink this to keep the suite fast. */
  submitDelayMs?: number;
  /** How long an automation-origin send() waits before re-reading `busy`.
   *  Tests shrink this. See FOREIGN_TURN_RECHECK_MS. */
  foreignTurnRecheckMs?: number;
  /** How long a second UserPromptSubmit still folds into the open foreign turn.
   *  Tests shrink this. See FOREIGN_RESUBMIT_FOLD_MS. */
  foreignResubmitFoldMs?: number;
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
  private unsubscribeExit: (() => void) | null = null;
  /** Resolved when the CURRENT pty exits. Raced against the Stop hook so a
   *  dead claude ends its turn immediately instead of at TURN_TIMEOUT_MS. */
  private ptyDead: Waiter<number | null> | null = null;
  /** Resolved by the SessionStart hook of the CURRENT pty. */
  private sessionStarted: Waiter<void> | null = null;
  /** True once the CURRENT pty's SessionStart hook landed. Reset per spawn. */
  private sessionStartSeen = false;
  /** Set only between a send()'s keystroke and its accepted Stop. A second
   *  Stop for the same turn finds it null and is ignored — the "exactly one
   *  turn-end" half of the manager contract. */
  private turnStop: Waiter<AgentSignal | null> | null = null;
  /** Monotonic turn counter — the identity a Stop is matched against. */
  private turnSeq = 0;
  /** How many TIMED-OUT turns are still owed a Stop. A timed-out turn's claude
   *  keeps working; its late Stop would otherwise resolve the NEXT turn's
   *  waiter and hang the old transcript off the new request. Each credit
   *  swallows exactly one Stop. */
  private supersededTurns = 0;
  private supersededTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many times in a ROW the Stop gate has refused. Reset on any allowed
   *  Stop and on every pty teardown; feeds the gate's own refusal cap, which is
   *  what keeps a gate from turning into a 30-minute trap. */
  private consecutiveStopBlocks = 0;
  /** True while a turn THIS ADAPTER DID NOT START is open — the human typed
   *  into the embedded TUI. Opened by UserPromptSubmit, closed by the Stop that
   *  no waiter claims. Automation reads it through `busy` and defers, exactly
   *  as it does for an adapter-started turn. */
  private foreignTurnOpen = false;
  /** When the open foreign turn started, or null when none is open. A foreign
   *  turn has no waiter and no timer of its own, so a Stop that never arrives
   *  (a hook command that failed to reach main, a claude build that skipped it)
   *  would strand `busy` forever — `busy` releases the flag past this stamp
   *  plus the turn timeout. */
  private foreignTurnOpenedAt: number | null = null;
  /** The open foreign turn's prompt text, for the repeat test in
   *  `onHookSignal`. Empty when the hook payload carried none. */
  private foreignTurnPrompt = '';
  /** Spawn-banner buffer, kept only for the stale-resume probe window. */
  private banner = '';
  private bannerWatching = false;
  /** Exit code of the pty that died most recently — only for the message. */
  private lastExitCode: number | null = null;

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

  /** True when the TUI is mid-turn on a prompt the ADAPTER did not send (the
   *  human typed into the embedded terminal). The session manager folds this
   *  into its own status so a heartbeat / loop / schedule tick never pushes a
   *  second prompt into a busy TUI. */
  get busy(): boolean {
    if (!this.foreignTurnOpen) return false;
    // Self-releasing read (the getter is the only thing that observes a foreign
    // turn, so this is where the backstop belongs). A foreign turn is closed by
    // its Stop hook and nothing else; a Stop that is never delivered would keep
    // this workspace busy for the rest of the app's life. Past the same ceiling
    // an adapter-started turn gets, assume the turn is long over.
    const openedAt = this.foreignTurnOpenedAt;
    const limit = this.deps.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    if (openedAt !== null && Date.now() - openedAt > limit) {
      console.warn('[deck] a terminal-brain turn the human started never reported its Stop — releasing it');
      this.closeForeignTurn();
      return false;
    }
    return true;
  }

  /** Close an open foreign turn (or no-op when none is). The one place the flag
   *  and its stamp are cleared together. */
  private closeForeignTurn(): void {
    const wasOpen = this.foreignTurnOpen;
    this.foreignTurnOpen = false;
    this.foreignTurnOpenedAt = null;
    this.foreignTurnPrompt = '';
    if (!wasOpen) return;
    try {
      this.deps.onForeignTurnEnd?.();
    } catch {
      /* the coalescer wake is best-effort — never surface into a hook */
    }
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

  /** Every hook signal from THIS pty. Only two kinds carry turn meaning.
   *
   *  Returning `{ block }` refuses the hook: the reason travels back down the
   *  `hooks.signal` response and the gated bridge turns it into exit 2, so the
   *  TUI keeps working. The turn stays open — `turnStop` is neither nulled nor
   *  resolved, so no `turn-end` is emitted and TURN_TIMEOUT_MS stays the
   *  backstop. */
  private onHookSignal(signal: AgentSignal): void | BrainPtyHookBlock {
    if (signal.kind === 'agent.session_start') {
      this.sessionStartSeen = true;
      this.sessionStarted?.resolve();
      return;
    }
    // The human submitted a prompt in the TUI. Only a turn we did NOT start
    // counts: during our own send() the hook fires for our keystroke too, and
    // that turn is already tracked by `turnStop`.
    if (signal.kind === 'agent.user_prompt_submit') {
      if (this.turnStop === null) {
        const now = Date.now();
        const prompt =
          typeof signal.payload['prompt'] === 'string'
            ? signal.payload['prompt'].trim()
            : '';
        // Two UserPromptSubmits with no Stop between them have two very
        // different causes, and folding both into one turn loses the second.
        //
        // The one worth folding is a RESUBMISSION: the human hit ESC and sent
        // the same thing again (an interrupt fires no Stop), or the bridge
        // delivered the hook twice. Announcing that twice opened a second work
        // row for one turn.
        //
        // The other is a genuinely NEW prompt after an interrupt — the human
        // stopped the agent and asked for something else, minutes later. Folded,
        // the deck kept announcing the abandoned objective and never opened a
        // row for the work actually running. So a submission that is neither
        // prompt-identical nor inside the resubmission window CLOSES the old
        // foreign turn and opens its own.
        const repeat =
          this.foreignTurnOpen
          && (
            (prompt.length > 0 && prompt === this.foreignTurnPrompt)
            || (this.foreignTurnOpenedAt !== null
              && now - this.foreignTurnOpenedAt
                <= (this.deps.foreignResubmitFoldMs ?? FOREIGN_RESUBMIT_FOLD_MS))
          );
        if (this.foreignTurnOpen && !repeat) this.closeForeignTurn();
        this.foreignTurnOpen = true;
        // The stamp always refreshes: the turn is live again, so `busy`'s
        // stale-release deadline must measure from the latest submission.
        this.foreignTurnOpenedAt = now;
        this.foreignTurnPrompt = prompt;
        if (repeat) return;
        try {
          // Empty is still meaningful: older Claude hook payloads may omit the
          // prompt. The deck supplies a neutral fallback objective rather than
          // losing ownership of the foreign turn entirely.
          this.deps.onForeignTurnStart?.(prompt);
        } catch {
          /* work tracking is best-effort — never surface into a hook */
        }
      }
      return;
    }
    if (signal.kind !== 'agent.stop') return;
    // A Stop no waiter claims is a FOREIGN turn's (or a superseded one from
    // the same pty session) — either way its session id is the transcript the
    // TUI is actually on. Adopt it and let the manager persist it, or a
    // restart resumes a conversation the human already left behind.
    if (this.turnStop === null && signal.agentSessionId && signal.agentSessionId !== this._sessionId) {
      this._sessionId = signal.agentSessionId;
      try {
        this.deps.onForeignSessionId?.(signal.agentSessionId);
      } catch {
        /* persistence is best-effort — never surface into a hook */
      }
    }
    // A FOREIGN turn's Stop outranks a superseded credit. Both are "a Stop no
    // waiter claims", but the credit is bookkeeping for a turn we already gave
    // up on, while the foreign flag is the live reason this workspace reports
    // busy. Letting the credit eat this Stop first left foreignTurnOpen set
    // with nothing else able to clear it — the workspace stayed busy forever
    // and every ambient turn deferred to a human who had long since finished.
    if (this.foreignTurnOpen && this.turnStop === null) {
      this.closeForeignTurn();
      return;
    }
    // A superseded (timed-out) turn's Stop arrives late and is
    // INDISTINGUISHABLE from the current turn's — the hook carries no turn
    // identity — so a credit banked at timeout drops exactly one Stop.
    if (this.supersededTurns > 0) {
      this.supersededTurns -= 1;
      if (this.supersededTurns === 0) this.clearSupersededExpiry();
      console.warn('[deck] dropped a late Stop from a superseded terminal-brain turn');
      return;
    }
    // A Stop with no waiter is a duplicate (or a stop the human triggered in
    // the embedded TUI directly) — deliberately dropped, so the open turn
    // still ends exactly once.
    const waiter = this.turnStop;
    if (!waiter) {
      // Still dropped as a turn signal — it just closes the foreign turn it
      // belongs to, so the workspace stops reporting busy. (The flag is already
      // clear on this path; the branch above owns the open case.) The gate
      // below never applies here: refusing a Stop nobody awaits would strand it.
      this.closeForeignTurn();
      return;
    }
    // The gate only ever applies to a turn this adapter opened: a Stop with no
    // waiter was already dropped above, so refusing one here can never strand a
    // turn nobody is awaiting.
    const verdict = this.evaluateStopGate();
    if (verdict) {
      this.consecutiveStopBlocks += 1;
      return { block: verdict };
    }
    this.consecutiveStopBlocks = 0;
    this.turnStop = null;
    waiter.resolve(signal);
  }

  /** Run the injected Stop gate. Returns the refusal reason, or null to allow.
   *  Fails OPEN on every error path: no predicate, no workspace, or a predicate
   *  that threw all mean "let the turn end". */
  private evaluateStopGate(): string | null {
    const gate = this.deps.evaluateStopGate;
    if (!gate || !this._workspaceId) return null;
    try {
      const verdict = gate(this._workspaceId, this.consecutiveStopBlocks);
      return verdict.block ? verdict.reason : null;
    } catch (err) {
      console.warn(`[deck] terminal-brain stop gate threw — allowing the turn to end: ${String(err)}`);
      return null;
    }
  }

  /** Bank a Stop-swallowing credit for a turn we gave up on, and ESC the TUI
   *  so the abandoned turn actually stops burning the brain's context. */
  private supersedeTurn(turnId: number): void {
    console.warn(`[deck] terminal-brain turn ${turnId} timed out — interrupting the TUI`);
    // Abandoning the turn abandons its refusal tally too: the late Stop this
    // turn may still emit is dropped, and the next turn must start from zero.
    this.consecutiveStopBlocks = 0;
    this.supersededTurns += 1;
    this.clearSupersededExpiry();
    const timer = setTimeout(() => {
      this.supersededTurns = 0;
      this.supersededTimer = null;
    }, SUPERSEDED_STOP_WINDOW_MS);
    (timer as { unref?: () => void }).unref?.();
    this.supersededTimer = timer;
    this.interrupt();
  }

  private clearSupersededExpiry(): void {
    if (this.supersededTimer) clearTimeout(this.supersededTimer);
    this.supersededTimer = null;
  }

  // ── spawn ───────────────────────────────────────────────────────────────

  /** Write the generated profile + MCP config, returning their paths. */
  private writeProfile(): { settingsPath: string; mcpConfigPath: string | null } {
    const dir = path.join(this.wmuxDir, 'brain-profiles');
    // 0700 / 0600 throughout: the generated MCP config carries this spawn's
    // WMUX_COMMANDER_TOKEN, which is a bearer credential for the whole
    // commander tool surface. Default 0644 would hand it to every local user.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = randomUUID();
    const settingsPath = path.join(dir, `settings-${stamp}.json`);
    const bridgePath = this.deps.bridgePath ?? null;
    const nodePath = this.deps.nodePath ?? process.execPath;
    // The PreToolUse denier, written beside the profile so it shares the
    // profile's lifetime (unlinked by dispose) and its 0600 mode.
    let denyScriptPath: string | null = path.join(dir, `deny-${stamp}.js`);
    try {
      fs.writeFileSync(denyScriptPath, buildDenyScript(), { encoding: 'utf8', mode: 0o600 });
      this.profilePaths.push(denyScriptPath);
    } catch (err) {
      // A denier we could not write costs the EXPLANATION, never the deny:
      // permissions.deny still refuses the tool, and the fallback hook command
      // still exits 2.
      console.warn(`[deck] could not write the terminal brain's deny script: ${String(err)}`);
      denyScriptPath = null;
    }
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(buildBrainSettingsProfile({ bridgePath, nodePath, denyScriptPath }), null, 2),
      { encoding: 'utf8', mode: 0o600 },
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
        // Contains WMUX_COMMANDER_TOKEN — owner-only, never world-readable.
        { encoding: 'utf8', mode: 0o600 },
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
    // Multi-account (M0), AFTER the scrub: the scrub above strips every
    // CLAUDE* var, including the CLAUDE_CONFIG_DIR of an account this
    // workspace is EXPLICITLY bound to — which would silently run the brain on
    // the default account. The scrub exists to drop INHERITED noise, not to
    // override an operator's binding, so the binding is re-applied here (same
    // contract as ClaudeSdkAdapter.buildEnv). A missing bound dir resolves to
    // {} + a warn and falls back to the default credential.
    if (this._workspaceId) {
      try {
        Object.assign(
          env,
          getAccountStore().resolveAccountEnv(this._workspaceId, 'claude', (acc) =>
            console.warn(
              `[account] terminal brain ws ${this._workspaceId}: bound account "${acc.name}" ` +
              `configDir missing (${acc.configDir}) — falling back to the default credential.`,
            ),
          ),
        );
      } catch (err) {
        // An unreadable account store costs the binding, never the spawn.
        console.warn('[account] terminal brain could not resolve its account binding:', err);
      }
    }
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
    // The mode is resolved HERE, per spawn: a workspace flipped between
    // assist and danger gets the new posture on its next TUI. A resolver that
    // throws costs the flag, never the spawn — the brain then launches with
    // claude's default (prompting) posture, which is the safe direction.
    let permissionMode: 'acceptEdits' | 'bypassPermissions' | null = null;
    try {
      permissionMode = this.deps.resolvePermissionMode?.() ?? null;
    } catch (err) {
      console.warn(`[deck] could not resolve the terminal brain's permission mode: ${String(err)}`);
    }
    const command = buildBrainLaunchCommand({
      executable,
      settingsPath,
      mcpConfigPath,
      resumeSessionId,
      permissionMode,
      ...(this.deps.model ? { model: this.deps.model } : {}),
    });
    // Held locally as well as on the instance: a dispose() racing this spawn
    // nulls the field (killPty), and awaiting the field would then throw
    // inside the turn instead of unwinding it.
    const started = createWaiter<void>();
    this.sessionStarted = started;
    this.sessionStartSeen = false;
    this.banner = '';
    this.bannerWatching = true;
    // CLAIM the id and INSTALL the listeners BEFORE the session exists.
    //  - The SessionStart hook and the spawn banner can both land while
    //    createSession/attach are still awaiting; listeners installed after
    //    would miss them (the hook silently, which costs the whole
    //    startup race).
    //  - `ptyId` set up front is what makes a failed attach — and a dispose()
    //    that lands mid-spawn — able to destroy the session it created
    //    instead of leaking a live claude nobody holds a handle to.
    // Both are rolled back by abandonPty() on every failure path below.
    this.ptyId = ptyId;
    this.unregisterHooks = registerBrainPty(ptyId, (s) => this.onHookSignal(s));
    this.unsubscribeData = this.deps.host.onData(ptyId, (chunk) => {
      if (!this.bannerWatching) return;
      this.banner += chunk;
      if (this.banner.length > 64 * 1024) this.bannerWatching = false;
    });
    const dead = createWaiter<number | null>();
    this.ptyDead = dead;
    this.unsubscribeExit = this.deps.host.onExit(ptyId, (code) => this.onPtyExit(ptyId, code));
    try {
      // claude keys its transcripts by cwd, so this must be STABLE across app
      // updates and launch locations — the same reason ClaudeSdkAdapter pins
      // it. Per-workspace (D4): each workspace's orchestrator gets its own
      // home under <wmuxDir>/brains/<wsId>, which partitions transcripts and
      // lets the operator drop a CLAUDE.md there as that workspace's standing
      // orchestrator instructions. Created here because claude refuses to
      // start in (and posix_spawn fails on) a missing cwd.
      const brainHome = resolveBrainHomeDir(this.wmuxDir, this._workspaceId);
      try {
        fs.mkdirSync(brainHome, { recursive: true });
        // The orchestrator's execution contract, as skills rather than
        // preamble text. Regenerated per spawn so they cannot drift behind the
        // profile; installBrainSkills never throws, so a skills write that
        // fails costs the skills, never the spawn.
        installBrainSkills(brainHome);
      } catch {
        /* an unmakeable home surfaces as the spawn error below */
      }
      await this.deps.host.createSession({
        id: ptyId,
        cwd: brainHome,
        env: this.buildSpawnEnv(),
        command,
        cols: 120,
        rows: 32,
      });
      await this.deps.host.attach(ptyId);
    } catch (err) {
      // createSession may well have SUCCEEDED and attach thrown — destroy the
      // id we claimed rather than leave an orphaned claude behind.
      await this.abandonPty(ptyId);
      return { error: `could not start the terminal brain: ${String(err)}` };
    }
    if (this._disposed) {
      // dispose() ran while we were awaiting: its killPty saw no live id (or
      // an id whose session did not exist yet), so the pty that just came up
      // is ours to reap.
      await this.abandonPty(ptyId);
      return { error: 'commander session disposed' };
    }
    try {
      this.deps.onPtySpawned?.(ptyId);
    } catch {
      /* the embed is cosmetic — never fail a spawn on it */
    }
    await Promise.race([
      started.promise,
      // A claude that dies during startup (bad auth, a missing binary the
      // shell only discovers on exec) must not cost the full SessionStart
      // timeout before the turn hears about it.
      dead.promise,
      delay(this.deps.sessionStartTimeoutMs ?? SESSION_START_TIMEOUT_MS),
    ]);
    if (!this.ptyId) {
      return { error: describePtyExit(this.lastExitCode) };
    }
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

  /** The pty ended under us. Clears the dead session state (id retracted, the
   *  embed retired) so the NEXT send() spawns a fresh TUI, and wakes an open
   *  turn — an exited claude fires no Stop hook, so nothing else would. */
  private onPtyExit(ptyId: string, exitCode: number | null): void {
    if (this.ptyId !== ptyId) return; // a stale listener for a pty we let go
    this.lastExitCode = exitCode;
    const dead = this.ptyDead;
    // detach, not killPty: destroying a session the daemon just told us is
    // gone would be a pointless round-trip. The embed still has to be retired.
    this.detachPty();
    this.retractPty();
    dead?.resolve(exitCode);
  }

  /** Drop every per-pty listener and forget the id, WITHOUT destroying the
   *  session. Shared by killPty and the failed-spawn rollback. */
  private detachPty(): void {
    this.ptyId = null;
    // A pty that died mid-foreign-turn will never fire its Stop; leaving the
    // flag set would strand the workspace busy forever. This is the one choke
    // point every teardown path goes through.
    this.closeForeignTurn();
    this.bannerWatching = false;
    this.consecutiveStopBlocks = 0;
    this.unregisterHooks?.();
    this.unregisterHooks = null;
    this.unsubscribeData?.();
    this.unsubscribeData = null;
    this.unsubscribeExit?.();
    this.unsubscribeExit = null;
    this.sessionStarted = null;
    this.ptyDead = null;
  }

  /** Tell the deck this workspace no longer has an embeddable terminal. Fired
   *  on EVERY teardown path (stale-resume respawn, /clear-style dispose, vendor
   *  swap, a pty that died) so the renderer never keeps a dead embed. */
  private retractPty(): void {
    try {
      this.deps.onPtySpawned?.(null);
    } catch {
      /* the embed is cosmetic — never fail a teardown on it */
    }
  }

  /** Tear down the live pty (profile files survive for the next spawn). */
  private async killPty(): Promise<void> {
    const id = this.ptyId;
    this.detachPty();
    if (!id) return;
    this.retractPty();
    await this.deps.host.destroy(id);
  }

  /** Roll back a spawn that never became THIS adapter's live pty: unwind the
   *  claimed id + listeners and destroy whatever the daemon did create. */
  private async abandonPty(ptyId: string): Promise<void> {
    if (this.ptyId === ptyId) this.detachPty();
    try {
      await this.deps.host.destroy(ptyId);
    } catch {
      /* nothing was created, or it is already gone */
    }
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

  async *send(text: string, opts: BrainSendOptions = {}): AsyncIterable<BrainEvent> {
    if (this._disposed) {
      yield { type: 'error', message: 'commander session disposed' };
      return;
    }

    if (!this.ptyId) {
      let spawned = await this.spawn(this._sessionId);
      // Disposal wins over the spawn's own outcome: a disposed adapter must
      // terminate its iterator silently (the manager's for-await unwinds).
      if (this._disposed) return;
      if ('error' in spawned) {
        yield { type: 'error', message: spawned.error };
        return;
      }
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
        if (this._disposed) return;
        if ('error' in fresh) {
          yield { type: 'error', message: fresh.error };
          return;
        }
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
            'Answer it in the terminal, then send your message again.',
        };
        return;
      }
    }

    const ptyId = this.ptyId;
    if (!ptyId) {
      yield { type: 'error', message: 'the terminal brain is not running' };
      return;
    }

    // FOREIGN-TURN DOUBLE-CHECK (automation only).
    //
    // The manager read `busy` before it called us, but the human's Enter and
    // the UserPromptSubmit hook that reports it are separated by a real window
    // (see FOREIGN_TURN_RECHECK_MS) — so an ambient turn can pass a busy check
    // against a TUI a human has already claimed and then type over them. One
    // short sleep plus a re-read closes that window for the ambient drivers,
    // which are the only callers with no human waiting on latency.
    //
    // RESIDUAL RACE, deliberately not closed here: a human who presses Enter
    // DURING this sleep — or after it, while the writes below are in flight —
    // is still not visible to us. Closing it fully means the renderer's own
    // input path taking the same lock before it forwards a keystroke to the
    // pty, which is a wider change than this fix; the window shrinks from
    // "the whole hook latency" to "the write window".
    if (opts.origin === 'automation') {
      await delay(this.deps.foreignTurnRecheckMs ?? FOREIGN_TURN_RECHECK_MS);
      if (this._disposed) return;
      if (this.busy) {
        yield {
          type: 'error',
          message: 'the human is mid-turn in the terminal brain — the ambient turn stood down',
        };
        return;
      }
    }

    const prompt = flattenPromptForPty(this.composePrompt(text));
    if (!prompt) {
      yield { type: 'error', message: 'the prompt was empty after sanitisation' };
      return;
    }

    const turnId = ++this.turnSeq;
    const waiter = createWaiter<AgentSignal | null>();
    // The block counter is PER TURN. Without this reset a turn that used up
    // refusals would hand its tally to the next turn, which would then be
    // allowed to stop immediately — the cap is a per-turn escape hatch, not a
    // per-pty budget.
    this.consecutiveStopBlocks = 0;
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
    // Captured locally: the field is nulled the moment the pty is let go, and
    // the race still has to settle on the promise this turn started with.
    const died = this.ptyDead?.promise.then(() => 'died' as const) ?? never<'died'>();
    const stop = await Promise.race([waiter.promise, timeout, died]);
    // dispose() resolves the waiter with null so this iterator TERMINATES
    // rather than hanging the manager's for-await on app quit.
    if (stop === null || this._disposed) return;
    if (stop === 'died') {
      // The TUI exited mid-turn (auth failure, crash, a human `/quit` in the
      // embed). No Stop hook is coming — end the turn NOW instead of holding
      // the composer for the rest of TURN_TIMEOUT_MS. onPtyExit already
      // retracted the pty, so the next send() spawns a fresh one.
      this.turnStop = null;
      yield { type: 'error', message: describePtyExit(this.lastExitCode) };
      return;
    }
    if (stop === 'timeout') {
      // Only clear OUR waiter — a turn that raced ahead of this one already
      // replaced it (it cannot, today, but the identity check keeps the
      // invariant explicit rather than positional).
      if (this.turnStop === waiter) this.turnStop = null;
      this.supersedeTurn(turnId);
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
    this.clearSupersededExpiry();
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

/** A promise that never settles — the "no live pty" arm of the turn race. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* deliberately never settles */
  });
}

/** The user-facing wording for a brain whose terminal exited. */
export function describePtyExit(exitCode: number | null): string {
  const code = exitCode === null ? '' : ` (exit code ${exitCode})`;
  return (
    `the terminal brain's Claude Code session ended${code} — check the terminal ` +
    '(sign-in, a crash, or a manual quit), then send your message again to restart it.'
  );
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
