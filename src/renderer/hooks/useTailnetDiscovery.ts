import { useCallback, useEffect, useRef, useState } from 'react';
import type { TailscaleCheckItem, TailscaleChecklist } from '../../shared/web';
import type { ListenProblemReport } from '../../shared/netListen';
import type {
  A2aDiscoverConnectResult,
  A2aDiscoverOpenResult,
  A2aDiscoverOutgoingState,
  A2aDiscoverOutgoingStatus,
  A2aDiscoverPc,
  A2aDiscoverReceiveView,
  A2aDiscoverRequestView,
  A2aDiscoverScanResult,
  A2aDiscoverStatus,
  A2aRemoteJoinError,
} from '../../shared/rpc';
import { blockingFailure } from '../components/Remote/tailnetCheck';
import { refreshA2aRemote } from './useA2aRemoteBridge';

// ─── Connect a PC › Tailscale: find PCs on the tailnet, pair by matching codes ─
//
// The daemon owns the discovery window (5 minutes, its caps, the card) and
// this PC's one outgoing request, and pushes nothing, so this hook polls
// about once a second while a window this panel opened is open or a request
// it sent is live, and not at all otherwise. Nothing here runs on show: the
// tailnet is scanned only on Find PCs, and the window opens only on Make
// discoverable. When the panel goes away (the dialog closed), a window it
// opened is closed and a request it sent is withdrawn.

/** How often an open window, or a live outgoing request, is read while it is shown. */
export const DISCOVER_POLL_MS = 1_000;
/** After Find PCs, the tailnet is scanned again this often… */
export const DISCOVER_RESCAN_MS = 5_000;
/** …for this long; then the list offers Search again. */
export const DISCOVER_RESCAN_FOR_MS = 120_000;

/** Tailscale is up on this PC: installed, signed in, and this PC on the tailnet. */
export function tailscaleReady(list: TailscaleChecklist | null): boolean {
  return list !== null && list.items.filter((i) => i.id !== 'peer').every((i) => i.state === 'pass');
}

/**
 * The failed check that surely stops discovery on this PC, said before
 * anything is pressed. No other device online (`peer`) does not: one may come
 * online while this PC is discoverable. An unreadable status or this PC
 * offline from Tailscale's control server does not either: the daemon reads
 * Tailscale itself when the window opens and says so then.
 */
export function tailscaleBlocker(list: TailscaleChecklist | null): TailscaleCheckItem | null {
  const item = blockingFailure(list);
  return item && item.id !== 'peer' ? item : null;
}

export type A2aDiscoverOpenRefused = Extract<A2aDiscoverOpenResult, { ok: false }>;

export interface ReceiveInputs {
  tailscale: TailscaleChecklist | null;
  /** A2A is off: the button turns it on. */
  a2aOff: boolean;
  /** `discover.open` is in flight. */
  starting: boolean;
  /** Why the last `discover.open` did not open a window. */
  refusal: A2aDiscoverOpenRefused | null;
  status: A2aDiscoverStatus | null;
  /** This panel opened a window, so how the last one ended is this panel's to say. */
  opened: boolean;
}

