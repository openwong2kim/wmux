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
import type { RemoteAttachmentsStore } from '../../remote/RemoteAttachmentsStore';
import { RemoteAttentionSubscriber } from '../../remote/RemoteAttentionSubscriber';
import type { RemoteAttentionNotification } from '../../remote/remoteAttention';
import { isCategoryMuted } from '../../notification/mutedCategories';
import { toastManager } from '../../notification/ToastManager';
import { parseRemoteAttachmentKey, parseWebUrl, remoteAttachmentKey, REMOTE_POLL_INTERVAL_MS } from '../../../shared/remoteHosts';
import { normalizeWorkspaceColor } from '../../../shared/workspaceColors';
import type {
  PairFailureReason,
  RemoteAttachmentDescriptor,
  RemoteHost,
  RemoteHostPublic,
  RemoteWorkspaceSummary,
} from '../../../shared/remoteHosts';

// Bearer-credentialed probe — never let a hung remote hang the add/refresh
// flow forever.
const PROBE_TIMEOUT_MS = 10_000;

/** Shape of a `GET /api/config` response we care about (WebTerminalServer.ts). */
interface RemoteConfigProbe {
  serverVersion?: string;
  protocolVersion?: number;
  minProtocolVersion?: number;
  allowInput?: boolean;
}

/** Distinguishes WHY a `/api/config` probe failed, so the caller can tell a
 *  rejected token apart from an unreachable host apart from a genuinely
 *  incompatible (pre-remote-attach) build — flattening these into one "too
 *  old" message misdiagnoses the two recoverable cases. */
type ProbeResult =
  | { kind: 'ok'; allowInput: boolean }
  | { kind: 'unauthorized' }
  | { kind: 'unreachable' }
  | { kind: 'incompatible' };

export interface RegisterRemoteHandlersDeps {
  store: RemoteHostsStore;
  /** Persisted attach descriptors — what makes an attachment survive a
   *  renderer reload and an app restart. */
  attachments: RemoteAttachmentsStore;
  /** Test seam: how a RemoteHostClient is built for a host record. Defaults
   *  to `new RemoteHostClient(host, fetchImpl)`. */
  clientFactory?: (host: RemoteHost) => RemoteHostClient;
  /** Test seam: how the per-host `/api/events` subscription is built. */
  attentionSubscriberFactory?: (
    host: RemoteHost,
    onNotification: (hostLabel: string, n: RemoteAttentionNotification) => void,
  ) => RemoteAttentionSubscriber;
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
 *  fresh). Never throws — a probe failure is reported via `kind`, never as
 *  an exception. */
