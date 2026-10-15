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
import type { BrowserWindow } from 'electron';
import { isMainWindowSender } from '../mainWindowSender';
import { ipcMain } from 'electron';
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
  const channels = [IPC.ROOM_STATUS, IPC.ROOM_READ, IPC.ROOM_THREADS, IPC.ROOM_POST, IPC.ROOM_RESOLVE, IPC.ROOM_DECISION, IPC.ROOM_ACTORS];
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
  ipcMain.handle(IPC.ROOM_POST, wrapHandler(IPC.ROOM_POST, operatorOnly((raw) => call(ROOM_RPC.post, { ...obj(raw), kind: 'human' }))));
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
