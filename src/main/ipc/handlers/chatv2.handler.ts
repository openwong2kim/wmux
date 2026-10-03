import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { DaemonClient } from '../../DaemonClient';
import type { DaemonEvent } from '../../../shared/rpc';
import { getWmuxDir } from '../../../daemon/config';
import { CHAT_IMAGE_MAX_BYTES, validChatImagePath } from '../../../shared/transcript/chatAttachments';
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
} from '../../../shared/chatv2/ipc';
import { wrapHandler } from '../wrapHandler';

/**
 * Panes the renderer subscribed, with a count per view. Module level on
 * purpose: registerAllHandlers re-runs on every daemon (re)connect, and the
 * reconnect rule needs the set that outlived the old connection.
 */
const subscribed = new Map<string, number>();

const unavailable = () => chatV2Error('unavailable', 'Chat is unavailable.');

/** Copy a picked image into the staging directory the daemon accepts attachments from. */
export async function stageChatV2Attachment(file: unknown, wmuxDir = getWmuxDir()): Promise<ChatV2StageAttachmentResult> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, reason: 'missing' };
  if (!validChatImagePath(file)) return { ok: false, reason: 'not-image' };
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return { ok: false, reason: 'missing' };
    if (stat.size > CHAT_IMAGE_MAX_BYTES) return { ok: false, reason: 'too-large' };
    const dir = path.join(wmuxDir, CHATV2_ATTACHMENT_DIR);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${randomUUID()}${path.extname(file).toLowerCase()}`);
    await fs.copyFile(file, target);
    await fs.chmod(target, 0o600);
    return { ok: true, path: target };
  } catch {
    return { ok: false, reason: 'missing' };
  }
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

  const forward = async (method: ChatV2Method, params: unknown) => {
    if (disposed || !client?.isConnected) return unavailable();
    try {
      return await client.rpc(CHATV2_RPC[method], params as Record<string, unknown>, { timeoutMs: 30_000 });
    } catch {
      return unavailable();
    }
  };

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
        // Count first, so a push that races the reply is already forwarded.
        subscribed.set(paneId, (subscribed.get(paneId) ?? 0) + 1);
        const result = await forward(method, params) as { ok?: boolean };
        if (!result?.ok) {
          const left = (subscribed.get(paneId) ?? 1) - 1;
          if (left > 0) subscribed.set(paneId, left); else subscribed.delete(paneId);
        }
        return result;
      }
      if (method === 'unsubscribe') {
        const { paneId } = params as { paneId: string };
        const left = (subscribed.get(paneId) ?? 0) - 1;
        if (left > 0) { subscribed.set(paneId, left); return { ok: true }; }
        subscribed.delete(paneId);
      }
      return forward(method, params);
    }));
  }
  channels.push(CHATV2_IPC.stageAttachment);
  ipcMain.removeHandler(CHATV2_IPC.stageAttachment);
  ipcMain.handle(CHATV2_IPC.stageAttachment, wrapHandler(CHATV2_IPC.stageAttachment, (e: IpcMainInvokeEvent, file: unknown): Promise<ChatV2StageAttachmentResult> =>
    trusted(e) ? stageChatV2Attachment(file) : Promise.resolve({ ok: false, reason: 'missing' })));

  // Reconnect rule: subscribe again for every pane, then tell the renderer to re-snapshot them.
  if (client?.isConnected && subscribed.size) {
    const panes = [...subscribed.keys()];
    void Promise.all(panes.map((paneId) => client.rpc(CHATV2_RPC.subscribe, { paneId }).catch(() => undefined)))
      .then(() => send(CHATV2_IPC.resync, { paneIds: panes }));
  }

  return () => {
    disposed = true;
    client?.off('event', onEvent);
    wc?.off('did-start-navigation', onNavigation);
    wc?.off('render-process-gone', clear);
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
