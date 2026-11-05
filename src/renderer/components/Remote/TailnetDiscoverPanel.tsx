import { useEffect, useId, useRef, type Ref } from 'react';
import { useT } from '../../hooks/useT';
import { useTailnetDiscovery } from '../../hooks/useTailnetDiscovery';
import Button from '../ui/Button';
import { formatRemaining } from '../Settings/A2aRemoteSection';
import { groupPin } from './LanLinkPairPanel';
import { TailscaleFixButton } from './TailscaleChecklist';
import { describeTailnetFailure } from './tailnetCheck';
import { FirewallNoticeView, ListenProblemView, useFirewall, useListenProblem, type FirewallController } from './FirewallNotice';
import { TailnetPcList, osLabel } from './TailnetPcList';
import type { A2aDiscoverPc, A2aDiscoverReceiveView, A2aDiscoverRequestView, A2aRemoteStatus } from '../../../shared/rpc';
import type { TailscaleChecklist } from '../../../shared/web';
import { classifyListenError, type ListenProblemReport } from '../../../shared/netListen';

// ─── Connect a PC › Tailscale ─────────────────────────────────────────────────
//
// "PCs found on your tailnet": Find PCs scans this user's tailnet for wmux
// PCs that are discoverable right now (again every 5 s for 2 minutes), and
// Connect asks one. Both screens then show the same 6-digit code; this one
// waits, with Cancel, until the other PC's person allows.
//
// "This PC": Make this PC discoverable opens a 5-minute window in which this
// PC's own user's tailnet devices can find it and ask to pair. A request
// shows as one card: Tailscale's identity of the asking device and the
// 6-digit code both screens show, with Deny and Allow. Allow pairs as an
// invite would and shows the PC nothing until panes are ticked.
//
// One role at a time: while this PC is discoverable the tab shows only that,
// and while a request is out the dialog shows only the code. The VIEW is
// pure (props only); the CONTAINER holds the state (useTailnetDiscovery).

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * What a refused open said about the port, for a daemon that sent no report
 * with it: whom the port belongs to is then unknown, and the next port is
 * offered untried (a retry that meets it taken offers the one after).
 */
export function refusedListenReport(
  v: Extract<A2aDiscoverReceiveView, { kind: 'listen-failed' }>,
  platform: string,
): ListenProblemReport | null {
  if (!v.lastErrorCode) return null;
  const problem = classifyListenError(v.lastErrorCode, v.port, platform, null);
  const aboutThePort = problem.kind === 'port-in-use' || problem.kind === 'port-reserved' || problem.kind === 'port-denied';
  return { problem, holder: null, suggestion: aboutThePort && v.port < 65535 ? v.port + 1 : null };
}

/** The receiving states that keep the window's band (countdown and Stop) on screen. */
const WINDOW_OPEN: ReadonlySet<A2aDiscoverReceiveView['kind']> = new Set(['discoverable', 'approval', 'allowed', 'denied', 'refused']);

/** The requesting states in which the dialog shows only the request (retitled, no tabs). */
export const REQUEST_FOCUS: ReadonlySet<A2aDiscoverRequestView['kind']> = new Set(['asking', 'waiting', 'confirm', 'joining']);

/** The PC a request in flight is for, when the dialog should show only it. */
export function requestFocusPc(v: A2aDiscoverRequestView): A2aDiscoverPc | null {
  return v.kind === 'asking' || v.kind === 'waiting' || v.kind === 'confirm' || v.kind === 'joining' ? v.pc : null;
}

