// ─── A bot's open prompts, pushed to the phone
//
// A bot asking the owner something without an approval record: a `question`
// (ask_person), a `login_request` or a `secret_request` room card, written by
// main and closed (`state: 'resolved'`) once answered. Main pushes the table
// of those still open over `daemon.botPrompts.set`, the same way and for the
// same reasons as the bot approval table (shared/botApprovalPush.ts); the
// daemon pushes what appeared and retracts what left.
//
// A row carries no text the bot wrote: not the question, not the card's
// title or body, not a login URL. A secret_request carries the secret's NAME,
// never a value — the card itself never holds one.

import { parseThreadId, type ThreadId } from './room';
import { isBotSecretName, type LoginService } from './botSecret';

export const BOT_PROMPT_PUSH_SET_METHOD = 'daemon.botPrompts.set';

/** What a device lists in `POST /api/push-registration` `capabilities` to
 *  receive bot prompt pushes. */
export const BOT_PROMPT_PUSH_CAPABILITY = 'botPromptPush';

export const BOT_PROMPT_KINDS = ['question', 'login_request', 'secret_request'] as const;
export type BotPromptKind = (typeof BOT_PROMPT_KINDS)[number];

/** Main sends at most this many; anything beyond is dropped by the daemon. */
export const BOT_PROMPT_PUSH_MAX_ROWS = 200;

const LOGIN_SERVICES: readonly LoginService[] = ['github', 'claude', 'website'];
/** Room card ids (`c-…`); short enough for `botprompt-<id>` to fit APNs' 64. */
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,54}$/;
const LINE_MAX = 200;
const BOT_NAME_MAX = 80;

export interface BotPromptPushRow {
  cardId: string;
  promptKind: BotPromptKind;
  workspaceId: string;
  threadId: ThreadId;
  botId: string;
  /** The bot's display name, as the owner sees it in wmux. */
  botName?: string;
  /** `secret_request`: the env name asked for. Never a value. */
  secretName?: string;
  /** `login_request`: the service to log in to. */
  loginService?: LoginService;
}

function line(v: unknown, max = LINE_MAX): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s.length === 0 || s.length > max) return undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return undefined;
  }
  return s;
}

/** One row, rebuilt from its allowed fields only, or null. */
function parseRow(value: unknown): BotPromptPushRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const cardId = typeof o.cardId === 'string' && CARD_ID_RE.test(o.cardId) ? o.cardId : undefined;
  const promptKind = (BOT_PROMPT_KINDS as readonly unknown[]).includes(o.promptKind) ? o.promptKind as BotPromptKind : undefined;
  const workspaceId = line(o.workspaceId);
  const threadId = parseThreadId(o.threadId);
  const botId = line(o.botId);
  if (!cardId || !promptKind || !workspaceId || !threadId || !botId) return null;
  const botName = line(o.botName, BOT_NAME_MAX);
  const row: BotPromptPushRow = { cardId, promptKind, workspaceId, threadId, botId, ...(botName ? { botName } : {}) };
  if (promptKind === 'secret_request') {
    if (!isBotSecretName(o.secretName)) return null;
    row.secretName = o.secretName;
  }
  if (promptKind === 'login_request') {
    if (!(LOGIN_SERVICES as readonly unknown[]).includes(o.loginService)) return null;
    row.loginService = o.loginService as LoginService;
  }
  return row;
}

/** The valid rows of a pushed table, or null when it is not a table. Main
 *  builds with it and the daemon parses with it. */
export function parseBotPromptPushRows(value: unknown): BotPromptPushRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: BotPromptPushRow[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, BOT_PROMPT_PUSH_MAX_ROWS)) {
    const row = parseRow(raw);
    if (!row || seen.has(row.cardId)) continue;
    seen.add(row.cardId);
    rows.push(row);
  }
  return rows;
}
