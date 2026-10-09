import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { COPIED_MS, useA2aInvite } from '../../hooks/useA2aInvite';
import { refreshA2aRemote } from '../../hooks/useA2aRemoteBridge';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Input from '../ui/Input';
import SegmentedControl from '../ui/SegmentedControl';
import Checkbox from '../ui/Checkbox';
import Field from '../ui/Field';
import { A2aExposureChecklist } from '../Settings/A2aExposureChecklist';
import { formatRemaining } from '../Settings/A2aRemoteSection';
import { INPUT_ERROR } from '../StatusBar/OtherComputersSection';
import { pairReasonMessage } from '../Sidebar/AttachRemoteModal';
import { pendingPairFlow, uniqueDeviceName, webComputerLink } from '../StatusBar/WebToggle';
import { webComputerPairOrigin } from '../../../shared/web';
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
//
// "Also let it see this PC's workspaces" (off by default, offered only while
// Share & pair is reachable over HTTPS) adds a view-only computer pairing
// link to the invite, one per line. Pasted on the other PC, each line
// connects in turn: one paste, both connections.

export type ConnectTab = 'invite' | 'paste';

/** How often the open invite is checked for a PC that redeemed it. */
export const CONNECT_PAIR_POLL_MS = 2_000;
/** Ticks an invite that went away before its expiry is still watched for the PC that redeemed it. */
export const CONNECT_REDEEM_GRACE_TICKS = 3;

const A2A_INVITE_RE = /^wmux-a2a:\/\//i;

function kindOf(value: string): 'a2a' | 'link' | null {
  if (A2A_INVITE_RE.test(value)) return 'a2a';
  return value && parseRemotePairInput(value).kind !== 'error' ? 'link' : null;
}

/**
 * The pieces a paste connects, in order: each line of a bundled invite when
 * every line is one on its own, else the whole text (an address and a code
 * on two lines is still one pairing).
 *
 * Ctrl+V into the single-line field turns the bundle's newline into a space
 * (Chromium does that for `<input type=text>`), so whitespace-separated words
 * that are each a whole invite or link on their own split the same way.
 */
export function pastedParts(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => kindOf(l) !== null)) return lines;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => kindOf(w) !== null)) return words;
  return [text.trim()];
}

/** What a pasted text is, for the Paste tab: an A2A invite, a pairing link, both, or nothing usable. */
export function pastedKind(text: string): 'a2a' | 'link' | 'bundle' | null {
  const parts = pastedParts(text);
  return parts.length > 1 ? 'bundle' : kindOf(parts[0]);
}

