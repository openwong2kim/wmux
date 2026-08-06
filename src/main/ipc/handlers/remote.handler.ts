// Remote workspace attach — renderer ↔ main IPC for registered remote wmux
// web hosts, and the per-pane attach/detach/write/push bridge to them.
//
// Trust boundary: this is a renderer-only surface, like channelLocal/fanout —
// never exposed on the pipe RPC. Main owns the RemoteHostsStore (tokens never
// cross into the renderer, see RemoteHostPublic) and one RemoteHostClient per
// registered host, built lazily and cached for the process lifetime.
//
// Push routing (REMOTE_PANE_META/DATA/EXIT) targets the WebContents that
// issued the attach — captured at REMOTE_PANE_ATTACH — never "the focused
// window": a background pane's owning window may not be focused, and a
// destroyed/reloaded sender must simply stop receiving pushes rather than
// crash the app on a stale `.send()`.
//
// Observer + input only: no route here ever calls a remote destroy/delete
// endpoint (RemoteHostClient itself never exposes one either).

import { app, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { RemoteHostClient } from '../../remote/RemoteHostClient';
import type { RemoteHostsStore } from '../../remote/RemoteHostsStore';
import { parseWebUrl } from '../../../shared/remoteHosts';
import type {
  RemoteHost,
  RemoteHostPublic,
  RemoteWorkspaceSummary,
} from '../../../shared/remoteHosts';

/** Shape of a `GET /api/config` response we care about (WebTerminalServer.ts). */
interface RemoteConfigProbe {
  serverVersion?: string;
  protocolVersion?: number;
  minProtocolVersion?: number;
  allowInput?: boolean;
}

export interface RegisterRemoteHandlersDeps {
  store: RemoteHostsStore;
  /** Test seam: how a RemoteHostClient is built for a host record. Defaults
   *  to `new RemoteHostClient(host, fetchImpl)`. */
  clientFactory?: (host: RemoteHost) => RemoteHostClient;
  /** Test seam: fetch implementation for the `/api/config` add-time probe
   *  (runs before any RemoteHostClient exists, so it needs its own seam). */
  fetchImpl?: typeof fetch;
}

interface AttachRecord {
  attachId: string;
  hostId: string;
  sessionId: string;
  senderId: number;
  sender: WebContents;
}

function assertString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${field} is required`);
  return v;
}

/** `GET /api/config` probe used both at add-time (gate old remotes out) and
 *  opportunistically on every workspacesList (keep the allowInput banner
 *  fresh). Never throws — a probe failure is reported as `null`. */
async function probeConfig(
  origin: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<RemoteConfigProbe | null> {
  try {
    const res = await fetchImpl(`${origin}/api/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const parsed: unknown = await res.json();
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as RemoteConfigProbe;
  } catch {
    return null;
  }
}

