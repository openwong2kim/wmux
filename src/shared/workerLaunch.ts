// ─── Fan-out worker launch line — the model-env marker (F15) ────────────────
//
// A fan-out worker's launch command is not spawned: it is TYPED into the pane's
// interactive login shell after that shell has booted (scheduleInitialCommand).
// By then the operator's rc files have run, so an `ANTHROPIC_MODEL` exported by
// `~/.zshrc` has overwritten whatever environment wmux resolved for the spawn.
// Three dogfood runs died there — every worker's first turn came back "There's
// an issue with the selected model (glm-5.3)" — so the neutralisation has to be
// part of the command line itself, which is the only thing that runs later than
// the rc files.
//
// This module owns the exact text of that prefix, because TWO processes handle
// it and a drifting private regex in either one silently disarms the fix:
//
//   - main (FanOutService) attaches it to an eligible launch;
//   - the renderer (useRpcBridge, fanout.spawnWorkspace) splits it off before
//     the operator's role binding is applied — `applyRoleAgent` and
//     `applyRoleBinding` both gate on the FIRST TOKEN of the command, so a
//     prefix in front of the launcher would silently drop the role's agent AND
//     its model — and re-attaches it only if the rewritten command still names
//     no model of its own.
//
// ── Why `unset` and not `env -u` ────────────────────────────────────────────
//
// `env -u VAR claude …` execs a BINARY named claude. `claude migrate-installer`
// leaves many machines with `alias claude="$HOME/.claude/local/claude"` and no
// `claude` on PATH at all, so that form dies with `env: claude: No such file or
// directory` — a worker that fails to start is strictly worse than one on the
// wrong model. `unset VAR; claude …` runs in the shell that owns the alias, and
// alias expansion applies to the first word of a command after `;`.
//
// ── Why the gateway test is in the SHELL, not in main ───────────────────────
//
// An operator routing claude through a gateway (`ANTHROPIC_BASE_URL`, e.g. a
// z.ai/GLM endpoint) NEEDS their `ANTHROPIC_MODEL`: unset it and claude asks
// that gateway for a default `claude-*` model it does not serve, and every
// worker dies the same way this fix exists to prevent. So the marker tests for
// it — and it tests in the PANE's shell rather than in main's `process.env`,
// because main's environment is not the one that has the problem. The whole
// finding is that the rc files export variables main never saw (and when wmux
// is opened from Finder/Dock, main inherits no shell environment at all), so a
// main-side `process.env.ANTHROPIC_BASE_URL` check would read absent for
// exactly the gateway operator it is meant to protect.

import { commandChoosesModel } from './orchestratorRole';

/** The variable the launch neutralises. */
export const WORKER_MODEL_ENV = 'ANTHROPIC_MODEL';

/** The variable whose presence CANCELS the neutralisation (see above). */
export const WORKER_GATEWAY_ENV = 'ANTHROPIC_BASE_URL';

/**
 * The prefix, verbatim. Compared and sliced as a literal on both sides — never
 * re-derived from a regex — so main and the renderer cannot drift apart.
 *
 * `ANTHROPIC_AUTH_TOKEN` is deliberately NOT touched here, nor is
 * `ANTHROPIC_BASE_URL` itself: routing every pane's claude through a proxy is a
 * legitimate whole-machine choice, and a worker that quietly bypassed it would
 * be talking to a different endpoint than every other pane the operator opens.
 * Model SELECTION is the one part of that environment wmux owns for a worker,
 * because wmux is what decided to launch this agent at all.
 */
export const MODEL_ENV_MARKER = `[ -n "$${WORKER_GATEWAY_ENV}" ] || unset ${WORKER_MODEL_ENV}; `;

/** Split a leading {@link MODEL_ENV_MARKER} off a launch command. */
export function splitModelEnvMarker(command: string): { marker: string; command: string } {
  return command.startsWith(MODEL_ENV_MARKER)
    ? { marker: MODEL_ENV_MARKER, command: command.slice(MODEL_ENV_MARKER.length) }
    : { marker: '', command };
}

/**
 * Shell basenames the marker's grammar is written for.
 *
 * fish spells this `set -e` and has no `unset` at all; csh/tcsh need `unsetenv`;
 * PowerShell, nushell, xonsh and elvish share none of the syntax. So a shell the
 * operator NAMED but this list does not know drops the marker: the worst case
 * of dropping it is the original bug, and the worst case of keeping it is a
 * worker that never starts.
 *
 * An ABSENT shell is the one case that still gets the marker — it means "the
 * pane inherits the platform default", and the attaching side has already
 * refused every platform whose default is not a Bourne shell.
 */
const POSIX_MARKER_SHELLS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ksh93', 'mksh', 'ash', 'busybox',
]);

