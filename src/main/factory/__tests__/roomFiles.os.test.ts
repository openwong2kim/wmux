import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOM_FILE_RETAIN_MS, RoomFileStore, isWin32UnsafeName, namesWin32Stream, parseRoomFiles, roomFileMediaType, roomFileName, strictlyInside } from '../roomFiles';
import { RoomWriter, setGuestTurnProbe } from '../roomWriter';
import { botFileRoots, handleRoomPost, type BotFileRoots, type RoomHandlerDeps } from '../../pipe/handlers/room.rpc';
import { TaskFolders, setTaskFolderPorts, type TaskFolderPorts, type TaskMission } from '../taskFolderCleanup';
import type { LedgerEntry } from '../../../shared/ledger';
import { ROOM_FILE_LIMITS, type RoomFile } from '../../../shared/roomFiles';
import type { BotBinding, BotProfile } from '../../../shared/bot';
import type { RoomCard } from '../../../shared/room';
import type { RpcContext } from '../../../shared/rpc';

const WS = 'ws-files-1';
const BOT_ID = 'bot-0a1b2c3d';

let dir = '';
let now = 0;
let store: RoomFileStore;
/** The allowed root (a bot's repository) and a folder outside it. */
const repo = () => path.join(dir, 'repo');
const outside = () => path.join(dir, 'elsewhere');
const storeRoot = () => path.join(dir, 'factory', 'room-files');
const write = (file: string, data: string | Buffer = 'hello\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const stored = () => (fs.existsSync(path.join(storeRoot(), WS)) ? fs.readdirSync(path.join(storeRoot(), WS)) : []);

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-room-files-')));
  fs.mkdirSync(repo(), { recursive: true });
  fs.mkdirSync(outside(), { recursive: true });
  now = Date.now();
  store = new RoomFileStore({ root: storeRoot(), now: () => now, log: () => undefined });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('room file rules', () => {
  it('types a file by its extension and keeps only its last path segment as the name', () => {
    expect(roomFileMediaType('report.md')).toBe('text/markdown');
    expect(roomFileMediaType('a.JSON')).toBe('application/json');
    expect(roomFileMediaType('pic.jpeg')).toBe('image/jpeg');
    expect(roomFileMediaType('x.svg')).toBe('image/svg+xml');
    expect(roomFileMediaType('main.ts')).toBe('text/plain');
    expect(roomFileMediaType('change.patch')).toBe('text/x-diff');
    expect(roomFileMediaType('blob.bin')).toBe('application/octet-stream');
    expect(roomFileMediaType('Makefile')).toBe('application/octet-stream');
    expect(roomFileName('/a/b/report.md')).toBe('report.md');
    expect(roomFileName('C:\\a\\b\\x\u0007y.txt')).toBe('xy.txt');
    const long = roomFileName(`/a/${'n'.repeat(300)}.md`);
    expect(long).toHaveLength(ROOM_FILE_LIMITS.NAME_MAX);
    expect(long.endsWith('.md')).toBe(true);
  });

  it('parses stored lists strictly', () => {
    const id = 'a'.repeat(32);
    const ok = { id, name: 'r.md', mediaType: 'text/markdown', bytes: 3 };
    expect(parseRoomFiles([{ ...ok, extra: 1 }])).toEqual([ok]);
    expect(parseRoomFiles([{ ...ok, id: '../x' }])).toBeUndefined();
    expect(parseRoomFiles([{ ...ok, name: 'a/b.md' }])).toBeUndefined();
    expect(parseRoomFiles([{ ...ok, mediaType: 'text/javascript+evil' }])).toBeUndefined();
    expect(parseRoomFiles([{ ...ok, bytes: 0 }])).toBeUndefined();
    expect(parseRoomFiles([ok, ok])).toHaveLength(1);
    const many = Array.from({ length: 12 }, (_, i) => ({ ...ok, id: i.toString(16).repeat(32).slice(0, 32) }));
    expect(parseRoomFiles(many)).toHaveLength(ROOM_FILE_LIMITS.PER_CARD);
  });

  it('makes a name Windows saves as itself: no reserved character, trailing dot or space, or device name', () => {
    expect(roomFileName('C:\\r\\README.md:hidden')).toBe('README.md_hidden');
    expect(roomFileName('/r/a<b>|c?"d*.txt')).toBe('a_b__c__d_.txt');
    expect(roomFileName('/r/notes.md. . ')).toBe('notes.md');
    expect(roomFileName('/r/CON.txt')).toBe('_CON.txt');
    expect(roomFileName('/r/nul')).toBe('_nul');
    expect(roomFileName('/r/lpt1')).toBe('_lpt1');
    expect(roomFileName('/r/console.txt')).toBe('console.txt');
    // A cut to NAME_MAX that ends in a dot, and a long device-like name, stay
    // names a stored list keeps.
    for (const source of [`/r/${'a'.repeat(199)}.${'b'.repeat(20)}`, `/r/con.${'x'.repeat(250)}`, `/r/${'a'.repeat(198)} .${'b'.repeat(20)}`]) {
      const name = roomFileName(source);
      expect(name.length).toBeLessThanOrEqual(ROOM_FILE_LIMITS.NAME_MAX);
      expect(isWin32UnsafeName(name)).toBe(false);
      expect(parseRoomFiles([{ id: 'c'.repeat(32), name, mediaType: 'application/octet-stream', bytes: 1 }])).toHaveLength(1);
    }
    for (const name of ['README.md_hidden', '_CON.txt', 'console.txt', 'a.b.md']) expect(isWin32UnsafeName(name)).toBe(false);
    for (const name of ['a:b.md', 'x.md.', 'x.md ', 'CON', 'aux.txt', 'COM1.log', 'a?b', 'a|b']) expect(isWin32UnsafeName(name)).toBe(true);
  });

  it('drops a stored name Windows would not save as itself', () => {
    const ok = { id: 'b'.repeat(32), name: 'r.md', mediaType: 'text/markdown', bytes: 3 };
    for (const name of ['README.md:hidden', 'x.md.', 'CON', 'aux.txt', 'a<b.md']) expect(parseRoomFiles([{ ...ok, name }])).toBeUndefined();
    expect(parseRoomFiles([{ ...ok, name: 'README.md_hidden' }])).toEqual([{ ...ok, name: 'README.md_hidden' }]);
  });

  it('tells a Windows path to a data stream from a path to a file', () => {
    expect(namesWin32Stream('D:\\r\\a.txt:s')).toBe(true);
    expect(namesWin32Stream('D:\\r\\a.txt::$DATA')).toBe(true);
    expect(namesWin32Stream('\\\\?\\D:\\r\\a.txt:s')).toBe(true);
    expect(namesWin32Stream('D:\\r\\a.txt')).toBe(false);
    expect(namesWin32Stream('\\\\?\\D:\\r\\a.txt')).toBe(false);
    expect(namesWin32Stream('\\\\?\\UNC\\srv\\share\\a.txt')).toBe(false);
    expect(namesWin32Stream('\\\\wsl.localhost\\distro\\root\\a.md')).toBe(false);
  });

  it('on Windows, a real path is inside a root only when it starts with the root in its exact case', () => {
    expect(strictlyInside('C:\\w\\repo', 'C:\\w\\repo\\docs\\a.md', 'win32')).toBe('docs\\a.md');
    // A sibling that differs only in case (a case-sensitive folder) is another folder.
    expect(strictlyInside('C:\\w\\repo', 'C:\\w\\REPO\\a.md', 'win32')).toBeNull();
    expect(strictlyInside('C:\\w\\repo', 'C:\\w\\repo2\\a.md', 'win32')).toBeNull();
    expect(strictlyInside('C:\\', 'C:\\a.md', 'win32')).toBe('a.md');
    expect(strictlyInside('\\\\wsl.localhost\\d\\root\\repo', '\\\\wsl.localhost\\d\\root\\repo\\a.md', 'win32')).toBe('a.md');
    expect(strictlyInside('/w/repo', '/w/repo/a.md', 'linux')).toBe('a.md');
    expect(strictlyInside('/w/repo', '/w/REPO/a.md', 'linux')).toBeNull();
  });
});

describe('RoomFileStore.copyIn', () => {
  it('copies a regular file inside an allowed root, 0600 in a 0700 folder', () => {
    const src = write(path.join(repo(), 'docs', 'report.md'), '# Report\n');
    const r = store.copyIn(WS, src, [repo()]);
    expect(r).toMatchObject({ ok: true, file: { name: 'report.md', mediaType: 'text/markdown', bytes: 9 } });
    if (!r.ok) return;
    expect(store.read(WS, r.file.id)?.toString()).toBe('# Report\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(store.file(WS, r.file.id)!).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(storeRoot(), WS)).mode & 0o777).toBe(0o700);
    }
  });

  it('refuses a file outside every root, a `..` escape, and a root that is not there', () => {
    const out = write(path.join(outside(), 'secret.txt'));
    expect(store.copyIn(WS, out, [repo()])).toMatchObject({ ok: false, reason: 'outside' });
    expect(store.copyIn(WS, path.join(repo(), '..', 'elsewhere', 'secret.txt'), [repo()])).toMatchObject({ ok: false, reason: 'outside' });
    expect(store.copyIn(WS, out, [path.join(dir, 'missing-root')])).toMatchObject({ ok: false, reason: 'outside' });
    // The root itself is not a file inside it.
    expect(store.copyIn(WS, repo(), [repo()])).toMatchObject({ ok: false, reason: 'outside' });
    expect(store.copyIn(WS, 'relative.txt', [repo()])).toMatchObject({ ok: false, reason: 'missing' });
    expect(stored()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses a link, whether it points out of the root or inside it', () => {
    const out = write(path.join(outside(), 'secret.txt'));
    fs.symlinkSync(out, path.join(repo(), 'out-link.txt'));
    expect(store.copyIn(WS, path.join(repo(), 'out-link.txt'), [repo()])).toMatchObject({ ok: false, reason: 'outside' });
    const inside = write(path.join(repo(), 'real.txt'));
    fs.symlinkSync(inside, path.join(repo(), 'in-link.txt'));
    expect(store.copyIn(WS, path.join(repo(), 'in-link.txt'), [repo()])).toMatchObject({ ok: false, reason: 'not_file' });
    // A linked folder that leads out of the root.
    fs.symlinkSync(outside(), path.join(repo(), 'linked-dir'));
    expect(store.copyIn(WS, path.join(repo(), 'linked-dir', 'secret.txt'), [repo()])).toMatchObject({ ok: false, reason: 'outside' });
    // A linked folder that stays inside the root is refused too.
    write(path.join(repo(), 'deep', 'card.png'));
    fs.symlinkSync(path.join(repo(), 'deep'), path.join(repo(), 'in-dir'));
    expect(store.copyIn(WS, path.join(repo(), 'in-dir', 'card.png'), [repo()])).toMatchObject({ ok: false, reason: 'linked_folder' });
    expect(stored()).toEqual([]);
    // The same file by its own path is taken.
    expect(store.copyIn(WS, path.join(repo(), 'deep', 'card.png'), [repo()]).ok).toBe(true);
  });

  it('refuses a file with more than one name, whether the other name is outside the root or inside it', () => {
    const out = write(path.join(outside(), 'secret.txt'), 'outside\n');
    fs.linkSync(out, path.join(repo(), 'linked.txt'));
    expect(store.copyIn(WS, path.join(repo(), 'linked.txt'), [repo()])).toMatchObject({ ok: false, reason: 'links' });
    const inside = write(path.join(repo(), 'a.txt'));
    fs.linkSync(inside, path.join(repo(), 'b.txt'));
    expect(store.copyIn(WS, inside, [repo()])).toMatchObject({ ok: false, reason: 'links' });
    expect(stored()).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('refuses a path that names a data stream of a file in the root', () => {
    const file = write(path.join(repo(), 'README.md'), '# Readme\n');
    fs.writeFileSync(`${file}:hidden`, 'stream\n');
    expect(store.copyIn(WS, `${file}:hidden`, [repo()])).toMatchObject({ ok: false, reason: 'stream' });
    expect(store.copyIn(WS, `${file}::$DATA`, [repo()])).toMatchObject({ ok: false, reason: 'stream' });
    expect(store.copyIn(WS, file, [repo()])).toMatchObject({ ok: true, file: { name: 'README.md' } });
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking on it', async () => {
    const { execFileSync } = await import('node:child_process');
    const fifo = path.join(repo(), 'pipe.txt');
    execFileSync('mkfifo', [fifo]);
    expect(store.copyIn(WS, fifo, [repo()])).toMatchObject({ ok: false, reason: 'not_file' });
  });

  it('refuses a folder, a missing file, an empty file, an oversized file and a protected file', () => {
    fs.mkdirSync(path.join(repo(), 'sub'));
    expect(store.copyIn(WS, path.join(repo(), 'sub'), [repo()])).toMatchObject({ ok: false, reason: 'not_file' });
    expect(store.copyIn(WS, path.join(repo(), 'nope.md'), [repo()])).toMatchObject({ ok: false, reason: 'missing' });
    expect(store.copyIn(WS, write(path.join(repo(), 'empty.txt'), ''), [repo()])).toMatchObject({ ok: false, reason: 'empty' });
    const big = path.join(repo(), 'big.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, ROOM_FILE_LIMITS.MAX_BYTES + 1);
    expect(store.copyIn(WS, big, [repo()])).toMatchObject({ ok: false, reason: 'size' });
    expect(store.copyIn(WS, write(path.join(repo(), '.env'), 'TOKEN=x'), [repo()])).toMatchObject({ ok: false, reason: 'protected' });
    expect(store.copyIn(WS, write(path.join(repo(), '.git', 'config'), 'x'), [repo()])).toMatchObject({ ok: false, reason: 'protected' });
    expect(stored()).toEqual([]);
  });

  it('refuses once the room holds its file count or its bytes, and evicts nothing', () => {
    const src = write(path.join(repo(), 'a.txt'));
    const wsDir = path.join(storeRoot(), WS);
    fs.mkdirSync(wsDir, { recursive: true });
    for (let i = 0; i < ROOM_FILE_LIMITS.ROOM_MAX_FILES; i++) fs.writeFileSync(path.join(wsDir, i.toString(16).padStart(32, '0')), '');
    expect(store.copyIn(WS, src, [repo()])).toMatchObject({ ok: false, reason: 'full' });
    expect(stored()).toHaveLength(ROOM_FILE_LIMITS.ROOM_MAX_FILES);
    const other = new RoomFileStore({ root: storeRoot(), now: () => now, log: () => undefined });
    const ws2 = path.join(storeRoot(), 'ws-files-2');
    fs.mkdirSync(ws2, { recursive: true });
    const huge = path.join(ws2, 'f'.repeat(32));
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, ROOM_FILE_LIMITS.ROOM_MAX_BYTES);
    expect(other.copyIn('ws-files-2', src, [repo()])).toMatchObject({ ok: false, reason: 'full' });
  });

  it('keeps each room tally across copies and removals without measuring the store again', () => {
    const wsDir = path.join(storeRoot(), WS);
    fs.mkdirSync(wsDir, { recursive: true });
    for (let i = 0; i < ROOM_FILE_LIMITS.ROOM_MAX_FILES - 2; i++) fs.writeFileSync(path.join(wsDir, i.toString(16).padStart(32, '0')), '');
    const a = store.copyIn(WS, write(path.join(repo(), 'a.txt')), [repo()]);
    const b = store.copyIn(WS, write(path.join(repo(), 'b.txt')), [repo()]);
    if (!a.ok || !b.ok) throw new Error('copy failed');
    expect(store.copyIn(WS, write(path.join(repo(), 'c.txt')), [repo()])).toMatchObject({ ok: false, reason: 'full' });
    store.remove(WS, [a.file.id]);
    expect(store.copyIn(WS, write(path.join(repo(), 'd.txt')), [repo()])).toMatchObject({ ok: true });
    expect(stored()).toHaveLength(ROOM_FILE_LIMITS.ROOM_MAX_FILES);
  });

  it('sweeps old stored files no kept card lists, and stray temporary files; none while the cards are unreadable', () => {
    let referenced: ReadonlySet<string> | null = null;
    const swept = new RoomFileStore({ root: storeRoot(), now: () => now, log: () => undefined, referenced: () => referenced });
    const fresh = swept.copyIn(WS, write(path.join(repo(), 'fresh.txt')), [repo()]);
    const old = swept.copyIn(WS, write(path.join(repo(), 'old.txt')), [repo()]);
    const openCard = swept.copyIn(WS, write(path.join(repo(), 'open.txt')), [repo()]);
    if (!fresh.ok || !old.ok || !openCard.ok) throw new Error('copy failed');
    const wsDir = path.join(storeRoot(), WS);
    const past = (ms: number) => new Date(now - ms);
    for (const id of [old.file.id, openCard.file.id]) fs.utimesSync(path.join(wsDir, id), past(ROOM_FILE_RETAIN_MS + 1000), past(ROOM_FILE_RETAIN_MS + 1000));
    const temp = path.join(wsDir, `${'c'.repeat(32)}.tmp`);
    fs.writeFileSync(temp, 'x');
    fs.utimesSync(temp, past(2 * 3600_000), past(2 * 3600_000));
    fs.writeFileSync(path.join(wsDir, 'not-ours'), 'x');
    fs.utimesSync(path.join(wsDir, 'not-ours'), past(ROOM_FILE_RETAIN_MS + 1000), past(ROOM_FILE_RETAIN_MS + 1000));
    // The rooms are not readable: only the temporary file goes.
    swept.sweep();
    expect(stored().sort()).toEqual([fresh.file.id, old.file.id, openCard.file.id, 'not-ours'].sort());
    // An open card still lists one old file: it stays.
    referenced = new Set([openCard.file.id]);
    swept.sweep();
    expect(stored().sort()).toEqual([fresh.file.id, openCard.file.id, 'not-ours'].sort());
  });
});

// ── room_post `files` ──────────────────────────────────────────────────────

const binding: BotBinding = { workspaceId: WS, botId: BOT_ID, role: 'lead' } as BotBinding;
const AS_BOT: RpcContext = { origin: 'local', bot: binding };
const OPERATOR: RpcContext = { origin: 'local', operator: true };

function postSetup(roots: BotFileRoots = { roots: [repo()], base: repo() }) {
  const roomsDir = path.join(dir, 'factory', 'rooms');
  const writer = new RoomWriter({ dir: roomsDir, log: () => undefined });
  const profile = { id: BOT_ID, workspaceId: WS, role: 'lead', enabled: true } as unknown as BotProfile;
  const deps: RoomHandlerDeps = {
    writer: () => writer,
    ports: () => ({ bots: { get: (id: string) => (id === BOT_ID ? profile : null), listEnabled: () => [profile] } }),
    wmuxDir: () => dir,
    files: () => store,
    fileRoots: async () => roots,
    signedIn: () => false,
  };
  return { writer, deps, roomsDir };
}

describe('room_post files', () => {
  it('a bot attaches files by absolute or repository-relative path; the card keeps them across a reload', async () => {
    const s = postSetup();
    write(path.join(repo(), 'out', 'spec.md'), '# Spec\n');
    const diff = write(path.join(repo(), 'change.diff'), 'diff --git\n');
    const r = await handleRoomPost({ kind: 'status', title: 'Done', clientPostId: 'p-1', files: ['out/spec.md', diff] }, AS_BOT, s.deps) as { ok: true; card: RoomCard };
    expect(r.ok).toBe(true);
    expect(r.card.files?.map((f) => [f.name, f.mediaType])).toEqual([['spec.md', 'text/markdown'], ['change.diff', 'text/x-diff']]);
    expect(stored().sort()).toEqual(r.card.files!.map((f) => f.id).sort());
    expect(JSON.stringify(r.card)).not.toContain(repo());
    const reloaded = new RoomWriter({ dir: s.roomsDir, log: () => undefined });
    expect(reloaded.get(WS, r.card.id)?.files).toEqual(r.card.files);
    // A repeat of the post keeps that card's files and copies nothing.
    const again = await handleRoomPost({ kind: 'status', title: 'Done', clientPostId: 'p-1', files: ['out/spec.md'] }, AS_BOT, s.deps) as { ok: true; card: RoomCard; duplicate?: true };
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(again.card.files).toEqual(r.card.files);
    expect(stored()).toHaveLength(2);
  });

  it('a wake not known clean attaches no files; a clean post keeps its provenance when a guest wake starts while its files are copied', async () => {
    let guestWake = true;
    setGuestTurnProbe(() => guestWake);
    try {
      const s = postSetup();
      write(path.join(repo(), 'out', 'notes.md'), '# Notes\n');
      const roots = vi.fn(async () => ({ roots: [repo()], base: repo() }));
      expect(await handleRoomPost({ kind: 'status', title: 'Notes', clientPostId: 'p-g', files: ['out/notes.md'] }, AS_BOT, { ...s.deps, fileRoots: roots }))
        .toMatchObject({ ok: false, code: 'not_now', message: expect.stringContaining('external guest') });
      expect(roots).not.toHaveBeenCalled();
      guestWake = false;
      const deps: RoomHandlerDeps = { ...s.deps, fileRoots: async () => { guestWake = true; return { roots: [repo()], base: repo() }; } };
      const r = await handleRoomPost({ kind: 'status', title: 'Notes', clientPostId: 'p-c', files: ['out/notes.md'] }, AS_BOT, deps) as { ok: true; card: RoomCard };
      expect(r.card).not.toHaveProperty('origin');
      expect(s.writer.read(WS).cards.map((c) => c.id)).toEqual([r.card.id]);
    } finally {
      setGuestTurnProbe(null);
    }
  });

  it.skipIf(process.platform === 'win32')('a task folder turned into a link after it was listed is no root at the copy', async () => {
    const task = path.join(dir, 'worktrees', 'h1', 'task-1');
    fs.mkdirSync(task, { recursive: true });
    write(path.join(outside(), 'x.md'));
    const s = postSetup({ roots: [], owned: [{ dir: task, parent: path.join(dir, 'worktrees') }] });
    write(path.join(task, 'ok.md'));
    expect(await handleRoomPost({ kind: 'status', title: 'A', files: [path.join(task, 'ok.md')] }, AS_BOT, s.deps)).toMatchObject({ ok: true });
    fs.rmSync(task, { recursive: true });
    fs.symlinkSync(outside(), task);
    expect(await handleRoomPost({ kind: 'status', title: 'B', files: [path.join(task, 'x.md')] }, AS_BOT, s.deps)).toMatchObject({ ok: false, code: 'file' });
  });

  it('one file that cannot be taken refuses the whole post, naming it, and leaves no copy', async () => {
    const s = postSetup();
    write(path.join(repo(), 'good.md'));
    const bad = write(path.join(outside(), 'x.md'));
    const r = await handleRoomPost({ kind: 'status', title: 'Done', files: ['good.md', bad] }, AS_BOT, s.deps) as { ok: false; code: string; message: string };
    expect(r).toMatchObject({ ok: false, code: 'file' });
    expect(r.message).toContain('files[1]');
    expect(r.message).toContain('not inside your repository');
    expect(stored()).toEqual([]);
    expect(s.writer.read(WS).cards).toEqual([]);
  });

  it('refuses more files than a card carries, a malformed list, and a relative path with no repository', async () => {
    const s = postSetup({ roots: [repo()] });
    const many = Array.from({ length: ROOM_FILE_LIMITS.PER_CARD + 1 }, (_, i) => write(path.join(repo(), `f${i}.txt`)));
    expect(await handleRoomPost({ kind: 'status', title: 'T', files: many }, AS_BOT, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handleRoomPost({ kind: 'status', title: 'T', files: 'a.md' }, AS_BOT, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handleRoomPost({ kind: 'status', title: 'T', files: [''] }, AS_BOT, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    const rel = await handleRoomPost({ kind: 'status', title: 'T', files: ['f0.txt'] }, AS_BOT, s.deps) as { message: string };
    expect(rel).toMatchObject({ ok: false, code: 'file' });
    expect(rel.message).toContain('absolute path');
    expect(stored()).toEqual([]);
  });

  it("lists a room's card files for the sweep, and none at all when the room's file cannot be read", async () => {
    const s = postSetup();
    write(path.join(repo(), 'a.md'));
    const r = await handleRoomPost({ kind: 'status', title: 'A', files: ['a.md'] }, AS_BOT, s.deps) as { ok: true; card: RoomCard };
    expect([...(s.writer.fileIds(WS) ?? [])]).toEqual([r.card.files![0].id]);
    fs.mkdirSync(path.join(s.roomsDir, 'ws-unreadable.jsonl'), { recursive: true });
    expect(s.writer.fileIds('ws-unreadable')).toBeNull();
  });

  it('the owner may not attach files, and a card written with files by anyone but a bot keeps none', async () => {
    const s = postSetup();
    write(path.join(repo(), 'a.md'));
    expect(await handleRoomPost({ workspaceId: WS, title: 'hi', files: [path.join(repo(), 'a.md')] }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    const forged: RoomFile[] = [{ id: 'd'.repeat(32), name: 'x.md', mediaType: 'text/markdown', bytes: 1 }];
    const human = s.writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: 'hi', files: forged });
    expect(human.ok && human.card.files).toBeFalsy();
    expect(stored()).toEqual([]);
  });
});

// ── Where a bot's files may come from ──────────────────────────────────────

describe('botFileRoots', () => {
  afterEach(() => setTaskFolderPorts(null));

  const worktrees = () => path.join(dir, 'worktrees');
  const row = (id: string, botId: string, owner = 'ws-owner'): LedgerEntry => ({ id, ownerWorkspaceId: owner, dispatch: { origin: { kind: 'bot', botId } } } as unknown as LedgerEntry);
  function ports(rows: LedgerEntry[], missions: Map<string, TaskMission> | null) {
    setTaskFolderPorts({
      store: new TaskFolders(path.join(dir, 'task-folders.json')),
      roots: { worktrees: worktrees(), wmuxDir: dir },
      missions: async () => missions,
      allRows: () => rows,
    } as unknown as TaskFolderPorts & { allRows: () => LedgerEntry[] });
  }
  const deps = (repoPath?: string) => ({
    ports: () => ({ bots: { get: () => ({ id: BOT_ID, repo: repoPath ? { repoKey: 'h/o/r', repoPath } : undefined } as unknown as BotProfile), listEnabled: () => [] } }),
    wmuxDir: () => dir,
  });

  it("holds the bot's repository, its own folder and its own tasks' worktrees, and no one else's", async () => {
    const mine = path.join(worktrees(), 'h1', 'task-mine');
    const theirs = path.join(worktrees(), 'h1', 'task-theirs');
    const detached = path.join(worktrees(), 'h1', 'task-detached');
    for (const d of [mine, theirs, detached, path.join(dir, 'factory', 'bots', BOT_ID)]) fs.mkdirSync(d, { recursive: true });
    ports(
      [row('task-mine', BOT_ID), row('task-theirs', 'bot-99999999'), row('task-detached', BOT_ID)],
      new Map([['task-mine', { folder: mine }], ['task-theirs', { folder: theirs }], ['task-detached', { folder: detached, detached: true }]]),
    );
    const r = await botFileRoots(binding, deps(repo()));
    expect(r.roots).toEqual([repo()]);
    expect(r.owned?.map((o) => o.dir).sort()).toEqual([path.join(dir, 'factory', 'bots', BOT_ID), mine].sort());
    expect(r.base).toBe(repo());
    expect(r.tasksUnread).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('leaves out a task folder or bot folder that is a link, and says when the tasks could not be listed', async () => {
    const linked = path.join(worktrees(), 'h1', 'task-link');
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(outside(), linked);
    fs.mkdirSync(path.join(dir, 'factory', 'bots'), { recursive: true });
    fs.symlinkSync(outside(), path.join(dir, 'factory', 'bots', BOT_ID));
    ports([row('task-link', BOT_ID)], new Map([['task-link', { folder: linked }]]));
    expect(await botFileRoots(binding, deps())).toEqual({ roots: [] });
    ports([row('task-link', BOT_ID)], null);
    expect(await botFileRoots(binding, deps())).toEqual({ roots: [], tasksUnread: true });
  });
});
