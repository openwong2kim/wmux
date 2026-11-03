// ─── Bot folders — the owner's way to file bots on the Bots page ───────────
//
// Contract for main/factory/botFolderStore.ts, the folder IPC
// (main/pipe/handlers/folder.rpc.ts) and the Bots page.
//
// A folder is a named, collapsible section of the Bots list. A bot is in at
// most one folder; a bot in none is unfiled. Folders are the owner's alone:
// bots never see, make or change one, and a folder changes nothing about a
// bot (its workspace, room or groups). Deleting a folder returns its bots
// to unfiled; it never deletes a bot.
//
// Folders live in `<wmuxDir>/factory/bot-folders.json`, written by main alone
// (the main window's IPC).

import { BOTS_MAX } from './bot';

export const BOT_FOLDER_ID_RE = /^fld-[0-9a-f]{8}$/;

export interface BotFolder {
  /** `fld-<8 hex>`. */
  id: string;
  name: string;
  /** Its bots, in the order they were filed (a bot deleted since is left
   *  out when read). */
  botIds: string[];
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
}

export const BOT_FOLDER_LIMITS = {
  NAME_MAX: 60,
  FOLDERS_MAX: 200,
  /** Bots one batch assign may name (the bot store's cap, BOTS_MAX). */
  ASSIGN_MANY_MAX: BOTS_MAX,
} as const;

export const BOT_FOLDER_IPC = {
  list: 'factory:folder:list',
  create: 'factory:folder:create',
  rename: 'factory:folder:rename',
  setCollapsed: 'factory:folder:set-collapsed',
  assign: 'factory:folder:assign',
  assignMany: 'factory:folder:assign-many',
  remove: 'factory:folder:remove',
} as const;

export type BotFolderRefusalCode = 'invalid' | 'not_found' | 'not_started' | 'store_unreadable' | 'not_authorized' | 'error';

export type BotFolderRefusal = { ok: false; code: BotFolderRefusalCode; field?: 'name' | 'bot' | 'folder'; message: string };

export type BotFolderResult = { ok: true; folder: BotFolder } | BotFolderRefusal;
export type BotFolderListResult = { ok: true; folders: BotFolder[] } | BotFolderRefusal;
/** The change was made (an assign to `null` of an unfiled bot included). */
export type BotFolderOkResult = { ok: true } | BotFolderRefusal;

/** A folder name as typed: one line, trimmed, at most NAME_MAX; null when
 *  nothing is left. Pure. */
export function normalizeFolderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return name.length > BOT_FOLDER_LIMITS.NAME_MAX ? name.slice(0, BOT_FOLDER_LIMITS.NAME_MAX).trimEnd() : name;
}
