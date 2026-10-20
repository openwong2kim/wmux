// ─── Bot memory — a bot's own notes and the owner's profile ────────────────
//
// Contract for main/factory/botMemory.ts (the files), the `memory` factory
// module (main/pipe/handlers/memory.rpc.ts), the `memory_update` bot tool
// (src/mcp/botMemory.ts) and the bot profile's Memory section.
//
// Two small stores, each a list of short entries kept by main in a plain
// text file, one entry after another with a DELIMITER line between them:
//
//   <wmuxDir>/factory/bot-memory/<botId>.txt   `memory`: the bot's own notes
//                                              (environment facts, the
//                                              owner's conventions, lessons)
//   <wmuxDir>/factory/bot-memory/owner.txt     `user`: who the owner is and
//                                              how they like to work, shared
//                                              by every bot of the owner
//
// Both load into a bot's session when it starts (a snapshot: what a bot saves
// applies from its next session). A bot writes its notes only through
// `memory_update`, in a conversation known clean (never a guest's, never one
// that ran a wake started from outside text). It never writes the owner's
// profile: `memory_update` on `user` raises an `owner_profile` approval card
// (shared/botApproval.ts) showing the exact change, and only the owner's
// Approve applies it. Every text is checked for instructions and secrets
// before it is kept, and again when the owner approves. The owner reads,
// removes and clears both in the bot's profile (BOT_MEMORY_IPC); the bot
// never names a file or a bot.

export const BOT_MEMORY_RPC = {
  /** `memory_update`: add, replace or remove one entry of the caller's
   *  notes or of the owner's profile (MemoryUpdateParams). */
  update: 'memory.update',
} as const;

/** Main-window IPC (operator only; the main window's top frame). */
export const BOT_MEMORY_IPC = {
  /** One bot's notes and the owner's profile (MemoryReadRequest → MemoryReadResult). */
  read: 'factory:memory:read',
  /** Remove one entry (MemoryRemoveRequest → MemorySimpleResult). */
  remove: 'factory:memory:remove',
  /** Clear one store (MemoryClearRequest → MemorySimpleResult). */
  clear: 'factory:memory:clear',
} as const;

export const MEMORY_TARGETS = ['memory', 'user'] as const;
export type MemoryTarget = typeof MEMORY_TARGETS[number];

export const MEMORY_ACTIONS = ['add', 'replace', 'remove'] as const;
export type MemoryAction = typeof MEMORY_ACTIONS[number];

export const MEMORY_LIMITS = {
  /** A bot's notes, every entry and delimiter counted. */
  MEMORY_CHARS: 2200,
  /** The owner's profile, the same way. */
  USER_CHARS: 1400,
  /** The substring that finds an entry to replace or remove. */
  MATCH_MAX: 200,
} as const;

/** The line between two entries in a store's file. */
export const MEMORY_DELIMITER = '§';

export function memoryLimit(target: MemoryTarget): number {
  return target === 'user' ? MEMORY_LIMITS.USER_CHARS : MEMORY_LIMITS.MEMORY_CHARS;
}

export interface MemoryUpdateParams {
  target: MemoryTarget;
  action: MemoryAction;
  /** add, replace: the entry's new text. */
  text?: string;
  /** replace, remove: a substring that only one entry holds. */
  match?: string;
}

/** A change as main checked it: the entry's text for add and replace, and
 *  the entry it replaces or removes (`old`), as it read then. */
export interface MemoryChange {
  action: MemoryAction;
  text?: string;
  old?: string;
}

/** One store as the bot and the owner see it. */
export interface MemoryView {
  target: MemoryTarget;
  entries: string[];
  /** Characters in use, delimiters counted. */
  used: number;
  limit: number;
}

export type MemoryUpdateResult =
  | ({
    ok: true; action: MemoryAction; message: string; unchanged?: true;
    /** `user`: the change waits for the owner on an approval card (this
     *  one); the entries are as they stand, without it. */
    pending?: true; approvalId?: string;
  } & MemoryView)
  | {
    ok: false;
    code: 'not_bot' | 'not_started' | 'not_authorized' | 'invalid' | 'unsafe' | 'not_found' | 'ambiguous' | 'over_limit' | 'write_failed';
    message: string;
    /** over_limit, not_found, ambiguous: the store as it stands. */
    entries?: string[];
    used?: number;
    limit?: number;
  };

export interface MemoryReadRequest { botId: string; }
export type MemoryReadResult = { ok: true; memory: MemoryView; user: MemoryView } | { ok: false; error: string };

/** `index` and `text` both name the entry, so a list read before the bot
 *  changed it never removes another one. */
export interface MemoryRemoveRequest { botId: string; target: MemoryTarget; index: number; text: string; }
export interface MemoryClearRequest { botId: string; target: MemoryTarget; }
export type MemorySimpleResult = { ok: true } | { ok: false; error: string };
