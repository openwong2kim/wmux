// ─── Bot commands — the owner's decision log ───────────────────────────────
//
// Every decision main makes on a bot's Bash, Write or Edit call (botExec.ts
// logBotExecDecision) is kept per bot in
// `<wmuxDir>/factory/bot-command-log/<botId>.json` ({version, entries},
// oldest first), the newest BOT_COMMAND_LOG_LIMIT of them: each new one
// drops the oldest past the limit and the file is written whole again
// (versionedFile.ts: atomic, one serial chain per file, a burst coalesced
// into few writes). A reviewer decision keeps the reviewer's code, risk,
// rationale and latency. A command, path, reason or rationale is masked
// before it is kept
// (stored secrets and anything shaped like a credential: shared/
// redactSecrets.ts), and again when it is read, so a
// value stored since never reaches the profile either.
//
// A missing file is an empty log; an unreadable one, or one of another
// version, is an empty log that is never written over. A removed bot's log
// is deleted (botCommandModule.ts, BotRuntime onBotRemoved).

import fs from 'node:fs';
import path from 'node:path';
import { BOT_ID_RE } from '../../shared/bot';
import { BOT_COMMAND_LOG_LIMIT, type BotCommandLogEntry, type BotCommandReview, type BotCommandTool } from '../../shared/botCommand';
import { assertNotLiveWmuxPath } from '../../shared/constants';
import { redactSecrets } from '../../shared/redactSecrets';
import type { BotExecDecisionRecord } from './botExec';
import { redactStoredSecrets } from './secretRedaction';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const BOT_COMMAND_LOG_DIRNAME = 'bot-command-log';
export const BOT_COMMAND_LOG_VERSION = 1 as const;
/** The longest command, path or reason kept (a longer one is cut, ending in …). */
export const BOT_COMMAND_LOG_TEXT_MAX = 300;
const TEXT_MAX = BOT_COMMAND_LOG_TEXT_MAX;
const TOOLS: readonly string[] = ['Bash', 'Write', 'Edit', 'Read'];
const BOT_FILE_RE = /^(bot-[0-9a-f]{8})\.json$/;

export function botCommandLogDir(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', BOT_COMMAND_LOG_DIRNAME);
}

/** One bot's log file, or null for an id that is not a bot's. */
export function botCommandLogFile(wmuxDir: string, botId: string): string | null {
  return BOT_ID_RE.test(botId) ? path.join(botCommandLogDir(wmuxDir), `${botId}.json`) : null;
}

function mask(text: string): string {
  return redactSecrets(redactStoredSecrets(text));
}

function short(text: unknown): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const masked = mask(text);
  return masked.length > TEXT_MAX ? `${masked.slice(0, TEXT_MAX - 1)}…` : masked;
}

const RISKS: readonly string[] = ['low', 'medium', 'high'];

/** A reviewer verdict as kept (rationale masked), or undefined. Pure but for the masking. */
function parseReview(value: unknown): BotCommandReview | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== 'string' || v.code.length === 0) return undefined;
  const rationale = short(v.rationale);
  return {
    code: v.code.slice(0, 40),
    ...(typeof v.risk === 'string' && RISKS.includes(v.risk) ? { risk: v.risk as BotCommandReview['risk'] } : {}),
    ...(rationale ? { rationale } : {}),
    ...(typeof v.latencyMs === 'number' && Number.isFinite(v.latencyMs) ? { latencyMs: v.latencyMs } : {}),
  };
}

/** One entry from the file, or null when malformed. Pure. */
function parseEntry(value: unknown): BotCommandLogEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.at !== 'number' || !TOOLS.includes(v.tool as string)) return null;
  if (v.decision !== 'allow' && v.decision !== 'deny') return null;
  if (typeof v.layer !== 'string' || v.layer.length === 0) return null;
  return {
    id: v.id,
    at: v.at,
    tool: v.tool as BotCommandTool,
    decision: v.decision,
    layer: v.layer,
    ...(typeof v.target === 'string' ? { target: v.target } : {}),
    ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
    ...(parseReview(v.review) ? { review: parseReview(v.review) } : {}),
  };
}

interface BotLog {
  entries: BotCommandLogEntry[];
  /** Null: the file could not be read as this version and is left alone. */
  persister: FilePersister | null;
}

export class BotCommandLog {
  private readonly bots = new Map<string, BotLog>();
  private seq = 0;

  constructor(private readonly wmuxDir: string, private readonly now: () => number = Date.now) {}