export interface TailnetDiscoverPanelViewProps {
  request: A2aDiscoverRequestView;
  /** The last scan's list, kept under a request's outcome line, and its offline count. */
  scan: { pcs: A2aDiscoverPc[]; checked: number; offline: number } | null;
  /** Find PCs was pressed under 2 minutes ago: the list still re-scans. */
  rescanning: boolean;
  onFind: () => void;
  onConnect: (pc: A2aDiscoverPc) => void;
  onCancel: () => void;
  /** The other PC allowed and its code matches this one: pair. */
  onConfirm: () => void;
  confirming: boolean;
  receive: A2aDiscoverReceiveView;
  /** A2A is off now: the button turns it on. */
  a2aOff: boolean;
  /** A2A's port, for the line on what turning it on does. */
  port: number | null;
  /** The listener's state is read; until then the button cannot say whether it turns A2A on. */
  statusRead: boolean;
  /** This PC's machine name, as the open window tells tailnet devices. */
  selfName: string;
  /** When the open window ends on its own. */
  expiresAt: number | null;
  now: number;
  busy: boolean;
  failed: boolean;
  listenProblem: ListenProblemReport | null;
  firewall: FirewallController;
  onMakeDiscoverable: () => void;
  onStop: () => void;
  onDecide: (allow: boolean) => void;
  onUsePort: (port: number) => void;
  /** The tab's first action, where the dialog puts focus when it opens on this tab. */
  firstActionRef?: Ref<HTMLButtonElement>;
  t: T;
}

export function TailnetDiscoverPanelView(p: TailnetDiscoverPanelViewProps) {
  return (
    <div className="wmux-remote-connect" data-testid="remote-connect-tailscale">
      {REQUEST_FOCUS.has(p.request.kind) ? (
        <RequestFocus {...p} />
      ) : WINDOW_OPEN.has(p.receive.kind) ? (
        <WindowOpen {...p} />
      ) : (
        <>
          <FoundPcs {...p} />
          <div className="h-px bg-[var(--stroke)]" aria-hidden="true" />
          <ThisPc {...p} />
        </>
      )}
      {p.failed && (
        <p className="wmux-a2a-note" data-tone="danger" role="alert" data-testid="discover-failed">{p.t('settings.a2aRemoteActionFailed')}</p>
      )}
    </div>
  );
}

/** Not discoverable: the button, and why the last try did not open a window. */
function ThisPc(p: TailnetDiscoverPanelViewProps) {
  const { receive: v, t } = p;
  const a2aOff = v.kind === 'idle' ? v.a2aOff : p.a2aOff;
  const starting = v.kind === 'starting';
  return (
    <div className="flex flex-col gap-2" data-discover-receive={v.kind}>
      <div className="flex items-center gap-3">
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[13px] font-medium text-[var(--text-main)]">{t('remotePage.discover.selfTitle')}</span>
          <span className="text-[11px] text-[var(--text-sub)]">{t('remotePage.discover.selfDesc')}</span>
        </div>
        <Button
          variant="secondary"
          size="md"
          disabled={starting || p.busy}
          // aria-disabled while the read is pending keeps it focusable (it can be the dialog's first focus).
          aria-disabled={!p.statusRead || undefined}
          onClick={() => { if (p.statusRead) p.onMakeDiscoverable(); }}
          data-testid="discover-make"
        >
          {t(starting ? 'remotePage.discover.starting' : a2aOff ? 'remotePage.discover.turnOnAndMake' : 'remotePage.discover.makeDiscoverable')}
        </Button>
      </div>
      {a2aOff && p.port !== null && !starting && (
        <p className="wmux-remote-connect-note" data-testid="discover-turn-on-note">{t('remotePage.discover.turnOnNote', { port: p.port })}</p>
      )}
      <div aria-live="polite" className="flex flex-col gap-2">
        <ThisPcLine {...p} />
      </div>
    </div>
  );
}

