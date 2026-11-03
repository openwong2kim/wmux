import { useCallback, useEffect, useRef, useState } from 'react';
import type { TailscaleCheckItem, TailscaleChecklist } from '../../shared/web';
import type { ListenProblemReport } from '../../shared/netListen';
import type { A2aDiscoverOpenResult, A2aDiscoverReceiveView, A2aDiscoverStatus } from '../../shared/rpc';
import { blockingFailure } from '../components/Remote/tailnetCheck';
import { refreshA2aRemote } from './useA2aRemoteBridge';

// ─── Connect a PC › Tailscale: find PCs on the tailnet, pair by matching codes ─
//
// The daemon owns the discovery window (5 minutes, its caps, the card) and
// pushes nothing, so this hook polls it about once a second while a window
// this panel opened is open, and not at all otherwise. Nothing here runs on
// show: the window opens only on Make discoverable. A window this panel
// opened is closed again when the panel goes away (the dialog closed).

/** How often an open window is read while it is shown. */
export const DISCOVER_POLL_MS = 1_000;

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

export interface TailnetDiscoveryOptions {
  /** The Tailscale check the dialog ran when it opened (read-only, never re-run here). */
  tailscale: TailscaleChecklist | null;
  a2aOff: boolean;
  /** A window turned A2A on, or ended and may have turned it off again: re-read the listener. */
  onA2aChanged?: () => void;
  /** A PC paired through a window this panel opened. */
  onPaired?: (peer: { hostId: string; name: string }) => void;
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
  /** The window this panel opened and has not seen end. */
  const live = useRef(false);
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
  };
}
