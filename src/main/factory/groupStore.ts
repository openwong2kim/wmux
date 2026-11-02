// ─── The owner's group chats — `<wmuxDir>/factory/groups.json` ─────────────
//
// `{version:1, groups: StoredGroup[], migrated: boolean}` (shared/botGroup.ts),
// written whole. Only the owner's main-window IPC changes it
// (pipe/handlers/group.rpc.ts); bots read nothing here — main routes an
// owner message in a group to its members (humanMessage.ts). Every record is
// checked again on read and a malformed one is dropped. A file that exists
// but cannot be read, or carries another version, loads as no groups and is
// not written over until the owner fixes or removes it.
//
// A deleted group stays as a record (`deletedAt`), hidden from every read:
// its cards stay in the room, and the room it was made from (a migrated
// `general` group) is never made into a group again. `migrated` marks the
// one-time move of workspace rooms into groups (group.rpc.ts).

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BOT_ID_RE } from '../../shared/bot';
import { BOT_GROUP_LIMITS, GROUP_ID_RE, normalizeGroupName, type BotGroup, type BotGroupRefusal } from '../../shared/botGroup';
import { GENERAL_THREAD, groupThreadGroup, groupThreadId, parseThreadId, type ThreadId } from '../../shared/room';
import { isRoomWorkspaceId } from './roomWriter';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const GROUPS_FILE_VERSION = 1 as const;

export function groupsFilePath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', 'groups.json');
}

interface StoredGroup extends BotGroup {
  deletedAt?: number;
}

/** A bot as the store needs it: where it lives and when it was made. */
export interface GroupBotRef {
  id: string;
  workspaceId: string;
  createdAt: number;
  /** On My Hermes (the owner's own Hermes): it talks with the owner one to
   *  one and joins no group. */
  ownHermes?: boolean;
  /** Its name, for the refusal that names it. */
  name?: string;
}

export interface GroupStoreOptions {
  now?: () => number;
  newId?: () => string;
  log?: (msg: string) => void;
  /** The bots that exist now (members naming another are left out when
   *  read); null: not known yet (nothing is pruned or checked). */
  bots?: () => readonly GroupBotRef[] | null;
  /** Told after every change. */
  onChange?: () => void;
}

/** Why a bot on My Hermes is not in a group chat. Pure. */
export function myHermesNoGroupMessage(bot: string): string {
  return `${bot} uses your own Hermes, so it talks with you one to one and cannot join a group chat.`;
}

export type GroupStoreResult = { ok: true; group: BotGroup } | BotGroupRefusal;

/** One record read from disk, or null when it is malformed. */
export function parseStoredGroup(raw: unknown): StoredGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !GROUP_ID_RE.test(r.id)) return null;
  if (!isRoomWorkspaceId(r.workspaceId)) return null;
  if (typeof r.createdAt !== 'number' || typeof r.updatedAt !== 'number') return null;
  const thread = parseThreadId(r.threadId);
  // Its own thread, or the room's General (a group made from the room).
  if (!thread || (thread !== GENERAL_THREAD && groupThreadGroup(thread) !== r.id)) return null;
  const name = r.name === '' ? '' : normalizeGroupName(r.name);
  if (name === null || (name === '' && thread !== GENERAL_THREAD)) return null;
  if (!Array.isArray(r.memberIds) || !r.memberIds.every((m) => typeof m === 'string' && BOT_ID_RE.test(m))) return null;
  const memberIds = [...new Set(r.memberIds as string[])].slice(0, BOT_GROUP_LIMITS.MEMBERS_MAX);
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    name,
    memberIds,
    threadId: thread,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(typeof r.deletedAt === 'number' ? { deletedAt: r.deletedAt } : {}),
  };
}

const invalid = (field: 'name' | 'members' | 'workspace', message: string): BotGroupRefusal => ({ ok: false, code: 'invalid', field, message });

export class GroupStore {
  private groups: StoredGroup[] = [];
  private migratedFlag = false;
  private unreadable: string | null = null;
  private readonly persister: FilePersister;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (msg: string) => void;