function ThisPcLine(p: TailnetDiscoverPanelViewProps) {
  const { receive: v, t } = p;
  switch (v.kind) {
    case 'tailscale-not-ready':
      // Said once, above, when the list's section says the same.
      if (p.request.kind === 'tailscale-not-ready' && p.request.check.reason === v.check.reason) return null;
      return (
        <>
          <p className="wmux-a2a-note" data-tone="warning" data-testid="discover-receive-line">{describeTailnetFailure(v.check)}</p>
          {v.check.fix && (
            <div className="flex flex-wrap items-center gap-2"><TailscaleFixButton fix={v.check.fix} /></div>
          )}
        </>
      );
    case 'no-tailnet-ipv4':
      return <p className="wmux-a2a-note" data-tone="warning" data-testid="discover-receive-line">{t('remotePage.discover.noTailnetIpv4')}</p>;
    case 'unavailable':
      return (
        <>
          <p className="wmux-a2a-note" data-tone="warning" data-testid="discover-receive-line">{t(`remotePage.discover.unavailable.${v.reason}`)}</p>
          {v.reason === 'tailscale-whois-unsupported' && (
            <div className="flex flex-wrap items-center gap-2"><TailscaleFixButton fix="download" /></div>
          )}
        </>
      );
    case 'listen-failed':
      return (
        <ListenProblemView
          report={p.listenProblem}
          fallback={v.lastErrorCode ? t('settings.a2aRemoteNotListening', { error: v.lastErrorCode }) : v.lastError ?? t('settings.a2aRemoteActionFailed')}
          onUsePort={p.onUsePort}
          busy={p.busy}
          repair
          primary
          listener="a2a"
          live={false}
          t={t}
        />
      );
    case 'paired':
      return <p className="wmux-a2a-note" data-testid="discover-receive-line">{t('remotePage.connect.joinedA2a', { name: v.peer.name })}</p>;
    case 'grant-expired':
      return <p className="wmux-a2a-note" data-testid="discover-receive-line">{t('remotePage.discover.grantExpired')}</p>;
    case 'ended':
      return <p className="wmux-a2a-note" data-testid="discover-receive-line">{t(`remotePage.discover.ended.${v.reason}`)}</p>;
    default:
      return null;
  }
}

/** PCs found on your tailnet: Find PCs, the list, and how the last request ended. */
function FoundPcs(p: TailnetDiscoverPanelViewProps) {
  const { request: v, t } = p;
  // The list under a request's outcome is the last scan's, so another PC can be asked at once.
  const last = OUTCOME.has(v.kind) ? p.scan : null;
  const checked = v.kind === 'results' || v.kind === 'empty' ? v.checked : last?.checked ?? null;
  const pcs = v.kind === 'searching' || v.kind === 'results' ? v.pcs : last?.pcs ?? [];
  const searching = v.kind === 'searching' || (p.rescanning && checked !== null);
  const scanned = checked !== null || v.kind === 'searching';
  return (
    <div className="flex flex-col gap-2" data-discover-request={v.kind}>
      <div className="flex items-center justify-between gap-3 min-h-[26px]">
        <span className="text-[13px] font-medium text-[var(--text-main)]">{t('remotePage.discover.pcsTitle')}</span>
        {searching ? (
          <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-sub)]" data-testid="discover-searching">
            <span className="wmux-remote-dot" aria-hidden="true" />
            {checked !== null ? t('remotePage.discover.searchingChecked', { count: checked }) : t('remotePage.discover.searching')}
          </span>
        ) : scanned && v.kind !== 'joined' ? (
          <span className="flex items-center gap-2">
            {checked !== null && <span className="text-[11px] text-[var(--text-sub)]" data-testid="discover-checked">{t('remotePage.discover.checked', { count: checked })}</span>}
            <Button ref={p.firstActionRef} variant="ghost" size="sm" onClick={p.onFind} data-testid="discover-search-again">{t('remotePage.discover.searchAgain')}</Button>
          </span>
        ) : null}
      </div>
      {!scanned && v.kind !== 'joined' && (
        <div className="flex items-center gap-3">
          <p className="wmux-remote-connect-note flex-1 min-w-0">{t('remotePage.discover.pcsDesc')}</p>
          <Button
            ref={p.firstActionRef}
            // A retry after Tailscale or the address said no is not the way forward; the fix is.
            // Nor while the listener's port notice below carries the one primary (Use port N).
            variant={v.kind === 'idle' && p.receive.kind !== 'listen-failed' ? 'primary' : 'secondary'}
            size="md"
            onClick={p.onFind}
            data-testid="discover-find"
          >
            {t('remotePage.discover.find')}
          </Button>
        </div>
      )}
      <div aria-live="polite" className="flex flex-col gap-2">
        <FoundPcsLine {...p} />
      </div>
      {/* While the port notice holds the one primary, no row's Connect takes it too. */}
      {pcs.length > 0 && <TailnetPcList pcs={pcs} onConnect={p.onConnect} primary={p.receive.kind !== 'listen-failed'} t={t} />}
      {v.kind === 'joined' ? null : (
        <>
          {p.scan && p.scan.offline > 0 && (
            <p className="wmux-remote-connect-note" data-testid="discover-offline">{t('remotePage.discover.offline', { count: p.scan.offline })}</p>
          )}
          <p className="text-[11px] leading-4 text-[var(--text-muted)] m-0">{t('remotePage.discover.hint')}</p>
        </>
      )}
    </div>
  );
}

