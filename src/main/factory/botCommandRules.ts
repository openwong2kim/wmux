// ─── Bot command rules — the owner's per-bot command list ──────────────────
//
// `<wmuxDir>/factory/bot-command-rules.json` holds, per bot, the commands the
// owner lets that bot run on top of the built-in read-only set
// (botCommandAllow.ts). Main reads it when a bot's command is decided; only
// the owner's own path writes it (`setRules`, called from main for the
// owner's settings — no bot RPC reaches this module, and no bot tool names
// it). The floor applies whatever a rule says, a rule never names a
// built-in command (its option checks stay), and a rule for a shell or an
// interpreter is exactly the interpreter and its script: no option, no other
// argument. A rule covers a line only when it is that one command, with no
// redirect (botCommandAllow.ts decideBotCommand).
//
// It also holds the owner's per-bot switch: a bot listed in `off` runs no
// commands at all (no Bash, Write or Edit, and no Read of its own folder).
//
// A missing file is an empty list with every bot on. A file of another
// version, or one that cannot be read, is an empty list too (logged), is
// never overwritten, and turns every bot's commands off.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { isBuiltinCommandName, type BotCommandRule } from './botCommandAllow';
import { commandName, isShellOrInterpreter, normalizeCommand } from './botCommandFloor';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const BOT_COMMAND_RULES_FILE = 'bot-command-rules.json';
export const BOT_COMMAND_RULES_VERSION = 1 as const;
export const BOT_COMMAND_RULES_LIMITS = { RULES_PER_BOT: 100, WORDS: 16, WORD_MAX: 200 } as const;

export function botCommandRulesPath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', BOT_COMMAND_RULES_FILE);
}

/** Why `value` is not a rule, or null when it is one. Pure. */
export function botCommandRuleRefusal(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'a command rule is malformed';
  const v = value as { argv?: unknown; anyArgs?: unknown };
  if (!Array.isArray(v.argv) || v.argv.length === 0) return 'a command rule names no command';
  if (v.argv.length > BOT_COMMAND_RULES_LIMITS.WORDS) return `a command rule has more than ${BOT_COMMAND_RULES_LIMITS.WORDS} words`;
  for (const w of v.argv) {
    if (typeof w !== 'string' || w.length === 0 || w.length > BOT_COMMAND_RULES_LIMITS.WORD_MAX || /[\0\r\n]/.test(w)) return 'a command rule has an empty, overlong or multi-line word';
  }
  if (v.anyArgs !== undefined && typeof v.anyArgs !== 'boolean') return 'a command rule is malformed';
  const argv = v.argv as string[];
  // A built-in command keeps its checks: a rule would let the options they
  // refuse (an output file, a program to run) through.
  if (isBuiltinCommandName(commandName(argv[0]))) return `${commandName(argv[0])} is a built-in command; its blocked options stay blocked`;
  // A shell or interpreter rule is exactly `[interpreter, script]`: any
  // option (`-m`, `-c`, `-r`, `-o`) or other word could run other code.
  if (isShellOrInterpreter(commandName(argv[0])) && (v.anyArgs === true || argv.length !== 2 || argv[1].startsWith('-'))) {
    return `a rule for ${commandName(argv[0])} must name the script it runs and nothing else (no options, no other arguments)`;
  }
  return null;
}

/** One rule from the file or the owner, or null when malformed. Pure. */
export function parseBotCommandRule(value: unknown): BotCommandRule | null {
  if (botCommandRuleRefusal(value) !== null) return null;
  const v = value as { argv: string[]; anyArgs?: boolean };
  const argv = [...v.argv];
  return v.anyArgs ? { argv, anyArgs: true } : { argv };
}

/** A rule as one command line (its words quoted as main runs them). Pure. */
export function botCommandRuleText(rule: BotCommandRule): string {
  return normalizeCommand([[{ assignments: [], argv: rule.argv, redirects: [] }]]);
}

export class BotCommandRulesStore {
  private readonly rules = new Map<string, BotCommandRule[]>();
  /** Bots the owner switched commands off for. */
  private readonly off = new Set<string>();
  private readonly persister: FilePersister;
  /** The file could not be read as this version: nothing is written over it. */
  private readonly locked: boolean;

