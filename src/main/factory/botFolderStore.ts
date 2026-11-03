// ─── The owner's bot folders — `<wmuxDir>/factory/bot-folders.json` ─────────
//
// `{version:1, folders: BotFolder[]}` (shared/botFolder.ts), written whole.
// Only the owner's main-window IPC changes it (pipe/handlers/folder.rpc.ts);
// bots read nothing here. Every record is checked again on read: a malformed
// or duplicate one is dropped (a bad bot id drops only itself), and a bot named by two folders stays in the
// first. A file that exists but cannot be read, or carries another version,
// loads as no folders and is not written over until the owner fixes or
// removes it. Reads leave out bots that no longer exist.

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BOT_ID_RE } from '../../shared/bot';
import { BOT_FOLDER_ID_RE, BOT_FOLDER_LIMITS, normalizeFolderName, type BotFolder, type BotFolderOkResult, type BotFolderRefusal } from '../../shared/botFolder';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const BOT_FOLDERS_FILE_VERSION = 1 as const;

export function botFoldersFilePath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', 'bot-folders.json');
}

export interface BotFolderStoreOptions {
  now?: () => number;
  newId?: () => string;
  log?: (msg: string) => void;
  /** Ids of the bots that exist now (others are left out when read); null:
   *  not known yet (nothing is pruned or checked). */
  bots?: () => readonly string[] | null;
  /** Told after every change. */
  onChange?: () => void;
}

export type BotFolderStoreResult = { ok: true; folder: BotFolder } | BotFolderRefusal;