/** The requesting states that end a request without a pairing: one line over the list. */
const OUTCOME: ReadonlySet<A2aDiscoverRequestView['kind']> = new Set(['denied', 'timed-out', 'gone', 'busy', 'refused', 'join-error']);

function FoundPcsLine(p: TailnetDiscoverPanelViewProps) {
  const { request: v, t } = p;
  switch (v.kind) {
    case 'tailscale-not-ready':
      return (
        <>
          <p className="wmux-a2a-note" data-tone="warning" data-testid="discover-request-line">{describeTailnetFailure(v.check)}</p>
          {v.check.fix && (
            <div className="flex flex-wrap items-center gap-2"><TailscaleFixButton fix={v.check.fix} /></div>
          )}
        </>
      );
    case 'no-tailnet-ipv4':
      return <p className="wmux-a2a-note" data-tone="warning" data-testid="discover-request-line">{t('remotePage.discover.noTailnetIpv4')}</p>;
    case 'unavailable':
      return <p className="wmux-a2a-note" data-tone="warning" data-testid="discover-request-line">{t(`remotePage.discover.unavailable.${v.reason}`)}</p>;
    case 'empty':
      return <p className="wmux-a2a-note" data-testid="discover-request-line">{t('remotePage.discover.empty')}</p>;
    case 'joined':
      return (
        <>
          <p className="wmux-a2a-note" role="status" data-testid="discover-request-line">{t('remotePage.connect.joinedA2a', { name: v.host.name })}</p>
          {/* The other PC shows this one nothing yet: say where that is chosen there. */}
          <p className="wmux-remote-connect-note" data-testid="discover-next-step">{t('remotePage.connect.nextStep', { name: v.host.name })}</p>
        </>
      );
    case 'denied':
    case 'timed-out':
    case 'gone':
    case 'busy':
      return <p className="wmux-a2a-note" data-tone="warning" data-testid="discover-request-line">{t(`remotePage.discover.outcome.${v.kind}`, { name: v.pc.device })}</p>;
    case 'refused':
      return <p className="wmux-a2a-note" data-tone="warning" data-testid="discover-request-line">{t(`remotePage.discover.outcome.refused.${v.reason}`, { name: v.pc.device })}</p>;
    case 'join-error':
      return (
        <p className="wmux-a2a-note" data-tone="danger" data-testid="discover-request-line">
          {/* The other PC dropped its old pairing with this one: only a new invite pairs them again. */}
          {v.error === 'fingerprint-mismatch' ? t('remotePage.discover.outcome.fingerprintMismatch', { name: v.pc.device }) : t(`settings.a2aRemoteJoinError.${v.error}`)}
        </p>
      );
    default:
      return null;
  }
}

