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
import PairingScope from '../PcRail/PairingScope';
import { formatRemaining } from '../Settings/A2aRemoteSection';
import { INPUT_ERROR } from '../StatusBar/OtherComputersSection';
import { pairReasonMessage } from '../Sidebar/AttachRemoteModal';
import { pendingPairFlow, uniqueDeviceName, webComputerLink } from '../StatusBar/WebToggle';
import { webComputerPairOrigin } from '../../../shared/web';
import { maskPairInput, parseRemotePairInput } from '../../../shared/remotePairInput';
import { HOST_UNREACHABLE_ERROR } from '../../../shared/remoteHosts';
import type { A2aRemoteStatus } from '../../../shared/rpc';
import LanLinkPairPanel from './LanLinkPairPanel';
import { TailscaleFixButton } from './TailscaleChecklist';
import { FirewallNoticeView, ListenProblemView, useFirewall, useListenProblem } from './FirewallNotice';
import { tailnetPrecheck, tailnetTargetOf, withTailnetNote, type TailnetNotice } from './tailnetCheck';
import type { TailscaleFix } from '../../../shared/web';

// ─── "Connect a PC…" on the Remote page ──────────────────────────────────────
//
// One dialog, three tabs. Opening it or showing a tab only reads state. It
// opens on "Invite this PC" when the A2A listener is already up, otherwise on
// "Paste an invite". The Invite tab opens (and copies) an invite only when the
// person presses Create invite; with A2A off that button says it turns the
// listener on, and pressing it is what turns it on. When a PC redeems the
// invite, the dialog turns into that PC's "what it can see" checklist
// (nothing ticked). "Paste an
// invite" takes a `wmux-a2a://` invite (A2A join) or any shape the remote-host
// pairing takes (a pairing link, a `wmux web` token URL, an address and a
// code), routed by its shape. The clipboard is read only on its Paste button,
// and nothing connects until the person presses Connect.
//
// "Also let it see this PC's workspaces" (off by default, offered only while
// Share & pair is reachable over HTTPS) adds a view-only computer pairing
// link to the invite, one per line. Pasted on the other PC, each line
// connects in turn: one paste, both connections.
//
// "LAN" pairs a message link with a PC on this network by a 6-digit PIN
// (LanLinkPairPanel). It is never the first tab and starts nothing on open.

export type ConnectTab = 'invite' | 'paste' | 'lan';

/** How often the open invite is checked for a PC that redeemed it. */
export const CONNECT_PAIR_POLL_MS = 2_000;
/** Ticks an invite that went away before its expiry is still watched for the PC that redeemed it. */
export const CONNECT_REDEEM_GRACE_TICKS = 3;

const A2A_INVITE_RE = /^wmux-a2a:\/\//i;

/** Join failures that mean the other PC was never reached. */
const JOIN_UNREACHABLE: ReadonlySet<string> = new Set(['connect-refused', 'timeout', 'not-found', 'failed']);

/** A failed connect's line, with the Tailscale reason added when there is one. */
function noteUnreachable(line: string, note: TailnetNotice | null): { ok: false; text: string; fix?: TailscaleFix } {
  return { ok: false, text: withTailnetNote(line, note), ...(note?.fix ? { fix: note.fix } : {}) };
}

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

/**
 * The invite's 8-character code in two groups (ABCD-EFGH), to read out or
 * check by eye. Display only: what is copied and pasted is the whole invite.
 */
export function inviteCodeGroups(invite: string): string | null {
  const m = /^wmux-a2a:\/\/[^/\s]+\/([A-Z0-9]{8})#/i.exec(invite.trim());
  return m ? `${m[1].slice(0, 4)}-${m[1].slice(4)}` : null;
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
  /** Opens "Add PC over SSH" for a computer that cannot send an invite. */
  onAddOverSsh?: () => void;
  /** A PC was paired on the LAN tab: the page re-reads its list. */
  onLanPaired?: () => void;
}

