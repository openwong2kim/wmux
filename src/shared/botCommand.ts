// ─── Bot commands — the owner's view and control ───────────────────────────
//
// Contract for main/factory/botCommandLog.ts (the decision log),
// main/factory/botCommandRules.ts (the owner's rules and the per-bot
// switch), main/factory/botCommandModule.ts (the main-window IPC) and the bot
// profile's Commands section.
//
// Every decision main makes on a bot's Bash, Write or Edit call
// (main/factory/botExec.ts) is kept per bot, the newest
// BOT_COMMAND_LOG_LIMIT of them, with stored secrets masked:
//
//   <wmuxDir>/factory/bot-command-log/<botId>.json   {version, entries}
//
// The owner reads that log, switches a bot's commands off or on, turns a
// command refused as not on the list into a rule ("Always allow"), and
// removes rules. Only the main window reaches these (BOT_COMMAND_IPC); no
// bot RPC or tool names them, and the renderer only ever gets masked text.

/** Main-window IPC (operator only; the main window's top frame). */
export const BOT_COMMAND_IPC = {
  /** One bot's switch, log and rules (BotCommandReadRequest → BotCommandReadResult). */
  read: 'factory:commands:read',
  /** Switch a bot's commands on or off (BotCommandSetEnabledRequest → BotCommandSimpleResult). */
  setEnabled: 'factory:commands:set-enabled',
  /** Always allow a refused command (BotCommandAllowRequest → BotCommandSimpleResult). */
  allow: 'factory:commands:allow',
  /** Remove one rule (BotCommandRemoveRuleRequest → BotCommandSimpleResult). */
  removeRule: 'factory:commands:remove-rule',
} as const;

/** The decisions kept per bot. */
export const BOT_COMMAND_LOG_LIMIT = 200;

export type BotCommandTool = 'Bash' | 'Write' | 'Edit' | 'Read';

/**
 * Where a decision was made: `attended` (not a turn the owner started),
 * `parse`, `floor` (never allowed), `allowlist` (the built-in list), `rule`
 * (the owner's rule), `unlisted` (needs an owner rule), `script` (runs code
 * from a file; needs an owner rule), `reviewer` (the command reviewer's
 * verdict), `path`, `input`, `off` (the owner switched the
 * bot's commands off). Any other value is shown as it is.
 */
export type BotCommandLayer = string;

/** The layers whose refusal an owner rule can turn into an allow: a
 *  program that needs an owner rule (`unlisted`), one that runs code from a
 *  file (`script`), and one the reviewer refused. Never a built-in command
 *  or the floor (main checks each entry, BotCommandLogEntry.canAllow). */
export const RULE_ALLOWABLE_LAYERS: readonly string[] = ['unlisted', 'script', 'reviewer'];

/** The command reviewer's verdict on a decision it made. */
export interface BotCommandReview {
  /** `reviewer_allow`, `reviewer_deny`, `reviewer_invalid`, … */
  code: string;
  risk?: 'low' | 'medium' | 'high';
  /** One short sentence, masked. */
  rationale?: string;
  latencyMs?: number;
}

export interface BotCommandLogEntry {
  /** Unique within the bot's log. */
  id: string;
  /** Epoch ms. */
  at: number;
  tool: BotCommandTool;
  /** The command as main parsed it (Bash) or the file's path, masked. */
  target?: string;
  decision: 'allow' | 'deny';
  layer: BotCommandLayer;
  /** Why it was refused, short and masked. */
  reason?: string;
  /** The reviewer's verdict, for a `reviewer` decision. */
  review?: BotCommandReview;
  /** In a read only, with canAllow (always, today): its rule may let the
   *  bot run code from files in its folder, which the bot can change, so
   *  Always allow asks the owner to confirm (BotCommandAllowRequest.confirm). */
  runsCode?: boolean;
  /** In a read only: main would save "Always allow"'s rule for it (a
   *  command refused as not on the list whose head is not a built-in). */
  canAllow?: boolean;
}

/** One owner rule as the profile shows it. */
export interface BotCommandRuleView {
  /** The rule's words as one command line, masked. */
  text: string;
  anyArgs: boolean;
}

export interface BotCommandReadRequest {
  botId: string;
}

export type BotCommandReadResult =
  | {
      ok: true;
      /** Whether this bot runs commands on this machine at all (a Claude
       *  SDK bot, the OS sandbox present, a new enough Claude Code). */
      available: boolean;
      /** The owner's switch (default on). */
      enabled: boolean;
      /** Newest first. */
      entries: BotCommandLogEntry[];
      rules: BotCommandRuleView[];
    }
  | { ok: false; error: string };

export type BotCommandSimpleResult = { ok: true } | { ok: false; error: string };

export interface BotCommandSetEnabledRequest {
  botId: string;
  enabled: boolean;
}

export interface BotCommandAllowRequest {
  botId: string;
  /** The log entry of the refused command. */
  entryId: string;
  /** The owner confirmed a rule that runs code (BotCommandLogEntry.runsCode). */
  confirm?: boolean;
}

export interface BotCommandRemoveRuleRequest {
  botId: string;
  index: number;
  /** The rule's text as read, so a stale index removes nothing. */
  text: string;
}
