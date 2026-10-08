// Claude-compatible hook flavours: one table for every agent CLI whose hooks
// follow Claude Code's contract (a command per event, event JSON on stdin,
// neutral = exit 0 with no output).
//
// A FLAVOUR is a hook dialect: where the CLI keeps its hook config, what it
// calls each lifecycle event, and where its payload keeps the session id and
// cwd. One shared bridge (integrations/shared/bin/wmux-hooks-bridge.mjs, run as
// `node <bridge> <flavour> [<Event>]`) turns any flavour's events into the
// canonical AgentSignal envelope and sends it over the existing `hooks.signal`
// RPC, so the daemon's kind-based dispatch and its hook > process > screen
// identity precedence (src/daemon/canonicalAgent.ts) apply unchanged. Adding a
// Claude-compatible agent is a row here plus its mirror in the bridge.
//
// What the kinds mean for the pane, as the daemon already derives them:
//   agent.session_start      → idle, before the first turn (fresh `source`)
//   agent.user_prompt_submit → working (turn start)
//   agent.awaiting_input     → waiting on a human (approval prompts only)
//   agent.stop               → done / idle (turn end)
//
// Lockstep: the runtime half of every row (agent, events, field paths) is
// mirrored by FLAVOURS in the bridge, which cannot import from src/.
// hookFlavours.lockstep.test.ts fails on any drift, and on an installer that
// would register an event the bridge drops (a process spawn for nothing).
//
// Sources: each row names the public documentation it was built from and
// whether it has been measured against a live CLI. A `docs` row is a promise
// read off a page, not an observed behaviour — say so wherever it surfaces.

import { agentHooksFlavour, type AgentHooksFlavour, type AgentSlug } from '../agentIdentity';
import type { AgentSignalKind } from './signal-types';

/** Every flavour the shared bridge serves. A subset of the registry's
 *  `AgentHooksFlavour`, which also names the bespoke bridges. */
export type CompatHookFlavourId = Extract<AgentHooksFlavour, 'kiro' | 'copilot' | 'gemini'>;

/** One dialect event → one wmux signal kind, optionally only when a payload
 *  field equals a value. */
export interface CompatHookEventRule {
  readonly kind: AgentSignalKind;
  readonly when?: { readonly field: string; readonly equals: string };
}

/**
 * How wmux's hook entry gets into the CLI's config.
 *
 * `owned-file`: the CLI loads every file in a directory, so wmux writes a file
 * of its own there. Install is create-or-refresh, uninstall is delete, and a
 * user's settings are never parsed or rewritten. Ownership is proved by the
 * content (every entry runs the shared bridge), never by the file name alone.
 *
 * `settings-hooks-key`: the hooks live under a `hooks` key in a settings file
 * the user also edits. Install would have to merge leaf by leaf, owned by the
 * bridge basename in the command, like `wmux setup-hooks` does for Claude
 * Code. Recorded as data; not wired to an installer yet.
 */
export type CompatHookInstall =
  | {
    readonly strategy: 'owned-file';
    /** The CLI's config directory, as path segments under the user's home
     *  directory (same on every OS). */
    readonly configDir: readonly string[];
    /** An env var that, when set to a non-blank path, replaces `configDir`
     *  entirely (Copilot's COPILOT_HOME), or null. */
    readonly configDirEnv: string | null;
    /** wmux's own file, as path segments under the config directory. */
    readonly file: readonly string[];
    /** Events written to the file. Must be events the bridge maps. */
    readonly register: readonly string[];
    /** `exec`: spawned with an argv and no shell (works under any host shell). */
    readonly commandForm: 'exec';
    /** Per-hook timeout the CLI enforces, in seconds. The bridge caps itself at 2s. */
    readonly timeoutSec: number;
  }
  | {
    readonly strategy: 'settings-hooks-key';
    readonly userFile: readonly string[];
    readonly register: readonly string[];
    /** `shell`: a command line run by the CLI's shell (PowerShell on Windows). */
    readonly commandForm: 'shell';
    readonly timeoutMs: number;
    /** False until a live CLI has been seen loading and firing the entry. */
    readonly wired: false;
  };

