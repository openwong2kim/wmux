import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useA2aInvite } from '../../hooks/useA2aInvite';
import { refreshA2aRemote } from '../../hooks/useA2aRemoteBridge';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Input from '../ui/Input';
import SegmentedControl from '../ui/SegmentedControl';
import { A2aExposureChecklist } from '../Settings/A2aExposureChecklist';
import { formatRemaining } from '../Settings/A2aRemoteSection';
import { INPUT_ERROR } from '../StatusBar/OtherComputersSection';
import { pairReasonMessage } from '../Sidebar/AttachRemoteModal';
import { maskPairInput, parseRemotePairInput } from '../../../shared/remotePairInput';
import type { A2aRemoteStatus } from '../../../shared/rpc';

// ─── "Connect a PC…" on the Remote page ──────────────────────────────────────
//
// One dialog, two tabs. It opens on "Invite this PC" only when the A2A
// listener is already up (then the invite is opened and copied at once);
// otherwise it opens on "Paste an invite", and choosing the Invite tab is
// what turns the listener on. When a PC redeems the invite, the dialog turns
// into that PC's "what it can see" checklist (nothing ticked). "Paste an
// invite" takes a `wmux-a2a://` invite (A2A join) or any shape the remote-host
// pairing takes (a pairing link, a `wmux web` token URL, an address and a
// code), routed by its shape. The clipboard is read only on its Paste button,
// and nothing connects until the person presses Connect.

export type ConnectTab = 'invite' | 'paste';

/** How often the open invite is checked for a PC that redeemed it. */
export const CONNECT_PAIR_POLL_MS = 2_000;
/** Ticks an invite that went away before its expiry is still watched for the PC that redeemed it. */
export const CONNECT_REDEEM_GRACE_TICKS = 3;

const A2A_INVITE_RE = /^wmux-a2a:\/\//i;

/** What a pasted text is, for the Paste tab: an A2A invite, a pairing link, or nothing usable. */
export function pastedKind(text: string): 'a2a' | 'link' | null {
  const value = text.trim();
  if (A2A_INVITE_RE.test(value)) return 'a2a';
  return value && parseRemotePairInput(value).kind !== 'error' ? 'link' : null;
}