/** One record read from disk, or null when it is malformed. */
export function parseStoredFolder(raw: unknown): BotFolder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !BOT_FOLDER_ID_RE.test(r.id)) return null;
  const name = normalizeFolderName(r.name);
  if (name === null) return null;
  if (typeof r.createdAt !== 'number' || typeof r.updatedAt !== 'number') return null;
  if (!Array.isArray(r.botIds)) return null;
  // Only the bad ids are dropped: losing the whole folder over one of them
  // would become permanent with the next write.
  const botIds = r.botIds.filter((m): m is string => typeof m === 'string' && BOT_ID_RE.test(m));
  return {
    id: r.id,
    name,
    botIds: [...new Set(botIds)],
    collapsed: r.collapsed === true,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const invalid = (field: 'name' | 'bot' | 'folder', message: string): BotFolderRefusal => ({ ok: false, code: 'invalid', field, message });
const notFound: BotFolderRefusal = { ok: false, code: 'not_found', field: 'folder', message: 'That folder no longer exists.' };

export class BotFolderStore {
  private folders: BotFolder[] = [];
  private unreadable: string | null = null;
  private readonly persister: FilePersister;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (msg: string) => void;

  constructor(private readonly file: string, private readonly opts: BotFolderStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `fld-${randomBytes(4).toString('hex')}`);
    this.log = opts.log ?? ((m) => console.warn(`[factory] bot folders: ${m}`));
    this.persister = createFilePersister(file, () => ({ version: BOT_FOLDERS_FILE_VERSION, folders: this.folders }));
  }

  load(): void {
    this.folders = [];
    this.unreadable = null;
    let raw: Record<string, unknown> | null;
    try {
      raw = readVersionedFile(this.file, BOT_FOLDERS_FILE_VERSION);
    } catch (err) {
      this.unreadable = String(err);
      this.log(`${path.basename(this.file)} is unreadable or of another version; no folders are loaded and none are saved until it is fixed`);
      return;
    }
    if (!raw) return;
    const filed = new Set<string>();
    for (const entry of Array.isArray(raw.folders) ? raw.folders : []) {
      const f = parseStoredFolder(entry);
      if (!f || this.folders.some((o) => o.id === f.id)) {
        this.log('dropped a malformed or duplicate folder');
        continue;
      }
      // One folder per bot: the first one that names it keeps it.
      f.botIds = f.botIds.filter((b) => !filed.has(b));
      for (const b of f.botIds) filed.add(b);
      this.folders.push(f);
    }
  }

  /** Why nothing can be saved now, or null. */
  writeRefusal(): string | null {
    return this.unreadable ? 'The bot folders file cannot be read, so nothing is saved over it. Fix or remove factory/bot-folders.json.' : null;
  }

  /** The folders, oldest first, with the bots that exist now. */
  list(): BotFolder[] {
    return this.folders.map((f) => this.view(f));
  }

  get(id: string): BotFolder | null {
    const f = this.folders.find((x) => x.id === id);
    return f ? this.view(f) : null;
  }

  create(rawName: string): BotFolderStoreResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, code: 'store_unreadable', message: why };
    const name = normalizeFolderName(rawName);
    if (!name) return invalid('name', 'Give the folder a name.');
    if (this.folders.length >= BOT_FOLDER_LIMITS.FOLDERS_MAX) return invalid('folder', 'There are too many folders; delete one first.');
    const at = this.now();
    const f: BotFolder = { id: this.mintId(), name, botIds: [], collapsed: false, createdAt: at, updatedAt: at };
    this.folders = [...this.folders, f];
    this.changed();
    return { ok: true, folder: this.view(f) };
  }

  rename(id: string, rawName: string): BotFolderStoreResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, code: 'store_unreadable', message: why };
    const f = this.folders.find((x) => x.id === id);
    if (!f) return notFound;
    const name = normalizeFolderName(rawName);
    if (!name) return invalid('name', 'Give the folder a name.');
    return this.replace({ ...f, name, updatedAt: this.now() });
  }

  setCollapsed(id: string, collapsed: boolean): BotFolderStoreResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, code: 'store_unreadable', message: why };
    const f = this.folders.find((x) => x.id === id);
    if (!f) return notFound;
    if (f.collapsed === collapsed) return { ok: true, folder: this.view(f) };
    return this.replace({ ...f, collapsed, updatedAt: this.now() });
  }

  /** File a bot in a folder (moving it from another), or take it out of its
   *  folder with `null`. */
  assign(botId: string, folderId: string | null): BotFolderOkResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, code: 'store_unreadable', message: why };
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) return invalid('bot', 'Pick a bot.');
    if (folderId !== null && !this.folders.some((x) => x.id === folderId)) return notFound;
    const known = this.opts.bots?.() ?? null;
    if (folderId !== null && known && !known.includes(botId)) return invalid('bot', 'That bot no longer exists.');
    if (this.move([botId], folderId)) this.changed();
    return { ok: true };
  }

  /** `assign` for several bots at once: every bot and the folder are checked
   *  first, so either all of them move or none does, and the change is
   *  announced once. */
  assignMany(botIds: readonly string[], folderId: string | null): BotFolderOkResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, code: 'store_unreadable', message: why };
    if (!Array.isArray(botIds) || botIds.length === 0 || botIds.length > BOT_FOLDER_LIMITS.ASSIGN_MANY_MAX) {
      return invalid('bot', 'Pick the bots to move.');
    }
    if (!botIds.every((b) => typeof b === 'string' && BOT_ID_RE.test(b))) return invalid('bot', 'Pick a bot.');
    if (folderId !== null && !this.folders.some((x) => x.id === folderId)) return notFound;
    const known = this.opts.bots?.() ?? null;
    if (folderId !== null && known && !botIds.every((b) => known.includes(b))) return invalid('bot', 'That bot no longer exists.');
    if (this.move([...new Set(botIds)], folderId)) this.changed();
    return { ok: true };
  }

  /** Delete a folder; its bots become unfiled. The removed folder, or a
   *  refusal: `store_unreadable` (like every other write) apart from
   *  `not_found` for a folder that is gone. */
  remove(id: string): BotFolderStoreResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, code: 'store_unreadable', message: why };
    const f = this.folders.find((x) => x.id === id);
    if (!f) return notFound;
    this.folders = this.folders.filter((x) => x.id !== id);
    this.changed();
    return { ok: true, folder: this.view(f) };
  }

  /** Resolves once the current state is on disk. */
  flush(): Promise<void> {
    // An unreadable file is never written over, flush included.
    if (this.unreadable) return Promise.resolve();
    return this.persister.schedule();
  }

  /** Files `ids` in `folderId` (null: nowhere), taking each out of any other
   *  folder. True when anything changed. Does not notify. */
  private move(ids: readonly string[], folderId: string | null): boolean {
    const at = this.now();
    let touched = false;
    this.folders = this.folders.map((f) => {
      if (f.id === folderId) {
        const add = ids.filter((b) => !f.botIds.includes(b));
        if (add.length === 0) return f;
        touched = true;
        return { ...f, botIds: [...f.botIds, ...add], updatedAt: at };
      }
      if (!ids.some((b) => f.botIds.includes(b))) return f;
      touched = true;
      return { ...f, botIds: f.botIds.filter((b) => !ids.includes(b)), updatedAt: at };
    });
    return touched;
  }

  private replace(next: BotFolder): BotFolderStoreResult {
    this.folders = this.folders.map((x) => (x.id === next.id ? next : x));
    this.changed();
    return { ok: true, folder: this.view(next) };
  }

  /** A folder as readers see it: only bots that exist now. */
  private view(f: BotFolder): BotFolder {
    const known = this.opts.bots?.() ?? null;
    const set = known ? new Set(known) : null;
    return { ...f, botIds: set ? f.botIds.filter((b) => set.has(b)) : [...f.botIds] };
  }

  private mintId(): string {
    for (;;) {
      const id = this.newId();
      if (BOT_FOLDER_ID_RE.test(id) && !this.folders.some((f) => f.id === id)) return id;
    }
  }

  private changed(): void {
    void this.persister.schedule().catch((err) => this.log(`${path.basename(this.file)} not written: ${String(err)}`));
    try {
      this.opts.onChange?.();
    } catch { /* a listener never fails a store write */ }
  }
}

let current: BotFolderStore | null = null;

/** The running app's bot folders (set by the folders module), or null. */
export function getBotFolderStore(): BotFolderStore | null {
  return current;
}

export function setBotFolderStore(next: BotFolderStore | null): void {
  current = next;
}