export default function RemoteConnectDialog({ initialTab, onClose, onLinkPane, onA2aStatus, onAddOverSsh, onLanPaired }: RemoteConnectDialogProps) {
  const t = useT();
  const api = window.electronAPI?.a2aRemote;
  const web = window.electronAPI?.web;
  const invite = useA2aInvite();
  const { applyPairStatus } = invite;
  // null until the listener's state is known (it picks the first tab).
  const [tab, setTab] = useState<ConnectTab | null>(initialTab ?? null);
  // A tab the person picked (or the caller asked for) is never replaced by the status-based default.
  const tabChosen = useRef(initialTab != null);
  // The LAN panel stays mounted once shown, so switching tabs keeps its PIN;
  // closing the dialog unmounts it, which closes a window it left open.
  const [lanShown, setLanShown] = useState(initialTab === 'lan');
  const [paste, setPaste] = useState('');
  const [masked, setMasked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'muted' | 'danger'; text: string; fix?: TailscaleFix } | null>(null);
  const [turnedOn, setTurnedOn] = useState(false);
  // The listener's state as last read (null: not read yet, or no daemon). Read only; never changed on show.
  const [a2aState, setA2aState] = useState<A2aRemoteStatus | null>(null);
  // Until the first read lands, Create invite cannot say whether it turns the listener on, so it waits.
  const [statusRead, setStatusRead] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // The listener could not bind: its code and port, explained by the daemon (who holds it, a port to try).
  const [inviteFailure, setInviteFailure] = useState<{ code: string; port: number } | null>(null);
  const inviteProblem = useListenProblem('a2a', inviteFailure ? `${inviteFailure.code}:${inviteFailure.port}` : null);
  // Checked only when asked (Check firewall after copying): the dialog never runs it by itself.
  const firewall = useFirewall('a2a', { enabled: false, checkKey: '' });
  const [creating, setCreating] = useState(false);
  const [joined, setJoined] = useState<{ hostId: string; name: string } | null>(null);
  const [linkHost, setLinkHost] = useState<{ hostId: string; name: string } | null>(null);
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
  const createRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const knownPeers = useRef<Set<string> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Opening the dialog changes nothing: it reads the listener's state, which
  // picks the first tab (Invite only when the listener is already up) and the
  // Invite tab's button (Create invite, or Turn on and create invite).
  useEffect(() => {
    let live = true;
    void (async () => {
      const status = await api?.status().catch(() => null);
      if (!live) return;
      setA2aState(status ?? null);
      setStatusRead(true);
      if (!tabChosen.current) setTab(status?.enabled && status.listening ? 'invite' : 'paste');
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

  // Create invite (pressed, never on show): listener on if it was off, invite open, invite copied.
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
      if (mounted.current) setA2aState(status);
      if (!status.listening) {
        if (!mounted.current) return;
        if (status.lastErrorCode) setInviteFailure({ code: status.lastErrorCode, port: status.lastErrorPort ?? status.port });
        else setInviteError(status.lastError ?? t('settings.a2aRemoteActionFailed'));
        return;
      }
      setInviteFailure(null);
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

  /** "Use port N": move the listener there, then open the invite on it. */
  const moveInvitePort = useCallback(async (port: number) => {
    if (!api) return;
    setCreating(true);
    try {
      const status = await api.configure({ port });
      onA2aStatus?.(status);
      if (mounted.current) setA2aState(status);
    } catch {
      if (mounted.current) setInviteError(t('settings.a2aRemoteActionFailed'));
      return;
    } finally {
      if (mounted.current) setCreating(false);
    }
    if (mounted.current) await startInvite();
  }, [api, onA2aStatus, startInvite, t]);

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
  const connectOne = useCallback(async (text: string): Promise<{ ok: boolean; text: string; host?: { hostId: string; name: string }; share?: boolean; fix?: TailscaleFix }> => {
    // Every address this piece would try is in the tailnet range: when
    // Tailscale here cannot carry it (off, signed out, the other device not
    // on it), say so now instead of letting the connect run into its timeout,
    // or, for an address Tailscale may not own, say it if the connect fails.
    const tailnet = await tailnetPrecheck(tailnetTargetOf(text));
    if (tailnet.held) return { ok: false, ...tailnet.held };
    const unreachable = (line: string): { ok: false; text: string; fix?: TailscaleFix } => noteUnreachable(line, tailnet.ifUnreachable);
    if (kindOf(text) === 'a2a') {
      const r = await invite.join(text);
      if (!r) return { ok: false, text: t('remote.pairFailed') };
      if (r.ok) {
        void refreshA2aRemote();
        return { ok: true, text: t('remotePage.connect.joinedA2a', { name: r.name }), host: { hostId: r.host.hostId, name: r.name } };
      }
      const retry = r.retryAfterSec != null && r.retryAfterSec > 0
        ? ` ${t('settings.a2aRemoteJoinRetryIn', { time: formatRemaining(r.retryAfterSec) })}` : '';
      const line = `${t(`settings.a2aRemoteJoinError.${r.error}`)}${retry}`;
      return JOIN_UNREACHABLE.has(r.error) ? unreachable(line) : { ok: false, text: line };
    }
    const parsed = parseRemotePairInput(text);
    if (parsed.kind === 'error') return { ok: false, text: t(INPUT_ERROR[parsed.reason]) };
    const remote = window.electronAPI?.remote;
    if (!remote) return { ok: false, text: t('remote.pairFailed') };
    try {
      const res = parsed.kind === 'pair'
        ? await remote.hostsPair(parsed.origin, parsed.code)
        : await remote.hostsAdd(parsed.url);
      if (res.ok) return { ok: true, text: t('remotePage.connect.hostAdded', { name: res.host.label }), share: true };
      if ('reason' in res) {
        const line = pairReasonMessage(t, res.reason, res.attemptsLeft);
        return res.reason === 'unreachable' ? unreachable(line) : { ok: false, text: line };
      }
      return res.error === HOST_UNREACHABLE_ERROR ? unreachable(res.error) : { ok: false, text: res.error };
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
    let host: { hostId: string; name: string } | null = null;
    let shared = false;
    let fix: TailscaleFix | undefined;
    try {
      for (const part of parts) {
        const r = await connectOne(part);
        if (!mounted.current) return;
        lines.push(r.text);
        if (!r.ok) left.push(part);
        if (r.host) host = r.host;
        if (r.share) shared = true;
        fix ??= r.fix;
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
    // A workspace share alone is not an A2A pairing: say where agent messages are set up.
    if (shared && !host) lines.push(t('remote.agentMessagesNote'));
    if (left.length !== parts.length) {
      setPaste(left.join('\n'));
      if (left.length === 0) setMasked(false);
    }
    // Only the PC this paste paired with: a workspace link or a failed join drops the last one.
    setLinkHost(host);
    setMessage({ tone: left.length > 0 ? 'danger' : 'muted', text: lines.join('\n'), ...(fix ? { fix } : {}) });
  }, [paste, connectOne, t]);

  if (tab === null) return null;
  const working = busy || invite.joinBusy;
  const remaining = invite.remainingSec;
  // Off (or never set up): the button says it turns the listener on, and the line above it says what that is.
  // A read that failed is not proof the listener is on: the button then says it turns it on.
  const a2aOff = statusRead && (a2aState === null || !a2aState.enabled);
  const createWaits = !statusRead || creating || shareBusy;
  const canConnect = paste.trim() !== '' && !working;
  // The port is taken: "Use port N" is what unblocks, so it is the primary and Create invite (a retry) is not.
  const usePortPrimary = inviteFailure !== null && !invite.invite && inviteProblem?.suggestion != null;

  // The LAN panel keeps its place in the body in both views below (second
  // child of DialogBody, after the tabs or an empty slot), so a PC redeeming
  // the invite does not unmount it and end a LAN PIN that is still open.
  const lanPanel = lanShown ? (
    <div hidden={tab !== 'lan' || joined !== null}>
      <LanLinkPairPanel onPaired={onLanPaired} />
    </div>
  ) : null;

  if (joined) {
    return (
      <Dialog onClose={onClose} width={520} data-testid="remote-connect-joined">
        <DialogHeader
          title={t('remotePage.connect.joinedTitle', { name: joined.name })}
          description={t('remotePage.connect.joinedDesc')}
          closeLabel={t('remotePage.connect.close')}
        />
        <DialogBody>
          {null}
          {lanPanel}
          <A2aExposureChecklist hostId={joined.hostId} pcName={joined.name} t={t} />
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" size="md" onClick={onClose}>{t('remotePage.connect.done')}</Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog
      onClose={onClose}
      width={520}
      initialFocusRef={tab === 'paste' ? inputRef : tab === 'invite' ? createRef : undefined}
      data-testid="remote-connect"
    >
      <DialogHeader title={t('remotePage.connect.title')} closeLabel={t('remotePage.connect.close')} />
      <DialogBody>
        <SegmentedControl<ConnectTab>
          value={tab}
          onValueChange={(v) => { tabChosen.current = true; setTab(v); setMessage(null); if (v === 'lan') setLanShown(true); }}
          ariaLabel={t('remotePage.connect.title')}
          options={[
            { value: 'invite', label: t('remotePage.connect.tabInvite') },
            { value: 'paste', label: t('remotePage.connect.tabPaste') },
            { value: 'lan', label: t('remotePage.connect.tabLan') },
          ]}
          data-testid="remote-connect-tabs"
        />
        {lanPanel}
        {tab === 'lan' ? null : tab === 'invite' ? (
          <div className="wmux-remote-connect" data-testid="remote-connect-invite">
            <p className="wmux-remote-connect-note">{t('remotePage.connect.inviteDesc')}</p>
            {a2aOff && a2aState !== null && !invite.invite && (
              <p className="wmux-remote-connect-note" data-testid="remote-connect-turn-on-note">
                {t('remotePage.connect.turnOnNote', { port: a2aState?.port ?? '' })}
              </p>
            )}
            {/* Says what the listener really did: on and reachable, or on but held off its port. */}
            {turnedOn && a2aState?.listening && <p className="wmux-remote-connect-note" data-testid="remote-connect-turned-on">{t('remotePage.connect.turnedOn')}</p>}
            {turnedOn && !a2aState?.listening && inviteFailure && (
              <p className="wmux-remote-connect-note" data-testid="remote-connect-turned-on-blocked">
                {t('remotePage.connect.turnedOnBlocked', { port: inviteFailure.port })}
              </p>
            )}
            {inviteError && <p className="wmux-a2a-note" data-tone="danger" role="alert">{inviteError}</p>}
            {inviteFailure && !invite.invite && (
              <ListenProblemView
                report={inviteProblem}
                fallback={t('settings.a2aRemoteNotListening', { error: inviteFailure.code })}
                onUsePort={(port) => void moveInvitePort(port)}
                busy={creating}
                working={creating}
                repair
                primary={usePortPrimary}
                listener="a2a"
                t={t}
              />
            )}
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
                {inviteCodeGroups(invite.invite) && (
                  <p className="wmux-remote-connect-note" data-testid="remote-connect-code-groups">
                    {t('remotePage.connect.codeGroups', { code: inviteCodeGroups(invite.invite) ?? '' })}
                  </p>
                )}
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
                {/* The host cannot see a blocked connection; the person comes back here when the other PC could not connect. */}
                <div className="flex flex-wrap items-center gap-2">
                  <p className="wmux-remote-connect-note" data-testid="remote-connect-firewall-hint">{t('net.fw.inviteHint')}</p>
                  <Button variant="ghost" size="sm" disabled={firewall.checking || firewall.busy !== null} onClick={firewall.check} data-testid="remote-connect-firewall-check">
                    {firewall.checking ? t('net.fw.checking') : t('net.fw.check')}
                  </Button>
                </div>
                <FirewallNoticeView c={firewall} listener="a2a" primary={false} ownCheck t={t} />
              </>
            ) : creating ? (
              <p className="wmux-remote-connect-note">{t('remotePage.connect.creating')}</p>
            ) : null}
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
            {/* What the shared link reaches, said before the other PC pastes it. */}
            {shareOn && <PairingScope />}
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
                ref={inputRef}
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
            {/* A shared-workspaces link puts that PC in the computer column,
                which checks it and holds a connection for its alerts. */}
            <p className="wmux-remote-connect-note" data-testid="remote-connect-paste-scope">{t('remotePage.connect.pasteScope')}</p>
            {onAddOverSsh && (
              <Button variant="ghost" size="sm" className="self-start" onClick={onAddOverSsh} data-testid="remote-connect-add-ssh">
                {t('remotePage.connect.addOverSsh')}
              </Button>
            )}
            {message && (
              <p className="wmux-a2a-note whitespace-pre-line" data-tone={message.tone === 'danger' ? 'danger' : undefined} role={message.tone === 'danger' ? 'alert' : 'status'} data-testid="remote-connect-message">
                {message.text}
              </p>
            )}
            {/* The other PC shows this one nothing yet: say where that is chosen there. */}
            {linkHost && !paste.trim() && (
              <p className="wmux-remote-connect-note" data-testid="remote-connect-next-step">
                {t('remotePage.connect.nextStep', { name: linkHost.name })}
              </p>
            )}
            {message?.fix && (
              <div className="flex flex-wrap items-center gap-2" data-testid="remote-connect-tailscale-fix">
                <TailscaleFixButton fix={message.fix} />
              </div>
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
        {tab === 'invite' && !invite.invite && (
          <Button
            ref={createRef}
            variant={createWaits || usePortPrimary ? 'secondary' : 'primary'}
            size="md"
            // aria-disabled while the read is pending keeps it focusable (it is the dialog's first focus).
            disabled={creating || shareBusy}
            aria-disabled={!statusRead || undefined}
            onClick={() => { if (statusRead) void startInvite(); }}
            data-testid="remote-connect-create"
          >
            {t(a2aOff ? 'remotePage.connect.turnOnAndCreate' : 'remotePage.connect.createInvite')}
          </Button>
        )}
        {tab === 'paste' && linkHost && !paste.trim() && (
          <Button variant="primary" size="md" onClick={() => onLinkPane(linkHost.hostId)} data-testid="remote-connect-link-pane">
            {t('remotePage.connect.linkPaneNow')}
          </Button>
        )}
        {tab === 'paste' && !(linkHost && !paste.trim()) && (
          // Disabled or in flight, Connect is not the primary: it turns primary once there is something to connect.
          <Button variant={canConnect ? 'primary' : 'secondary'} size="md" disabled={!canConnect} onClick={() => void connect()} data-testid="remote-connect-submit">
            {working ? t('remotePage.connect.connecting') : t('remotePage.connect.connect')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
