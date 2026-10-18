// Agent factory rooms — the renderer's side (the room dock and the HQ room).
//
// The room RPC handlers (pipe/handlers/room.rpc.ts) are the gate; this file
// reaches them through the renderer's operator bridge into the RpcRouter
// (the same `invokeRendererRpc` rpc:invoke uses), so it adds no authority of
// its own. Only the main window's own webContents is served: any other
// sender is refused before anything is dispatched.
//
// Pushes: the rooms module already sends ROOM_EVENT (shared/room.ts) to the
// main window for every card it writes or changes; nothing here re-sends.
//
// ROOM_STATUS tells the renderer whether rooms run and whether the factory is
// on (the dock gate). The factory's settings belong to the bot runtime
// (factory/settings.json): `liveFactoryState` reads the runtime's live
// settings, and the file (leniently: missing or malformed = off) only until
// the runtime has started.
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, OpenDialogOptions } from 'electron';
import { isMainWindowSender } from '../mainWindowSender';
import { dialog, ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import type { BotProfile, BotRole, RemovedBot } from '../../../shared/bot';
import { getBotStore } from '../../factory/botStore';
import type { RoomCard } from '../../../shared/room';
import { wrapHandler } from '../wrapHandler';
import { getWmuxDir } from '../../../daemon/config';
import { ROOM_RPC } from '../../../shared/room';
import { getRoomWriter, isRoomWorkspaceId, type RoomWriter } from '../../factory/roomWriter';
import { loadWorkspaceDecisions, type WorkspaceDecision } from '../../deck/deckDecisionStore';
import { getFactorySettingsStore } from '../../factory/factorySettings';
import { getRoomAttachmentStore, type RoomAttachmentStore } from '../../factory/roomAttachments';
import { ROOM_ATTACHMENT_ID_RE, ROOM_ATTACHMENT_LIMITS, type RoomAttachment } from '../../../shared/roomAttachments';
import { resolveAccessiblePath } from './fs.handler';

/** What the dock needs to know about the factory. */
export interface RoomFactoryState {
  /** The factory is switched on (Settings › Factory). */
  enabled: boolean;
  /** Always null: no workspace is special any more (owner decision,
   *  2026-10-14). Kept so an older renderer reading it sees "no HQ". */
  hqWorkspaceId: string | null;
}

/** ROOM_STATUS answer. */
export interface RoomStatus extends RoomFactoryState {
  /** The rooms module has started (cards can be read and posted). */
  running: boolean;
}

/** Dispatch one RPC as the renderer operator (main/index.ts invokeRendererRpc). */
export type RendererRpcInvoke = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface RoomIpcPorts {
  /** Absent: every room call answers `not_wired`. */
  invoke?: RendererRpcInvoke;
  factoryState?: () => RoomFactoryState;
  writer?: () => RoomWriter | null;
  wmuxDir?: () => string;
  /** The decision a question card is backed by. */
  decisions?: (workspaceId: string) => WorkspaceDecision[];
  /** Every bot profile (the bot store), for naming card authors. */
  bots?: () => readonly Pick<BotProfile, 'id' | 'role' | 'name'>[];
  /** The removed bots' tombstones (botStore.ts listRemoved). */
  removedBots?: () => readonly RemovedBot[];
  /** The room's photo store (roomAttachments.ts). */
  attachments?: () => RoomAttachmentStore | null;
  /** Turn a picked path into a readable real path, or null (fs.handler). */
  resolvePath?: (file: string) => Promise<string | null>;
  /** The composer's photo picker. */
  pickFiles?: () => Promise<string[] | null>;
}

/** A bot as a card author. A removed one (`removed`) keeps its name, its
 *  picture, its colour slot and its workspace (where its 1:1 lives), from
 *  its tombstone. */
export interface RoomActor { role: BotRole; name: string; removed?: true; avatar?: string; hue?: number; workspaceId?: string }

/** A refused room call (the handlers' typed refusal). */
export interface RoomRefusal { ok: false; code: string; message: string }

/** ROOM_POST answer: the card, and for a new human card the bot it was
 *  addressed to (null: no enabled bot to wake) and the wake it queued. */
export type RoomPostResponse =
  | {
      ok: true; card: RoomCard; duplicate?: true; addressee?: { botId: string; role: BotRole } | null; wakeId?: string;
      /** Every bot the message is for, and its wake (humanMessage.ts). */
      addressees?: Array<{ botId: string; role: BotRole; wakeId?: string }>;
    }
  | RoomRefusal;

const OFF: RoomFactoryState = { enabled: false, hqWorkspaceId: null };

/** `enabled` from `<wmuxDir>/factory/settings.json` (version 1); anything
 *  unreadable reads as off. The file's hqWorkspaceId is not used. */
export function readFactoryStateFile(wmuxDir: string): RoomFactoryState {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(wmuxDir, 'factory', 'settings.json'), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return OFF;
    const r = raw as Record<string, unknown>;
    if (r.version !== 1) return OFF;
    return { enabled: r.enabled === true, hqWorkspaceId: null };
  } catch {
    return OFF;
  }
}