  constructor(private readonly file: string) {
    this.persister = createFilePersister(file, () => ({ version: BOT_COMMAND_RULES_VERSION, bots: Object.fromEntries(this.rules), off: [...this.off] }));
    let locked = false;
    try {
      const raw = readVersionedFile(file, BOT_COMMAND_RULES_VERSION);
      const bots = raw && raw.bots && typeof raw.bots === 'object' && !Array.isArray(raw.bots) ? (raw.bots as Record<string, unknown>) : {};
      for (const [botId, list] of Object.entries(bots)) {
        if (!Array.isArray(list)) continue;
        const parsed = list.map(parseBotCommandRule).filter((r): r is BotCommandRule => r !== null);
        if (parsed.length < list.length) console.warn(`[factory] bot command rules: dropped ${list.length - parsed.length} malformed or unsafe rule(s) of ${botId}`);
        if (parsed.length > 0) this.rules.set(botId, parsed.slice(0, BOT_COMMAND_RULES_LIMITS.RULES_PER_BOT));
      }
      if (raw && Array.isArray(raw.off)) for (const botId of raw.off) if (typeof botId === 'string' && botId.length > 0) this.off.add(botId);
    } catch (err) {
      locked = true;
      console.warn(`[factory] bot command rules not loaded (every bot keeps the built-in list only): ${String(err)}`);
    }
    this.locked = locked;
  }

  /** The owner's rules for one bot ([] when none). */
  rulesFor(botId: string): BotCommandRule[] {
    return (this.rules.get(botId) ?? []).map((r) => ({ ...r, argv: [...r.argv] }));
  }

  /**
   * Replace one bot's rules. The owner's path only (settings, main side);
   * never reachable from a bot. Throws on a malformed rule or a file this
   * version cannot write.
   */
  async setRules(botId: string, rules: readonly unknown[]): Promise<void> {
    if (this.locked) throw new Error(`${this.file} is from another version of wmux and is not changed`);
    if (typeof botId !== 'string' || botId.length === 0) throw new Error('a bot id is required');
    if (rules.length > BOT_COMMAND_RULES_LIMITS.RULES_PER_BOT) throw new Error('too many command rules');
    const parsed = rules.map(parseBotCommandRule);
    const refusal = rules.map(botCommandRuleRefusal).find((r) => r !== null);
    if (refusal) throw new Error(refusal);
    if (parsed.length === 0) this.rules.delete(botId);
    else this.rules.set(botId, parsed as BotCommandRule[]);
    await this.persister.schedule();
  }

  /** A removed bot's rules and switch go (none when the file is locked). */
  async forgetBot(botId: string): Promise<void> {
    if (this.locked) return;
    const had = this.rules.delete(botId);
    if (!this.off.delete(botId) && !had) return;
    await this.persister.schedule();
  }

  /** Whether `botId` may run commands: on unless the owner switched it off,
   *  and off for every bot while the file cannot be read. */
  commandsEnabled(botId: string): boolean {
    return !this.locked && !this.off.has(botId);
  }

  /** The owner's switch for one bot. The owner's path only, as setRules. */
  async setCommandsEnabled(botId: string, enabled: boolean): Promise<void> {
    if (this.locked) throw new Error(`${this.file} is from another version of wmux and is not changed`);
    if (typeof botId !== 'string' || botId.length === 0) throw new Error('a bot id is required');
    if (enabled) this.off.delete(botId);
    else this.off.add(botId);
    await this.persister.schedule();
  }
}

let store: BotCommandRulesStore | null = null;

/** The store on wmux's data folder, opened on first use. */
export function getBotCommandRulesStore(): BotCommandRulesStore {
  store ??= new BotCommandRulesStore(botCommandRulesPath(getWmuxDir()));
  return store;
}

/** The owner's rules for `botId`; [] when they cannot be read. */
export function botCommandRulesFor(botId: string): BotCommandRule[] {
  try {
    return getBotCommandRulesStore().rulesFor(botId);
  } catch {
    return [];
  }
}

/** Whether `botId` may run commands (the owner's switch); false when the
 *  switch cannot be read. */
export function botCommandsEnabled(botId: string): boolean {
  try {
    return getBotCommandRulesStore().commandsEnabled(botId);
  } catch {
    return false;
  }
}

/** Test-only. */
export function __setBotCommandRulesStoreForTesting(next: BotCommandRulesStore | null): void {
  store = next;
}
