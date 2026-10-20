// ─── Bot commands — main's decision on Bash, Write, Edit and Read ──────────
//
// A Claude SDK bot on a machine where the OS sandbox runs
// (botExecSandbox.ts) holds Bash, Write and Edit, and Read for its own
// folder. ClaudeSdkAdapter wires this decision into the session twice: a
// PreToolUse hook (the gate, run for every call) and canUseTool (the same
// decision again). The guest gate (applyGuestToolGate) stays in front of both.
//
// Bash, in order:
//   1. attended — the wake running now is the owner's own (a message or the
//      run button) and known clean (wakeTaint.ts runningWakeAttended); any
//      other wake, none, or one that cannot be told is refused;
//   2. the floor (botCommandFloor.ts) — refused whatever the owner allowed;
//   3. the list (botCommandAllow.ts) — the built-in read-only commands and
//      the owner's rules for this bot (botCommandRules.ts) are allowed;
//   4. anything else is refused (`unlisted`).
// An allowed call runs as main rebuilt it (every word quoted, every command
// as `\command <name>`, past the owner's aliases and functions), with
// `dangerouslyDisableSandbox` and `run_in_background` removed and its
// timeout clamped to BOT_EXEC_TIMEOUT_MS.
//
// Write and Edit: attended, then the path is checked inside the bot's folder
// (botFolderPath.ts). Read: inside the bot's folder (a bot with a
// repository also reads that, botRepoRead.ts). Every decision on Bash, Write
// and Edit is logged with its layer, a short reason and the parsed command,
// with stored secrets masked.

import { decideBotCommand, type BotCommandRule } from './botCommandAllow';
import { checkBotFolderPath, type BotFolderDeps } from './botFolderPath';
import { redactStoredSecrets } from './secretRedaction';

/** The built-in tools a bot that runs commands holds besides Read. */
export const BOT_EXEC_TOOLS: readonly string[] = ['Bash', 'Write', 'Edit'];

/** The longest a bot's command may run. */
export const BOT_EXEC_TIMEOUT_MS = 120_000;

export interface BotExecContext {
  botId: string;
  /** The bot's own folder (the session's cwd). */
  botDir: string;
  /** The repository the bot reads, if any (`git -C` may name it). */
  repoRoot?: string;
  /** Whether the wake running now is attended (runningWakeAttended). */
  attended: () => boolean;
  /** The owner's command rules for this bot. */
  rules: () => readonly BotCommandRule[];
  fs?: BotFolderDeps;
}

export type BotExecLayer = 'attended' | 'parse' | 'floor' | 'allowlist' | 'unlisted' | 'path' | 'input';

export type BotExecDecision =
  | { ok: true; layer: BotExecLayer; input: Record<string, unknown>; command?: string }
  | { ok: false; layer: BotExecLayer; reason: string; command?: string };

/** An allowed Bash call's input as it runs. Pure. */
export function sanitizeBashInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  delete out.dangerouslyDisableSandbox;
  delete out.run_in_background;
  if (typeof out.timeout === 'number' && Number.isFinite(out.timeout)) out.timeout = Math.max(1, Math.min(out.timeout, BOT_EXEC_TIMEOUT_MS));
  else delete out.timeout;
  return out;
}

const UNATTENDED = 'commands and file edits run only in a turn the owner started (their message or the run button)';

/** Main's decision on one Bash, Write, Edit or Read call of a bot. */
export function evaluateBotExecTool(toolName: string, input: Record<string, unknown>, ctx: BotExecContext): BotExecDecision {
  if (toolName === 'Read') {
    const r = checkBotFolderPath(input.file_path, ctx.botDir, ctx.fs);
    return r.ok ? { ok: true, layer: 'path', input: { ...input, file_path: r.real } } : { ok: false, layer: 'path', reason: `${String(input.file_path)}: ${r.reason}` };
  }
  if (!BOT_EXEC_TOOLS.includes(toolName)) return { ok: false, layer: 'input', reason: `${toolName} is not a command tool` };
  let attended = false;
  try {
    attended = ctx.attended();
  } catch {
    attended = false;
  }
  if (toolName === 'Bash') {
    if (!attended) return { ok: false, layer: 'attended', reason: UNATTENDED, command: typeof input.command === 'string' ? input.command.slice(0, 200) : undefined };
    let rules: readonly BotCommandRule[] = [];
    try {
      rules = ctx.rules();
    } catch {
      rules = [];
    }
    const d = decideBotCommand(input.command, { botDir: ctx.botDir, repoRoot: ctx.repoRoot, fs: ctx.fs, rules });
    if (!d.ok) {
      // `unlisted` is where a later review step decides; today it refuses.
      return { ok: false, layer: d.layer, reason: d.reason, command: d.command };
    }
    // It runs as main rebuilt it from the approved words (botCommandFloor.ts
    // commandLineToRun), never as the model wrote it.
    return { ok: true, layer: d.layer, input: { ...sanitizeBashInput(input), command: d.run }, command: d.command };
  }
  if (!attended) return { ok: false, layer: 'attended', reason: UNATTENDED };
  const r = checkBotFolderPath(input.file_path, ctx.botDir, ctx.fs);
  if (!r.ok) return { ok: false, layer: 'path', reason: `${String(input.file_path)}: ${r.reason}` };
  return { ok: true, layer: 'path', input: { ...input, file_path: r.real } };
}

/** One log line per decision on Bash, Write or Edit (never a secret). */
export function logBotExecDecision(botId: string, toolName: string, d: BotExecDecision, log: (line: string) => void = console.warn): void {
  const target = toolName === 'Bash' ? d.command : d.ok ? (d.input.file_path as string | undefined) : undefined;
  const entry = {
    botId,
    tool: toolName,
    decision: d.ok ? 'allow' : 'deny',
    layer: d.layer,
    ...(d.ok ? {} : { reason: d.reason }),
    ...(target ? { target } : {}),
  };
  let line: string;
  try {
    line = redactStoredSecrets(JSON.stringify(entry));
  } catch {
    line = JSON.stringify({ botId, tool: toolName, decision: entry.decision, layer: d.layer });
  }
  log(`[factory] bot command ${line}`);
}