/** The dock gate from the bot runtime's live settings; the file until the
 *  runtime has started. */
export function liveFactoryState(wmuxDir: () => string = getWmuxDir): RoomFactoryState {
  const store = getFactorySettingsStore();
  if (!store) return readFactoryStateFile(wmuxDir());
  const s = store.get();
  return { enabled: s.enabled, hqWorkspaceId: null };
}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export { isMainWindowSender };

const NOT_OPERATOR = { ok: false, code: 'operator_only', message: 'only the main window may act on rooms' } as const;

/** The handler's answer out of the router's envelope. */
export function unwrapRpc(resp: unknown): unknown {
  const r = obj(resp);
  if (r.ok === true && 'result' in r) return r.result;
  return { ok: false, code: 'rpc_error', message: typeof r.error === 'string' ? r.error : 'the room call failed' };
}

export function registerRoomIpcHandlers(getWindow: () => BrowserWindow | null, ports: RoomIpcPorts = {}): () => void {
  const writer = ports.writer ?? getRoomWriter;
  const wmuxDir = ports.wmuxDir ?? getWmuxDir;
  const factoryState = ports.factoryState ?? (() => readFactoryStateFile(wmuxDir()));
  const decisions = ports.decisions ?? ((ws: string) => loadWorkspaceDecisions(ws, wmuxDir()));
  const call = async (method: string, raw: unknown): Promise<unknown> => {
    if (!ports.invoke) return { ok: false, code: 'not_wired', message: 'the room bridge is not wired' };
    return unwrapRpc(await ports.invoke(method, obj(raw)));
  };
  const bots = ports.bots ?? (() => getBotStore()?.list() ?? []);
  const removedBots = ports.removedBots ?? (() => getBotStore()?.listRemoved() ?? []);
  const channels = [IPC.ROOM_STATUS, IPC.ROOM_READ, IPC.ROOM_THREADS, IPC.ROOM_POST, IPC.ROOM_RESOLVE, IPC.ROOM_DECISION, IPC.ROOM_ACTORS, IPC.ROOM_ATTACHMENT, IPC.ROOM_PICK_ATTACHMENTS];
  for (const c of channels) ipcMain.removeHandler(c);

  // Every channel acts with the operator's authority, so every one checks
  // the sender first.
  const operatorOnly = <R>(fn: (raw: unknown) => R | Promise<R>) =>
    (e: Electron.IpcMainInvokeEvent, raw: unknown): R | Promise<R> | typeof NOT_OPERATOR =>
      isMainWindowSender(e, getWindow()) ? fn(raw) : NOT_OPERATOR;

  ipcMain.handle(IPC.ROOM_STATUS, wrapHandler(IPC.ROOM_STATUS, operatorOnly((): RoomStatus => ({
    running: writer() !== null,
    ...factoryState(),
  }))));
  ipcMain.handle(IPC.ROOM_READ, wrapHandler(IPC.ROOM_READ, operatorOnly((raw) => call(ROOM_RPC.read, raw))));
  ipcMain.handle(IPC.ROOM_THREADS, wrapHandler(IPC.ROOM_THREADS, operatorOnly((raw) => call(ROOM_RPC.threads, raw))));
  // The owner posts human cards only; the kind is fixed here.
  // Photos: the paths the owner picked are copied into the room's store
  // here, and only the stored records go on to room.post (postWithPhotos).
  const photos = ports.attachments ?? getRoomAttachmentStore;
  const resolvePath = ports.resolvePath ?? resolveAccessiblePath;
  const posting = new Map<string, Promise<unknown>>();
  ipcMain.handle(IPC.ROOM_POST, wrapHandler(IPC.ROOM_POST, operatorOnly((raw) => postWithPhotos(raw, {
    post: (params) => call(ROOM_RPC.post, { ...params, kind: 'human' }),
    writer, store: photos, resolvePath, posting,
  }))));
  ipcMain.handle(IPC.ROOM_ATTACHMENT, wrapHandler(IPC.ROOM_ATTACHMENT, operatorOnly((raw) => roomPhoto(raw, writer(), photos()))));
  ipcMain.handle(IPC.ROOM_PICK_ATTACHMENTS, wrapHandler(IPC.ROOM_PICK_ATTACHMENTS, operatorOnly(async () => (await (ports.pickFiles ?? (() => pickPhotos(getWindow)))()) ?? [])));
  ipcMain.handle(IPC.ROOM_RESOLVE, wrapHandler(IPC.ROOM_RESOLVE, operatorOnly((raw) => call(ROOM_RPC.resolve, raw))));
  // The decision behind a question card (its options), for answering it.
  ipcMain.handle(IPC.ROOM_DECISION, wrapHandler(IPC.ROOM_DECISION, operatorOnly((raw): { decision: WorkspaceDecision | null } => {
    const p = obj(raw);
    if (!isRoomWorkspaceId(p.workspaceId) || typeof p.cardId !== 'string') return { decision: null };
    const card = writer()?.get(p.workspaceId, p.cardId) ?? null;
    const id = card?.kind === 'question' ? card.refs?.decisionId : undefined;
    if (!id) return { decision: null };
    return { decision: decisions(p.workspaceId).find((d) => d.id === id) ?? null };
  })));

  // Who the bot authors of cards are (role and name only), so a card can
  // name its author before the bot runtime's own bridge lists the bots.
  ipcMain.handle(IPC.ROOM_ACTORS, wrapHandler(IPC.ROOM_ACTORS, operatorOnly((): { actors: Record<string, RoomActor> } => {
    const actors: Record<string, RoomActor> = {};
    for (const r of removedBots()) {
      actors[r.id] = { role: r.role, name: r.name, removed: true, workspaceId: r.workspaceId, ...(r.avatar ? { avatar: r.avatar } : {}), ...(r.hue !== undefined ? { hue: r.hue } : {}) };
    }
    for (const b of bots()) actors[b.id] = { role: b.role, name: b.name };
    return { actors };
  })));

  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}

