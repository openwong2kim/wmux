// ─── Bot group chats — rooms the owner makes (owner decision 2026-10-15) ───
//
// Contract for main/factory/groupStore.ts, the group IPC
// (main/pipe/handlers/group.rpc.ts) and the Bots page.
//
// The owner makes a group chat: a name and the bots in it, all from one
// workspace (they share its repository and its room). Bots never make one,
// and no workspace has one by itself. A group is a thread of its workspace's
// room: its own `group:<groupId>`, or `general` for the group a workspace's
// room became when group chats arrived (it had the owner's messages; its
// name is empty and reads as the workspace's). An owner message in a group
// goes to every member, or to the members the owner picked.
//
// Groups live in `<wmuxDir>/factory/groups.json`, written by main alone (the
// main window's IPC). Deleting a group hides it; its cards stay in the room
// file, and a deleted group is kept as a record so it is never re-made.

import { GROUP_ID_RE, ROOM_LIMITS, type ThreadId } from './room';

export { GROUP_ID_RE };

export interface BotGroup {
  /** `grp-<8 hex>`. */
  id: string;
  workspaceId: string;
  /** The owner's name for it; empty: named after its workspace (a group
   *  made from a workspace's room). */
  name: string;
  /** Its bots, in the order the owner picked them; every one is a bot of
   *  `workspaceId` (a bot deleted since is left out when read). */
  memberIds: string[];
  /** The room thread it lives in: `group:<id>`, or `general` for a group
   *  made from a workspace's room. */
  threadId: ThreadId;
  createdAt: number;
  updatedAt: number;
}

export const BOT_GROUP_LIMITS = {
  NAME_MAX: 60,
  /** A group chat is two or more bots (one bot is its 1:1). */
  MEMBERS_MIN: 2,
  /** An owner message wakes at most this many bots. */
  MEMBERS_MAX: ROOM_LIMITS.MENTIONS_MAX,
  /** Groups kept, deleted ones included. */
  GROUPS_MAX: 500,
} as const;

export const BOT_GROUP_IPC = {
  list: 'factory:group:list',
  create: 'factory:group:create',
  update: 'factory:group:update',
  remove: 'factory:group:remove',
} as const;

export interface BotGroupCreateRequest {
  workspaceId: string;
  name: string;
  memberIds: string[];
}

/** Rename and/or change the members; a field left out is kept. */
export interface BotGroupUpdateRequest {
  id: string;
  name?: string;
  memberIds?: string[];
}

export type BotGroupRefusalCode = 'invalid' | 'not_found' | 'not_started' | 'store_unreadable' | 'not_authorized' | 'error';

export type BotGroupRefusal = { ok: false; code: BotGroupRefusalCode; field?: 'name' | 'members' | 'workspace'; message: string };

export type BotGroupResult = { ok: true; group: BotGroup } | BotGroupRefusal;
export type BotGroupListResult = { ok: true; groups: BotGroup[] } | BotGroupRefusal;
export type BotGroupRemoveResult = { ok: true } | BotGroupRefusal;

/** A group name as typed: one line, trimmed, at most NAME_MAX; null when
 *  nothing is left. Pure. */
export function normalizeGroupName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return name.length > BOT_GROUP_LIMITS.NAME_MAX ? name.slice(0, BOT_GROUP_LIMITS.NAME_MAX).trimEnd() : name;
}