export interface CompatHookFlavour {
  readonly id: CompatHookFlavourId;
  /** The registry slug the signals are about. */
  readonly agent: AgentSlug;
  /** Public documentation the row was built from. */
  readonly docs: readonly string[];
  /** `live`: measured against a running CLI. `docs`: read off the docs only. */
  readonly verified: 'live' | 'docs';
  /** Dialect event name → wmux kind. Mirrored by the bridge. */
  readonly events: Readonly<Record<string, CompatHookEventRule>>;
  /** Payload fields holding the session id, first non-empty wins. Mirrored. */
  readonly sessionIdFields: readonly string[];
  /** Payload fields holding the cwd, first non-empty wins. Mirrored. */
  readonly cwdFields: readonly string[];
  /** Payload field holding a SessionStart `source`, or null. Mirrored. */
  readonly sourceField: string | null;
  /** Config locations the CLI documents, for operators and future installers. */
  readonly configLocations: readonly string[];
  /** How wmux installs its entry, or null when installation stays manual. */
  readonly install: CompatHookInstall | null;
}

/** Basename of the shared bridge, in the bundle and under ~/.wmux/hooks/. */
export const SHARED_HOOKS_BRIDGE_BASENAME = 'wmux-hooks-bridge.mjs';

/** First-line marker of the shared bridge source. */
export const SHARED_HOOKS_BRIDGE_MARKER = 'wmux-managed: shared-hooks-bridge';

export const COMPAT_HOOK_FLAVOURS: Readonly<Record<CompatHookFlavourId, CompatHookFlavour>> = {
  kiro: {
    id: 'kiro',
    agent: 'kiro',
    docs: ['https://kiro.dev/docs/cli/2x-reference/#hooks'],
    // kiro-cli 2.15.1, 2026-08-16: stop + agentSpawn fire with
    // {hook_event_name, cwd}; no session id exists in any payload.
    verified: 'live',
    events: {
      stop: { kind: 'agent.stop' },
      agentSpawn: { kind: 'agent.session_start' },
    },
    sessionIdFields: [],
    cwdFields: ['cwd'],
    sourceField: null,
    configLocations: ['~/.kiro/agents/<name>.json (hooks inside an agent config)'],
    // Deliberately manual: integrations/kiro/README.md holds automatic
    // installation back until the end-to-end path is verified with an account.
    install: null,
  },
  copilot: {
    id: 'copilot',
    agent: 'copilot',
    docs: [
      'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference',
      'https://docs.github.com/en/copilot/concepts/agents/hooks',
      'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference',
    ],
    // Copilot CLI 1.0.93 on Windows, 2026-10-08 (#1912): loaded
    // ~/.copilot/hooks/wmux.json and fired SessionStart, UserPromptSubmit,
    // PermissionRequest and Stop with session_id and cwd, as documented.
    // An Esc-cancelled permission prompt fires no hook at all (#1918).
    verified: 'live',
    // PascalCase names are the documented Claude-compatible mode; the docs say
    // it switches payload fields to snake_case (session_id, cwd).
    events: {
      SessionStart: { kind: 'agent.session_start' },
      UserPromptSubmit: { kind: 'agent.user_prompt_submit' },
      Stop: { kind: 'agent.stop' },
      PermissionRequest: { kind: 'agent.awaiting_input' },
    },
    sessionIdFields: ['session_id', 'sessionId'],
    cwdFields: ['cwd'],
    sourceField: 'source',
    configLocations: [
      '~/.copilot/hooks/*.json (user; %USERPROFILE%\\.copilot\\hooks on Windows; $COPILOT_HOME/hooks when COPILOT_HOME is set)',
      '~/.copilot/settings.json `hooks` (user)',
      '.github/hooks/*.json, .github/copilot/settings.json `hooks` (repository)',
    ],
    install: {
      strategy: 'owned-file',
      // "If COPILOT_HOME is set, it is $COPILOT_HOME/hooks/" (cli-hooks-reference);
      // COPILOT_HOME replaces the whole ~/.copilot path (cli-config-dir-reference).
      configDir: ['.copilot'],
      configDirEnv: 'COPILOT_HOME',
      file: ['hooks', 'wmux.json'],
      register: ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest'],
      // `exec` + `args` is spawned without a shell, so the same entry runs on
      // Windows whether the host would have used PowerShell or bash (#1882).
      commandForm: 'exec',
      timeoutSec: 5,
    },
  },
  gemini: {
    id: 'gemini',
    agent: 'gemini',
    docs: [
      'https://geminicli.com/docs/hooks/',
      'https://geminicli.com/docs/hooks/reference/',
    ],
    verified: 'docs',
    events: {
      SessionStart: { kind: 'agent.session_start' },
      BeforeAgent: { kind: 'agent.user_prompt_submit' },
      AfterAgent: { kind: 'agent.stop' },
      Notification: { kind: 'agent.awaiting_input', when: { field: 'notification_type', equals: 'ToolPermission' } },
    },
    sessionIdFields: ['session_id'],
    cwdFields: ['cwd'],
    sourceField: 'source',
    configLocations: [
      '~/.gemini/settings.json `hooks` (user)',
      '.gemini/settings.json `hooks` (project; fingerprinted, untrusted until approved)',
      '/etc/gemini-cli/settings.json `hooks` (system)',
    ],
    install: {
      strategy: 'settings-hooks-key',
      userFile: ['.gemini', 'settings.json'],
      register: ['SessionStart', 'BeforeAgent', 'AfterAgent', 'Notification'],
      commandForm: 'shell',
      timeoutMs: 5000,
      wired: false,
    },
  },
};

