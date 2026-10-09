// PC rail — renderer ↔ main IPC for the computer column's feeds.
//
// Renderer-only surface (never on the pipe RPC). While at least one renderer
// holds a SUBSCRIBE, a PcRailHub polls every web-paired host and keeps one
// `/api/events` stream per host; the results are pushed to every subscriber.
// SUBSCRIBE is refcounted per WebContents, and a reload, crash or destroy
// drops that renderer's whole count (same rules as the remote poll tick).
//
// The token never leaves main: pushes carry host ids, labels and rows only.

import { ipcMain } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { wrapHandler } from '../wrapHandler';
import {
  PC_RAIL_IPC,
  PC_RAIL_LIMITS,
  type PcRailApprovalsResult,
  type PcRailAttentionEvent,
  type PcRailStreamEvent,
} from '../../../shared/pcRail';
import type { RemoteHostsStore } from '../../remote/RemoteHostsStore';
import type { RemoteAttachmentsStore } from '../../remote/RemoteAttachmentsStore';
import { PcRailHub, type PcRailHubDeps } from '../../remote/pcRailHub';
import { fetchPcRailApprovals } from '../../remote/pcRailFeed';
import { PC_RAIL_FEED_EVENT } from '../../remote/pcRailWire';
import type { RemoteAttentionNotification } from '../../remote/remoteAttention';
import { isCategoryMuted } from '../../notification/mutedCategories';
import { toastManager } from '../../notification/ToastManager';

export interface RegisterPcRailHandlersDeps {
  store: Pick<RemoteHostsStore, 'list' | 'get'>;
  attachments: Pick<RemoteAttachmentsStore, 'list'>;
  fetchImpl?: typeof fetch;
  /** Test seam: build the hub with the given sinks. */
  hubFactory?: (deps: PcRailHubDeps) => PcRailHub;
  /** Test seam: how a remote toast is shown. */
  toast?: (title: string, body: string) => void;
}

/** The muted set main last received, for toast paths outside this hub. */
const mutedHosts = new Set<string>();

/** True when the user muted this computer's notifications in the rail. */
export function isPcRailHostMuted(hostId: string): boolean {
  return mutedHosts.has(hostId);
}

function parseHostId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const hostId = (value as { hostId?: unknown }).hostId;
  return typeof hostId === 'string' && hostId.length > 0 && hostId.length <= PC_RAIL_LIMITS.id ? hostId : null;
}