/** The pasted text with its secret (code, token) dotted out, for display. */
export function maskPasted(text: string): string {
  const value = text.trim();
  if (A2A_INVITE_RE.test(value)) return value.replace(/^(wmux-a2a:\/\/[^/]+\/)[^#]*/i, '$1••••••••');
  return maskPairInput(value);
}

export interface RemoteConnectDialogProps {
  /** Open on this tab. Absent: Invite when A2A is already listening, else Paste. */
  initialTab?: ConnectTab;
  onClose: () => void;
  /** The dialog changed the A2A listener (turned it on): the page's line follows at once. */
  onA2aStatus?: (status: A2aRemoteStatus) => void;
  /** An A2A join succeeded and the person wants to link a pane with that PC. */
  onLinkPane: (hostId: string) => void;
}

export default function RemoteConnectDialog({ initialTab, onClose, onLinkPane, onA2aStatus }: RemoteConnectDialogProps) {
  const t = useT();
  const api = window.electronAPI?.a2aRemote;
  const invite = useA2aInvite();
  const { applyPairStatus } = invite;
  // null until the listener's state is known (it picks the first tab).
  const [tab, setTab] = useState<ConnectTab | null>(initialTab ?? null);
  const [paste, setPaste] = useState('');
  const [masked, setMasked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'muted' | 'danger'; text: string } | null>(null);
  const [turnedOn, setTurnedOn] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [joined, setJoined] = useState<{ hostId: string; name: string } | null>(null);
  const [linkHost, setLinkHost] = useState<string | null>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const knownPeers = useRef<Set<string> | null>(null);
  const started = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Opening the dialog changes nothing: Invite (which opens and copies an
  // invite) is the first tab only when the listener is already up.
  useEffect(() => {
    if (initialTab) return;
    let live = true;
    void (async () => {
      const status = await api?.status().catch(() => null);
      if (live) setTab(status?.enabled && status.listening ? 'invite' : 'paste');
    })();
    return () => { live = false; };
  }, [initialTab, api]);

  /**
   * Read the clipboard ONLY here, on the Paste button: what it holds is the
   * person's, and a pairing link in it is a credential. Shown masked, never
   * stored or logged, sent nowhere until Connect.
   */
  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await window.clipboardAPI?.readText();
      if (typeof text === 'string' && text.trim() && mounted.current) {
        setPaste(text.trim());
        setMasked(true);
        setMessage(null);
      }
    } catch {
      /* clipboard busy: the field still takes a normal paste */
    }
  }, []);

  // Invite tab, first visit: listener on, invite open, invite copied.
  const startInvite = useCallback(async () => {
    if (!api) return;
    setInviteError(null);
    setCreating(true);
    try {
      let status = await api.status();
      if (!status.enabled) {
        status = await api.configure({ enabled: true });
        if (mounted.current) setTurnedOn(true);
        onA2aStatus?.(status);
      }
      if (!status.listening) {
        if (mounted.current) setInviteError(status.lastError ?? t('settings.a2aRemoteActionFailed'));
        return;
      }
      // By pairing (peerId), not by PC: a PC that pairs again under this
      // invite keeps its hostId but gets a new peerId.
      const peers = await api.peersList().catch(() => null);
      knownPeers.current = new Set((peers?.peers ?? []).map((p) => p.peerId));
      const text = await invite.create();
      if (!mounted.current) return;
      if (!text) { setInviteError(t('settings.a2aRemoteActionFailed')); return; }
      if (!(await invite.copy(text)) && mounted.current) setInviteError(t('remotePage.connect.copyFailed'));
      copyRef.current?.focus();
    } catch {
      if (mounted.current) setInviteError(t('settings.a2aRemoteActionFailed'));
    } finally {
      if (mounted.current) setCreating(false);
    }
  }, [api, invite, t, onA2aStatus]);
  useEffect(() => {
    if (tab !== 'invite' || started.current) return;
    started.current = true;
    void startInvite();
  }, [tab, startInvite]);

  // While the invite is open: a PC that redeems it turns the dialog into
  // that PC's checklist. The invite going inactive with no new PC means it
  // expired or was burned; the countdown line says so.
  const open = invite.invite !== null;
  const expiresRef = useRef<number | null>(null);
  expiresRef.current = invite.expiresAt;
  useEffect(() => {
    if (!open || !api) return;
    // The daemon consumes the invite before it has stored the new PC's
    // pairing (a key derivation sits in between), so a tick can see the
    // invite gone and the PC not there yet. An invite that went away before
    // its expiry was most likely redeemed: keep looking for a few ticks (an
    // invite burned by wrong codes reads the same, and shows as gone a little
    // later).
    let graceTicks = CONNECT_REDEEM_GRACE_TICKS;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const pair = await api.pairStatus();
          if (pair.active) { applyPairStatus(pair); return; }
          const peers = await api.peersList();
          if (!mounted.current) return;
          const fresh = (peers?.peers ?? []).find((p) => p.revokedAt === undefined && !knownPeers.current?.has(p.peerId));
          if (fresh) {
            applyPairStatus(pair);
            setJoined({ hostId: fresh.hostId, name: fresh.name });
            void refreshA2aRemote();
            return;
          }
          const beforeExpiry = expiresRef.current !== null && Date.now() < expiresRef.current;
          if (beforeExpiry && graceTicks > 0) { graceTicks -= 1; return; }
          applyPairStatus(pair);
        } catch {
          /* the daemon is away; the next tick tries again */
        }
      })();
    }, CONNECT_PAIR_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, api, applyPairStatus]);

  const connect = useCallback(async () => {
    const text = paste.trim();
    const kind = pastedKind(text);
    setMessage(null);
    if (kind === 'a2a') {
      const r = await invite.join(text);
      if (!mounted.current || !r) return;
      if (r.ok) {
        setPaste(''); setMasked(false);
        setLinkHost(r.host.hostId);
        setMessage({ tone: 'muted', text: t('remotePage.connect.joinedA2a', { name: r.name }) });
        void refreshA2aRemote();
      } else {
        const retry = r.retryAfterSec != null && r.retryAfterSec > 0
          ? ` ${t('settings.a2aRemoteJoinRetryIn', { time: formatRemaining(r.retryAfterSec) })}` : '';
        setMessage({ tone: 'danger', text: `${t(`settings.a2aRemoteJoinError.${r.error}`)}${retry}` });
      }
      return;
    }
    const parsed = parseRemotePairInput(text);
    if (parsed.kind === 'error') {
      setMessage({ tone: 'danger', text: t(INPUT_ERROR[parsed.reason]) });
      return;
    }
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    setBusy(true);
    try {
      const res = parsed.kind === 'pair'
        ? await remote.hostsPair(parsed.origin, parsed.code)
        : await remote.hostsAdd(parsed.url);
      if (!mounted.current) return;
      if (res.ok) {
        setPaste(''); setMasked(false);
        setMessage({ tone: 'muted', text: t('remotePage.connect.hostAdded', { name: res.host.label }) });
      } else {
        setMessage({ tone: 'danger', text: 'reason' in res ? pairReasonMessage(t, res.reason, res.attemptsLeft) : res.error });
      }
    } catch {
      if (mounted.current) setMessage({ tone: 'danger', text: t('remote.pairFailed') });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [paste, invite, t]);

  if (tab === null) return null;
  const working = busy || invite.joinBusy;
  const remaining = invite.remainingSec;

  if (joined) {
    return (
      <Dialog onClose={onClose} width={520} data-testid="remote-connect-joined">
        <DialogHeader
          title={t('remotePage.connect.joinedTitle', { name: joined.name })}
          description={t('remotePage.connect.joinedDesc')}
          closeLabel={t('remotePage.connect.close')}
        />
        <DialogBody>
          <A2aExposureChecklist hostId={joined.hostId} pcName={joined.name} t={t} />
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" size="md" onClick={onClose}>{t('remotePage.connect.done')}</Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog onClose={onClose} width={520} data-testid="remote-connect">
      <DialogHeader title={t('remotePage.connect.title')} closeLabel={t('remotePage.connect.close')} />
      <DialogBody>
        <SegmentedControl<ConnectTab>
          value={tab}
          onValueChange={(v) => { setTab(v); setMessage(null); }}
          ariaLabel={t('remotePage.connect.title')}
          options={[
            { value: 'invite', label: t('remotePage.connect.tabInvite') },
            { value: 'paste', label: t('remotePage.connect.tabPaste') },
          ]}
          data-testid="remote-connect-tabs"
        />
        {tab === 'invite' ? (
          <div className="wmux-remote-connect" data-testid="remote-connect-invite">
            <p className="wmux-remote-connect-note">{t('remotePage.connect.inviteDesc')}</p>
            {turnedOn && <p className="wmux-remote-connect-note" data-testid="remote-connect-turned-on">{t('remotePage.connect.turnedOn')}</p>}
            {inviteError && <p className="wmux-a2a-note" data-tone="danger" role="alert">{inviteError}</p>}
            {invite.invite ? (
              <>
                <div className="wmux-remote-code">
                  <code className="ui-code" data-testid="remote-connect-code">{invite.invite}</code>
                  <Button ref={copyRef} variant="primary" size="md" onClick={() => void invite.copy()} data-testid="remote-connect-copy">
                    {invite.copied ? t('web.copied') : t('web.copy')}
                  </Button>
                </div>
                {invite.addresses.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="wmux-remote-connect-label">{t('remotePage.connect.addresses')}</span>
                    <ol className="wmux-remote-order" data-testid="remote-connect-addresses">
                      {invite.addresses.map((a, i) => (
                        <li key={a}>
                          <span className="wmux-remote-order-n">{i + 1}</span>
                          <code className="ui-code truncate">{a}</code>
                          {invite.tailnet.includes(a) && <span className="wmux-remote-order-k">{t('remotePage.connect.tailscale')}</span>}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </>
            ) : creating ? (
              <p className="wmux-remote-connect-note">{t('remotePage.connect.creating')}</p>
            ) : (
              <Button variant="secondary" size="md" className="self-start" onClick={() => void startInvite()} data-testid="remote-connect-new-code">
                {t('remotePage.connect.newCode')}
              </Button>
            )}
            {invite.lockedSec != null && invite.lockedSec > 0 && (
              <p className="wmux-a2a-note" data-tone="warning">{t('settings.a2aRemoteInviteLocked', { time: formatRemaining(invite.lockedSec) })}</p>
            )}
          </div>
        ) : (
          <div className="wmux-remote-connect" data-testid="remote-connect-paste">
            <span className="wmux-remote-connect-label">{t('remotePage.connect.pasteLabel')}</span>
            {masked ? (
              <div className="wmux-remote-code">
                <code className="ui-code" data-testid="remote-connect-pasted">{maskPasted(paste)}</code>
                <Button variant="ghost" size="md" onClick={() => { setPaste(''); setMasked(false); }}>{t('remotePage.connect.clear')}</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
              <Input
                type="text"
                value={paste}
                placeholder="wmux-a2a://…"
                aria-label={t('remotePage.connect.pasteLabel')}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => { setPaste(e.target.value); setMessage(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && paste.trim() && !working) { e.preventDefault(); void connect(); }
                }}
                className="font-mono flex-1 min-w-0"
                data-testid="remote-connect-input"
              />
              <Button variant="secondary" size="md" onClick={() => void pasteFromClipboard()} data-testid="remote-connect-paste-button">
                {t('remotePage.connect.paste')}
              </Button>
              </div>
            )}
            <p className="wmux-remote-connect-note">{masked ? t('remotePage.connect.fromClipboard') : t('remotePage.connect.pasteHint')}</p>
            {message && (
              <p className="wmux-a2a-note" data-tone={message.tone === 'danger' ? 'danger' : undefined} role={message.tone === 'danger' ? 'alert' : 'status'} data-testid="remote-connect-message">
                {message.text}
              </p>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        {tab === 'invite' && invite.invite && (
          <span className="wmux-remote-connect-expiry" data-testid="remote-connect-expiry">
            {remaining != null && remaining > 0
              ? t('settings.a2aRemoteInviteExpires', { time: formatRemaining(remaining) })
              : t('settings.a2aRemoteInviteExpired')}
          </span>
        )}
        {tab === 'invite' && invite.invite && (
          <Button variant="destructive" size="md" onClick={() => void invite.cancel()} data-testid="remote-connect-discard">
            {t('remotePage.connect.discard')}
          </Button>
        )}
        <Button variant="ghost" size="md" onClick={onClose}>{t('remotePage.connect.close')}</Button>
        {tab === 'paste' && linkHost && !paste.trim() && (
          <Button variant="primary" size="md" onClick={() => onLinkPane(linkHost)} data-testid="remote-connect-link-pane">
            {t('remotePage.connect.linkPaneNow')}
          </Button>
        )}
        {tab === 'paste' && !(linkHost && !paste.trim()) && (
          <Button variant="primary" size="md" disabled={!paste.trim() || working} onClick={() => void connect()} data-testid="remote-connect-submit">
            {working ? t('remotePage.connect.connecting') : t('remotePage.connect.connect')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