// ── Photos ─────────────────────────────────────────────────────────────────

/** A photo the room did not take: the reason, for the composer's line. */
export interface RoomPhotoRefusal { ok: false; code: 'attachment'; reason: 'missing' | 'type' | 'size' | 'changed' | 'full' | 'count' | 'unavailable'; message: string; index?: number }

export interface PostWithPhotosDeps {
  post: (params: Record<string, unknown>) => Promise<unknown>;
  writer: () => RoomWriter | null;
  store: () => RoomAttachmentStore | null;
  resolvePath: (file: string) => Promise<string | null>;
  /** In-flight posts by room and clientPostId: one at a time per key. */
  posting: Map<string, Promise<unknown>>;
}

const PHOTO_MESSAGES: Record<RoomPhotoRefusal['reason'], string> = {
  missing: 'A photo could not be read.',
  type: 'Only PNG and JPEG photos can be sent.',
  size: 'A photo is too large.',
  changed: 'A photo changed while it was being sent.',
  full: "This room's photo storage is full.",
  count: `At most ${ROOM_ATTACHMENT_LIMITS.PER_MESSAGE} photos can be sent with one message.`,
  unavailable: 'Photos cannot be sent until the bots have started.',
};

function photoRefusal(reason: RoomPhotoRefusal['reason'], index?: number): RoomPhotoRefusal {
  return { ok: false, code: 'attachment', reason, message: PHOTO_MESSAGES[reason], ...(index !== undefined ? { index } : {}) };
}

/**
 * ROOM_POST with `attachmentPaths` (absolute paths the owner picked, pasted
 * or dropped). One post per (room, clientPostId) at a time; inside it: a card
 * that already has the id keeps its photos and nothing is copied; else each
 * path is copied into the room's store, then room.post runs with the stored
 * records. Copies are removed only when no card took them. A renderer's own
 * `attachments` field is never forwarded.
 */