export const COMPAT_HOOK_FLAVOUR_IDS: readonly CompatHookFlavourId[] =
  Object.keys(COMPAT_HOOK_FLAVOURS) as CompatHookFlavourId[];

/** Narrow an untrusted string (a CLI flag) to a flavour id. */
export function isCompatHookFlavourId(value: unknown): value is CompatHookFlavourId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COMPAT_HOOK_FLAVOURS, value);
}

/** The shared-bridge flavour serving an agent, or undefined (a bespoke bridge,
 *  or no hooks at all). Read from the agent's registry row (`hooks`). */
export function compatHookFlavourForAgent(agent: AgentSlug): CompatHookFlavourId | undefined {
  const flavour = agentHooksFlavour(agent);
  return isCompatHookFlavourId(flavour) ? flavour : undefined;
}

/**
 * Characters that would be interpreted by a host shell inside a double-quoted
 * path: `"` ends the quote, `$` and the backtick expand in PowerShell and
 * POSIX shells, `%` expands in cmd. A `shell`-form command is only built for a
 * path free of them; an `exec`-form entry has no such constraint.
 */
const SHELL_UNSAFE_PATH = /["$`%\r\n]/;

/**
 * The command line for a `shell`-form flavour. A bare `node` leads: PowerShell
 * reads a line that STARTS with a quoted token as a string expression and fails
 * to run it (#1882), while `node "<path>" args` parses the same way in
 * PowerShell, cmd and POSIX shells. Returns null for a path that no single
 * quoting survives in all three.
 */
export function compatHookShellCommand(bridgePath: string, flavour: CompatHookFlavourId, event: string): string | null {
  if (SHELL_UNSAFE_PATH.test(bridgePath)) return null;
  return `node "${bridgePath}" ${flavour} ${event}`;
}

/** The exec-form argv for a flavour: `node <bridge> <flavour> <event>`. */
export function compatHookExecArgs(bridgePath: string, flavour: CompatHookFlavourId, event: string): string[] {
  return [bridgePath, flavour, event];
}