function maskOne(value: string): string {
  if (A2A_INVITE_RE.test(value)) return value.replace(/^(wmux-a2a:\/\/[^/]+\/)[^#]*/i, '$1••••••••');
  return maskPairInput(value);
}

/**
 * The pasted text with its secrets (code, token) dotted out, for display.
 * Line by line, so a stray line in a bundle cannot leave the others bare.
 */
export function maskPasted(text: string): string {
  const parts = pastedParts(text);
  if (parts.length > 1) return parts.map(maskOne).join('\n');
  const whole = parts[0];
  // An address and a code, on one line or two.
  if (whole.split(/\s+/).length === 2 && /^https?:\/\//i.test(whole)) return maskPairInput(whole);
  return whole.split(/\r?\n/).map((l) => maskOne(l.trim())).join('\n');
}

/** How long a bundle stays on the clipboard when the link's expiry is unknown. */
const BUNDLE_FALLBACK_TTL_MS = 600_000;

/** The computer pairing link riding along with the invite. */
interface WorkspaceLink { link: string; expiresAt: number | null }

/** What the invite tab copies: the invite, plus the workspace link on its own line while it lives. */
export function inviteBundle(invite: string, ws: WorkspaceLink | null, now: number = Date.now()): string {
  const live = ws && (ws.expiresAt === null || now < ws.expiresAt);
  return live ? `${invite}\n${ws.link}` : invite;
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
  const web = window.electronAPI?.web;
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
  // Share & pair answers on an HTTPS address another PC can reach.
  const [shareReady, setShareReady] = useState(false);
  const [shareOn, setShareOn] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<'busy' | 'failed' | null>(null);
  const [wsLink, setWsLink] = useState<WorkspaceLink | null>(null);
  const [bundleCopied, setBundleCopied] = useState(false);
  const shareRef = useRef(false);
  const wsRef = useRef<WorkspaceLink | null>(null);
  wsRef.current = wsLink;
  // Bumped by every tick, untick and Discard: a mint that finishes after one
  // of them is no longer wanted, and is cancelled instead of copied.
  const shareGen = useRef(0);
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

  useEffect(() => {
    if (tab !== 'invite' || !web) return;
    let live = true;
    void web.status()
      .then((info) => { if (live) setShareReady(webComputerPairOrigin(info) !== ''); })
      .catch(() => { /* no web server: the box stays off */ });
    return () => { live = false; };
  }, [tab, web]);

  /**
   * Mint a view-only computer pairing link, named like Share & pair's own.
   * The daemon holds one pairing code at a time: one that Share & pair has
   * open (and may have handed over already) is not this dialog's to replace,
   * so that comes back as 'busy'.
   */
  const mintWorkspaceLink = useCallback(async (): Promise<WorkspaceLink | 'busy' | null> => {
    if (!web?.pairStart) return null;
    const current = await web.status();
    const live = pendingPairFlow(current) !== null
      && (typeof current.pairExpiresAt !== 'number' || Date.now() < current.pairExpiresAt);
    if (live && webComputerLink(current) !== wsRef.current?.link) return 'busy';
    const roster = await web.deviceList().catch(() => null);
    const name = uniqueDeviceName(t('web.computerDefaultName'), roster?.devices ?? null);
    const info = await web.pairStart(name, false, 'computer');
    const link = webComputerLink(info);
    return link ? { link, expiresAt: info.pairExpiresAt ?? null } : null;
  }, [web, t]);

  /** Cancel `ws` (a link this dialog minted), unless Share & pair has minted another since. */
  const cancelLink = useCallback(async (ws: WorkspaceLink | null) => {
    if (!ws || !web) return;
    const info = await web.status().catch(() => null);
    if (info && webComputerLink(info) === ws.link) await web.pairCancel?.().catch(() => undefined);
  }, [web]);

  const dropWorkspaceLink = useCallback(async () => {
    shareGen.current += 1;
    const ws = wsRef.current;
    wsRef.current = null;
    if (mounted.current) setWsLink(null);
    await cancelLink(ws);
  }, [cancelLink]);

  /**
   * Mint for the invite on screen. Resolves to the link, or null when there
   * is none to copy: the mint failed or was refused (the reason is shown), or
   * a later tick, untick or Discard made it moot (then it is cancelled).
   */
  const mintForInvite = useCallback(async (): Promise<WorkspaceLink | null> => {
    const gen = ++shareGen.current;
    const got = await mintWorkspaceLink().catch(() => null);
    if (gen !== shareGen.current || !mounted.current) {
      if (got && got !== 'busy') await cancelLink(got);
      return null;
    }
    const ws = got === 'busy' ? null : got;
    wsRef.current = ws;
    setWsLink(ws);
    setShareError(got === 'busy' ? 'busy' : ws ? null : 'failed');
    // Refused or failed: the box does not claim a link that is not there.
    if (!ws) { shareRef.current = false; setShareOn(false); }
    return ws;
  }, [mintWorkspaceLink, cancelLink]);

  /**
   * Copy the invite, with the workspace link when one rides along. That
   * bundle holds a computer credential: it goes on the clipboard only for as
   * long as the link lives, as Share & pair's own copy does.
   */
  const copyBundle = useCallback(async (text: string, ws: WorkspaceLink | null): Promise<boolean> => {
    const bundle = inviteBundle(text, ws);
    if (bundle === text) return invite.copy(text);
    const write = window.clipboardAPI?.writeEphemeral;
    if (!write || !ws) return false;
    try {
      await write(bundle, ws.expiresAt === null ? BUNDLE_FALLBACK_TTL_MS : Math.max(0, ws.expiresAt - Date.now()));
      setBundleCopied(true);
      setTimeout(() => setBundleCopied(false), COPIED_MS);
      return true;
    } catch {
      return false;
    }
  }, [invite]);

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
      // A new code while the box is ticked brings a new link along.
      const ws = shareRef.current ? await mintForInvite() : null;
      if (!mounted.current) return;
      if (!(await copyBundle(text, ws)) && mounted.current) setInviteError(t('remotePage.connect.copyFailed'));
      copyRef.current?.focus();
    } catch {
      if (mounted.current) setInviteError(t('settings.a2aRemoteActionFailed'));
    } finally {
      if (mounted.current) setCreating(false);
    }
  }, [api, invite, t, onA2aStatus, mintForInvite, copyBundle]);

  /** Tick: mint the link and copy both. Untick: cancel the link and copy the invite alone. */
  const toggleShare = useCallback(async () => {
    const next = !shareRef.current;
    shareRef.current = next;
    setShareOn(next);
    setShareError(null);
    setInviteError(null);
    const text = invite.invite;
    setShareBusy(true);
    try {
      if (!next) {
        await dropWorkspaceLink();
        if (text && mounted.current) await invite.copy(text);
        return;
      }
      // No invite yet: the next one brings the link along.
      if (!text) return;
      const ws = await mintForInvite();
      if (!ws || !mounted.current) return;
      if (!(await copyBundle(text, ws)) && mounted.current) setInviteError(t('remotePage.connect.copyFailed'));
    } finally {
      if (mounted.current) setShareBusy(false);
    }
  }, [invite, dropWorkspaceLink, mintForInvite, copyBundle, t]);
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

  /** Connect one pasted piece; the line it leaves for the message. */
  const connectOne = useCallback(async (text: string): Promise<{ ok: boolean; text: string; hostId?: string }> => {
    if (kindOf(text) === 'a2a') {
      const r = await invite.join(text);
      if (!r) return { ok: false, text: t('remote.pairFailed') };
      if (r.ok) {
        void refreshA2aRemote();
        return { ok: true, text: t('remotePage.connect.joinedA2a', { name: r.name }), hostId: r.host.hostId };
      }
      const retry = r.retryAfterSec != null && r.retryAfterSec > 0
        ? ` ${t('settings.a2aRemoteJoinRetryIn', { time: formatRemaining(r.retryAfterSec) })}` : '';
      return { ok: false, text: `${t(`settings.a2aRemoteJoinError.${r.error}`)}${retry}` };
    }
    const parsed = parseRemotePairInput(text);
    if (parsed.kind === 'error') return { ok: false, text: t(INPUT_ERROR[parsed.reason]) };
    const remote = window.electronAPI?.remote;
    if (!remote) return { ok: false, text: t('remote.pairFailed') };
    try {
      const res = parsed.kind === 'pair'
        ? await remote.hostsPair(parsed.origin, parsed.code)
        : await remote.hostsAdd(parsed.url);
      if (res.ok) return { ok: true, text: t('remotePage.connect.hostAdded', { name: res.host.label }) };
      return { ok: false, text: 'reason' in res ? pairReasonMessage(t, res.reason, res.attemptsLeft) : res.error };
    } catch {
      return { ok: false, text: t('remote.pairFailed') };
    }
  }, [invite, t]);

  /**
   * Connect each piece in turn (a bundled invite is two). What failed stays
   * in the field for another try; what connected does not, since its code is
   * spent.
   */
  const connect = useCallback(async () => {
    const parts = pastedParts(paste);
    if (!parts[0]) return;
    setMessage(null);
    setBusy(true);
    const lines: string[] = [];
    const left: string[] = [];
    let host: string | null = null;
    try {
      for (const part of parts) {
        const r = await connectOne(part);
        if (!mounted.current) return;
        lines.push(r.text);
        if (!r.ok) left.push(part);
        if (r.hostId) host = r.hostId;
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
    if (left.length !== parts.length) {
      setPaste(left.join('\n'));
      if (left.length === 0) setMasked(false);
    }
    if (host) setLinkHost(host);
    setMessage({ tone: left.length > 0 ? 'danger' : 'muted', text: lines.join('\n') });
  }, [paste, connectOne]);

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
                  <code className="ui-code whitespace-pre-line" data-testid="remote-connect-code">{inviteBundle(invite.invite, wsLink)}</code>
                  <Button
                    ref={copyRef}
                    variant="primary"
                    size="md"
                    onClick={() => {
                      void copyBundle(invite.invite ?? '', wsLink).then((ok) => {
                        if (!ok && mounted.current) setInviteError(t('remotePage.connect.copyFailed'));
                      });
                    }}
                    data-testid="remote-connect-copy"
                  >
                    {invite.copied || bundleCopied ? t('web.copied') : t('web.copy')}
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
              <Button variant="secondary" size="md" className="self-start" disabled={shareBusy} onClick={() => void startInvite()} data-testid="remote-connect-new-code">
                {t('remotePage.connect.newCode')}
              </Button>
            )}
            <Field
              label={t('remotePage.connect.shareWorkspaces')}
              description={shareReady ? t('remotePage.connect.shareWorkspacesHint') : t('remotePage.connect.shareWorkspacesOff')}
            >
              <Checkbox
                checked={shareOn}
                disabled={!shareReady || shareBusy || creating}
                onCheckedChange={() => void toggleShare()}
                data-testid="remote-connect-share"
              />
            </Field>
            {shareError && (
              <p className="wmux-a2a-note" data-tone="danger" role="alert" data-testid="remote-connect-share-error">
                {t(shareError === 'busy' ? 'remotePage.connect.shareWorkspacesBusy' : 'remotePage.connect.shareWorkspacesFailed')}
              </p>
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
                <code className="ui-code whitespace-pre-line" data-testid="remote-connect-pasted">{maskPasted(paste)}</code>
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
            {!(masked && message) && (
              <p className="wmux-remote-connect-note">{masked ? t('remotePage.connect.fromClipboard') : t('remotePage.connect.pasteHint')}</p>
            )}
            {message && (
              <p className="wmux-a2a-note whitespace-pre-line" data-tone={message.tone === 'danger' ? 'danger' : undefined} role={message.tone === 'danger' ? 'alert' : 'status'} data-testid="remote-connect-message">
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
          <Button variant="destructive" size="md" onClick={() => { void invite.cancel(); void dropWorkspaceLink(); }} data-testid="remote-connect-discard">
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