export async function postWithPhotos(raw: unknown, deps: PostWithPhotosDeps): Promise<unknown> {
  const { attachmentPaths, attachments: _ignored, ...params } = obj(raw);
  void _ignored;
  if (attachmentPaths === undefined) return deps.post(params);
  if (!Array.isArray(attachmentPaths) || attachmentPaths.length === 0 || attachmentPaths.some((p) => typeof p !== 'string')) return photoRefusal('missing');
  if (attachmentPaths.length > ROOM_ATTACHMENT_LIMITS.PER_MESSAGE) return photoRefusal('count');
  const workspaceId = params.workspaceId;
  if (!isRoomWorkspaceId(workspaceId)) return deps.post(params);
  const clientPostId = typeof params.clientPostId === 'string' ? params.clientPostId : null;
  const key = clientPostId ? `${workspaceId}\u0000${clientPostId}` : null;
  const run = async (): Promise<unknown> => {
    const store = deps.store();
    if (!store) return photoRefusal('unavailable');
    const prior = clientPostId ? deps.writer()?.find(workspaceId, (c) => c.clientPostId === clientPostId) ?? null : null;
    let records: RoomAttachment[] = prior?.attachments ?? [];
    const imported: string[] = [];
    if (!prior) {
      // Only a new post reads the files: a retry whose card is up needs none
      // (the owner may have moved them since).
      const resolved: string[] = [];
      for (const [index, file] of (attachmentPaths as string[]).entries()) {
        const real = await deps.resolvePath(file).catch(() => null);
        if (!real) return photoRefusal('missing', index);
        resolved.push(real);
      }
      for (const [index, file] of resolved.entries()) {
        const r = store.importFile(workspaceId, file);
        if (!r.ok) {
          store.remove(workspaceId, imported);
          return photoRefusal(r.reason, index);
        }
        imported.push(r.attachment.id);
        records = [...records, r.attachment];
      }
    }
    // A throw leaves the copies: whether a card was written is unknown, and
    // a retry with the same id finds it (the age sweep takes any leftover).
    const answer = await deps.post({ ...params, ...(records.length > 0 ? { attachments: records } : {}) });
    const card = obj(answer).card as RoomCard | undefined;
    const kept = new Set((card?.attachments ?? []).map((a) => a.id));
    const orphans = imported.filter((id) => !kept.has(id));
    if (orphans.length > 0) store.remove(workspaceId, orphans);
    return answer;
  };
  if (!key) return run();
  // Serialised per key: a double send waits for the first, then finds its card.
  const before = deps.posting.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(run);
  deps.posting.set(key, mine);
  try {
    return await mine;
  } finally {
    if (deps.posting.get(key) === mine) deps.posting.delete(key);
  }
}

/** ROOM_ATTACHMENT: a photo of a kept owner card of that room, as a data URL. */
export function roomPhoto(raw: unknown, writer: RoomWriter | null, store: RoomAttachmentStore | null): { ok: true; dataUrl: string; width?: number; height?: number } | { ok: false } {
  const p = obj(raw);
  const { workspaceId, attachmentId } = p;
  if (!isRoomWorkspaceId(workspaceId) || typeof attachmentId !== 'string' || !ROOM_ATTACHMENT_ID_RE.test(attachmentId) || !writer || !store) return { ok: false };
  const card = writer.find(workspaceId, (c) => c.kind === 'human' && !!c.attachments?.some((a) => a.id === attachmentId));
  const meta = card?.attachments?.find((a) => a.id === attachmentId);
  if (!meta) return { ok: false };
  const data = store.read(workspaceId, attachmentId);
  if (!data) return { ok: false };
  return {
    ok: true, dataUrl: `data:${meta.mediaType};base64,${data.toString('base64')}`,
    ...(meta.width ? { width: meta.width } : {}), ...(meta.height ? { height: meta.height } : {}),
  };
}

/** The composer's picker: PNG and JPEG, several at once. An isolated
 *  instance (WMUX_DATA_SUFFIX) started with WMUX_TEST_ROOM_ATTACH_FILE takes
 *  that file instead of asking, so a live check can drive it. */
async function pickPhotos(getWindow: () => BrowserWindow | null): Promise<string[] | null> {
  const testFile = process.env.WMUX_DATA_SUFFIX ? process.env.WMUX_TEST_ROOM_ATTACH_FILE : undefined;
  if (testFile) return [testFile];
  const opts: OpenDialogOptions = {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  };
  const win = getWindow();
  const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : r.filePaths.slice(0, ROOM_ATTACHMENT_LIMITS.PER_MESSAGE);
}
