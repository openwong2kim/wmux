// ─── Bot command rules — the owner's per-bot command list ──────────────────
//
// `<wmuxDir>/factory/bot-command-rules.json` holds, per bot, the commands the
// owner lets that bot run on top of the built-in read-only set
// (botCommandAllow.ts). Main reads it when a bot's command is decided; only
// the owner's own path writes it (`setRules`, called from main for the
// owner's settings — no bot RPC reaches this module, and no bot tool names
// it). The floor applies whatever a rule says, and a rule for a shell or an
// interpreter must name its script and may not take any arguments.
//
// A missing file is an empty list. A file of another version, or one that
// cannot be read, is an empty list too (logged) and is never overwritten.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import type { BotCommandRule } from './botCommandAllow';
import { commandName, isShellOrInterpreter } from './botCommandFloor';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const BOT_COMMAND_RULES_FILE = 'bot-command-rules.json';
export const BOT_COMMAND_RULES_VERSION = 1 as const;
export const BOT_COMMAND_RULES_LIMITS = { RULES_PER_BOT: 100, WORDS: 16, WORD_MAX: 200 } as const;

export function botCommandRulesPath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', BOT_COMMAND_RULES_FILE);
}

/** One rule from the file or the owner, or null when malformed. Pure. */
export function parseBotCommandRule(value: unknown): BotCommandRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { argv?: unknown; anyArgs?: unknown };
  if (!Array.isArray(v.argv) || v.argv.length === 0 || v.argv.length > BOT_COMMAND_RULES_LIMITS.WORDS) return null;
  const argv: string[] = [];
  for (const w of v.argv) {
    if (typeof w !== 'string' || w.length === 0 || w.length > BOT_COMMAND_RULES_LIMITS.WORD_MAX || /[\0\r\n]/.test(w)) return null;
    argv.push(w);
  }
  if (v.anyArgs !== undefined && typeof v.anyArgs !== 'boolean') return null;
  // A shell or interpreter rule names its script and takes nothing else:
  // with any arguments it would run whatever code follows.
  if (isShellOrInterpreter(commandName(argv[0])) && (v.anyArgs === true || !argv.slice(1).some((w) => !w.startsWith('-')))) return null;
  return v.anyArgs ? { argv, anyArgs: true } : { argv };
}

export class BotCommandRulesStore {
  private readonly rules = new Map<string, BotCommandRule[]>();
  private readonly persister: FilePersister;
  /** The file could not be read as this version: nothing is written over it. */
  private readonly locked: boolean;

  constructor(private readonly file: string) {
    this.persister = createFilePersister(file, () => ({ version: BOT_COMMAND_RULES_VERSION, bots: Object.fromEntries(this.rules) }));
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
    if (parsed.some((r) => r === null)) throw new Error('a command rule is malformed');
    if (parsed.length === 0) this.rules.delete(botId);
    else this.rules.set(botId, parsed as BotCommandRule[]);
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

/** Test-only. */
export function __setBotCommandRulesStoreForTesting(next: BotCommandRulesStore | null): void {
  store = next;
}
