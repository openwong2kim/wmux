import { useCallback, useEffect, useState } from 'react';
import type { A2aRemoteHostRecordV1 } from '../../shared/a2aRemote';
import type { A2aRemoteJoinError, A2aRemotePairStatus } from '../../shared/rpc';
import { useIpc } from './useIpc';

// ─── Cross-PC A2A invite / join state ────────────────────────────────────────
//
// The invite this PC offers (code, the addresses the other PC tries, which of
// them are tailnet ones, the expiry countdown, the lockout after failed tries)
// and the join of another PC's invite. Shared by Settings › LAN and the
// Remote page's "Connect a PC" dialog, so both run the same daemon calls.

export type A2aJoinOutcome =
  | { ok: true; name: string; host: A2aRemoteHostRecordV1 }
  /** `retryAfterSec`: for a rate-limited try, seconds until the other PC accepts another. */
  | { ok: false; error: A2aRemoteJoinError; retryAfterSec?: number }
  | null;

type JoinResult =
  | { ok: true; name: string; host: A2aRemoteHostRecordV1 }
  | { ok: false; error: A2aRemoteJoinError; retryUntil?: number }
  | null;

export interface A2aInviteState {
  invite: string | null;
  /** The addresses the open invite offers, in the order the other PC tries them. */
  addresses: string[];
  /** Those of `addresses` that are this PC's tailnet addresses. */
  tailnet: string[];
  remainingSec: number | null;
  /** When the open invite expires (epoch ms), or null with none open. */
  expiresAt: number | null;
  lockedSec: number | null;
  copied: boolean;
  /** The last create / cancel / copy failed. */
  failed: boolean;
  joinBusy: boolean;
  joinOutcome: A2aJoinOutcome;
  /** Open an invite; resolves to its text, or null when the daemon refused. */
  create: () => Promise<string | null>;
  cancel: () => Promise<void>;
  /** Copy the open invite (or `text`) to the clipboard. */
  copy: (text?: string) => Promise<boolean>;
  join: (invite: string) => Promise<A2aJoinOutcome>;
  clearJoin: () => void;
  /** Fold in a `pairStatus` read: a redeemed, cancelled or burned invite is gone. */
  applyPairStatus: (pair: A2aRemotePairStatus) => void;
  /** Forget the invite locally (the daemon dropped it, e.g. on a listener restart). */
  forget: () => void;
}

/** How long Copy reads "Copied" after a copy, made by hand or on open. */
export const COPIED_MS = 1500;

export function useA2aInvite(): A2aInviteState {
  const { invoke: ipcInvoke } = useIpc({ silent: ['NOT_FOUND', 'UNKNOWN', 'DAEMON_DISCONNECTED'] });
  const api = window.electronAPI?.a2aRemote;
  const [invite, setInvite] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [tailnet, setTailnet] = useState<string[]>([]);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinResult, setJoinResult] = useState<JoinResult>(null);

  // A 1s tick only while something counts down.
  const retryUntil = joinResult && !joinResult.ok ? joinResult.retryUntil ?? null : null;
  const counting = deadline != null || (lockedUntil != null && lockedUntil > now) || (retryUntil != null && retryUntil > now);
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [counting]);

  const forget = useCallback(() => { setInvite(null); setDeadline(null); }, []);

  const copy = useCallback(async (text?: string): Promise<boolean> => {
    const value = text ?? invite;
    if (!value) return false;
    try {
      await window.clipboardAPI.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  }, [invite]);

  const create = useCallback(async (): Promise<string | null> => {
    if (!api) return null;
    setFailed(false); setCopied(false);
    const r = await ipcInvoke(() => api.pairBegin());
    if (!r.ok) { setFailed(true); return null; }
    setInvite(r.data.invite);
    setAddresses(Array.isArray(r.data.addresses) ? r.data.addresses : []);
    setTailnet(Array.isArray(r.data.tailnet) ? r.data.tailnet : []);
    setDeadline(r.data.expiresAt);
    setNow(Date.now());
    return r.data.invite;
  }, [api, ipcInvoke]);

  const cancel = useCallback(async () => {
    if (!api) return;
    const r = await ipcInvoke(() => api.pairCancel());
    if (r.ok) forget();
  }, [api, ipcInvoke, forget]);

  const join = useCallback(async (text: string): Promise<A2aJoinOutcome> => {
    if (!api || !text.trim()) return null;
    setJoinBusy(true); setJoinResult(null);
    const r = await ipcInvoke(() => api.join(text.trim()));
    setJoinBusy(false);
    if (!r.ok) {
      setJoinResult({ ok: false, error: 'failed' });
      return { ok: false, error: 'failed' };
    }
    if (r.data.ok) {
      const done = { ok: true as const, name: r.data.host.name, host: r.data.host };
      setJoinResult(done);
      return done;
    }
    const after = r.data.retryAfterMs;
    const retry = typeof after === 'number' && after > 0 ? Date.now() + after : undefined;
    setJoinResult({ ok: false, error: r.data.error, ...(retry ? { retryUntil: retry } : {}) });
    return { ok: false, error: r.data.error, ...(retry ? { retryAfterSec: Math.ceil((retry - Date.now()) / 1000) } : {}) };
  }, [api, ipcInvoke]);

  const applyPairStatus = useCallback((pair: A2aRemotePairStatus) => {
    if (pair?.active === false) forget();
    setLockedUntil(typeof pair?.lockedUntil === 'number' ? pair.lockedUntil : null);
  }, [forget]);

  const joinOutcome: A2aJoinOutcome = !joinResult
    ? null
    : joinResult.ok
      ? joinResult
      : {
          ok: false,
          error: joinResult.error,
          ...(joinResult.retryUntil != null ? { retryAfterSec: Math.ceil((joinResult.retryUntil - now) / 1000) } : {}),
        };

  return {
    invite,
    addresses,
    tailnet,
    remainingSec: deadline != null ? Math.ceil((deadline - now) / 1000) : null,
    expiresAt: deadline,
    lockedSec: lockedUntil != null ? Math.ceil((lockedUntil - now) / 1000) : null,
    copied,
    failed,
    joinBusy,
    joinOutcome,
    create,
    cancel,
    copy,
    join,
    clearJoin: useCallback(() => setJoinResult(null), []),
    applyPairStatus,
    forget,
  };
}