/**
 * A request in flight: the code to compare with the other PC's card, its
 * countdown, and Cancel. Once the other PC allowed, this PC's person also
 * confirms the codes match before anything pairs. The dialog is retitled to
 * that PC and hides its tabs meanwhile; closing it withdraws the request.
 */
function RequestFocus(p: TailnetDiscoverPanelViewProps) {
  const { request: v, t } = p;
  const pc = requestFocusPc(v);
  if (!pc) return null;
  const coded = v.kind === 'waiting' || v.kind === 'confirm' ? v : null;
  const left = coded ? Math.max(0, Math.ceil((coded.expiresAt - p.now) / 1000)) : 0;
  return (
    <div className="flex flex-col gap-4" data-discover-request={v.kind}>
      <div className="flex flex-col items-center gap-2.5 rounded-[10px] border border-[var(--line)] px-4 py-7" aria-live="polite">
        <span className="text-[13px] text-[var(--text-sub)] text-center">
          {coded ? t('remotePage.discover.checkCode')
            : v.kind === 'joining' ? t('remotePage.discover.joining', { name: pc.device })
              : t('remotePage.discover.asking', { name: pc.device })}
        </span>
        {coded && (
          <>
            <code className="font-mono text-[34px] tracking-[6px] tabular-nums text-[var(--text-main)]" data-testid="discover-code">{groupPin(coded.code)}</code>
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-sub)] tabular-nums" data-testid="discover-waiting">
              <span className="wmux-remote-dot" aria-hidden="true" />
              {t(coded.kind === 'confirm' ? 'remotePage.discover.confirmLine' : 'remotePage.discover.waitingFor', { name: pc.device, time: formatRemaining(left) })}
            </span>
          </>
        )}
      </div>
      <div className="flex flex-col gap-1.5 text-[12px] leading-[18px] text-[var(--text-sub)]">
        <span>{t('remotePage.discover.afterAllow')}</span>
        <span>{t('remotePage.discover.codeDiffers')}</span>
      </div>
      <div className="flex justify-end gap-2">
        {/* Once allowed, the join runs to its end on the daemon: Cancel would do nothing, so it says so by being off. */}
        <Button variant="secondary" size="md" disabled={v.kind === 'joining'} onClick={p.onCancel} data-testid="discover-cancel">{t('remotePage.discover.cancel')}</Button>
        {v.kind === 'confirm' && (
          <Button variant="primary" size="md" disabled={p.confirming} onClick={p.onConfirm} data-testid="discover-confirm">{t('remotePage.discover.confirm')}</Button>
        )}
      </div>
    </div>
  );
}