function parseMutes(value: unknown): string[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const ids = (value as { hostIds?: unknown }).hostIds;
  if (!Array.isArray(ids)) return null;
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= PC_RAIL_LIMITS.hosts) break;
    if (typeof id === 'string' && id.length > 0 && id.length <= PC_RAIL_LIMITS.id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function registerPcRailHandlers(deps: RegisterPcRailHandlersDeps): () => void {
  const { store, attachments } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  interface Subscriber {
    sender: WebContents;
    count: number;
  }
  const subscribers = new Map<number, Subscriber>();
  const trackedSenders = new Map<number, () => void>();

  function broadcast(channel: string, payload: unknown): void {
    for (const [id, { sender }] of [...subscribers]) {
      if (sender.isDestroyed()) {
        subscribers.delete(id);
        continue;
      }
      try {
        sender.send(channel, payload);
      } catch {
        // Renderer mid-reload: it subscribes again on its next mount.
      }
    }
  }

  const showToast = deps.toast ?? ((title: string, body: string) => {
    toastManager.show(title, body, { ptyId: null, workspaceId: null });
  });

  const hubDeps: PcRailHubDeps = {
    hosts: store,
    attachedHostIds: () => new Set(attachments.list().map((a) => a.hostId)),
    fetchImpl,
    feed: (event) => broadcast(PC_RAIL_FEED_EVENT, event),
    frame: (hostId, kind, data) => broadcast(PC_RAIL_IPC.ATTENTION_EVENT, { hostId, kind, data } satisfies PcRailAttentionEvent),
    stream: (hostId, state) => broadcast(PC_RAIL_IPC.STREAM_EVENT, { hostId, state } satisfies PcRailStreamEvent),
    toast: (hostLabel: string, n: RemoteAttentionNotification) => {
      // A remote toast names no local pane or workspace, as on the attach path.
      if (isCategoryMuted(n.category)) return;
      showToast(`${hostLabel || 'Remote'} · ${n.title}`, n.body);
    },
  };
  const hub = deps.hubFactory ? deps.hubFactory(hubDeps) : new PcRailHub(hubDeps);
  hub.setMuted(mutedHosts);

  function syncHub(): void {
    if (subscribers.size > 0) hub.start();
    else hub.stop();
  }

  function dropSender(senderId: number): void {
    subscribers.delete(senderId);
    trackedSenders.get(senderId)?.();
    syncHub();
  }

  function installSenderCleanup(sender: WebContents): void {
    if (trackedSenders.has(sender.id)) return;
    const id = sender.id;
    const onGone = (): void => dropSender(id);
    const onNavigation = (_e: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame && !isInPlace) onGone();
    };
    trackedSenders.set(id, () => {
      trackedSenders.delete(id);
      sender.removeListener('destroyed', onGone);
      sender.removeListener('render-process-gone', onGone);
      sender.removeListener('did-start-navigation', onNavigation);
    });
    sender.once('destroyed', onGone);
    sender.on('render-process-gone', onGone);
    sender.on('did-start-navigation', onNavigation);
  }

  ipcMain.removeAllListeners(PC_RAIL_IPC.SUBSCRIBE);
  ipcMain.on(PC_RAIL_IPC.SUBSCRIBE, (e: IpcMainEvent) => {
    const sender = e.sender;
    const entry = subscribers.get(sender.id);
    if (entry) {
      entry.sender = sender;
      entry.count += 1;
    } else {
      subscribers.set(sender.id, { sender, count: 1 });
    }
    installSenderCleanup(sender);
    const wasRunning = hub.isRunning();
    syncHub();
    // A renderer that joins a running hub gets the current picture at once.
    if (wasRunning) {
      for (const event of hub.snapshot()) {
        if (!sender.isDestroyed()) sender.send(PC_RAIL_FEED_EVENT, event);
      }
    }
  });

  ipcMain.removeAllListeners(PC_RAIL_IPC.UNSUBSCRIBE);
  ipcMain.on(PC_RAIL_IPC.UNSUBSCRIBE, (e: IpcMainEvent) => {
    const entry = subscribers.get(e.sender.id);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    dropSender(e.sender.id);
  });

  ipcMain.removeHandler(PC_RAIL_IPC.APPROVALS_LIST);
  ipcMain.handle(PC_RAIL_IPC.APPROVALS_LIST, wrapHandler(PC_RAIL_IPC.APPROVALS_LIST,
    async (_e: IpcMainInvokeEvent, request: unknown): Promise<PcRailApprovalsResult> => {
      const hostId = parseHostId(request);
      const host = hostId ? store.get(hostId) : null;
      if (!host) return { ok: false, reason: 'unavailable' };
      return fetchPcRailApprovals(host, fetchImpl);
    }));

  ipcMain.removeHandler(PC_RAIL_IPC.MUTES_SET);
  ipcMain.handle(PC_RAIL_IPC.MUTES_SET, wrapHandler(PC_RAIL_IPC.MUTES_SET,
    async (_e: IpcMainInvokeEvent, request: unknown): Promise<void> => {
      const ids = parseMutes(request);
      if (!ids) throw new Error('hostIds is required');
      mutedHosts.clear();
      for (const id of ids) mutedHosts.add(id);
      hub.setMuted(mutedHosts);
    }));

  return () => {
    hub.stop();
    subscribers.clear();
    for (const release of [...trackedSenders.values()]) release();
    ipcMain.removeAllListeners(PC_RAIL_IPC.SUBSCRIBE);
    ipcMain.removeAllListeners(PC_RAIL_IPC.UNSUBSCRIBE);
    ipcMain.removeHandler(PC_RAIL_IPC.APPROVALS_LIST);
    ipcMain.removeHandler(PC_RAIL_IPC.MUTES_SET);
  };
}