async function probeConfig(
  origin: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/api/config`, {
      headers: { Authorization: `Bearer ${token}` },
      // Bearer-credentialed request: never follow a redirect, and don't
      // let a hung probe hang the caller indefinitely.
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    // fetch itself threw — DNS failure, connection refused, TLS error: the
    // host could not be reached at all, as opposed to reaching it and being
    // turned away.
    return { kind: 'unreachable' };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
  if (!res.ok) return { kind: 'incompatible' };
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { kind: 'incompatible' };
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'incompatible' };
  const allowInput = (parsed as RemoteConfigProbe).allowInput === true;
  return { kind: 'ok', allowInput };
}

/** Add-time error string for a probe failure — three distinct messages so a
 *  rejected token and an unreachable host aren't both misreported as "too
 *  old". */
function probeFailureMessage(probe: Exclude<ProbeResult, { kind: 'ok' }>): string {
  switch (probe.kind) {
    case 'unauthorized':
      return 'token rejected — re-run wmux web on the remote and paste the new URL';
    case 'unreachable':
      return 'could not reach that host';
    case 'incompatible':
      return "that machine's wmux is too old for remote attach";
  }
}

/** Shape of a `GET /api/pair` 403 error body (WebTerminalServer.handlePair). */
interface PairErrorBody {
  error?: string;
  detail?: string;
  attemptsLeft?: number;
}

/** Shape of a successful `GET /api/pair` 200 body. deviceId/deviceSecret may
 *  also be present but are the daemon's own bookkeeping — only `token` is
 *  used, as the Bearer credential for this device. */
interface PairSuccessBody {
  token?: string;
}

type PairExchangeResult =
  | { ok: true; token: string }
  | { ok: false; reason: PairFailureReason; attemptsLeft?: number };

/** Exchanges a pairing code for a device-scoped token via the unauthenticated
 *  `GET /api/pair` route. Never throws — a fetch failure is reported as
 *  'unreachable', mirroring probeConfig's contract, and the code/token never
 *  reach a throw path. */
async function exchangePairCode(
  origin: string,
  code: string,
  fetchImpl: typeof fetch,
): Promise<PairExchangeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/api/pair?code=${encodeURIComponent(code)}`, {
      // Unauthenticated by design (no Bearer header — that's the point of
      // pairing) but still a credential-minting request: never follow a
      // redirect, and don't let a hung remote hang the modal forever.
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  if (res.status === 403) {
    let body: PairErrorBody;
    try {
      body = (await res.json()) as PairErrorBody;
    } catch {
      return { ok: false, reason: 'pairing-failed' };
    }
    switch (body.error) {
      case 'expired':
        return { ok: false, reason: 'expired' };
      case 'too many attempts':
        return { ok: false, reason: 'too-many-attempts' };
      case 'invalid code':
        return { ok: false, reason: 'invalid-code', attemptsLeft: body.attemptsLeft };
      case 'insecure-transport':
        return { ok: false, reason: 'insecure-transport' };
      default:
        return { ok: false, reason: 'pairing-failed' };
    }
  }

  if (!res.ok) return { ok: false, reason: 'pairing-failed' };

  let parsed: PairSuccessBody;
  try {
    parsed = (await res.json()) as PairSuccessBody;
  } catch {
    return { ok: false, reason: 'pairing-failed' };
  }
  if (typeof parsed.token !== 'string' || !parsed.token) {
    return { ok: false, reason: 'pairing-failed' };
  }
  return { ok: true, token: parsed.token };
}

export function registerRemoteHandlers(deps: RegisterRemoteHandlersDeps): () => void {
  const { store, attachments } = deps;
  const makeAttentionSubscriber =
    deps.attentionSubscriberFactory ??
    ((host: RemoteHost, onNotification: (hostLabel: string, n: RemoteAttentionNotification) => void) =>
      new RemoteAttentionSubscriber({ host, onNotification, fetchImpl }));
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

  // #1391 — the liveness-poll tick. Keyed by WebContents id so a renderer that
  // subscribes twice gets ONE tick per round, never two.
  //
  // REFCOUNTED, and that is load-bearing. The renderer's subscribe is an async
  // invoke inside a React effect keyed on "is anything attached", so detaching
  // and re-attaching faster than one IPC round trip — the last mirror closed
  // and another opened, a workspace switch that empties and refills the row set
  // — interleaves as: subscribe(A) → subscribe(B) → the LATE unsubscribe from
  // A. A plain membership set would drop the whole entry on that unsubscribe,
  // disarm the timer, and leave the renderer holding a live listener it
  // believes is subscribed — polling silently dead for the rest of the session.
  // Counting makes the pair balance: B survives A's teardown. (This renderer
  // does not mount under React StrictMode, whose double-invoked effects would
  // produce the same order on every single mount.)
  //
  // A WebContents teardown deletes the entry outright, count and all, so a
  // reload can never strand a positive count.
  interface PollSubscriber {
    sender: WebContents;
    /** Outstanding subscribes from this renderer, not tick recipients. */
    count: number;
  }
  const pollSubscribers = new Map<number, PollSubscriber>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // --- remote agent notifications (#1344) ---------------------------------
  //
  // One `/api/events` subscription per ATTACHED host, started and stopped with
  // the attach roster: a registered-but-not-attached host is one the user is
  // not watching, and subscribing to it would notify about panes that are
  // nowhere on screen. Transitions land in `dispatchNotification`, the same
  // entry point every local event uses, so remote notifications inherit the
  // renderer's notification policy, the per-category mute, idle suppression
  // and the toast dedup without a second copy of any of them.
  const attentionSubs = new Map<string, RemoteAttentionSubscriber>(); // hostId -> sub

  function onRemoteAttention(hostLabel: string, n: RemoteAttentionNotification): void {
    const label = hostLabel || 'Remote';
    // NOT `dispatchNotification`: its renderer leg resolves a notification with
    // no ptyId and no workspaceId onto the ACTIVE LOCAL workspace
    // (resolveNotificationTarget's last fallback), and a remote event has
    // neither — it names a remote session id that no local surface owns. That
    // fallback would flash an unrelated local pane, jump there on click, and
    // let that workspace's `notificationsMuted` silence a remote host it has
    // nothing to do with. So the remote path takes the two gates main owns
    // outright and skips the local-surface machinery it cannot honestly feed:
    // the mirrored per-category mute, and ToastManager (which applies the
    // `toastEnabled` setting and stays quiet while a window has OS focus).
    if (isCategoryMuted(n.category)) return;
    toastManager.show(`${label} · ${n.title}`, n.body, { ptyId: null, workspaceId: null });
  }

  /** Reconcile live subscriptions against the attach roster. Idempotent. */
  function syncAttentionSubs(): void {
    const wanted = new Set<string>();
    for (const a of attachments.list()) {
      // A descriptor whose host is gone can never be restored either — it is
      // waiting to be cascaded away, not a host to subscribe to.
      if (store.get(a.hostId)) wanted.add(a.hostId);
    }
    for (const [hostId, sub] of [...attentionSubs.entries()]) {
      if (wanted.has(hostId)) continue;
      sub.stop();
      attentionSubs.delete(hostId);
    }
    for (const hostId of wanted) {
      if (attentionSubs.has(hostId)) continue;
      const host = store.get(hostId);
      if (!host) continue;
      const sub = makeAttentionSubscriber(host, onRemoteAttention);
      attentionSubs.set(hostId, sub);
      sub.start();
    }
  }

  function attachKey(senderId: number, hostId: string, sessionId: string): string {
    return `${senderId}:${hostId}:${sessionId}`;
  }

  function pushToOwner(attachId: string, channel: string, payload: unknown): void {
    const record = attachRecords.get(attachId);
    if (!record) return;
    if (record.sender.isDestroyed()) return;
    record.sender.send(channel, payload);
  }

  /**
   * #1391 — arm the tick on the FIRST subscriber, disarm it on the last.
   *
   *   renderer has ≥1 attached remote workspace
   *          │  REMOTE_POLL_SUBSCRIBE
   *          ▼
   *   pollSubscribers ──first──▶ setInterval(REMOTE_POLL_INTERVAL_MS)
   *          │                          │ every tick
   *          │                          ▼
   *          │                   send REMOTE_POLL_TICK to each live subscriber
   *          │  UNSUBSCRIBE / reload / crash / destroy
   *          ▼
   *   pollSubscribers ──last──▶ clearInterval
   *
   * An app with no remote workspaces attached therefore runs no periodic timer
   * at all — the property the old renderer-side `hasAttachments` gate had, kept.
   */
  function syncPollTimer(): void {
    if (pollSubscribers.size > 0) {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        for (const [id, { sender }] of [...pollSubscribers]) {
          // A destroyed WebContents throws on send(). Drop it here rather than
          // waiting for a lifecycle event that may never come.
          if (sender.isDestroyed()) {
            pollSubscribers.delete(id);
            continue;
          }
          try {
            sender.send(IPC.REMOTE_POLL_TICK);
          } catch {
            // Renderer mid-reload — it re-subscribes on the next mount, and
            // one missed tick costs one poll interval, never correctness.
          }
        }
        // A round that found every subscriber dead must not keep ticking.
        if (pollSubscribers.size === 0) syncPollTimer();
      }, REMOTE_POLL_INTERVAL_MS);
      // Never hold the app open for a poll tick.
      pollTimer.unref?.();
      return;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function addPollSubscriber(sender: WebContents): void {
    const entry = pollSubscribers.get(sender.id);
    // Re-seat `sender` on every subscribe: after a reload the id is the same
    // object here, but taking the live one costs nothing and cannot go stale.
    if (entry) {
      entry.sender = sender;
      entry.count += 1;
    } else {
      pollSubscribers.set(sender.id, { sender, count: 1 });
    }
    syncPollTimer();
  }

  /** One unsubscribe. The entry survives while other subscribes are still
   *  outstanding — see the refcount rationale on `pollSubscribers`. */
  function releasePollSubscriber(senderId: number): void {
    const entry = pollSubscribers.get(senderId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    pollSubscribers.delete(senderId);
    syncPollTimer();
  }

  /** The renderer is GONE (destroyed, crashed, navigated away). Drops the
   *  whole entry regardless of count — a teardown must never leave a positive
   *  refcount holding the timer open for a renderer that no longer exists. */
  function dropPollSubscriber(senderId: number): void {
    if (!pollSubscribers.delete(senderId)) return;
    syncPollTimer();
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
    client.onResize((e) => pushToOwner(e.attachId, IPC.REMOTE_PANE_RESIZE, e));
    client.onData((e) => pushToOwner(e.attachId, IPC.REMOTE_PANE_DATA, e));
    client.onExit((e) => {
      pushToOwner(e.attachId, IPC.REMOTE_PANE_EXIT, e);
      // The remote session is gone — forget the attach so a re-attach for
      // the same (sender, host, session) opens a FRESH SSE stream instead of
      // idempotently handing back a dead attachId, and so the client's own
      // attachment record stops being a reconnect target.
      detachAttach(e.attachId);
    });
    client.onError((e) => pushToOwner(e.attachId, IPC.REMOTE_PANE_ERROR, e));
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
   *  connection against the remote daemon — and, since #1391, a poll-tick
   *  subscription that would keep main's interval armed for a renderer that no
   *  longer exists. A PLAIN reload (Cmd+R) fires
   *  neither 'destroyed' nor 'render-process-gone' in Electron — it's a
   *  same-WebContents in-place navigation, not a teardown — so
   *  'did-start-navigation' is the only event that observes it; a
   *  same-document navigation (hash change, pushState) is excluded via
   *  `isInPlace`, and a subframe navigation via `isMainFrame`. */
  function installSenderCleanup(sender: WebContents): void {
    if (trackedSenders.has(sender.id)) return;
    trackedSenders.add(sender.id);
    const onGoneListener = (): void => {
      for (const [attachId, record] of [...attachRecords.entries()]) {
        if (record.senderId === sender.id) detachAttach(attachId);
      }
      dropPollSubscriber(sender.id);
      trackedSenders.delete(sender.id);
      // A plain reload (Cmd+R) does NOT destroy the WebContents — it's the
      // same sender re-entering installSenderCleanup on the next
      // REMOTE_PANE_ATTACH. Without removing these listeners here, every
      // reload cycle stacks a fresh set on top of the last.
      sender.removeListener('destroyed', onGoneListener);
      sender.removeListener('render-process-gone', onGoneListener);
      sender.removeListener('did-start-navigation', onNavigationListener);
    };
    const onNavigationListener = (_e: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
      if (!isMainFrame || isInPlace) return;
      onGoneListener();
    };
    sender.once('destroyed', onGoneListener);
    sender.on('render-process-gone', onGoneListener);
    sender.on('did-start-navigation', onNavigationListener);
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

      // Probe BEFORE persisting: an old/unreachable/token-rejected remote
      // never makes it into the store at all.
      const probe = await probeConfig(parsed.origin, parsed.token, fetchImpl);
      if (probe.kind !== 'ok') {
        return { ok: false, error: probeFailureMessage(probe) };
      }

      // store.add() persists via secureWriteTokenFile, which is fail-closed
      // (throws on a chmod/ACL failure). If it throws here, `url` — the raw
      // pasted URL with the bearer token still embedded — is in scope as
      // this handler's first argument, and an uncaught throw would let
      // wrapHandler's args_summary logging see it. Never let that happen:
      // report a generic failure and keep the throw from ever reaching
      // wrapHandler. (wrapHandler.ts also redacts a bare-string URL's
      // `token` param as a second line of defense.)
      let result: ReturnType<typeof store.add>;
      try {
        result = store.add(url, safeLabel);
      } catch {
        return { ok: false, error: 'could not save host' };
      }
      if (!result.ok) return result;

      allowInputCache.set(result.host.id, probe.allowInput);
      return { ok: true, host: { ...result.host, allowInput: probe.allowInput } };
    }));

  ipcMain.removeHandler(IPC.REMOTE_HOSTS_PAIR);
  ipcMain.handle(IPC.REMOTE_HOSTS_PAIR, wrapHandler(IPC.REMOTE_HOSTS_PAIR,
    async (
      _e: IpcMainInvokeEvent,
      rawOrigin: unknown,
      rawCode: unknown,
      label?: unknown,
    ): Promise<
      | { ok: true; host: RemoteHostPublic }
      | { ok: false; reason: PairFailureReason; attemptsLeft?: number }
    > => {
      const originInput = assertString(rawOrigin, 'origin');
      const code = assertString(rawCode, 'code').trim();
      const safeLabel = label === undefined ? undefined : assertString(label, 'label');

      let origin: string;
      try {
        const u = new URL(originInput);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return { ok: false, reason: 'invalid-origin' };
        }
        origin = u.origin;
      } catch {
        return { ok: false, reason: 'invalid-origin' };
      }

      if (store.list().some((h) => h.origin === origin)) {
        return { ok: false, reason: 'already-registered' };
      }

      const exchange = await exchangePairCode(origin, code, fetchImpl);
      if (!exchange.ok) return exchange;

      // Probe BEFORE persisting — same compatibility gate as hostsAdd, so a
      // pre-remote-attach remote never makes it into the store even though
      // the code exchange itself succeeded. An 'unauthorized' outcome here
      // would mean the token we JUST minted was rejected on the very next
      // request — treated the same as 'incompatible' rather than inventing
      // a reason that would wrongly imply the CODE was wrong.
      const probe = await probeConfig(origin, exchange.token, fetchImpl);
      if (probe.kind !== 'ok') {
        return { ok: false, reason: 'incompatible' };
      }

      // store.addDirect() persists via secureWriteTokenFile, which is
      // fail-closed (throws on a chmod/ACL failure). Mirrors hostsAdd's C1
      // discipline — never let that throw escape with the minted token
      // still in scope as an in-flight local.
      let result: ReturnType<typeof store.addDirect>;
      try {
        result = store.addDirect(origin, exchange.token, safeLabel);
      } catch {
        return { ok: false, reason: 'pairing-failed' };
      }
      if (!result.ok) return { ok: false, reason: 'already-registered' };

      allowInputCache.set(result.host.id, probe.allowInput);
      return { ok: true, host: { ...result.host, allowInput: probe.allowInput } };
    }));

  ipcMain.removeHandler(IPC.REMOTE_HOSTS_REMOVE);
  ipcMain.handle(IPC.REMOTE_HOSTS_REMOVE, wrapHandler(IPC.REMOTE_HOSTS_REMOVE,
    async (_e: IpcMainInvokeEvent, id: unknown): Promise<boolean> => {
      const hostId = assertString(id, 'id');
      const removed = store.remove(hostId);
      if (!removed) return false;

      // A descriptor pointing at an unregistered host can never be restored
      // (no token to reach it with), so it must not outlive the host. The
      // write is best-effort ON PURPOSE: the host is already gone from the
      // store by now, and letting a disk failure escape here would report a
      // removal that actually happened as a failure.
      try {
        attachments.removeByHost(hostId);
      } catch { /* see above — an orphan descriptor restores as a stale row */ }
      syncAttentionSubs();
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
      if (probe.kind === 'ok') allowInputCache.set(id, probe.allowInput);

      const client = getOrCreateClient(id);
      if (!client) return { ok: false, error: 'unknown host' };
      try {
        const res = await client.listWorkspaces();
        return { ok: true, workspaces: res.workspaces };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }));

  ipcMain.removeHandler(IPC.REMOTE_WORKSPACE_CREATE);
  ipcMain.handle(IPC.REMOTE_WORKSPACE_CREATE, wrapHandler(IPC.REMOTE_WORKSPACE_CREATE,
    async (
      _e: IpcMainInvokeEvent,
      hostId: unknown,
      workspaceId: unknown,
      cwd?: unknown,
    ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> => {
      const id = assertString(hostId, 'hostId');
      const wsId = assertString(workspaceId, 'workspaceId');
      const safeCwd = cwd === undefined ? undefined : assertString(cwd, 'cwd');
      const client = getOrCreateClient(id);
      if (!client) return { ok: false, error: 'unknown host' };
      try {
        const { sessionId } = await client.createWorkspace(wsId, safeCwd);
        return { ok: true, sessionId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }));

  // #1129 — the teardown twin of REMOTE_WORKSPACE_CREATE. Closing a
  // remote-terminal tab detaches its SSE stream; without this the shell it
  // minted (and the one-shot workspace row the daemon derives from that
  // session's WMUX_WORKSPACE_ID) outlives the tab forever.
  ipcMain.removeHandler(IPC.REMOTE_SESSION_CLOSE);
  ipcMain.handle(IPC.REMOTE_SESSION_CLOSE, wrapHandler(IPC.REMOTE_SESSION_CLOSE,
    async (
      _e: IpcMainInvokeEvent,
      hostId: unknown,
      sessionId: unknown,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const id = assertString(hostId, 'hostId');
      const session = assertString(sessionId, 'sessionId');
      const client = getOrCreateClient(id);
      if (!client) return { ok: false, error: 'unknown host' };
      // DESTROY FIRST, DETACH AFTER — order matters, and the intuitive order
      // is the wrong one. Detaching first would be failure-destructive: if
      // the DELETE then fails (host offline, or a 403 after --allow-input was
      // revoked), the session is still alive but every mirror of it has been
      // cut, with no live attach left to retry from. The remote daemon's
      // handleSessionDelete does not refuse a delete while SSE streams are
      // open, so there is nothing to gain by going the other way.
      try {
        await client.closeSession(session);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      // The session is gone. Drop every live attach on this (host, session) —
      // for any sender, since a session can legitimately be mirrored from
      // more than one place — so nothing is left feeding the client's
      // reconnect loop a target that no longer exists.
      for (const [attachId, record] of [...attachRecords.entries()]) {
        if (record.hostId === id && record.sessionId === session) detachAttach(attachId);
      }
      return { ok: true };
    }));

  // Attach descriptors — the persistence half of "attachments survive a
  // reload". Deliberately independent of the SSE attach lifecycle below: the
  // reload teardown in installSenderCleanup still kills every live stream (a
  // stale SSE connection must die), and these records are what lets the
  // renderer rebuild the attachments from scratch afterwards.
  ipcMain.removeHandler(IPC.REMOTE_ATTACHMENTS_LIST);
  ipcMain.handle(IPC.REMOTE_ATTACHMENTS_LIST, wrapHandler(IPC.REMOTE_ATTACHMENTS_LIST,
    async (): Promise<RemoteAttachmentDescriptor[]> => attachments.list()));

  ipcMain.removeHandler(IPC.REMOTE_ATTACHMENTS_ADD);
  ipcMain.handle(IPC.REMOTE_ATTACHMENTS_ADD, wrapHandler(IPC.REMOTE_ATTACHMENTS_ADD,
    async (_e: IpcMainInvokeEvent, descriptor: unknown): Promise<boolean> => {
      if (typeof descriptor !== 'object' || descriptor === null) {
        throw new Error('descriptor is required');
      }
      const d = descriptor as Record<string, unknown>;
      // #1086 — the local aliases ride the same descriptor. Validated here, at
      // the IPC boundary: the label is trimmed and capped at the rename
      // input's 64-char limit, and the color must be a known palette id.
      const label = typeof d.label === 'string' ? d.label.trim().slice(0, 64) : '';
      const color = normalizeWorkspaceColor(d.color);
      const entry: RemoteAttachmentDescriptor = {
        key: assertString(d.key, 'key'),
        hostId: assertString(d.hostId, 'hostId'),
        hostLabel: typeof d.hostLabel === 'string' ? d.hostLabel : '',
        workspaceId: assertString(d.workspaceId, 'workspaceId'),
        name: typeof d.name === 'string' ? d.name : '',
        ...(label ? { label } : {}),
        ...(color ? { color } : {}),
      };
      // The key is what every later lookup addresses this record by, so it
      // must actually derive from the pair it claims to describe — a record
      // filed under someone else's key would be unremovable by its owner and
      // would restore as a row pointing at the wrong workspace.
      if (entry.key !== remoteAttachmentKey(entry.hostId, entry.workspaceId)) return false;
      // Refuse to record an attachment for a host we do not have — it could
      // never be restored, and would leak a row into the sidebar forever.
      if (!store.get(entry.hostId)) return false;
      // A write failure must not reject: the attach itself already succeeded
      // in the renderer, and losing persistence only costs this attachment
      // its restore-after-reload.
      try {
        attachments.add(entry);
      } catch {
        return false;
      }
      syncAttentionSubs();
      return true;
    }));

  ipcMain.removeHandler(IPC.REMOTE_ATTACHMENTS_REMOVE);
  ipcMain.handle(IPC.REMOTE_ATTACHMENTS_REMOVE, wrapHandler(IPC.REMOTE_ATTACHMENTS_REMOVE,
    async (_e: IpcMainInvokeEvent, key: unknown): Promise<boolean> => {
      try {
        const k = assertString(key, 'key');
        // Same derivation gate as add: only a well-formed
        // `<hostId>:<workspaceId>` addresses a record, so a key that cannot
        // have been minted by the attach path deletes nothing.
        if (!parseRemoteAttachmentKey(k)) return false;
        const removed = attachments.remove(k);
        syncAttentionSubs();
        return removed;
      } catch {
        return false;
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

  // #1322 — a remote-terminal mirror's own fit-to-box request, resolved
  // through the attachId the way write is: the record it was minted with
  // (REMOTE_PANE_ATTACH) is the only place this handler learns which host and
  // session `attachId` names. An unknown attachId (raced a detach, or a stale
  // renderer reference) resolves `{ ok: false }` rather than throwing — the
  // caller's remedy either way is "wait for the next box-size change", not a
  // crash. The actual applied geometry, if granted, reaches this same mirror
  // through its own SSE stream (REMOTE_PANE_RESIZE below), fired by the
  // daemon for every attached viewer of that session — this invoke's answer
  // only says whether the route accepted the request at all.
  ipcMain.removeHandler(IPC.REMOTE_PANE_RESIZE_REQUEST);
  ipcMain.handle(IPC.REMOTE_PANE_RESIZE_REQUEST, wrapHandler(IPC.REMOTE_PANE_RESIZE_REQUEST,
    async (
      _e: IpcMainInvokeEvent,
      attachId: unknown,
      cols: unknown,
      rows: unknown,
    ): Promise<{ ok: true; cols: number; rows: number } | { ok: false; reason: string }> => {
      const id = assertString(attachId, 'attachId');
      if (typeof cols !== 'number' || typeof rows !== 'number') {
        return { ok: false, reason: 'cols and rows must be numbers' };
      }
      const record = attachRecords.get(id);
      if (!record) return { ok: false, reason: 'unknown attach' };
      const client = clients.get(record.hostId);
      if (!client) return { ok: false, reason: 'unknown host' };
      try {
        return await client.resizeSession(record.sessionId, cols, rows);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }));

  // #1391 — the renderer asks for the unthrottled cadence while (and only
  // while) it has something attached. One tick per WebContents per round
  // however many times it subscribed; the count only decides when the LAST
  // unsubscribe lands (see `pollSubscribers`).
  ipcMain.removeHandler(IPC.REMOTE_POLL_SUBSCRIBE);
  ipcMain.handle(IPC.REMOTE_POLL_SUBSCRIBE, wrapHandler(IPC.REMOTE_POLL_SUBSCRIBE,
    async (e: IpcMainInvokeEvent): Promise<boolean> => {
      // Shared with the pane attaches: one listener set per sender covers
      // reload/crash/destroy for both the SSE attaches and this subscription.
      installSenderCleanup(e.sender);
      addPollSubscriber(e.sender);
      return true;
    }));

  ipcMain.removeHandler(IPC.REMOTE_POLL_UNSUBSCRIBE);
  ipcMain.handle(IPC.REMOTE_POLL_UNSUBSCRIBE, wrapHandler(IPC.REMOTE_POLL_UNSUBSCRIBE,
    async (e: IpcMainInvokeEvent): Promise<boolean> => {
      releasePollSubscriber(e.sender.id);
      return true;
    }));

  const onWillQuit = (): void => {
    for (const client of clients.values()) client.detachAll();
    pollSubscribers.clear();
    syncPollTimer();
    for (const sub of attentionSubs.values()) sub.stop();
    attentionSubs.clear();
  };
  app.on('will-quit', onWillQuit);

  // Restore after an app restart: the attach roster is on disk, so the
  // subscriptions must come back with it rather than waiting for the user to
  // re-attach something.
  try {
    syncAttentionSubs();
  } catch {
    // Never let a notification subscription take the app down on boot — the
    // roster is restored, the alerts are not, and the next attach retries.
  }

  return () => {
    ipcMain.removeHandler(IPC.REMOTE_HOSTS_LIST);
    ipcMain.removeHandler(IPC.REMOTE_HOSTS_ADD);
    ipcMain.removeHandler(IPC.REMOTE_HOSTS_PAIR);
    ipcMain.removeHandler(IPC.REMOTE_HOSTS_REMOVE);
    ipcMain.removeHandler(IPC.REMOTE_WORKSPACES_LIST);
    ipcMain.removeHandler(IPC.REMOTE_WORKSPACE_CREATE);
    ipcMain.removeHandler(IPC.REMOTE_SESSION_CLOSE);
    ipcMain.removeHandler(IPC.REMOTE_ATTACHMENTS_LIST);
    ipcMain.removeHandler(IPC.REMOTE_ATTACHMENTS_ADD);
    ipcMain.removeHandler(IPC.REMOTE_ATTACHMENTS_REMOVE);
    ipcMain.removeHandler(IPC.REMOTE_PANE_ATTACH);
    ipcMain.removeHandler(IPC.REMOTE_PANE_DETACH);
    ipcMain.removeAllListeners(IPC.REMOTE_PANE_WRITE);
    ipcMain.removeHandler(IPC.REMOTE_PANE_RESIZE_REQUEST);
    ipcMain.removeHandler(IPC.REMOTE_POLL_SUBSCRIBE);
    ipcMain.removeHandler(IPC.REMOTE_POLL_UNSUBSCRIBE);
    // #1391 — the timer is the one thing here that outlives `removeHandler`.
    // Every other resource above is reachable only through a route that has
    // just been unregistered; an interval keeps firing on its own, against
    // renderers whose subscribe can no longer be re-answered. (`src/main/index.ts`
    // discards this disposer today, so in production this runs only under test —
    // but the contract a disposer states must be true, or the first caller that
    // does keep it inherits a live timer.)
    pollSubscribers.clear();
    syncPollTimer();
    app.removeListener('will-quit', onWillQuit);
  };
}