  private open(botId: string): BotLog | null {
    const hit = this.bots.get(botId);
    if (hit) return hit;
    const file = botCommandLogFile(this.wmuxDir, botId);
    if (!file) return null;
    let entries: BotCommandLogEntry[] = [];
    let writable = true;
    try {
      const raw = readVersionedFile(file, BOT_COMMAND_LOG_VERSION);
      const list = raw && Array.isArray(raw.entries) ? raw.entries : [];
      entries = list.map(parseEntry).filter((e): e is BotCommandLogEntry => e !== null).slice(-BOT_COMMAND_LOG_LIMIT);
    } catch (err) {
      writable = false;
      console.warn(`[factory] bot command log of ${botId} not loaded (kept in memory only): ${String(err)}`);
    }
    const log: BotLog = { entries, persister: null };
    if (writable) log.persister = createFilePersister(file, () => ({ version: BOT_COMMAND_LOG_VERSION, entries: log.entries }));
    this.bots.set(botId, log);
    return log;
  }

  /** Keep one decision. Returns the entry kept, or null for a record that
   *  is not one (an unknown tool, a bot id that is not one). */
  record(botId: string, rec: BotExecDecisionRecord): BotCommandLogEntry | null {
    if (!TOOLS.includes(rec.tool) || (rec.decision !== 'allow' && rec.decision !== 'deny')) return null;
    const log = this.open(botId);
    if (!log) return null;
    const at = this.now();
    const target = short(rec.target);
    const reason = short(rec.reason);
    const review = parseReview(rec.review);
    const entry: BotCommandLogEntry = {
      id: `${at.toString(36)}-${(this.seq++).toString(36)}`,
      at,
      tool: rec.tool as BotCommandTool,
      decision: rec.decision,
      layer: typeof rec.layer === 'string' && rec.layer.length > 0 ? rec.layer.slice(0, 40) : 'input',
      ...(target ? { target } : {}),
      ...(reason ? { reason } : {}),
      ...(review ? { review } : {}),
    };
    log.entries.push(entry);
    if (log.entries.length > BOT_COMMAND_LOG_LIMIT) log.entries.splice(0, log.entries.length - BOT_COMMAND_LOG_LIMIT);
    log.persister?.schedule().catch((err) => console.warn(`[factory] bot command log of ${botId} not written: ${String(err)}`));
    return entry;
  }

  /** One bot's decisions, newest first, masked again for what was stored since. */
  entries(botId: string): BotCommandLogEntry[] {
    const log = this.open(botId);
    if (!log) return [];
    return log.entries
      .slice()
      .reverse()
      .map((e) => ({
        ...e,
        ...(e.target ? { target: mask(e.target) } : {}),
        ...(e.reason ? { reason: mask(e.reason) } : {}),
        ...(e.review?.rationale ? { review: { ...e.review, rationale: mask(e.review.rationale) } } : {}),
      }));
  }

  /** One entry as kept (masked when it was written), or null. */
  entry(botId: string, id: string): BotCommandLogEntry | null {
    const found = this.open(botId)?.entries.find((e) => e.id === id);
    return found ? { ...found } : null;
  }

  /** Delete a bot's log, once any write in flight has landed. */
  async remove(botId: string): Promise<void> {
    const file = botCommandLogFile(this.wmuxDir, botId);
    if (!file) return;
    const log = this.bots.get(botId);
    this.bots.delete(botId);
    await log?.persister?.settled();
    removeLogFiles(file);
  }

  /** The logs of every bot `has` no longer knows are deleted. Returns how many. */
  forgetRemoved(has: (botId: string) => boolean): number {
    let names: string[];
    try {
      names = fs.readdirSync(botCommandLogDir(this.wmuxDir));
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      const id = BOT_FILE_RE.exec(name)?.[1];
      if (!id || has(id) || this.bots.has(id)) continue;
      const file = botCommandLogFile(this.wmuxDir, id);
      if (!file) continue;
      removeLogFiles(file);
      n += 1;
    }
    return n;
  }

  /** Resolves once every write scheduled so far has finished. */
  async settled(): Promise<void> {
    await Promise.all([...this.bots.values()].map((l) => l.persister?.settled()));
  }
}

/** The file and the backup its atomic write keeps. */
function removeLogFiles(file: string): void {
  assertNotLiveWmuxPath(file);
  for (const f of [file, `${file}.bak`]) fs.rmSync(f, { force: true });
}
