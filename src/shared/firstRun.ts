/**
 * First-run wizard shared types + constants (Plan 1.15).
 *
 * Frozen interface used by:
 *   - main process: FirstRunOrchestrator, ClaudeDetector, SampleTaskRunner
 *   - preload: electronAPI.firstRun namespace
 *   - renderer: FirstRunWizard.tsx, SettingsPanel "First-run setup" section
 *
 * See: progress.md (T1), decisions.md (D2/D5/D8/D9/D10/D11)
 */

// === Mode ===
// 'firstRun' — wizard mounted from boot hook (no marker yet)
// 'reopen'   — user clicked "Open setup wizard" in Settings (D9: sample task disabled)
export type FirstRunMode = 'firstRun' | 'reopen';

// === Detection result ===
// Filled by ClaudeDetector (T2) and surfaced through firstRun:check / firstRun:reopen.
export interface FirstRunStatus {
  /** `~/.claude/` directory + `~/.claude.json` both present. */
  claudeFound: boolean;
  /** `mcpServers.wmux` key present in ~/.claude.json. */
  mcpRegistered: boolean;
  /** Resolved absolute path to ~/.claude.json (informational, may not exist). */
  claudeJsonPath: string;
}

// === Check / reopen IPC payload ===
// `shown` — true if marker file already exists (caller should NOT mount wizard for mode='firstRun')
// `completedAt` — ISO timestamp of last completion, used for "Already completed on YYYY-MM-DD" copy
export interface FirstRunCheckResult {
  shown: boolean;
  status: FirstRunStatus;
  completedAt?: string;
}

// === MCP registration result envelope (D10) ===
// Distinct from McpStatusPayload — wizard needs Tier 2 inline error display
// with problem/cause/fix copy, so we expose a discriminated union.
export type RegisterMcpErrorCode = 'PERM' | 'PARSE' | 'IO' | 'UNKNOWN';

export type RegisterMcpResult =
  | { ok: true }
  | { ok: false; code: RegisterMcpErrorCode; message: string };

// === Sample task ===
// Outcome reported by SampleTaskRunner (T3) via firstRun:sample-task-ready or :timeout events.
export type SampleTaskOutcome = 'ok' | 'timeout' | 'aborted';

// Renderer → main payload for firstRun:start-sample-task.
// `ptyId` is the upper-left pane's shell — the sample task launches `claude`
// there once the shell emits OSC133 prompt-ready (D3). It is a plain shell,
// not a pre-running Claude pane (#452).
export interface SampleTaskStartPayload {
  ptyId: string;
}

// === Constants ===

/**
 * DOM CustomEvent name dispatched from the Settings panel "Open setup wizard"
 * button so AppLayout can re-mount the wizard in mode='reopen' (D4 / D9).
 *
 * Hoisted to a shared constant (I2) so the magic string lives in exactly one
 * place — both the dispatcher (SettingsPanel) and the listener (AppLayout)
 * import this symbol.
 */
export const FIRST_RUN_REOPEN_EVENT = 'wmux:firstrun-reopen';

/**
 * Deterministic command injected into the upper-left pane's shell once it
 * emits OSC133 prompt-ready (D3). This launches Claude Code with the sample
 * prompt as its initial query.
 *
 * IMPORTANT (#452): the OSC133 prompt-ready we scan for comes from the *shell*
 * (e.g. PowerShell/pwsh shell integration), NOT from Claude — nothing spawns
 * Claude in the pane on its own. So we must invoke `claude` here; pasting the
 * bare prompt would make the shell try to run it as a command (that was the
 * #452 symptom: the prompt text landed directly in a PowerShell session).
 *
 * Verbatim — do not alter without coordinating with SampleTaskRunner / wizard copy.
 */
export const SAMPLE_TASK_COMMAND =
  'claude "Use the wmux browser_open tool to navigate to https://www.google.com/search?q=wmux"';

/** OSC133 prompt-ready handshake timeout (ms). After this, fallback "Press Enter" UI. */
export const OSC133_TIMEOUT_MS = 5000;

/**
 * OSC133 "A" (prompt-ready) sequence patterns to scan in raw PTY byte streams.
 *
 * Two terminator forms exist in the wild:
 *   - BEL terminator: ESC ] 1 3 3 ; A BEL  →  '\x1b]133;A\x07'
 *   - ST  terminator: ESC ] 1 3 3 ; A ESC \\ →  '\x1b]133;A\x1b\\'
 *
 * Patterns use literal control bytes (NOT String.raw — these must match real escape sequences).
 * `[` / `]` / `\` are escaped for regex syntax; `\x1b` and `\x07` are real bytes.
 */
// eslint-disable-next-line no-control-regex -- intentional: must match real OSC133 control bytes
export const OSC133_PROMPT_READY_PATTERNS: readonly RegExp[] = [
  // eslint-disable-next-line no-control-regex
  /\x1b\]133;A\x07/,
  // eslint-disable-next-line no-control-regex
  /\x1b\]133;A\x1b\\/,
];
