import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import { useStore } from '../../stores';
import Button from '../ui/Button';
import Input from '../ui/Input';
import type { LanLinkNic, LanLinkStopReason, NicInfo } from '../../../shared/lanlink';
import { lanLinkStopReasonKey } from './lanLinkStopReason';

// ─── Connect a PC › LAN (a PIN pairing for message links) ────────────────────
//
// The LanLink PIN flow that used to sit in Settings › LAN: pair this PC (a
// one-time 6-digit PIN with its countdown) or join another PC by its LAN
// address and PIN. The daemon owns the window, its 2-minute expiry and its
// failure limit; this panel only starts, shows and cancels it. Paired peers
// are listed on the Remote page under Message links, not here. The VIEW is
// pure (props only); the CONTAINER holds the state.

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface LanLinkPairPanelViewProps {
  /** null while unknown, false when there is no daemon to pair through. */
  available: boolean | null;
  /** LanLink is on and a network interface is picked. */
  ready: boolean;
  /** A listener is open, so another PC can join this one. */
  listening: boolean;
  /** Why LanLink is on but not listening (null while that is still being checked). */
  stopReason: LanLinkStopReason | null;
  /** This PC's host:port for the other PC's Join form. */
  selfAddress: string | null;
  pin: string | null;
  countdownSec: number | null;
  failCount: number;
  pairBusy: boolean;
  onBeginPair: () => void;
  onCancelPair: () => void;
  joinHost: string;
  joinPort: string;
  joinPin: string;
  onJoinHost: (v: string) => void;
  onJoinPort: (v: string) => void;
  onJoinPin: (v: string) => void;
  onJoin: () => void;
  joinBusy: boolean;
  /** The PC this panel just paired with, for the confirmation line. */
  joinedName: string | null;
  onOpenSettings: () => void;
  error: string | null;
  t: T;
}

/** A 6-digit PIN read in two groups of three. */
export function groupPin(pin: string): string {
  return /^\d{6}$/.test(pin) ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin;
}

