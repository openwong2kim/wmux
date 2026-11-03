import { useEffect, useId, useRef, type Ref } from 'react';
import { useT } from '../../hooks/useT';
import { useTailnetDiscovery } from '../../hooks/useTailnetDiscovery';
import Button from '../ui/Button';
import { formatRemaining } from '../Settings/A2aRemoteSection';
import { groupPin } from './LanLinkPairPanel';
import { TailscaleFixButton } from './TailscaleChecklist';
import { describeTailnetFailure } from './tailnetCheck';
import { FirewallNoticeView, ListenProblemView, useFirewall, useListenProblem, type FirewallController } from './FirewallNotice';
import type { A2aDiscoverReceiveView, A2aRemoteStatus } from '../../../shared/rpc';
import type { TailscaleChecklist } from '../../../shared/web';
import { classifyListenError, type ListenProblemReport } from '../../../shared/netListen';

// ─── Connect a PC › Tailscale ─────────────────────────────────────────────────
//
// "This PC": Make this PC discoverable opens a 5-minute window in which this
// PC's own user's tailnet devices can find it and ask to pair. A request
// shows as one card: Tailscale's identity of the asking device and the
// 6-digit code both screens show, with Deny and Allow. Allow pairs as an
// invite would and shows the PC nothing until panes are ticked. The VIEW is
// pure (props only); the CONTAINER holds the state (useTailnetDiscovery).

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Tailscale's OS names (`windows`, `macOS`, `linux`) as people write them. */
export function osLabel(os: string): string {
  const lower = os.toLowerCase();
  if (lower === 'windows') return 'Windows';
  if (lower === 'macos') return 'macOS';
  if (lower === 'linux') return 'Linux';
  return os;
}

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

export interface TailnetDiscoverPanelViewProps {
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
      {WINDOW_OPEN.has(p.receive.kind) ? <WindowOpen {...p} /> : <ThisPc {...p} />}
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
          ref={p.firstActionRef}
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
  firstActionRef?: Ref<HTMLButtonElement>;
}

/**
 * The container. A window this panel opened is closed again when the panel
 * goes away (the dialog closed), so this PC never stays discoverable behind
 * a closed dialog; the daemon's own 5 minutes are the backstop.
 */
export default function TailnetDiscoverPanel({ a2a, statusRead, tailscale, onA2aChanged, onPaired, onReceive, firstActionRef }: TailnetDiscoverPanelProps) {
  const t = useT();
  // A read that failed is not proof the listener is on: the button then says it turns it on.
  const a2aOff = statusRead && (a2a === null || !a2a.enabled);
  const d = useTailnetDiscovery({ tailscale, a2aOff, onA2aChanged, onPaired });
  const v = d.receive;
  const onReceiveRef = useRef(onReceive);
  onReceiveRef.current = onReceive;
  useEffect(() => { onReceiveRef.current?.(v.kind); }, [v.kind]);
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