/** Discoverable: the band with its countdown and Stop, then the card or the last request's line. */
function WindowOpen(p: TailnetDiscoverPanelViewProps) {
  const { receive: v, t } = p;
  const name = v.kind === 'discoverable' ? v.name : p.selfName;
  const expiresAt = v.kind === 'discoverable' ? v.expiresAt : v.kind === 'denied' || v.kind === 'refused' ? v.expiresAt ?? p.expiresAt : p.expiresAt;
  const left = expiresAt !== null ? Math.max(0, Math.ceil((expiresAt - p.now) / 1000)) : null;
  return (
    <div className="flex flex-col gap-3" data-discover-receive={v.kind}>
      <div className="flex items-center gap-3 rounded-[10px] border border-[var(--line)] px-3.5 py-3" data-testid="discover-band">
        <span className="wmux-remote-dot" aria-hidden="true" />
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[13px] text-[var(--text-main)] tabular-nums" data-testid="discover-countdown">
            {t('remotePage.discover.discoverable', { time: formatRemaining(left ?? 0) })}
          </span>
          <span className="text-[11px] text-[var(--text-sub)]">{t('remotePage.discover.discoverableNote', { name })}</span>
        </div>
        <Button variant="ghost" size="md" disabled={p.busy} onClick={p.onStop} data-testid="discover-stop">{t('remotePage.discover.stop')}</Button>
      </div>
      <div aria-live="polite" className="flex flex-col gap-3">
        {v.kind === 'approval' && <ApprovalCard incoming={v.incoming} busy={p.busy} onDecide={p.onDecide} t={t} />}
        {v.kind === 'allowed' && (
          <>
            <p className="wmux-a2a-note" data-testid="discover-receive-line">{t('remotePage.discover.allowed', { name: v.incoming.device.name })}</p>
            {/* Closing the dialog ends the window, and with it this pairing. */}
            <p className="wmux-remote-connect-note" data-testid="discover-keep-open">{t('remotePage.discover.keepOpen')}</p>
          </>
        )}
        {v.kind === 'denied' && (
          <p className="wmux-a2a-note" data-testid="discover-receive-line">{t('remotePage.discover.denied', { name: v.device.name })}</p>
        )}
        {v.kind === 'refused' && (
          <p className="wmux-a2a-note" data-testid="discover-receive-line">{t(`remotePage.discover.refused.${v.reason}`, { ip: v.ip })}</p>
        )}
      </div>
      {v.kind === 'approval' ? (
        <p className="wmux-remote-connect-note">{t('remotePage.discover.allowNote', { name: v.incoming.device.name })}</p>
      ) : v.kind !== 'allowed' ? (
        <>
          {/* This PC cannot see a blocked request; the person comes back here when the other PC could not find it. */}
          <div className="flex flex-wrap items-center gap-2">
            <p className="wmux-remote-connect-note" data-testid="discover-firewall-hint">{t('remotePage.discover.firewallHint')}</p>
            <Button variant="ghost" size="sm" disabled={p.firewall.checking || p.firewall.busy !== null} onClick={p.firewall.check} data-testid="discover-firewall-check">
              {p.firewall.checking ? t('net.fw.checking') : t('net.fw.check')}
            </Button>
          </div>
          <FirewallNoticeView c={p.firewall} listener="a2a" primary={false} ownCheck t={t} />
          <p className="wmux-remote-connect-note">{t('remotePage.discover.waitingNote')}</p>
        </>
      ) : null}
    </div>
  );
}

/**
 * The request on the card: the asking device as Tailscale identifies it
 * (never as it names itself), and the code to compare with its screen. The
 * one needs-you mark of this dialog: an attention hairline, no wash.
 */