export function LanLinkPairPanelView(p: LanLinkPairPanelViewProps) {
  const { t } = p;
  if (p.available === false) {
    return (
      <div className="wmux-remote-connect" data-testid="remote-connect-lan">
        <p className="wmux-remote-connect-note">{t('settings.lanlinkUnavailable')}</p>
      </div>
    );
  }
  if (p.available === null) {
    return (
      <div className="wmux-remote-connect" data-testid="remote-connect-lan">
        <p className="wmux-remote-connect-note">{t('settings.lanlinkLoading')}</p>
      </div>
    );
  }
  if (!p.ready) {
    return (
      <div className="wmux-remote-connect" data-testid="remote-connect-lan">
        <p className="wmux-remote-connect-note">{t('remotePage.connect.lanDesc')}</p>
        <p className="wmux-remote-connect-note" data-testid="remote-connect-lan-off">{t('remotePage.connect.lanOff')}</p>
        <Button variant="secondary" size="md" className="self-start" onClick={p.onOpenSettings} data-testid="remote-connect-lan-settings">
          {t('remotePage.connect.lanOpenSettings')}
        </Button>
      </div>
    );
  }
  return (
    <div className="wmux-remote-connect" data-testid="remote-connect-lan">
      <p className="wmux-remote-connect-note">{t('remotePage.connect.lanDesc')}</p>
      <span className="wmux-remote-connect-label">{t('settings.lanlinkPairStart')}</span>
      {!p.listening ? (
        // Joining another PC goes out from here and still works; being joined needs the listener.
        p.stopReason ? (
          <p className="wmux-a2a-note" data-tone="warning" role="status" data-testid="remote-connect-lan-stop-reason">
            {t(lanLinkStopReasonKey(p.stopReason))}
          </p>
        ) : (
          <p className="wmux-remote-connect-note">{t('settings.lanlinkLoading')}</p>
        )
      ) : p.pin ? (
        <>
          <div className="wmux-remote-code">
            <code className="ui-code wmux-remote-pin" data-testid="remote-connect-lan-pin">{groupPin(p.pin)}</code>
            <span className="wmux-remote-connect-note tabular-nums" data-testid="remote-connect-lan-countdown">
              {p.countdownSec != null && p.countdownSec > 0
                ? t('settings.lanlinkPairCountdown', { seconds: p.countdownSec })
                : t('settings.lanlinkPairExpired')}
            </span>
            <Button variant="ghost" size="md" onClick={p.onCancelPair} data-testid="remote-connect-lan-cancel">{t('settings.lanlinkPairCancel')}</Button>
          </div>
          {p.selfAddress && (
            <p className="wmux-remote-connect-note" data-testid="remote-connect-lan-self">
              {t('settings.lanlinkPairSelfAddress', { address: p.selfAddress })}
            </p>
          )}
          {p.failCount > 0 && (
            <p className="wmux-a2a-note" data-tone="warning">{t('settings.lanlinkPairFailCount', { count: p.failCount })}</p>
          )}
        </>
      ) : (
        <>
          <p className="wmux-remote-connect-note">{t('settings.lanlinkPairStartDesc')}</p>
          <Button variant="secondary" size="md" className="self-start" onClick={p.onBeginPair} disabled={p.pairBusy} data-testid="remote-connect-lan-begin">
            {t('settings.lanlinkPairStartButton')}
          </Button>
        </>
      )}

      <span className="wmux-remote-connect-label">{t('settings.lanlinkPairJoin')}</span>
      <p className="wmux-remote-connect-note">{t('settings.lanlinkPairJoinDesc')}</p>
      {/* Every keystroke commits, so Join with the focus still in a field sends what is typed. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="text"
          value={p.joinHost}
          placeholder={t('settings.lanlinkPairJoinHostPlaceholder')}
          aria-label={t('settings.lanlinkPairJoinHost')}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => p.onJoinHost(e.target.value)}
          className="font-mono flex-1 min-w-0"
          data-testid="remote-connect-lan-host"
        />
        <Input
          type="number"
          value={p.joinPort}
          min={1}
          max={65535}
          aria-label={t('settings.lanlinkPairJoinPort')}
          placeholder={t('settings.lanlinkPairJoinPort')}
          onChange={(e) => p.onJoinPort(e.target.value)}
          className="font-mono tabular-nums"
          style={{ width: 96 }}
          data-testid="remote-connect-lan-port"
        />
        <Input
          type="text"
          value={p.joinPin}
          placeholder={t('settings.lanlinkPairJoinPinPlaceholder')}
          aria-label={t('settings.lanlinkPairJoinPin')}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          inputMode="numeric"
          onChange={(e) => p.onJoinPin(e.target.value)}
          className="font-mono"
          style={{ width: 96 }}
          data-testid="remote-connect-lan-join-pin"
        />
        <Button variant="secondary" size="md" onClick={p.onJoin} disabled={p.joinBusy} data-testid="remote-connect-lan-join">
          {t('settings.lanlinkPairJoinButton')}
        </Button>
      </div>
      {p.joinedName && (
        <p className="wmux-a2a-note" role="status" data-testid="remote-connect-lan-joined">{t('remotePage.connect.lanJoined', { name: p.joinedName })}</p>
      )}
      {p.error && <p className="wmux-a2a-note" data-tone="danger" role="alert" data-testid="remote-connect-lan-error">{p.error}</p>}
    </div>
  );
}

/** How often the panel re-reads LanLink's state while it is shown. */
export const LAN_PANEL_POLL_MS = 3_000;

export interface LanLinkPairPanelProps {
  /** A PC was paired from this panel (the page re-reads its list). */
  onPaired?: () => void;
}

/**
 * The container. A pairing window this panel opened is closed again when the
 * panel goes away (the dialog closed), so a half-finished pairing never stays
 * open behind it; a window opened elsewhere is left alone.
 */
export default function LanLinkPairPanel({ onPaired }: LanLinkPairPanelProps) {
  const t = useT();
  const { invoke: ipcInvoke } = useIpc({ silent: ['NOT_FOUND', 'UNKNOWN', 'DAEMON_DISCONNECTED'] });
  const api = window.electronAPI?.lanlink;

  const [available, setAvailable] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [nic, setNic] = useState<LanLinkNic | null>(null);
  const [effectivePort, setEffectivePort] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const [stopReason, setStopReason] = useState<LanLinkStopReason | null>(null);
  const [nics, setNics] = useState<NicInfo[]>([]);
  const [pin, setPin] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [failCount, setFailCount] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [joinHost, setJoinHost] = useState('');
  const [joinPort, setJoinPort] = useState('');
  const [joinPin, setJoinPin] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinedName, setJoinedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The window this panel opened and has not seen close. */
  const minted = useRef(false);
  /** The panel went away (the dialog closed). */
  const disposed = useRef(false);
  // The latest callback, read when a pairing lands: a parent that passes a new
  // function every render must not restart the 1 s countdown below.
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;

  const refreshStatus = useCallback(async () => {
    if (!api?.status) { setAvailable(false); return; }
    const r = await ipcInvoke(() => api.status());
    if (!r.ok) { setAvailable(false); return; }
    setAvailable(true);
    setEnabled(r.data.enabled);
    setNic(r.data.nic);
    setEffectivePort(r.data.effectivePort);
    setListening(r.data.listening);
    setStopReason(r.data.stopReason);
    setNics(r.data.nics);
  }, [api, ipcInvoke]);

  const refreshPairStatus = useCallback(async () => {
    if (!api?.pairStatus) return;
    const r = await ipcInvoke(() => api.pairStatus());
    if (!r.ok) return;
    setFailCount(r.data.failCount);
    if (!r.data.active) {
      // Redeemed, expired or burned by wrong PINs: the window is gone.
      if (minted.current) onPairedRef.current?.();
      minted.current = false;
      setPin(null);
      setDeadline(null);
    }
  }, [api, ipcInvoke]);

  useEffect(() => {
    void refreshStatus();
    const daemonApi = (
      window.electronAPI as unknown as { daemon?: { onConnected?: (cb: () => void) => () => void } }
    ).daemon;
    const off = daemonApi?.onConnected?.(() => { void refreshStatus(); });
    const poll = window.setInterval(() => { void refreshStatus(); }, LAN_PANEL_POLL_MS);
    return () => { off?.(); window.clearInterval(poll); };
  }, [refreshStatus]);

  // Countdown and window check only while a PIN is shown.
  useEffect(() => {
    if (!pin || deadline == null) return;
    const tick = window.setInterval(() => {
      setNow(Date.now());
      void refreshPairStatus();
    }, 1000);
    return () => window.clearInterval(tick);
  }, [pin, deadline, refreshPairStatus]);

  useEffect(() => {
    if (deadline != null && now >= deadline) { setPin(null); setDeadline(null); minted.current = false; }
  }, [now, deadline]);

  // Closing the dialog closes a window this panel left open.
  useEffect(() => {
    // A remount (StrictMode re-runs effects) is alive again.
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (minted.current) {
        minted.current = false;
        void window.electronAPI?.lanlink?.pairCancel?.().catch(() => undefined);
      }
    };
  }, []);

  const onBeginPair = useCallback(async () => {
    if (!api?.pairBegin) return;
    setPairBusy(true);
    setError(null);
    setFailCount(0);
    const r = await ipcInvoke(() => api.pairBegin());
    // Closed while the window was opening: nobody will see this PIN, so close it.
    if (disposed.current) {
      if (r.ok) void api.pairCancel?.().catch(() => undefined);
      return;
    }
    setPairBusy(false);
    if (!r.ok) { setError(t('settings.lanlinkPairError')); return; }
    minted.current = true;
    setPin(r.data.pin);
    // A null expiry reads as already expired, never as a window that stays open.
    setDeadline(r.data.expiresInMs != null ? Date.now() + r.data.expiresInMs : Date.now());
    setNow(Date.now());
  }, [api, ipcInvoke, t]);

  const onCancelPair = useCallback(async () => {
    if (!api?.pairCancel) return;
    const r = await ipcInvoke(() => api.pairCancel());
    // Hide the PIN only once the daemon closed the window.
    if (r.ok) { minted.current = false; setPin(null); setDeadline(null); setFailCount(0); }
  }, [api, ipcInvoke]);

  const onJoin = useCallback(async () => {
    if (!api?.pairJoin) return;
    const port = Number(joinPort);
    if (!joinHost.trim() || !Number.isInteger(port) || port < 1 || port > 65535 || !joinPin.trim()) {
      setError(t('settings.lanlinkPairError'));
      return;
    }
    setJoinBusy(true);
    setError(null);
    setJoinedName(null);
    const r = await ipcInvoke(() => api.pairJoin({ host: joinHost.trim(), port, pin: joinPin.trim() }));
    setJoinBusy(false);
    if (r.ok) {
      setJoinPin('');
      setJoinedName(r.data.peerName);
      onPairedRef.current?.();
    } else setError(t('settings.lanlinkPairError'));
  }, [api, ipcInvoke, joinHost, joinPort, joinPin, t]);

  const selfAddress = (() => {
    if (!nic || effectivePort == null) return null;
    const ip = nics.find((n) => n.name === nic.name && n.mac === nic.mac)?.addresses[0];
    return ip ? `${ip}:${effectivePort}` : null;
  })();
  const countdownSec = deadline != null ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;

  return (
    <LanLinkPairPanelView
      available={available}
      ready={enabled && nic !== null}
      listening={listening}
      stopReason={stopReason}
      selfAddress={selfAddress}
      pin={pin}
      countdownSec={countdownSec}
      failCount={failCount}
      pairBusy={pairBusy}
      onBeginPair={() => void onBeginPair()}
      onCancelPair={() => void onCancelPair()}
      joinHost={joinHost}
      joinPort={joinPort}
      joinPin={joinPin}
      onJoinHost={setJoinHost}
      onJoinPort={setJoinPort}
      onJoinPin={setJoinPin}
      onJoin={() => void onJoin()}
      joinBusy={joinBusy}
      joinedName={joinedName}
      onOpenSettings={() => useStore.getState().openSettingsTab('lanlink')}
      error={error}
      t={t}
    />
  );
}