/** What the Tailscale tab's "This PC" section shows. */
export function receiveViewOf(i: ReceiveInputs): A2aDiscoverReceiveView {
  if (i.starting) return { kind: 'starting' };
  const r = i.refusal;
  if (r) {
    switch (r.reason) {
      case 'tailscale-not-ready':
        if (r.check) return { kind: 'tailscale-not-ready', check: r.check };
        break;
      case 'no-tailnet-ipv4':
        return { kind: 'no-tailnet-ipv4' };
      case 'tailnet-range-on-lan':
      case 'tailscale-whois-unsupported':
        return { kind: 'unavailable', reason: r.reason };
      case 'listen-failed':
        return {
          kind: 'listen-failed',
          port: r.listen?.lastErrorPort ?? r.listen?.port ?? 0,
          lastError: r.listen?.lastError ?? null,
          lastErrorCode: r.listen?.lastErrorCode ?? null,
        };
      case 'a2a-off':
        return { kind: 'idle', a2aOff: true };
      case 'cancelled':
        // Stopped while it was opening: back to the button, A2A as it was.
        break;
    }
  }
  const s = i.status;
  if (s?.open) {
    if (s.incoming) return { kind: s.incoming.state === 'deciding' ? 'approval' : 'allowed', incoming: s.incoming };
    const last = s.lastOutcome;
    if (last?.outcome === 'denied' && last.device) return { kind: 'denied', device: last.device, expiresAt: s.expiresAt };
    if (last?.outcome === 'refused' && last.reason) return { kind: 'refused', reason: last.reason, ip: last.ip, expiresAt: s.expiresAt };
    // A request withdrawn, or whose card ran out, leaves the window as it was.
    return { kind: 'discoverable', name: s.name, expiresAt: s.expiresAt ?? 0 };
  }
  // The person's own Stop needs no line: the section is back to its button.
  if (i.opened && s?.ended && s.ended.reason !== 'stopped') {
    const e = s.ended;
    if (e.reason === 'paired') {
      if (e.peer) return { kind: 'paired', peer: e.peer };
    } else if (e.reason === 'grant-expired') {
      return { kind: 'grant-expired' };
    } else {
      return { kind: 'ended', reason: e.reason };
    }
  }
  const blocker = tailscaleBlocker(i.tailscale);
  if (blocker) return { kind: 'tailscale-not-ready', check: blocker };
  return { kind: 'idle', a2aOff: i.a2aOff };
}

export type A2aDiscoverScanRefused = Extract<A2aDiscoverScanResult, { ok: false }>;
export type A2aDiscoverConnectRefused = Extract<A2aDiscoverConnectResult, { ok: false }>;

/** The outgoing states the request is still running in (polled, and withdrawn on close). */
const OUTGOING_LIVE: ReadonlySet<A2aDiscoverOutgoingState> = new Set(['asking', 'waiting', 'confirm', 'joining']);

/** `connect` failures worded like an invite join's (`settings.a2aRemoteJoinError.*`). */
const CONNECT_AS_JOIN_ERROR: Partial<Record<A2aDiscoverConnectRefused['error'], A2aRemoteJoinError>> = {
  'fingerprint-mismatch': 'fingerprint-mismatch',
  timeout: 'timeout',
  'connect-refused': 'connect-refused',
  protocol: 'protocol',
  'version-mismatch': 'protocol',
  'rate-limited': 'rate-limited',
};

export interface RequestInputs {
  tailscale: TailscaleChecklist | null;
  /** A scan is in flight. */
  scanning: boolean;
  /** The last scan's answer. */
  scan: { pcs: A2aDiscoverPc[]; checked: number } | null;
  scanRefusal: A2aDiscoverScanRefused | null;
  /** `connect` is in flight for this PC. */
  asking: A2aDiscoverPc | null;
  /** The last `connect` that did not reach the code. */
  connectFail: { pc: A2aDiscoverPc; result: A2aDiscoverConnectRefused } | null;
  /** The outgoing request as last read; null once withdrawn or before any. */
  outgoing: A2aDiscoverOutgoingStatus | null;
}

