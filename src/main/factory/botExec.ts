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
//   4. anything else is `unlisted`: refused, unless the reviewer
//      (botCommandReviewer.ts, factory setting `botCommandReviewer`) judges
//      it a small task in the bot's folder (`reviewUnlistedCommand`); a line
//      that runs code from a file (`script`), or any program but a plain
//      file utility (`unlisted`), is refused before that, since only an
//      owner rule may allow it.
// An allowed call runs as main rebuilt it (every word quoted, every command
// as `\command <name>`, past the owner's aliases and functions), with
// `dangerouslyDisableSandbox` and `run_in_background` removed and its
// timeout clamped to BOT_EXEC_TIMEOUT_MS.
//
// Write and Edit: attended, then the path is checked inside the bot's folder
// (botFolderPath.ts). Read: inside the bot's folder (a bot with a
// repository also reads that, botRepoRead.ts). Every decision on Bash, Write
// and Edit is logged with its layer, a short reason and the parsed command,
// with stored secrets masked, and handed to the owner's decision log
// (botCommandLog.ts, through setBotExecDecisionSink).
//
// Before all of them, a bot the owner switched off (botCommandRules.ts) is
// refused (`off`); the adapter also gives it none of these tools.

import { decideBotCommand, type BotCommandRule } from './botCommandAllow';
import { BOT_COMMAND_REVIEWER_LIMITS, reviewerRefusal, type BotCommandReviewer, type ReviewCode, type ReviewFolder, type ReviewOutcome } from './botCommandReviewer';
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
  /** The owner's switch for this bot (absent: on); an error counts as off. */
  enabled?: () => boolean;
  fs?: BotFolderDeps;
}

export type BotExecLayer = 'attended' | 'parse' | 'floor' | 'allowlist' | 'rule' | 'unlisted' | 'script' | 'reviewer' | 'path' | 'input' | 'off';

/** An `unlisted` line as the reviewer sees it and as it would run. */
export interface UnlistedCommand {
  run: string;
  argv: string[][];
  /** The commands neither listed nor allowed by an owner rule. */
  offList: string[][];
}

export type BotExecDecision =
  | { ok: true; layer: BotExecLayer; input: Record<string, unknown>; command?: string; review?: ReviewOutcome }
  | { ok: false; layer: BotExecLayer; reason: string; command?: string; unlisted?: UnlistedCommand; review?: ReviewOutcome };

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
const SWITCHED_OFF = 'the owner switched this bot\'s commands off';

/** The refusal of a call made while the owner's switch is off. */
export function botExecSwitchedOff(command?: string): BotExecDecision {
  return { ok: false, layer: 'off', reason: SWITCHED_OFF, ...(command !== undefined ? { command } : {}) };
}

/** Main's decision on one Bash, Write, Edit or Read call of a bot. */
export function evaluateBotExecTool(toolName: string, input: Record<string, unknown>, ctx: BotExecContext): BotExecDecision {
  let enabled = true;
  try {
    enabled = ctx.enabled ? ctx.enabled() : true;
  } catch {
    enabled = false;
  }
  if (!enabled) return botExecSwitchedOff(toolName === 'Bash' && typeof input.command === 'string' ? input.command.slice(0, 200) : undefined);
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
      // `unlisted` is refused here; reviewUnlistedCommand may take it up.
      if (d.layer === 'unlisted') return { ok: false, layer: d.layer, reason: d.reason, command: d.command, unlisted: { run: d.run, argv: d.argv, offList: d.offList } };
      return { ok: false, layer: d.layer, reason: d.reason, command: d.command };
    }
    // It runs as main rebuilt it from the approved words (botCommandFloor.ts
    // commandLineToRun), never as the model wrote it.
    return { ok: true, layer: d.matched === 'rule' ? 'rule' : d.layer, input: { ...sanitizeBashInput(input), command: d.run }, command: d.command };
  }
  if (!attended) return { ok: false, layer: 'attended', reason: UNATTENDED };
  const r = checkBotFolderPath(input.file_path, ctx.botDir, ctx.fs);
  if (!r.ok) return { ok: false, layer: 'path', reason: `${String(input.file_path)}: ${r.reason}` };
  return { ok: true, layer: 'path', input: { ...input, file_path: r.real } };
}

export interface ReviewGate {
  /** The factory setting is on and the turn may be reviewed (not a guest's). */
  enabled: () => boolean;
  /** Whether the wake running now is attended (asked again here). */
  attended: () => boolean;
  /** This turn's reviewer; null: none could be built. */
  reviewer: BotCommandReviewer | null;
  /** The bot folder a reviewable utility's operands must stay in. */
  folder: ReviewFolder;
}