/** Can this pane's shell run the marker? `undefined` = the platform default. */
export function shellSupportsModelEnvMarker(shell: string | undefined): boolean {
  if (!shell) return true;
  const base = (shell.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
  return POSIX_MARKER_SHELLS.has(base);
}

/**
 * Is `agentCmd` a single simple command the marker can safely precede?
 *
 * `unset X; a && b` would leave `b` running with the variable unset in a way the
 * operator never wrote, and a `VAR=value claude` form puts the assignment where
 * the marker's `;` would split it off. Neither is a shape wmux assembles — both
 * would have to come from an explicit `agentCmd` — so the honest answer for one
 * is to leave the command exactly as written and say why.
 */
export function isSimpleLaunchCommand(agentCmd: string): boolean {
  if (/[;|&\n\r`]/.test(agentCmd)) return false;
  if (/\$\(/.test(agentCmd)) return false;
  return !/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(agentCmd);
}

/**
 * Re-attach `marker` to a command the role rewrite has been through.
 *
 * Dropped when the rewritten command now names a model itself (the operator's
 * role binding IS wmux deciding the model, and a CLI flag beats the environment
 * anyway) or when the pane's shell cannot run the marker. `reason` says which,
 * so the caller can log a dropped neutralisation rather than lose it silently.
 */
export function reattachModelEnvMarker(
  marker: string,
  command: string,
  shell: string | undefined,
): { command: string; dropped?: 'model-bound' | 'shell' } {
  if (!marker) return { command };
  if (commandChoosesModel(command)) return { command, dropped: 'model-bound' };
  if (!shellSupportsModelEnvMarker(shell)) return { command, dropped: 'shell' };
  return { command: marker + command };
}

// ─── Fan-out worker permission mode + tool allow-list ───────────────────────
//
// A worker runs unattended, so the boundary that actually holds is its Claude
// Code permission mode and allow-list, not wmux's approval dialog. The mode is
// an operator setting (main-side, because it can loosen what a worker may do);
// the allow-list is the fixed minimum a worker needs to report back.

/** The operator's choice for fan-out workers. `manual` is wmux's word for
 *  "add no permission flag" — deliberately NOT a PermissionMode value, which
 *  describes what a transcript recorded rather than what wmux launches. */
export type FanoutWorkerPermissionMode = 'auto' | 'acceptEdits' | 'bypassPermissions' | 'manual';

export const FANOUT_WORKER_PERMISSION_MODES: readonly FanoutWorkerPermissionMode[] = [
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'manual',
];

export const DEFAULT_FANOUT_WORKER_PERMISSION_MODE: FanoutWorkerPermissionMode = 'auto';

export function isFanoutWorkerPermissionMode(v: unknown): v is FanoutWorkerPermissionMode {
  return typeof v === 'string' && (FANOUT_WORKER_PERMISSION_MODES as readonly string[]).includes(v);
}

/**
 * The wmux tools a worker may call without a prompt: report status, talk on
 * its mission channel, and read who it is / what it was asked. Nothing that
 * types into another pane, opens a browser or fans out. Never `mcp__wmux` as a
 * whole — that would pre-approve every tool wmux exposes.
 */
export const FANOUT_WORKER_ALLOWED_TOOLS: readonly string[] = [
  'mcp__wmux__ledger_update',
  'mcp__wmux__channel_post',
  'mcp__wmux__channel_read',
  'mcp__wmux__channel_unread',
  'mcp__wmux__channel_ack',
  'mcp__wmux__a2a_task_query',
  'mcp__wmux__a2a_whoami',
];

const PERMISSION_FLAG_FOR_WORKER: Readonly<Record<FanoutWorkerPermissionMode, string>> = {
  auto: '--permission-mode auto',
  acceptEdits: '--permission-mode acceptEdits',
  bypassPermissions: '--dangerously-skip-permissions',
  manual: '',
};

/** First-token stem, extension and path stripped (`/x/claude.exe` → claude). */
function launchStem(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return (first.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * Append the worker's permission flag and allow-list to a launch line.
 *
 * Only a `claude` launch is touched — a role binding may have swapped the agent
 * to one that rejects these flags. Both go AFTER everything already on the line,
 * i.e. after the prompt argument: `--allowedTools` is variadic, so placed before
 * the prompt it would swallow it as a tool name. The list is one quoted
 * `--allowedTools=a,b` token for the same reason (and so PowerShell does not
 * read the commas as an array).
 *
 * Any permission flag already on the line (a role binding's args, a typed
 * agentCmd) is removed first so the setting is the one that applies; `manual`
 * leaves the line's own flags alone, because it means "wmux adds none".
 */
export function applyWorkerPermissionFlags(command: string, mode: FanoutWorkerPermissionMode): string {
  if (launchStem(command) !== 'claude') return command;
  let line = command;
  const flag = PERMISSION_FLAG_FOR_WORKER[mode];
  if (flag) {
    // Each flag goes with the whitespace in front of it, so nothing else on
    // the line (the quoted prompt path included) is re-spaced.
    line = line
      .replace(/\s+--dangerously-skip-permissions(?=\s|$)/g, '')
      .replace(/\s+--permission-mode(?:=|\s+)[A-Za-z]+(?=\s|$)/g, '');
  }
  const allow = `"--allowedTools=${FANOUT_WORKER_ALLOWED_TOOLS.join(',')}"`;
  return [line, flag, allow].filter((p) => p.length > 0).join(' ');
}