/** What the Tailscale tab's "PCs found on your tailnet" section shows. */
export function requestViewOf(i: RequestInputs): A2aDiscoverRequestView {
  if (i.asking) return { kind: 'asking', pc: i.asking };
  const o = i.outgoing;
  if (o?.pc) {
    const pc = o.pc;
    switch (o.state) {
      case 'asking':
        return { kind: 'asking', pc };
      case 'waiting':
      case 'confirm':
        if (o.code && o.expiresAt !== null) return { kind: o.state, pc, code: o.code, expiresAt: o.expiresAt };
        return { kind: 'asking', pc };
      case 'joining':
        return { kind: 'joining', pc };
      case 'joined':
        if (o.host) return { kind: 'joined', host: o.host };
        break;
      case 'denied':
        return { kind: 'denied', pc };
      case 'expired':
        return { kind: 'timed-out', pc };
      case 'gone':
        return { kind: 'gone', pc };
      case 'failed':
        return { kind: 'join-error', pc, error: o.error ?? 'failed', ...(o.detail ? { detail: o.detail } : {}) };
      default:
        // Withdrawn, or no request: back to the list.
        break;
    }
  }
  const f = i.connectFail;
  if (f) {
    const r = f.result;
    if (r.error === 'busy') return { kind: 'busy', pc: f.pc, ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) };
    if (r.error === 'refused') return { kind: 'refused', pc: f.pc, reason: r.reason ?? 'unidentified' };
    if (r.error === 'gone' || r.error === 'not-found') return { kind: 'gone', pc: f.pc };
    return { kind: 'join-error', pc: f.pc, error: CONNECT_AS_JOIN_ERROR[r.error] ?? 'failed', ...(r.detail ? { detail: r.detail } : {}) };
  }
  const r = i.scanRefusal;
  if (r) {
    if (r.reason === 'tailscale-not-ready') return { kind: 'tailscale-not-ready', check: r.check };
    if (r.reason === 'tailnet-range-on-lan') return { kind: 'unavailable', reason: r.reason };
    return { kind: 'no-tailnet-ipv4' };
  }
  // A re-scan keeps the list it has, so the rows do not blink every 5 s.
  if (i.scan) return i.scan.pcs.length > 0 ? { kind: 'results', pcs: i.scan.pcs, checked: i.scan.checked } : { kind: 'empty', checked: i.scan.checked };
  if (i.scanning) return { kind: 'searching', pcs: [] };
  const blocker = tailscaleBlocker(i.tailscale);
  if (blocker) return { kind: 'tailscale-not-ready', check: blocker };
  return { kind: 'idle' };
}

export interface TailnetDiscoveryOptions {
  /** The Tailscale check the dialog ran when it opened (read-only, never re-run here). */
  tailscale: TailscaleChecklist | null;
  a2aOff: boolean;
  /** A window turned A2A on, or ended and may have turned it off again: re-read the listener. */
  onA2aChanged?: () => void;
  /** A PC paired through a window this panel opened. */
  onPaired?: (peer: { hostId: string; name: string }) => void;
  /** This PC joined a PC it asked. */
  onJoined?: (host: { hostId: string; name: string }) => void;
}

export interface TailnetDiscovery {
  receive: A2aDiscoverReceiveView;
  /** This PC's machine name, as the last window reported it ('' before one). */
  selfName: string;
  /** When the open window ends on its own; null with none open. */
  expiresAt: number | null;
  /** For the countdowns; ticks with the poll. */
  now: number;
  /** Stop, Allow or Deny is in flight. */
  busy: boolean;
  /** The last action could not reach the daemon. */
  failed: boolean;
  makeDiscoverable: () => void;
  stop: () => void;
  decide: (allow: boolean) => void;
  /** "Use port N" after the listener could not start: move it, then open again. */
  moveToPort: (port: number) => void;
  /** Why the listener could not bind, as the daemon read it before turning A2A off again. */
  listenReport: ListenProblemReport | null;
  request: A2aDiscoverRequestView;
  /** The last scan's list, kept under a request's outcome line. */
  scan: { pcs: A2aDiscoverPc[]; checked: number; offline: number } | null;
  /** Find PCs was pressed under 2 minutes ago: the list still re-scans every 5 s. */
  rescanning: boolean;
  find: () => void;
  connect: (pc: A2aDiscoverPc) => void;
  /** Withdraw the outgoing request. */
  cancel: () => void;
  /** The other PC allowed and the codes match: pair. */
  confirm: () => void;
  /** Confirm is in flight. */
  confirming: boolean;
}