const REVIEW_REFUSALS: Record<Exclude<ReviewCode, 'reviewer_allow'>, string> = {
  reviewer_deny: 'reviewer_deny: the command reviewer did not judge this a small task in your own folder; the owner can add it to your command list',
  reviewer_invalid: 'reviewer_invalid: the command reviewer gave no usable answer, so the command is refused',
  reviewer_unavailable: 'reviewer_unavailable: the command reviewer could not answer, so the command is refused',
  reviewer_budget: 'reviewer_budget: the command reviewer has reached its limit for this turn or today, so the command is refused',
};

/**
 * The reviewer step for an `unlisted` Bash line (and only that). Whatever
 * the setting, a line that runs code from a file is refused first
 * (`script`), then one with a program the reviewer does not judge
 * (`unlisted`: it needs an owner rule) or a refused option of one (`floor`):
 * botCommandReviewer.ts reviewerRefusal. Otherwise, with the setting on, in an
 * attended turn, the reviewer's verdict decides. Allowed,
 * the line runs as main rebuilt it (commandLineToRun, from the words the
 * floor passed), never as the bot wrote it. Every other decision, and an
 * `unlisted` line with the setting off, is returned unchanged.
 */
export async function reviewUnlistedCommand(d: BotExecDecision, input: Record<string, unknown>, gate: ReviewGate): Promise<BotExecDecision> {
  if (d.ok || d.layer !== 'unlisted' || !d.unlisted) return d;
  let refused: ReturnType<typeof reviewerRefusal>;
  try {
    refused = reviewerRefusal(d.unlisted.argv, d.unlisted.offList, gate.folder);
  } catch {
    refused = { layer: 'floor', reason: 'the command check failed' };
  }
  if (refused) return { ok: false, layer: refused.layer, reason: refused.reason, command: d.command };
  let open = false;
  try {
    open = gate.enabled() && gate.attended();
  } catch {
    open = false;
  }
  if (!open) return d;
  const { run, argv } = d.unlisted;
  const command = d.command ?? '';
  let review: ReviewOutcome;
  try {
    review = gate.reviewer ? await gate.reviewer.review({ command, argv }) : { allow: false, code: 'reviewer_unavailable', latencyMs: 0 };
  } catch {
    review = { allow: false, code: 'reviewer_unavailable', latencyMs: 0 };
  }
  if (review.allow && review.code === 'reviewer_allow') return { ok: true, layer: 'reviewer', input: { ...sanitizeBashInput(input), command: run }, command, review };
  const code = review.code === 'reviewer_allow' ? 'reviewer_deny' : review.code;
  return { ok: false, layer: 'reviewer', reason: REVIEW_REFUSALS[code], command, review };
}

/** One decision as the owner's log keeps it (before masking). */
export interface BotExecDecisionRecord {
  tool: string;
  decision: 'allow' | 'deny';
  layer: string;
  reason?: string;
  target?: string;
  review?: { code: string; risk?: 'low' | 'medium' | 'high'; rationale?: string; latencyMs?: number };
}

type BotExecDecisionSink = (botId: string, record: BotExecDecisionRecord) => void;

let decisionSink: BotExecDecisionSink | null = null;

/** Where every decision goes besides the console (the owner's log,
 *  botCommandModule.ts); null: nowhere. */
export function setBotExecDecisionSink(next: BotExecDecisionSink | null): void {
  decisionSink = next;
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
    ...(d.review
      ? {
          review: {
            code: d.review.code,
            ...(d.review.risk ? { risk: d.review.risk } : {}),
            ...(d.review.rationale ? { rationale: d.review.rationale.slice(0, BOT_COMMAND_REVIEWER_LIMITS.RATIONALE_MAX) } : {}),
            latencyMs: d.review.latencyMs,
            ...(d.review.cached ? { cached: true } : {}),
          },
        }
      : {}),
  };
  let line: string;
  try {
    line = redactStoredSecrets(JSON.stringify(entry));
  } catch {
    line = JSON.stringify({ botId, tool: toolName, decision: entry.decision, layer: d.layer });
  }
  log(`[factory] bot command ${line}`);
  try {
    decisionSink?.(botId, {
      tool: toolName,
      decision: d.ok ? 'allow' : 'deny',
      layer: d.layer,
      ...(d.ok ? {} : { reason: d.reason }),
      ...(target ? { target } : {}),
      ...(d.review ? { review: { code: d.review.code, ...(d.review.risk ? { risk: d.review.risk } : {}), ...(d.review.rationale ? { rationale: d.review.rationale } : {}), latencyMs: d.review.latencyMs } } : {}),
    });
  } catch {
    /* the owner's log is best effort; the console line is kept */
  }
}
