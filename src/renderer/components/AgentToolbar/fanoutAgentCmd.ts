// fan-out "agent command" helpers: the skip-permissions checkbox and the
// remembered last launch command.
//
// The agent command is free text (`claude`, `codex --model o3`, …), so the
// checkbox is a PROJECTION of that string rather than a second source of truth:
// checking it appends the flag, unchecking strips it, and typing the flag by
// hand ticks the box. That keeps the command preview WYSIWYG with what the
// task pane will actually launch (ResumeInfoChip uses the same shape).
//
// wmux only knows one bypass flag — Claude Code's (agentSupportsPermissionFlag).
// Codex and friends have their own spelling, so instead of guessing a flag the
// CLI would reject, the last launched command is persisted and prefilled: a
// Codex user types their own bypass flag once and it sticks.
//
// Parsing goes through the shared `tokenize` rather than a regex: the panel
// review caught that a regex both mis-fires on a flag inside a quoted argument
// (`claude "explain --dangerously-skip-permissions"` would tick the box, and
// unchecking would corrupt the argument) and backtracks quadratically on long
// whitespace runs. Tokenizing is linear, quote-aware, and agrees with the resume
// builder on what a launcher token is.

import { PERMISSION_FLAG, agentSupportsPermissionFlag, launcherStem, tokenize } from '../../../shared/agentResume';
import { KNOWN_AGENT_STEMS } from '../../../shared/orchestratorRole';

/** The only bypass flag wmux assembles itself (Claude Code). */
export const SKIP_PERMISSIONS_FLAG = PERMISSION_FLAG.bypassPermissions;

/** Launcher stem of a free-text agent command: `"C:\tools\claude.cmd" --x` → `claude`. */
export function fanoutAgentStem(agentCmd: string): string {
  const first = tokenize(agentCmd)[0];
  return first ? launcherStem(first.value) : '';
}

/** Whether wmux knows a bypass flag for this command's launcher (Claude only). */
export function supportsSkipPermissions(agentCmd: string): boolean {
  return agentSupportsPermissionFlag(fanoutAgentStem(agentCmd));
}

/** Whether the command carries the flag as its own UNQUOTED token. */
export function hasSkipPermissions(agentCmd: string): boolean {
  return tokenize(agentCmd).some((tok) => !tok.quoted && tok.value === SKIP_PERMISSIONS_FLAG);
}

/**
 * Drop every unquoted flag token, leaving the rest of the command byte-identical
 * (each kept token is spliced back with the whitespace that preceded it).
 */
function stripSkipPermissions(agentCmd: string): string {
  let out = '';
  let cursor = 0;
  for (const tok of tokenize(agentCmd)) {
    // The segment carries this token's leading whitespace, so dropping it drops
    // the separator with it — no double space where the flag used to be.
    if (tok.quoted || tok.value !== SKIP_PERMISSIONS_FLAG) out += agentCmd.slice(cursor, tok.end);
    cursor = tok.end;
  }
  return (out + agentCmd.slice(cursor)).trim();
}

/**
 * Reflect the checkbox onto the command. `on` appends the flag once (only for a
 * launcher wmux knows it for); `off` strips every occurrence.
 */
export function applySkipPermissions(agentCmd: string, on: boolean): string {
  const stripped = stripSkipPermissions(agentCmd);
  if (!on || !supportsSkipPermissions(stripped)) return stripped;
  return `${stripped} ${SKIP_PERMISSIONS_FLAG}`;
}

/** True when the command carries a Claude-only flag its launcher won't accept. */
export function hasStaleSkipPermissions(agentCmd: string): boolean {
  return hasSkipPermissions(agentCmd) && !supportsSkipPermissions(agentCmd);
}

// ─── Last launched command (survives a reload — localStorage) ─────────────────

const STORAGE_KEY = 'wmux.fanout.agentCmd';

/** A prefill is a convenience, never a blank cheque — cap what we will restore. */
const MAX_RESTORED_LENGTH = 512;

/** Shell metacharacters. main interpolates agentCmd UNQUOTED into the PTY line
 *  (`FanOutService.buildInitialCommand`), so a restored value that carries any
 *  of these could run a second command the user never typed. Backslash, quotes,
 *  `:` and `/` stay legal — a Windows launcher path needs them. */
const SHELL_METACHARS = /[;&|`$(){}<>\n\r]/;

/**
 * Whether a value read back from storage is safe to prefill. The panel review
 * (Codex+GLM, both CRITICAL) flagged the restore path as a persistent injection
 * surface: whatever sits in storage is auto-loaded and fired at a shell on the
 * next Spawn without anyone re-typing it. A typed command is trusted (the human
 * is right there); a RESTORED one is not, so it must look like a plain agent
 * launch — a known agent CLI plus flags, no shell operators.
 */
function isRestorableAgentCmd(value: string): boolean {
  if (value.length === 0 || value.length > MAX_RESTORED_LENGTH) return false;
  if (SHELL_METACHARS.test(value)) return false;
  return KNOWN_AGENT_STEMS.has(fanoutAgentStem(value));
}

/** The last successfully launched agent command, or '' when there is none (or
 *  the stored value no longer looks like a plain agent launch). */
export function loadLastAgentCmd(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    const raw = (localStorage.getItem(STORAGE_KEY) ?? '').trim();
    return isRestorableAgentCmd(raw) ? raw : '';
  } catch {
    // localStorage unavailable (private mode / test env) → no memory, no crash.
    return '';
  }
}

/** Remember the command a fan-out actually launched. */
export function saveLastAgentCmd(agentCmd: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const v = agentCmd.trim();
    if (v.length > 0) localStorage.setItem(STORAGE_KEY, v);
  } catch {
    // Persisting the convenience prefill must never break a launch.
  }
}