export function useTailnetDiscovery(opts: TailnetDiscoveryOptions): TailnetDiscovery {
  const api = window.electronAPI?.a2aRemote;
  const [status, setStatus] = useState<A2aDiscoverStatus | null>(null);
  const [refusal, setRefusal] = useState<A2aDiscoverOpenRefused | null>(null);
  const [starting, setStarting] = useState(false);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [scan, setScan] = useState<{ pcs: A2aDiscoverPc[]; checked: number; offline: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanRefusal, setScanRefusal] = useState<A2aDiscoverScanRefused | null>(null);
  const [rescanUntil, setRescanUntil] = useState<number | null>(null);
  const [asking, setAsking] = useState<A2aDiscoverPc | null>(null);
  const [connectFail, setConnectFail] = useState<RequestInputs['connectFail']>(null);
  const [outgoing, setOutgoing] = useState<A2aDiscoverOutgoingStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** The window this panel opened and has not seen end. */
  const live = useRef(false);
  /** A request this panel sent (or is sending) and has not seen end. */
  const sent = useRef(false);
  /** Bumped by Cancel: a `connect` that answers after it is withdrawn, not shown. */
  const connectGen = useRef(0);
  const scanInFlight = useRef(false);
  /** The panel went away (the dialog closed). */
  const disposed = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;
  // Read when something lands, so a parent passing new functions every render restarts nothing.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Closing the dialog closes a window this panel left open.
  useEffect(() => {
    // A remount (StrictMode re-runs effects) is alive again.
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (live.current) {
        live.current = false;
        void window.electronAPI?.a2aRemote?.discoverClose?.().catch(() => undefined);
      }
      if (sent.current) {
        sent.current = false;
        void window.electronAPI?.a2aRemote?.discoverOutgoingCancel?.().catch(() => undefined);
      }
    };
  }, []);

  const apply = useCallback((next: A2aDiscoverStatus) => {
    setStatus(next);
    setNow(Date.now());
    if (!live.current || next.open) return;
    live.current = false;
    if (next.ended?.reason === 'paired' && next.ended.peer) {
      void refreshA2aRemote();
      optsRef.current.onPaired?.(next.ended.peer);
    }
    // A window that turned A2A on turns it off again when it ends without a pairing.
    optsRef.current.onA2aChanged?.();
  }, []);

  const polling = opened && status?.open === true;
  useEffect(() => {
    if (!polling || !api?.discoverStatus) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void api.discoverStatus().then(
        (next) => { if (!disposed.current) apply(next); },
        () => { /* the daemon is away; the next tick tries again */ },
      );
    }, DISCOVER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling, api, apply]);

  const makeDiscoverable = useCallback(async () => {
    if (!api?.discoverOpen) return;
    // One role at a time: a PC being found stops looking for others.
    setRescanUntil(null);
    setRefusal(null);
    setFailed(false);
    setStarting(true);
    const turnOn = optsRef.current.a2aOff;
    let r: A2aDiscoverOpenResult | null;
    try {
      r = await api.discoverOpen(turnOn ? { turnOn: true } : {});
    } catch {
      r = null;
    }
    // Closed while the window was opening: nobody will see it, so close it.
    if (disposed.current) {
      if (r?.ok) void api.discoverClose().catch(() => undefined);
      return;
    }
    setStarting(false);
    if (!r) { setFailed(true); return; }
    // The listener was turned on (or turned out to be off): the dialog and the page follow.
    if (turnOn || (!r.ok && r.reason === 'a2a-off')) optsRef.current.onA2aChanged?.();
    if (!r.ok) { setRefusal(r); return; }
    live.current = r.status.open;
    setOpened(true);
    setStatus(r.status);
    setNow(Date.now());
  }, [api]);

  const stop = useCallback(async () => {
    if (!api?.discoverClose) return;
    setBusy(true);
    setFailed(false);
    try {
      // What Stop answers is not read: the window's state comes from the status read after it.
      await api.discoverClose();
      const next = await api.discoverStatus();
      if (!disposed.current) apply(next);
    } catch {
      if (!disposed.current) setFailed(true);
    } finally {
      if (!disposed.current) setBusy(false);
    }
  }, [api, apply]);

  const decide = useCallback(async (allow: boolean) => {
    const requestId = statusRef.current?.incoming?.requestId;
    if (!api?.discoverDecide || !requestId) return;
    setBusy(true);
    setFailed(false);
    try {
      // `ok` false means that request already left the card; the status says what is there now.
      const r = await api.discoverDecide({ requestId, allow });
      if (!disposed.current) apply(r.status);
    } catch {
      if (!disposed.current) setFailed(true);
    } finally {
      if (!disposed.current) setBusy(false);
    }
  }, [api, apply]);

  const moveToPort = useCallback(async (port: number) => {
    if (!api?.configure) return;
    setBusy(true);
    try {
      await api.configure({ port });
    } catch {
      if (!disposed.current) { setBusy(false); setFailed(true); }
      return;
    }
    if (disposed.current) return;
    setBusy(false);
    optsRef.current.onA2aChanged?.();
    await makeDiscoverable();
  }, [api, makeDiscoverable]);

  // ── Requesting side ──

  /**
   * One scan. Find PCs (`pressed`) says when it fails; a timed re-scan that
   * fails or is refused keeps the list it has and stops re-scanning quietly.
   */
  const runScan = useCallback(async (pressed: boolean) => {
    if (!api?.discoverScan || scanInFlight.current) return;
    scanInFlight.current = true;
    setScanning(true);
    let r: A2aDiscoverScanResult | null;
    try {
      r = await api.discoverScan();
    } catch {
      r = null;
    }
    scanInFlight.current = false;
    if (disposed.current) return;
    setScanning(false);
    if (!r || !r.ok) {
      setRescanUntil(null);
      if (!pressed) return;
      if (r) { setScanRefusal(r); setScan(null); } else setFailed(true);
      return;
    }
    setScanRefusal(null);
    setScan({ pcs: r.pcs, checked: r.checked, offline: r.skipped.offline });
  }, [api]);

  const find = useCallback(async () => {
    setFailed(false);
    setConnectFail(null);
    setScanRefusal(null);
    setOutgoing(null);
    setRescanUntil(Date.now() + DISCOVER_RESCAN_FOR_MS);
    await runScan(true);
  }, [runScan]);

  // Re-scan every 5 s for 2 minutes after Find PCs, then offer Search again.
  // Never while a request is out or this PC is discoverable.
  const requestLive = asking !== null || (outgoing !== null && OUTGOING_LIVE.has(outgoing.state));
  const rescanning = rescanUntil !== null;
  useEffect(() => {
    if (rescanUntil === null || requestLive || polling) return;
    const timer = window.setInterval(() => { void runScan(false); }, DISCOVER_RESCAN_MS);
    return () => window.clearInterval(timer);
  }, [rescanUntil, requestLive, polling, runScan]);
  // Search again shows at the 2-minute mark itself, not at the next 5 s tick.
  useEffect(() => {
    if (rescanUntil === null) return;
    const timer = window.setTimeout(() => setRescanUntil(null), Math.max(0, rescanUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [rescanUntil]);

  const applyOutgoing = useCallback((next: A2aDiscoverOutgoingStatus) => {
    setNow(Date.now());
    if (next.state === 'idle' || next.state === 'cancelled') {
      sent.current = false;
      setOutgoing(null);
      return;
    }
    // A read without the PC (the daemon restarted) keeps the PC this panel asked.
    // An allowance left unconfirmed runs out on two deadlines about 1.5 s apart
    // (this PC's and the other's), ending `expired` or `gone`: both read as timed out.
    setOutgoing((prev) => {
      const ran = next.state === 'gone' && prev?.state === 'confirm' ? { ...next, state: 'expired' as const } : next;
      return ran.pc || !prev?.pc ? ran : { ...ran, pc: prev.pc };
    });
    if (OUTGOING_LIVE.has(next.state)) return;
    sent.current = false;
    if (next.state === 'joined' && next.host) {
      setRescanUntil(null);
      void refreshA2aRemote();
      optsRef.current.onJoined?.({ hostId: next.host.hostId, name: next.host.name });
    }
  }, []);

  const outgoingPolling = outgoing !== null && OUTGOING_LIVE.has(outgoing.state);
  useEffect(() => {
    if (!outgoingPolling || !api?.discoverOutgoingStatus) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void api.discoverOutgoingStatus().then(
        (next) => { if (!disposed.current) applyOutgoing(next); },
        () => { /* the daemon is away; the next tick tries again */ },
      );
    }, DISCOVER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [outgoingPolling, api, applyOutgoing]);

  const connect = useCallback(async (pc: A2aDiscoverPc) => {
    if (!api?.discoverConnect) return;
    const gen = ++connectGen.current;
    setFailed(false);
    setConnectFail(null);
    setOutgoing(null);
    setAsking(pc);
    sent.current = true;
    let r: A2aDiscoverConnectResult | null;
    try {
      // Only the address from the last scan: the daemon dials the port and pins the certificate its own scan saw.
      r = await api.discoverConnect({ ip: pc.ip });
    } catch {
      r = null;
    }
    // Withdrawn (Cancel, or the dialog closed) while it was asking: nobody will compare this code.
    if (disposed.current || gen !== connectGen.current) {
      if (r?.ok) void api.discoverOutgoingCancel().catch(() => undefined);
      return;
    }
    setAsking(null);
    if (!r || !r.ok) {
      sent.current = false;
      if (r) setConnectFail({ pc, result: r });
      else setFailed(true);
      return;
    }
    setOutgoing({ state: 'waiting', sessionId: r.sessionId, pc, code: r.code, expiresAt: r.expiresAt });
    setNow(Date.now());
  }, [api]);

  const cancel = useCallback(async () => {
    if (!api?.discoverOutgoingCancel) return;
    connectGen.current += 1;
    sent.current = false;
    setAsking(null);
    try {
      // What Cancel answers is not read: the request's state comes from the status read after it.
      await api.discoverOutgoingCancel();
      const next = await api.discoverOutgoingStatus();
      if (!disposed.current) applyOutgoing(next);
    } catch {
      if (!disposed.current) setOutgoing(null);
    }
  }, [api, applyOutgoing]);

  const confirm = useCallback(async () => {
    if (!api?.discoverOutgoingConfirm) return;
    setConfirming(true);
    setFailed(false);
    try {
      // Only now does this PC pair: the other PC allowed, and its person checked the codes.
      const next = await api.discoverOutgoingConfirm();
      if (!disposed.current) applyOutgoing(next);
    } catch {
      if (!disposed.current) setFailed(true);
    } finally {
      if (!disposed.current) setConfirming(false);
    }
  }, [api, applyOutgoing]);

  return {
    receive: receiveViewOf({ tailscale: opts.tailscale, a2aOff: opts.a2aOff, starting, refusal, status, opened }),
    selfName: status?.name ?? '',
    expiresAt: status?.open ? status.expiresAt : null,
    now,
    busy,
    failed,
    makeDiscoverable: () => void makeDiscoverable(),
    stop: () => void stop(),
    decide: (allow) => void decide(allow),
    moveToPort: (port) => void moveToPort(port),
    listenReport: refusal?.reason === 'listen-failed' ? refusal.listen?.report ?? null : null,
    request: requestViewOf({ tailscale: opts.tailscale, scanning, scan, scanRefusal, asking, connectFail, outgoing }),
    scan,
    rescanning,
    find: () => void find(),
    connect: (pc) => void connect(pc),
    cancel: () => void cancel(),
    confirm: () => void confirm(),
    confirming,
  };
}