  constructor(private readonly file: string, private readonly opts: GroupStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `grp-${randomBytes(4).toString('hex')}`);
    this.log = opts.log ?? ((m) => console.warn(`[factory] groups: ${m}`));
    this.persister = createFilePersister(file, () => ({ version: GROUPS_FILE_VERSION, groups: this.groups, migrated: this.migratedFlag }));
  }

  load(): void {
    this.groups = [];
    this.migratedFlag = false;
    this.unreadable = null;
    let raw: Record<string, unknown> | null;
    try {
      raw = readVersionedFile(this.file, GROUPS_FILE_VERSION);
    } catch (err) {
      this.unreadable = String(err);
      this.log(`${path.basename(this.file)} is unreadable or of another version; no groups are loaded and none are saved until it is fixed`);
      return;
    }
    if (!raw) return;
    this.migratedFlag = raw.migrated === true;
    for (const entry of Array.isArray(raw.groups) ? raw.groups : []) {
      const g = parseStoredGroup(entry);
      if (!g || this.groups.some((o) => o.id === g.id)) {
        this.log('dropped a malformed or duplicate group');
        continue;
      }
      this.groups.push(g);
    }
  }

  /** Why nothing can be saved now, or null. */
  writeRefusal(): string | null {
    return this.unreadable ? 'The group chats file cannot be read, so nothing is saved over it. Fix or remove factory/groups.json.' : null;
  }

  /** The live groups (a workspace's, or every one), oldest first, with
   *  members that are bots of their workspace now. */
  list(workspaceId?: string): BotGroup[] {
    return this.groups
      .filter((g) => g.deletedAt === undefined && (workspaceId === undefined || g.workspaceId === workspaceId))
      .map((g) => this.view(g));
  }

  get(id: string): BotGroup | null {
    const g = this.groups.find((x) => x.id === id && x.deletedAt === undefined);
    return g ? this.view(g) : null;
  }

  /** The live group a thread of a workspace's room is, or null. */
  byThread(workspaceId: string, threadId: ThreadId | string | null | undefined): BotGroup | null {
    if (!threadId) return null;
    const g = this.groups.find((x) => x.deletedAt === undefined && x.workspaceId === workspaceId && x.threadId === threadId);
    return g ? this.view(g) : null;
  }

  /** Was the room's `general` ever a group (live or deleted)? */
  hadRoomGroup(workspaceId: string): boolean {
    return this.groups.some((g) => g.workspaceId === workspaceId && g.threadId === GENERAL_THREAD);
  }

  isMigrated(): boolean {
    return this.migratedFlag;
  }

  /** Make a group the owner named. Its members: two or more bots of the
   *  workspace. */
  create(input: { workspaceId: string; name: string; memberIds: readonly string[] }): GroupStoreResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, code: 'store_unreadable', message: why };
    if (!isRoomWorkspaceId(input.workspaceId)) return invalid('workspace', 'Pick a workspace.');
    const name = normalizeGroupName(input.name);
    if (!name) return invalid('name', 'Give the group a name.');
    const members = this.checkMembers(input.workspaceId, input.memberIds);
    if (!members.ok) return members;
    if (this.groups.length >= BOT_GROUP_LIMITS.GROUPS_MAX) return invalid('workspace', 'There are too many group chats; delete one first.');
    const id = this.mintId();
    const at = this.now();
    const g: StoredGroup = { id, workspaceId: input.workspaceId, name, memberIds: members.ids, threadId: groupThreadId(id), createdAt: at, updatedAt: at };
    this.groups = [...this.groups, g];
    this.changed();
    return { ok: true, group: this.view(g) };
  }

  /** Make a workspace's room (its `general`) a group: named after the
   *  workspace, with the bots given. Once per workspace; null when it was
   *  made before (even if deleted since) or nothing can be saved. */
  adoptRoom(workspaceId: string, memberIds: readonly string[]): BotGroup | null {
    if (this.writeRefusal() || !isRoomWorkspaceId(workspaceId) || this.hadRoomGroup(workspaceId)) return null;
    const own = new Set((this.opts.bots?.() ?? []).filter((b) => b.ownHermes === true).map((b) => b.id));
    const ids = [...new Set(memberIds.filter((m) => BOT_ID_RE.test(m) && !own.has(m)))].slice(0, BOT_GROUP_LIMITS.MEMBERS_MAX);
    // Without its My Hermes bots the room may be too small to be a group; it stays a room.
    if (ids.length < BOT_GROUP_LIMITS.MEMBERS_MIN) return null;
    const at = this.now();
    const g: StoredGroup = { id: this.mintId(), workspaceId, name: '', memberIds: ids, threadId: GENERAL_THREAD, createdAt: at, updatedAt: at };
    this.groups = [...this.groups, g];
    this.changed();
    return this.view(g);
  }

  /** The one-time move of rooms into groups is done. */
  markMigrated(): void {
    if (this.migratedFlag || this.writeRefusal()) return;
    this.migratedFlag = true;
    this.changed();
  }

  /** Rename and/or change the members. */
  update(id: string, patch: { name?: string; memberIds?: readonly string[] }): GroupStoreResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, code: 'store_unreadable', message: why };
    const g = this.groups.find((x) => x.id === id && x.deletedAt === undefined);
    if (!g) return { ok: false, code: 'not_found', message: 'That group chat no longer exists.' };
    let name = g.name;
    if (patch.name !== undefined) {
      const typed = normalizeGroupName(patch.name);
      if (!typed) return invalid('name', 'Give the group a name.');
      name = typed;
    }
    let memberIds = g.memberIds;
    if (patch.memberIds !== undefined) {
      const members = this.checkMembers(g.workspaceId, patch.memberIds);
      if (!members.ok) return members;
      memberIds = members.ids;
    }
    const next: StoredGroup = { ...g, name, memberIds, updatedAt: this.now() };
    this.groups = this.groups.map((x) => (x.id === id ? next : x));
    this.changed();
    return { ok: true, group: this.view(next) };
  }

  /** Hide a group; its cards stay in the room. The removed group, or null. */
  remove(id: string): BotGroup | null {
    if (this.writeRefusal()) return null;
    const g = this.groups.find((x) => x.id === id && x.deletedAt === undefined);
    if (!g) return null;
    const at = this.now();
    this.groups = this.groups.map((x) => (x.id === id ? { ...x, deletedAt: at, updatedAt: at } : x));
    this.changed();
    return this.view(g);
  }

  /** Resolves once the current state is on disk. */
  flush(): Promise<void> {
    return this.persister.schedule();
  }

  private checkMembers(workspaceId: string, raw: readonly string[]): { ok: true; ids: string[] } | BotGroupRefusal {
    if (!Array.isArray(raw) || !raw.every((m) => typeof m === 'string' && BOT_ID_RE.test(m))) return invalid('members', 'Pick the bots.');
    const ids = [...new Set(raw)];
    if (ids.length < BOT_GROUP_LIMITS.MEMBERS_MIN) return invalid('members', 'A group chat needs two or more bots.');
    if (ids.length > BOT_GROUP_LIMITS.MEMBERS_MAX) return invalid('members', `A group chat holds at most ${BOT_GROUP_LIMITS.MEMBERS_MAX} bots.`);
    const bots = this.opts.bots?.() ?? null;
    if (bots) {
      const here = new Set(bots.filter((b) => b.workspaceId === workspaceId).map((b) => b.id));
      if (ids.some((m) => !here.has(m))) return invalid('members', 'Every bot of a group chat is from its workspace.');
      const own = bots.find((b) => b.ownHermes === true && ids.includes(b.id));
      if (own) return invalid('members', myHermesNoGroupMessage(own.name ?? own.id));
    }
    return { ok: true, ids };
  }

  /** A group as readers see it: members that are bots of its workspace now. */
  private view(g: StoredGroup): BotGroup {
    const bots = this.opts.bots?.() ?? null;
    const here = bots ? new Set(bots.filter((b) => b.workspaceId === g.workspaceId).map((b) => b.id)) : null;
    return {
      id: g.id,
      workspaceId: g.workspaceId,
      name: g.name,
      memberIds: here ? g.memberIds.filter((m) => here.has(m)) : [...g.memberIds],
      threadId: g.threadId,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    };
  }

  private mintId(): string {
    for (;;) {
      const id = this.newId();
      if (GROUP_ID_RE.test(id) && !this.groups.some((g) => g.id === id)) return id;
    }
  }

  private changed(): void {
    void this.persister.schedule().catch((err) => this.log(`${path.basename(this.file)} not written: ${String(err)}`));
    try {
      this.opts.onChange?.();
    } catch { /* a listener never fails a store write */ }
  }
}

let current: GroupStore | null = null;

/** The running app's group chats (set by the groups module), or null. */
export function getGroupStore(): GroupStore | null {
  return current;
}

export function setGroupStore(next: GroupStore | null): void {
  current = next;
}