function ApprovalCard({ incoming, busy, onDecide, t }: {
  incoming: Extract<A2aDiscoverReceiveView, { kind: 'approval' }>['incoming'];
  busy: boolean;
  onDecide: (allow: boolean) => void;
  t: T;
}) {
  const titleId = useId();
  const d = incoming.device;
  return (
    <div className="wmux-remote-needs" role="group" aria-labelledby={titleId} data-testid="discover-card">
      <div className="flex flex-col gap-3 py-1 pr-1">
        <div className="flex flex-col gap-0.5">
          <span id={titleId} className="text-[13px] font-medium text-[var(--text-main)]">{t('remotePage.discover.requestTitle', { name: d.name })}</span>
          <span className="text-[11px] text-[var(--text-sub)]" data-testid="discover-card-identity">
            {t('remotePage.discover.requestMeta', { os: osLabel(d.os), login: d.login, ip: d.ip })}
          </span>
          {incoming.replaces && (
            <span className="wmux-a2a-note" data-tone="warning" data-testid="discover-card-replaces">
              {t('remotePage.discover.replaces', { name: incoming.replaces })}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-[var(--text-sub)]">{t('remotePage.discover.sameCode')}</span>
          <code className="font-mono text-[24px] tracking-[4px] tabular-nums text-[var(--text-main)]" data-testid="discover-card-code">{groupPin(incoming.code)}</code>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="md" disabled={busy} onClick={() => onDecide(false)} data-testid="discover-deny">{t('remotePage.discover.deny')}</Button>
          <Button variant="primary" size="md" disabled={busy} onClick={() => onDecide(true)} data-testid="discover-allow">{t('remotePage.discover.allow')}</Button>
        </div>
      </div>
    </div>
  );
}

export interface TailnetDiscoverPanelProps {
  /** The A2A listener as the dialog last read it (null: not read, or no daemon). */
  a2a: A2aRemoteStatus | null;
  statusRead: boolean;
  /** The Tailscale check the dialog ran when it opened. */
  tailscale: TailscaleChecklist | null;
  /** A window turned A2A on, or ended and may have turned it off: the dialog re-reads it. */
  onA2aChanged?: () => void;
  /** A PC paired through this PC's window: the dialog shows what it can see. */
  onPaired?: (peer: { hostId: string; name: string }) => void;
  /** The receiving state changed (the dialog marks the tab while a card waits on another tab). */
  onReceive?: (kind: A2aDiscoverReceiveView['kind']) => void;
  /** This PC joined a PC it asked: the dialog offers Link a pane now. */
  onJoined?: (host: { hostId: string; name: string }) => void;
  /** A request went out or ended: the dialog shows only it (retitled, no tabs) while it runs. */
  onFocus?: (pc: A2aDiscoverPc | null) => void;
  firstActionRef?: Ref<HTMLButtonElement>;
}

/**
 * The container. A window this panel opened is closed again when the panel
 * goes away (the dialog closed), so this PC never stays discoverable behind
 * a closed dialog; the daemon's own 5 minutes are the backstop.
 */
export default function TailnetDiscoverPanel({ a2a, statusRead, tailscale, onA2aChanged, onPaired, onReceive, onJoined, onFocus, firstActionRef }: TailnetDiscoverPanelProps) {
  const t = useT();
  // A read that failed is not proof the listener is on: the button then says it turns it on.
  const a2aOff = statusRead && (a2a === null || !a2a.enabled);
  const d = useTailnetDiscovery({ tailscale, a2aOff, onA2aChanged, onPaired, onJoined });
  const v = d.receive;
  const onReceiveRef = useRef(onReceive);
  onReceiveRef.current = onReceive;
  useEffect(() => { onReceiveRef.current?.(v.kind); }, [v.kind]);
  // Told once per PC, not on every 1 s read of the same request.
  const focus = requestFocusPc(d.request);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const focusIp = focus?.ip ?? null;
  useEffect(() => { onFocusRef.current?.(focusRef.current); }, [focusIp]);
  // Explained once per distinct failure (it runs netstat), never on a poll.
  // Who holds the port and a port that looked free: from the refusal (read before
  // a window that turned A2A on turned it off again), else asked of the daemon
  // once, else what the refusal's code alone says.
  const explained = useListenProblem('a2a', v.kind === 'listen-failed' && v.lastErrorCode && !d.listenReport ? `${v.lastErrorCode}:${v.port}` : null);
  const listenProblem = d.listenReport ?? explained ?? (v.kind === 'listen-failed' ? refusedListenReport(v, window.electronAPI?.platform ?? '') : null);
  // Checked only when asked (Check firewall): the tab never runs it by itself.
  const firewall = useFirewall('a2a', { enabled: false, checkKey: '' });
  return (
    <TailnetDiscoverPanelView
      request={d.request}
      scan={d.scan}
      rescanning={d.rescanning}
      onFind={d.find}
      onConnect={d.connect}
      onCancel={d.cancel}
      onConfirm={d.confirm}
      confirming={d.confirming}
      receive={v}
      a2aOff={a2aOff}
      port={a2a?.port ?? null}
      statusRead={statusRead}
      selfName={d.selfName}
      expiresAt={d.expiresAt}
      now={d.now}
      busy={d.busy}
      failed={d.failed}
      listenProblem={listenProblem}
      firewall={firewall}
      onMakeDiscoverable={d.makeDiscoverable}
      onStop={d.stop}
      onDecide={d.decide}
      onUsePort={d.moveToPort}
      firstActionRef={firstActionRef}
      t={t}
    />
  );
}