export function registerRemoteHandlers(deps: RegisterRemoteHandlersDeps): () => void {
  const { store } = deps;
  const fetchImpl: typeof fetch = deps.fetchImpl ?? fetch;
  const makeClient = deps.clientFactory ?? ((host: RemoteHost) => new RemoteHostClient(host, fetchImpl));

  const clients = new Map<string, RemoteHostClient>(); // hostId -> client, lazily built
  // RemoteHostsStore.add() has no allowInput param (Task 3 interface), so the
  // add-time/refresh-time probe result lives here rather than on disk. Lost
  // across an app restart, which just means the first list() after restart
  // shows no banner until the next workspacesList call re-probes it.
  const allowInputCache = new Map<string, boolean>(); // hostId -> allowInput
  const attachByKey = new Map<string, string>(); // `${senderId}:${hostId}:${sessionId}` -> attachId
  const attachRecords = new Map<string, AttachRecord>(); // attachId -> record
  const trackedSenders = new Set<number>();

  function attachKey(senderId: number, hostId: string, sessionId: string): string {
    return `${senderId}:${hostId}:${sessionId}`;
  }

  function pushToOwner(attachId: string, channel: string, payload: unknown): void {
    const record = attachRecords.get(attachId);
    if (!record) return;
    if (record.sender.isDestroyed()) return;
    record.sender.send(channel, payload);
  }

  function getOrCreateClient(hostId: string): RemoteHostClient | null {
    const existing = clients.get(hostId);
    if (existing) return existing;
    const host = store.get(hostId);
    if (!host) return null;
    const client = makeClient(host);
    // Wired ONCE per client — every attach on this host shares these
    // callbacks; the attachId on each event is how a shared callback fans a
    // single client's events back out to the RIGHT sender.
    client.onMeta((e) => pushToOwner(e.attachId, IPC.REMOTE_PANE_META, e));
    client.onData((e) => pushToOwner(e.attachId, IPC.REMOTE_PANE_DATA, e));
    client.onExit((e) => pushToOwner(e.attachId, IPC.REMOTE_PANE_EXIT, e));
    clients.set(hostId, client);
    return client;
  }

  function detachAttach(attachId: string): void {
    const record = attachRecords.get(attachId);
    if (!record) return;
    clients.get(record.hostId)?.detach(attachId);
    attachRecords.delete(attachId);
    attachByKey.delete(attachKey(record.senderId, record.hostId, record.sessionId));
  }

  /** Reload/crash cleanup (once per sender): a renderer reload never runs
   *  React unmount cleanup, so without this every Cmd+R leaks a live SSE
   *  connection against the remote daemon. */
  function installSenderCleanup(sender: WebContents): void {
    if (trackedSenders.has(sender.id)) return;
    trackedSenders.add(sender.id);
    const onGone = (): void => {
      for (const [attachId, record] of [...attachRecords.entries()]) {
        if (record.senderId === sender.id) detachAttach(attachId);
      }
      trackedSenders.delete(sender.id);
    };
    sender.once('destroyed', onGone);
    sender.on('render-process-gone', onGone);
  }

  function publicHost(host: RemoteHostPublic): RemoteHostPublic {
    const cached = allowInputCache.get(host.id);
    return cached === undefined ? host : { ...host, allowInput: cached };
  }

  ipcMain.removeHandler(IPC.REMOTE_HOSTS_LIST);
  ipcMain.handle(IPC.REMOTE_HOSTS_LIST, wrapHandler(IPC.REMOTE_HOSTS_LIST, async (): Promise<RemoteHostPublic[]> => {
    return store.list().map(publicHost);
  }));

  ipcMain.removeHandler(IPC.REMOTE_HOSTS_ADD);
  ipcMain.handle(IPC.REMOTE_HOSTS_ADD, wrapHandler(IPC.REMOTE_HOSTS_ADD,
    async (
      _e: IpcMainInvokeEvent,
      rawUrl: unknown,
      label?: unknown,
    ): Promise<{ ok: true; host: RemoteHostPublic } | { ok: false; error: string }> => {
      const url = assertString(rawUrl, 'rawUrl');
      const safeLabel = label === undefined ? undefined : assertString(label, 'label');

      const parsed = parseWebUrl(url);
      if (!parsed) return { ok: false, error: 'invalid wmux web URL' };
      if (store.list().some((h) => h.origin === parsed.origin)) {
        return { ok: false, error: 'already registered' };
      }

      // Probe BEFORE persisting: an old remote (no /api/config, or a body we
      // can't parse) never makes it into the store at all.
      const probe = await probeConfig(parsed.origin, parsed.token, fetchImpl);
      if (!probe) {
        return { ok: false, error: "that machine's wmux is too old for remote attach" };
      }

      const result = store.add(url, safeLabel);
      if (!result.ok) return result;

      const allowInput = probe.allowInput === true;
      allowInputCache.set(result.host.id, allowInput);
      return { ok: true, host: { ...result.host, allowInput } };
    }));

  ipcMain.removeHandler(IPC.REMOTE_HOSTS_REMOVE);
  ipcMain.handle(IPC.REMOTE_HOSTS_REMOVE, wrapHandler(IPC.REMOTE_HOSTS_REMOVE,
    async (_e: IpcMainInvokeEvent, id: unknown): Promise<boolean> => {
      const hostId = assertString(id, 'id');
      const removed = store.remove(hostId);
      if (!removed) return false;

      allowInputCache.delete(hostId);
      const client = clients.get(hostId);
      if (client) {
        client.detachAll();
        clients.delete(hostId);
      }
      for (const [attachId, record] of [...attachRecords.entries()]) {
        if (record.hostId === hostId) detachAttach(attachId);
      }
      return true;
    }));

  ipcMain.removeHandler(IPC.REMOTE_WORKSPACES_LIST);
  ipcMain.handle(IPC.REMOTE_WORKSPACES_LIST, wrapHandler(IPC.REMOTE_WORKSPACES_LIST,
    async (
      _e: IpcMainInvokeEvent,
      hostId: unknown,
    ): Promise<{ ok: true; workspaces: RemoteWorkspaceSummary[] } | { ok: false; error: string }> => {
      const id = assertString(hostId, 'hostId');
      const host = store.get(id);
      if (!host) return { ok: false, error: 'unknown host' };

      // Refresh allowInput opportunistically — best-effort, never blocks the
      // workspace list on a probe hiccup.
      const probe = await probeConfig(host.origin, host.token, fetchImpl);
      if (probe) allowInputCache.set(id, probe.allowInput === true);

      const client = getOrCreateClient(id);
      if (!client) return { ok: false, error: 'unknown host' };
      try {
        const res = await client.listWorkspaces();
        return { ok: true, workspaces: res.workspaces };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }));

  ipcMain.removeHandler(IPC.REMOTE_PANE_ATTACH);
  ipcMain.handle(IPC.REMOTE_PANE_ATTACH, wrapHandler(IPC.REMOTE_PANE_ATTACH,
    async (
      event: IpcMainInvokeEvent,
      hostId: unknown,
      sessionId: unknown,
    ): Promise<{ ok: true; attachId: string } | { ok: false; error: string }> => {
      const id = assertString(hostId, 'hostId');
      const session = assertString(sessionId, 'sessionId');
      const sender = event.sender;

      // Idempotent: a second attach for the same (sender, host, session) —
      // e.g. React StrictMode's double-effect — returns the existing
      // attachId rather than opening a second SSE stream.
      const key = attachKey(sender.id, id, session);
      const existingAttachId = attachByKey.get(key);
      if (existingAttachId) return { ok: true, attachId: existingAttachId };

      const client = getOrCreateClient(id);
      if (!client) return { ok: false, error: 'unknown host' };

      installSenderCleanup(sender);
      const attachId = client.attach(session);
      attachRecords.set(attachId, { attachId, hostId: id, sessionId: session, senderId: sender.id, sender });
      attachByKey.set(key, attachId);
      return { ok: true, attachId };
    }));

  ipcMain.removeHandler(IPC.REMOTE_PANE_DETACH);
  ipcMain.handle(IPC.REMOTE_PANE_DETACH, wrapHandler(IPC.REMOTE_PANE_DETACH,
    async (_e: IpcMainInvokeEvent, attachId: unknown): Promise<void> => {
      detachAttach(assertString(attachId, 'attachId'));
    }));

  // remote:pane:write — fire-and-forget like pty:write. Errors (dead
  // attachment, network failure) are the RemoteHostClient's own reconnect
  // problem; nothing useful for the renderer to await here.
  ipcMain.removeAllListeners(IPC.REMOTE_PANE_WRITE);
  ipcMain.on(IPC.REMOTE_PANE_WRITE, (_e, attachId: unknown, data: unknown) => {
    if (typeof attachId !== 'string' || typeof data !== 'string') return;
    const record = attachRecords.get(attachId);
    if (!record) return;
    const client = clients.get(record.hostId);
    if (!client) return;
    client.write(attachId, data).catch(() => { /* see doc comment above */ });
  });

  const onWillQuit = (): void => {
    for (const client of clients.values()) client.detachAll();
  };
  app.on('will-quit', onWillQuit);

  return () => {
    ipcMain.removeHandler(IPC.REMOTE_HOSTS_LIST);
    ipcMain.removeHandler(IPC.REMOTE_HOSTS_ADD);
    ipcMain.removeHandler(IPC.REMOTE_HOSTS_REMOVE);
    ipcMain.removeHandler(IPC.REMOTE_WORKSPACES_LIST);
    ipcMain.removeHandler(IPC.REMOTE_PANE_ATTACH);
    ipcMain.removeHandler(IPC.REMOTE_PANE_DETACH);
    ipcMain.removeAllListeners(IPC.REMOTE_PANE_WRITE);
    app.removeListener('will-quit', onWillQuit);
  };
}
