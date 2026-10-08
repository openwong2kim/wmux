import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { A2aPeerRecordV1, A2aRemoteHostRecordV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteJoinError, A2aRemoteStatus } from '../../../shared/rpc';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import UiButton from '../ui/Button';
import Switch from '../ui/Switch';
import Input from '../ui/Input';
import { SettingsSection, SettingRow, SettingNote } from './SettingsLayout';
import { A2aExposureChecklist } from './A2aExposureChecklist';

// ─── Cross-PC A2A (experimental) ─────────────────────────────────────────────
//
// Settings → LAN. The daemon is the source of truth (`a2a.remote.*` over the
// control pipe); this section reads it on mount, polls lightly while open and
// writes through configure / invite / join / remove / revoke. The VIEW is pure
// (props only) so it renders under renderToStaticMarkup in a node test.
//
// The LAN tab already spends its one primary button on LanLink's "Generate
// PIN", so every action here is secondary (DESIGN.md: one primary per tab).

type T = (key: string, vars?: Record<string, string | number>) => string;

export type A2aRemoteConfirm = { kind: 'host' | 'peer'; id: string } | null;
export type A2aRemoteJoinOutcome =
  | { ok: true; name: string }
  /** `retryAfterSec`: for a rate-limited try, seconds until the other PC accepts another. */
  | { ok: false; error: A2aRemoteJoinError; retryAfterSec?: number }
  | null;

export type A2aRemotePlatform = 'darwin' | 'win32' | 'linux';

/** Bytes shown in the fingerprint chip; the full value is in the tooltip and the copy button. */
export const FINGERPRINT_CHIP_BYTES = 6;

/** The first `bytes` bytes of a `AA:BB:…` fingerprint, cut on a byte boundary, with an ellipsis. */
export function fingerprintPrefix(fp: string, bytes = FINGERPRINT_CHIP_BYTES): string {
  const parts = fp.split(':');
  return parts.length > bytes ? `${parts.slice(0, bytes).join(':')}…` : fp;
}

export interface A2aRemoteViewProps {
  status: A2aRemoteStatus;
  /** Picks the firewall hint under the port. */
  platform: A2aRemotePlatform;
  fingerprintCopied: boolean;
  onCopyFingerprint: () => void;
  /** Seconds some PC stays locked out of pairing after repeated failures; null when none is. */
  lockedSec: number | null;
  busy: boolean;
  onToggleEnabled: (v: boolean) => void;
  portDraft: string;
  onPortDraft: (v: string) => void;
  onPortCommit: () => void;
  // invite (this PC)
  invite: string | null;
  /** The addresses the open invite offers, in the order the other PC tries them. */
  inviteAddresses: string[];
  /** Those of `inviteAddresses` that are this PC's tailnet addresses (labelled "(Tailscale)"). */
  inviteTailnet: string[];
  remainingSec: number | null;
  copied: boolean;
  onCreateInvite: () => void;
  onCopyInvite: () => void;
  onCancelInvite: () => void;
  // join (another PC)
  joinInput: string;
  onJoinInput: (v: string) => void;
  onJoin: () => void;
  joinBusy: boolean;
  joinOutcome: A2aRemoteJoinOutcome;
  // lists
  hosts: A2aRemoteHostRecordV1[];
  peers: A2aPeerRecordV1[];
  confirming: A2aRemoteConfirm;
  /** Outcome of the last "Remove" of a PC this PC joined. */
  removed: { name: string; remoteRevoked: boolean } | null;
  onAsk: (c: Exclude<A2aRemoteConfirm, null>) => void;
  onConfirm: (c: Exclude<A2aRemoteConfirm, null>) => void;
  onCancelConfirm: () => void;
  /** The PC whose "panes to show" checklist is open (by hostId). */
  exposureOpen: string | null;
  onToggleExposure: (hostId: string) => void;
  /** Renders that checklist; a slot so this view stays pure. */
  renderExposure?: (hostId: string, name: string) => ReactNode;
  error: string | null;
  t: T;
}

