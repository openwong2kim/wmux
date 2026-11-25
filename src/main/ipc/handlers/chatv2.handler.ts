import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { DaemonClient } from '../../DaemonClient';
import type { DaemonEvent } from '../../../shared/rpc';
import { getWmuxDir } from '../../../daemon/config';
import { CHAT_ATTACHMENT_LIMIT, CHAT_IMAGE_MAX_BYTES, validChatImagePath } from '../../../shared/transcript/chatAttachments';
import {
  CHATV2_ATTACHMENT_DIR,
  CHATV2_IPC,
  CHATV2_PUSH_EVENT,
  CHATV2_RPC,
  chatV2Error,
  parseChatV2Params,
  type ChatV2EventsPush,
  type ChatV2Method,
  type ChatV2StageAttachmentResult,
  validChatV2AttachmentPath,
} from '../../../shared/chatv2/ipc';
import { wrapHandler } from '../wrapHandler';
import { resolveAccessiblePath } from './fs.handler';

/**
 * Panes the renderer subscribed, each with the generation of its latest
 * subscribe request (so a late failure of an older request cannot drop a newer
 * subscription). Subscribing is idempotent per pane. Module level on purpose:
 * registerAllHandlers re-runs on every daemon (re)connect, and the reconnect
 * rule needs the set that outlived the old connection.
 */
const subscribed = new Map<string, number>();
let generation = 0;

/** Staged images older than this are removed when the next one is staged. */
const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const unavailable = () => chatV2Error('unavailable', 'Chat is unavailable.');

/**
 * Check a picked, dropped or pasted file for a chat. An image within the image
 * size limit is copied into the staging directory the daemon reads
 * attachments from; any other file (a larger image too) keeps its own path,
 * resolved the way the daemon checks it (the agent opens it itself; see
 * ipc.ts). Nothing here decodes the file: the composer shows the staged copy
 * through the preview scheme.
 */
export async function stageChatV2Attachment(raw: unknown, wmuxDir = getWmuxDir()): Promise<ChatV2StageAttachmentResult> {
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) return { ok: false, reason: 'missing' };
  const file = path.resolve(raw);
  if (!validChatV2AttachmentPath(file)) return { ok: false, reason: 'missing' };
  const dir = path.resolve(wmuxDir, CHATV2_ATTACHMENT_DIR);
  try {
    // Read from the real file, checked like a preview: never through a link to somewhere else.
    const source = await resolveAccessiblePath(file);
    if (!source) return { ok: false, reason: 'missing' };
    const stat = await fs.stat(source);
    if (!stat.isFile()) return { ok: false, reason: 'missing' };
    const image = validChatImagePath(file) && validChatImagePath(source);
    // The daemon takes only staged images from the staging directory.
    const staged = path.dirname(file) === dir || path.dirname(source) === dir;
    if (staged && (!image || stat.size > CHAT_IMAGE_MAX_BYTES)) return { ok: false, reason: 'missing' };
    const name = path.basename(file);
    if (!image || stat.size > CHAT_IMAGE_MAX_BYTES) return { ok: true, path: file, name, kind: 'file', size: stat.size };
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await pruneStaged(dir);
    const target = path.join(dir, `${randomUUID()}${path.extname(source).toLowerCase()}`);
    await fs.copyFile(source, target);
    await fs.chmod(target, 0o600);
    return { ok: true, path: target, name, kind: 'image', size: stat.size };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}

/** Remove staged images past STAGED_MAX_AGE_MS (best effort, regular files directly in `dir` only). */
async function pruneStaged(dir: string, now = Date.now()): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return; }
  await Promise.all(names.map(async (name) => {
    const file = path.join(dir, name);
    try {
      const stat = await fs.lstat(file);
      if (stat.isFile() && now - stat.mtimeMs > STAGED_MAX_AGE_MS) await fs.unlink(file);
    } catch { /* gone or unreadable: leave it */ }
  }));
}

/**
 * Chat v2 IPC: the application renderer's main frame only, never a webview or
 * the public RPC router. Params are validated with the shared parser before
 * they reach the daemon.
 */