/** `m:ss` for the invite countdown. */
export function formatRemaining(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function A2aRemoteView(props: A2aRemoteViewProps) {
  const {
    status, platform, fingerprintCopied, onCopyFingerprint, lockedSec, busy, onToggleEnabled, portDraft, onPortDraft, onPortCommit,
    invite, inviteAddresses, inviteTailnet, remainingSec, copied, onCreateInvite, onCopyInvite, onCancelInvite,
    joinInput, onJoinInput, onJoin, joinBusy, joinOutcome,
    hosts, peers, confirming, removed, onAsk, onConfirm, onCancelConfirm, exposureOpen, onToggleExposure, renderExposure, error, t,
  } = props;

  const confirmRow = (kind: 'host' | 'peer', id: string, label: string) =>
    confirming?.kind === kind && confirming.id === id ? (
      <div className="flex items-center gap-2 shrink-0">
        <UiButton variant="ghost" size="md" onClick={onCancelConfirm}>{t('settings.a2aRemoteKeep')}</UiButton>
        <UiButton variant="danger" size="md" onClick={() => onConfirm({ kind, id })}>{label}</UiButton>
      </div>
    ) : (
      <UiButton variant="destructive" size="md" className="shrink-0" onClick={() => onAsk({ kind, id })}>
        {label}
      </UiButton>
    );

  return (
    <>
      <SettingsSection title={t('settings.a2aRemote')} data-testid="a2a-remote-section">
        <SettingRow label={t('settings.a2aRemoteEnable')} description={t('settings.a2aRemoteEnableDesc')}>
          <Switch
            checked={status.enabled}
            onCheckedChange={onToggleEnabled}
            aria-label={t('settings.a2aRemoteEnable')}
            disabled={busy}
          />
        </SettingRow>
        <SettingRow label={t('settings.a2aRemotePort')} description={t(`settings.a2aRemotePortDesc.${platform}`)}>
          <Input
            type="number"
            aria-label={t('settings.a2aRemotePort')}
            value={portDraft}
            min={1024}
            max={65535}
            disabled={busy}
            onChange={(e) => onPortDraft(e.target.value)}
            onBlur={onPortCommit}
            onKeyDown={(e) => { if (e.key === 'Enter') onPortCommit(); }}
            className="settings-input tabular-nums text-center"
            style={{ width: 96 }}
          />
        </SettingRow>
        <SettingRow label={t('settings.a2aRemoteThisPc')} description={status.name}>
          <div className="flex items-center gap-2">
            <span data-testid="a2a-remote-fingerprint" className="ui-code" title={status.fingerprint256 ?? undefined}>
              {status.fingerprint256 ? fingerprintPrefix(status.fingerprint256) : '—'}
            </span>
            {status.fingerprint256 && (
              <UiButton variant="secondary" size="md" onClick={onCopyFingerprint} aria-label={t('settings.a2aRemoteFingerprintCopy')}>
                {fingerprintCopied ? t('settings.a2aRemoteInviteCopied') : t('settings.a2aRemoteInviteCopy')}
              </UiButton>
            )}
          </div>
        </SettingRow>
        {status.enabled && (
          <SettingNote data-testid="a2a-remote-listening" tone={status.listening && !status.lastError ? 'muted' : 'warning'}>
            {!status.listening
              ? t('settings.a2aRemoteNotListening', { error: status.lastError ?? '—' })
              : status.lastError
                ? t('settings.a2aRemotePortFailed', { error: status.lastError, port: status.port })
                : t('settings.a2aRemoteListening', { port: status.port })}
          </SettingNote>
        )}

        <SettingRow label={t('settings.a2aRemoteInvite')} description={t('settings.a2aRemoteInviteDesc')} layout="stacked">
          {invite ? (
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="a2a-remote-invite" className="ui-code break-all select-all">{invite}</span>
              <UiButton variant="secondary" size="md" onClick={onCopyInvite}>
                {copied ? t('settings.a2aRemoteInviteCopied') : t('settings.a2aRemoteInviteCopy')}
              </UiButton>
              <span className="ui-field-description tabular-nums">
                {remainingSec != null && remainingSec > 0
                  ? t('settings.a2aRemoteInviteExpires', { time: formatRemaining(remainingSec) })
                  : t('settings.a2aRemoteInviteExpired')}
              </span>
              <UiButton variant="ghost" size="md" onClick={onCancelInvite}>{t('settings.a2aRemoteInviteCancel')}</UiButton>
            </div>
          ) : (
            <UiButton variant="secondary" size="md" onClick={onCreateInvite} disabled={!status.listening}>
              {t('settings.a2aRemoteInviteButton')}
            </UiButton>
          )}
        </SettingRow>
        {invite && inviteAddresses.length > 0 && (
          <SettingNote data-testid="a2a-remote-invite-addresses">
            {t('settings.a2aRemoteInviteAddresses', {
              addresses: inviteAddresses
                .map((a) => (inviteTailnet.includes(a) ? t('settings.a2aRemoteInviteTailnetAddress', { address: a }) : a))
                .join(', '),
            })}
          </SettingNote>
        )}
        {!status.listening && !invite && (
          <SettingNote>{t('settings.a2aRemoteInviteNeedsListener')}</SettingNote>
        )}
        {lockedSec != null && lockedSec > 0 && (
          <SettingNote data-testid="a2a-remote-invite-locked" tone="warning">
            {t('settings.a2aRemoteInviteLocked', { time: formatRemaining(lockedSec) })}
          </SettingNote>
        )}

        <SettingRow label={t('settings.a2aRemoteJoin')} description={t('settings.a2aRemoteJoinDesc')} layout="stacked">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              value={joinInput}
              placeholder="wmux-a2a://…"
              aria-label={t('settings.a2aRemoteJoin')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => onJoinInput(e.target.value)}
              className="settings-input font-mono"
              style={{ flex: '1 1 260px', minWidth: 0 }}
            />
            <UiButton variant="secondary" size="md" onClick={onJoin} disabled={joinBusy || !joinInput.trim()}>
              {joinBusy ? t('settings.a2aRemoteJoinBusy') : t('settings.a2aRemoteJoinButton')}
            </UiButton>
          </div>
        </SettingRow>
        {joinOutcome && (
          <SettingNote data-testid="a2a-remote-join-outcome" tone={joinOutcome.ok ? 'muted' : 'danger'}>
            {joinOutcome.ok
              ? t('settings.a2aRemoteJoinOk', { name: joinOutcome.name })
              : t(`settings.a2aRemoteJoinError.${joinOutcome.error}`)}
            {!joinOutcome.ok && joinOutcome.retryAfterSec != null && joinOutcome.retryAfterSec > 0 && (
              <> {t('settings.a2aRemoteJoinRetryIn', { time: formatRemaining(joinOutcome.retryAfterSec) })}</>
            )}
          </SettingNote>
        )}
        {error && <SettingNote tone="danger">{error}</SettingNote>}
      </SettingsSection>

      <SettingsSection title={t('settings.a2aRemoteHosts')}>
        {removed && (
          <SettingNote data-testid="a2a-remote-removed" tone={removed.remoteRevoked ? 'muted' : 'warning'}>
            {t(removed.remoteRevoked ? 'settings.a2aRemoteRemovedBoth' : 'settings.a2aRemoteRemovedLocalOnly', { name: removed.name })}
          </SettingNote>
        )}
        {hosts.length === 0 ? (
          <SettingNote>{t('settings.a2aRemoteListEmpty')}</SettingNote>
        ) : (
          <div className="contents" data-testid="a2a-remote-hosts">
            {hosts.map((h) => (
              <div key={h.hostId} className="settings-row ui-row" style={{ flexDirection: 'row' }}>
                <span className="ui-field-label truncate">{h.name}</span>
                <span className="ui-code truncate">{`${h.addresses[0] ?? ''}:${h.port}`}</span>
                <div className="flex-1" />
                {confirmRow('host', h.hostId, t('settings.a2aRemoteHostRemove'))}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.a2aRemotePeers')}>
        {peers.length === 0 ? (
          <SettingNote>{t('settings.a2aRemoteListEmpty')}</SettingNote>
        ) : (
          <div className="contents" data-testid="a2a-remote-peers">
            {peers.map((p) => (
              <div key={p.peerId} className="contents">
                <div className="settings-row ui-row" style={{ flexDirection: 'row' }}>
                  <span className="ui-field-label truncate">{p.name}</span>
                  <div className="flex-1" />
                  <UiButton
                    variant="ghost"
                    size="md"
                    className="shrink-0"
                    aria-expanded={exposureOpen === p.hostId}
                    onClick={() => onToggleExposure(p.hostId)}
                  >
                    {t('settings.a2aExposureButton')}
                  </UiButton>
                  {confirmRow('peer', p.peerId, t('settings.a2aRemotePeerRevoke'))}
                </div>
                {exposureOpen === p.hostId && renderExposure && (
                  <div className="settings-row ui-row" data-testid="a2a-remote-exposure">{renderExposure(p.hostId, p.name)}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </>
  );
}

export function A2aRemoteSection() {
  const t = useT();
  const { invoke: ipcInvoke } = useIpc({ silent: ['NOT_FOUND', 'UNKNOWN', 'DAEMON_DISCONNECTED'] });
  const api = window.electronAPI?.a2aRemote;

  const [status, setStatus] = useState<A2aRemoteStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [portDraft, setPortDraft] = useState('');
  const [invite, setInvite] = useState<string | null>(null);
  const [inviteAddresses, setInviteAddresses] = useState<string[]>([]);
  const [inviteTailnet, setInviteTailnet] = useState<string[]>([]);
  const [removed, setRemoved] = useState<{ name: string; remoteRevoked: boolean } | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinResult, setJoinResult] = useState<
    { ok: true; name: string } | { ok: false; error: A2aRemoteJoinError; retryUntil?: number } | null
  >(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [fingerprintCopied, setFingerprintCopied] = useState(false);
  const [hosts, setHosts] = useState<A2aRemoteHostRecordV1[]>([]);
  const [peers, setPeers] = useState<A2aPeerRecordV1[]>([]);
  const [confirming, setConfirming] = useState<A2aRemoteConfirm>(null);
  const [exposureOpen, setExposureOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The port last shown, so a poll does not overwrite a port being typed.
  const shownPort = useRef<number | null>(null);
  const applyStatus = useCallback((s: A2aRemoteStatus) => {
    setStatus(s);
    if (shownPort.current !== s.port) {
      shownPort.current = s.port;
      setPortDraft(String(s.port));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!api) { setUnavailable(true); return; }
    const r = await ipcInvoke(() => api.status());
    // A daemon too old to know `a2a.remote.*` answers nothing usable.
    if (!r.ok || typeof r.data?.port !== 'number') { setUnavailable(true); return; }
    setUnavailable(false);
    applyStatus(r.data);
    const [h, p, pair] = await Promise.all([
      ipcInvoke(() => api.hostsList()),
      ipcInvoke(() => api.peersList()),
      ipcInvoke(() => api.pairStatus()),
    ]);
    if (h.ok && Array.isArray(h.data?.hosts)) setHosts(h.data.hosts);
    if (p.ok && Array.isArray(p.data?.peers)) setPeers(p.data.peers.filter((x) => x.revokedAt === undefined));
    // The invite was redeemed, cancelled or burned on the daemon side.
    if (pair.ok && pair.data?.active === false) { setInvite(null); setDeadline(null); }
    if (pair.ok) setLockedUntil(typeof pair.data?.lockedUntil === 'number' ? pair.data.lockedUntil : null);
  }, [api, ipcInvoke, applyStatus]);

  useEffect(() => {
    void refresh();
    const daemonApi = (
      window.electronAPI as unknown as { daemon?: { onConnected?: (cb: () => void) => () => void } }
    ).daemon;
    const off = daemonApi?.onConnected?.(() => void refresh());
    // Light poll while the LAN tab is open: a PC that joins this one shows up without a refresh.
    const poll = setInterval(() => void refresh(), 3000);
    return () => { off?.(); clearInterval(poll); };
  }, [refresh]);

  // A 1s tick only while something counts down.
  const retryUntil = joinResult && !joinResult.ok ? joinResult.retryUntil ?? null : null;
  const counting = deadline != null || (lockedUntil != null && lockedUntil > now) || (retryUntil != null && retryUntil > now);
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [counting]);

  const configure = useCallback(async (patch: { enabled?: boolean; port?: number }) => {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      const r = await ipcInvoke(() => api.configure(patch));
      if (r.ok && typeof r.data?.port === 'number') applyStatus(r.data);
      else setError(t('settings.a2aRemoteActionFailed'));
    } finally {
      setBusy(false);
    }
    // A stop or rebind drops the open invite daemon-side.
    setInvite(null); setDeadline(null);
  }, [api, ipcInvoke, applyStatus, t]);

  const onPortCommit = useCallback(() => {
    if (!status) return;
    const n = Number(portDraft);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) { setPortDraft(String(status.port)); return; }
    if (n !== status.port) void configure({ port: n });
  }, [status, portDraft, configure]);

  const onCreateInvite = useCallback(async () => {
    if (!api) return;
    setError(null); setCopied(false);
    const r = await ipcInvoke(() => api.pairBegin());
    if (r.ok) {
      setInvite(r.data.invite);
      setInviteAddresses(Array.isArray(r.data.addresses) ? r.data.addresses : []);
      setInviteTailnet(Array.isArray(r.data.tailnet) ? r.data.tailnet : []);
      setDeadline(r.data.expiresAt);
      setNow(Date.now());
    }
    else setError(t('settings.a2aRemoteActionFailed'));
  }, [api, ipcInvoke, t]);

  const onCancelInvite = useCallback(async () => {
    if (!api) return;
    const r = await ipcInvoke(() => api.pairCancel());
    if (r.ok) { setInvite(null); setDeadline(null); }
  }, [api, ipcInvoke]);

  const onCopyInvite = useCallback(async () => {
    if (!invite) return;
    try {
      await window.clipboardAPI.writeText(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t('settings.a2aRemoteActionFailed'));
    }
  }, [invite, t]);

  const onJoin = useCallback(async () => {
    if (!api || !joinInput.trim()) return;
    setJoinBusy(true); setJoinResult(null);
    const r = await ipcInvoke(() => api.join(joinInput.trim()));
    setJoinBusy(false);
    if (!r.ok) { setJoinResult({ ok: false, error: 'failed' }); return; }
    if (r.data.ok) {
      setJoinResult({ ok: true, name: r.data.host.name });
      setJoinInput('');
      void refresh();
    } else {
      const after = r.data.retryAfterMs;
      setJoinResult({
        ok: false,
        error: r.data.error,
        ...(typeof after === 'number' && after > 0 ? { retryUntil: Date.now() + after } : {}),
      });
    }
  }, [api, ipcInvoke, joinInput, refresh]);

  const onCopyFingerprint = useCallback(async () => {
    if (!status?.fingerprint256) return;
    try {
      await window.clipboardAPI.writeText(status.fingerprint256);
      setFingerprintCopied(true);
      setTimeout(() => setFingerprintCopied(false), 2000);
    } catch {
      setError(t('settings.a2aRemoteActionFailed'));
    }
  }, [status, t]);

  const onConfirm = useCallback(async (c: Exclude<A2aRemoteConfirm, null>) => {
    if (!api) return;
    setConfirming(null);
    setRemoved(null);
    if (c.kind === 'host') {
      const name = hosts.find((h) => h.hostId === c.id)?.name ?? '';
      const r = await ipcInvoke(() => api.hostsRemove(c.id));
      if (r.ok && r.data?.ok) setRemoved({ name, remoteRevoked: r.data.remoteRevoked === true });
      else setError(t('settings.a2aRemoteActionFailed'));
    } else {
      const r = await ipcInvoke(() => api.peersRevoke(c.id));
      if (!r.ok) setError(t('settings.a2aRemoteActionFailed'));
    }
    void refresh();
  }, [api, ipcInvoke, refresh, t, hosts]);

  if (unavailable) {
    return (
      <SettingsSection title={t('settings.a2aRemote')}>
        <SettingNote>{t('settings.a2aRemoteUnavailable')}</SettingNote>
      </SettingsSection>
    );
  }
  if (!status) {
    return (
      <SettingsSection title={t('settings.a2aRemote')}>
        <SettingNote>{t('settings.a2aRemoteLoading')}</SettingNote>
      </SettingsSection>
    );
  }

  const platform: A2aRemotePlatform =
    window.electronAPI?.platform === 'darwin' ? 'darwin' : window.electronAPI?.platform === 'linux' ? 'linux' : 'win32';
  const joinOutcome: A2aRemoteJoinOutcome = !joinResult
    ? null
    : joinResult.ok
      ? joinResult
      : {
          ok: false,
          error: joinResult.error,
          ...(joinResult.retryUntil != null ? { retryAfterSec: Math.ceil((joinResult.retryUntil - now) / 1000) } : {}),
        };

  return (
    <A2aRemoteView
      status={status}
      platform={platform}
      fingerprintCopied={fingerprintCopied}
      onCopyFingerprint={() => void onCopyFingerprint()}
      lockedSec={lockedUntil != null ? Math.ceil((lockedUntil - now) / 1000) : null}
      busy={busy}
      onToggleEnabled={(v) => void configure({ enabled: v })}
      portDraft={portDraft}
      onPortDraft={setPortDraft}
      onPortCommit={onPortCommit}
      invite={invite}
      inviteAddresses={inviteAddresses}
      inviteTailnet={inviteTailnet}
      remainingSec={deadline != null ? Math.ceil((deadline - now) / 1000) : null}
      copied={copied}
      onCreateInvite={() => void onCreateInvite()}
      onCopyInvite={() => void onCopyInvite()}
      onCancelInvite={() => void onCancelInvite()}
      joinInput={joinInput}
      onJoinInput={setJoinInput}
      onJoin={() => void onJoin()}
      joinBusy={joinBusy}
      joinOutcome={joinOutcome}
      hosts={hosts}
      peers={peers}
      confirming={confirming}
      removed={removed}
      onAsk={setConfirming}
      onConfirm={(c) => void onConfirm(c)}
      onCancelConfirm={() => setConfirming(null)}
      exposureOpen={exposureOpen}
      onToggleExposure={(hostId) => setExposureOpen((cur) => (cur === hostId ? null : hostId))}
      renderExposure={(hostId, name) => <A2aExposureChecklist hostId={hostId} pcName={name} t={t} />}
      error={error}
      t={t}
    />
  );
}