export function registerChatV2Handlers(client: DaemonClient | undefined, getWindow: () => BrowserWindow | null): () => void {
  let disposed = false;
  let wc: BrowserWindow['webContents'] | undefined;

  const send = (channel: string, payload: unknown) => {
    const target = getWindow()?.webContents;
    if (!disposed && target && !target.isDestroyed()) target.send(channel, payload);
  };
  // A reload or a crashed renderer drops its subscriptions; the new page subscribes again.
  const clear = () => {
    const panes = [...subscribed.keys()];
    subscribed.clear();
    if (client?.isConnected) for (const paneId of panes) void client.rpc(CHATV2_RPC.unsubscribe, { paneId }).catch(() => undefined);
  };
  const onNavigation = (event: unknown, _url?: string, _inPlace?: boolean, mainFrame?: boolean) => {
    const isMainFrame = event && typeof event === 'object' && 'isMainFrame' in event ? event.isMainFrame : mainFrame;
    if (isMainFrame) clear();
  };
  const watchWindow = () => {
    const next = getWindow()?.webContents;
    if (next === wc) return;
    wc?.off('did-start-navigation', onNavigation);
    wc?.off('render-process-gone', clear);
    // A new window's renderer subscribes for itself.
    if (wc) clear();
    wc = next;
    wc?.on('did-start-navigation', onNavigation);
    wc?.on('render-process-gone', clear);
  };
  const trusted = (e: IpcMainInvokeEvent) => {
    watchWindow();
    const target = getWindow()?.webContents;
    return !!target && !target.isDestroyed() && e.sender === target && e.senderFrame === target.mainFrame;
  };
  watchWindow();

  const onEvent = (event: DaemonEvent) => {
    if (event.type !== CHATV2_PUSH_EVENT) return;
    const push = event.data as ChatV2EventsPush | null;
    if (push && typeof push.paneId === 'string' && subscribed.has(push.paneId)) send(CHATV2_IPC.events, push);
  };
  client?.on('event', onEvent);

  /** `thrown` = no answer (timeout, dropped socket): the daemon's side is unknown. */
  const call = async (method: ChatV2Method, params: unknown): Promise<{ result: unknown; thrown: boolean }> => {
    if (disposed || !client?.isConnected) return { result: unavailable(), thrown: false };
    try {
      // A move into chat stops a TUI (a 5 s grace), proves it gone and starts the agent;
      // a model change may restart the agent the same way.
      const timeoutMs = method === 'fromTerminal' || method === 'configure' ? 120_000 : 30_000;
      return { result: await client.rpc(CHATV2_RPC[method], params as Record<string, unknown>, { timeoutMs }), thrown: false };
    } catch {
      return { result: unavailable(), thrown: true };
    }
  };
  const forward = async (method: ChatV2Method, params: unknown) => (await call(method, params)).result;

  const channels: string[] = [];
  for (const method of Object.keys(CHATV2_RPC) as ChatV2Method[]) {
    const channel = CHATV2_IPC[method];
    channels.push(channel);
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, async (e: IpcMainInvokeEvent, raw: unknown) => {
      if (!trusted(e)) return unavailable();
      const params = parseChatV2Params(method, raw);
      if (!params) return chatV2Error('invalid-params', `Invalid ${method} request.`);
      if (method === 'subscribe') {
        const { paneId } = params as { paneId: string };
        // Record first, so a push that races the reply is already forwarded.
        const mine = ++generation;
        subscribed.set(paneId, mine);
        const { result, thrown } = await call(method, params);
        if (!(result as { ok?: boolean })?.ok && subscribed.get(paneId) === mine) {
          subscribed.delete(paneId);
          // No answer: the daemon may hold the subscription anyway. Drop it there too.
          if (thrown && client?.isConnected) void client.rpc(CHATV2_RPC.unsubscribe, { paneId }).catch(() => undefined);
        }
        return result;
      }
      if (method === 'unsubscribe') subscribed.delete((params as { paneId: string }).paneId);
      return forward(method, params);
    }));
  }
  channels.push(CHATV2_IPC.stageAttachment);
  ipcMain.removeHandler(CHATV2_IPC.stageAttachment);
  ipcMain.handle(CHATV2_IPC.stageAttachment, wrapHandler(CHATV2_IPC.stageAttachment, (e: IpcMainInvokeEvent, file: unknown): Promise<ChatV2StageAttachmentResult> =>
    trusted(e) ? stageChatV2Attachment(file) : Promise.resolve({ ok: false, reason: 'missing' })));
  channels.push(CHATV2_IPC.pickAttachments);
  ipcMain.removeHandler(CHATV2_IPC.pickAttachments);
  ipcMain.handle(CHATV2_IPC.pickAttachments, wrapHandler(CHATV2_IPC.pickAttachments, async (e: IpcMainInvokeEvent): Promise<ChatV2StageAttachmentResult[]> => {
    if (!trusted(e)) return [];
    const win = getWindow();
    const opts = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !trusted(e)) return [];
    // One past the limit, so the composer can say why the rest were left out.
    return Promise.all(picked.filePaths.slice(0, CHAT_ATTACHMENT_LIMIT + 1).map((file) => stageChatV2Attachment(file)));
  }));

  // Reconnect rule: subscribe again for every pane, then tell the renderer to
  // re-snapshot them. A pane whose subscribe failed leaves the set; the
  // renderer's re-snapshot subscribes it again.
  if (client?.isConnected && subscribed.size) {
    const panes = [...subscribed.entries()];
    void Promise.all(panes.map(async ([paneId, gen]) => {
      const result = await client.rpc(CHATV2_RPC.subscribe, { paneId }, { timeoutMs: 30_000 }).catch(() => null) as { ok?: boolean } | null;
      if (!result?.ok && subscribed.get(paneId) === gen) subscribed.delete(paneId);
    })).then(() => send(CHATV2_IPC.resync, { paneIds: panes.map(([paneId]) => paneId) }));
  }

  return () => {
    disposed = true;
    client?.off('event', onEvent);
    wc?.off('did-start-navigation', onNavigation);
    wc?.off('render-process-gone', clear);
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
