import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import WebToggle, { webPairUrl } from '../StatusBar/WebToggle';
import AttachRemoteModal from '../Sidebar/AttachRemoteModal';
import { hostStatusText } from '../StatusBar/OtherComputersSection';
import { revokeFailureMessage } from '../StatusBar/PairedDevicesModal';
import { IconComputer, IconPhone, IconRemoteDevices } from '../icons';
import { timeAgo } from '../../utils/timeAgo';
import type { WebDeviceSummary, WebTerminalInfo } from '../../../shared/web';
import type { RemoteHostPublic, RemoteHostStatus } from '../../../shared/remoteHosts';
import type { LanLinkPeerSummary } from '../../../shared/lanlink';
import { buildRemoteEntries, serverReach, type RemoteEntry, type ServerReach } from './remoteEntries';
import { selectRemoteInbox } from '../../stores/selectors/remoteInbox';
import A2aLinksPanel from './A2aLinksPanel';
import A2aDeliveryPanel from './A2aDeliveryPanel';

/** How often the page re-reads the roster, the hosts and the server state. */
export const REMOTE_PAGE_POLL_MS = 10_000;

const REACH_SHORT: Record<ServerReach, string> = {
  off: 'remotePage.serverOff',
  local: 'remotePage.reachLocal',
  lan: 'remotePage.reachLan',
  tailscale: 'remotePage.reachTailnet',
  unknown: 'remotePage.unknown',
};

/** One line of the recent-activity list. */
interface ActivityItem {
  key: string;
  kind: 'paired' | 'revoked' | 'added' | 'connected' | 'disconnected';
  name: string;
  at: number;
}

/**
 * The Remote rail page: a live board of what is connected to this machine
 * right now — paired phones and computers, the hosts this app connects to and
 * LAN peers. Every number and action comes from the existing web, remote and
 * lanlink bridges, polled while the page is shown; the existing sharing,
 * pairing and add-host flows open from here (Share & pair is the remote hub).
 */
export default function RemotePage() {
  const t = useT();
  // Focus moves to the page title on open, so keyboard users start on this
  // page and never in the panes it covers.
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  // LAN messages wait in Fleet's inbox; this page opens it too.
  const lanMessages = useStore((s) => selectRemoteInbox({ remoteItems: s.remoteItems, remoteItemOrder: s.remoteItemOrder }).length);
  const openLanInbox = () => {
    const s = useStore.getState();
    s.setAppRoute('fleet');
    s.setFleetActiveTab('remote');
  };
  const [info, setInfo] = useState<WebTerminalInfo | null>(null);
  const [devices, setDevices] = useState<WebDeviceSummary[] | null>(null);
  const [devicesError, setDevicesError] = useState(false);
  const [hosts, setHosts] = useState<RemoteHostPublic[] | null>(null);
  const [hostStatus, setHostStatus] = useState<Record<string, RemoteHostStatus>>({});
  const [peers, setPeers] = useState<LanLinkPeerSummary[] | null>(null);
  const [attach, setAttach] = useState<{ hostId?: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  // Connects and disconnects seen while this page is open (a device's live
  // state turning on or off between reads) — nothing is stored.
  const [seen, setSeen] = useState<ActivityItem[]>([]);
  const lastLive = useRef<Map<string, boolean> | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Each source is read on its own so one slow or missing bridge never
  // blanks the others.
  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    const reads: Promise<unknown>[] = [];
    if (api?.web?.status) reads.push(api.web.status().then((v) => { if (mounted.current) setInfo(v); }, () => undefined));
    if (api?.web?.deviceList) reads.push(api.web.deviceList().then((v) => {
      if (!mounted.current) return;
      setDevices(v.devices);
      setDevicesError(Boolean(v.error));
    }, () => { if (mounted.current) setDevicesError(true); }));
    if (api?.remote?.hostsList) reads.push(api.remote.hostsList().then((v) => { if (mounted.current) setHosts(v); }, () => undefined));
    if (api?.remote?.hostsStatus) reads.push(api.remote.hostsStatus().then((v) => { if (mounted.current) setHostStatus(v); }, () => undefined));
    if (api?.lanlink?.peersList) reads.push(api.lanlink.peersList().then((v) => { if (mounted.current) setPeers(v.peers); }, () => undefined));
    await Promise.all(reads);
    if (mounted.current) setNow(Date.now());
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, REMOTE_PAGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const remoteWorkspaces = useStore(useShallow((s) => s.remoteWorkspaces));
  const openByHost = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const w of remoteWorkspaces) (out[w.hostId] ??= []).push(w.label || w.name || w.workspaceId.slice(0, 8));
    return out;
  }, [remoteWorkspaces]);
  const entries = useMemo(
    () => buildRemoteEntries({ devices, info, hosts, hostStatus, peers, openByHost }),
    [devices, info, hosts, hostStatus, peers, openByHost],
  );
  const deviceEntries = entries.filter((e) => e.kind !== 'host' && e.kind !== 'peer');
  const hostEntries = entries.filter((e) => e.kind === 'host');
  const loaded = devices !== null || hosts !== null || peers !== null;
  useEffect(() => {
    if (devices === null) return;
    const live = new Map(deviceEntries.map((e) => [e.key, e.live]));
    const before = lastLive.current;
    lastLive.current = live;
    if (!before) return;
    const changes: ActivityItem[] = [];
    for (const e of deviceEntries) {
      const was = before.get(e.key);
      if (was !== undefined && was !== e.live) {
        changes.push({ key: `${e.key}:${Date.now()}`, kind: e.live ? 'connected' : 'disconnected', name: e.name, at: Date.now() });
      }
    }
    if (changes.length > 0) setSeen((prev) => [...changes, ...prev].slice(0, 10));
  }, [devices]);
  // Recent activity from what the roster and host list already record
  // (paired, revoked, host added), plus the connects seen above. Newest first.
  const activity = useMemo<ActivityItem[]>(() => [
    ...seen,
    ...(devices ?? []).flatMap((d) => [
      { key: `p:${d.deviceId}`, kind: 'paired' as const, name: d.name, at: d.createdAt },
      ...(d.revokedAt ? [{ key: `r:${d.deviceId}`, kind: 'revoked' as const, name: d.name, at: d.revokedAt }] : []),
    ]),
    ...(hosts ?? []).map((h) => ({ key: `h:${h.id}`, kind: 'added' as const, name: h.label, at: h.addedAt })),
  ].filter((item) => item.at > 0).sort((a, b) => b.at - a.at).slice(0, 6), [seen, devices, hosts]);

  const runAction = useCallback(async (entry: RemoteEntry, action: () => Promise<string | null>) => {
    setBusy(entry.key);
    setError(null);
    try {
      const message = await action();
      if (message && mounted.current) setError({ key: entry.key, message });
    } catch {
      if (mounted.current) setError({ key: entry.key, message: t('web.revokeUnknown') });
    } finally {
      if (mounted.current) {
        setBusy(null);
        setConfirming(null);
      }
      await refresh();
    }
  }, [refresh, t]);

  const remove = (entry: RemoteEntry) => runAction(entry, async () => {
    const api = window.electronAPI;
    if (entry.kind === 'host') {
      if (!api?.remote?.hostsRemove) return t('web.revokeUnavailable');
      await api.remote.hostsRemove(entry.id);
      // Main drops the host's descriptors; the renderer's mirrors are memory-only.
      for (const w of useStore.getState().remoteWorkspaces.filter((x) => x.hostId === entry.id)) {
        useStore.getState().detachRemoteWorkspace(w.key);
      }
      return null;
    }
    if (entry.kind === 'peer') {
      if (!api?.lanlink?.peersRemove) return t('web.revokeUnavailable');
      await api.lanlink.peersRemove(entry.id);
      return null;
    }
    if (!api?.web?.deviceRevoke) return t('web.revokeUnavailable');
    const res = await api.web.deviceRevoke(entry.id);
    return res.ok ? null : revokeFailureMessage(t, res);
  });

  const reach = serverReach(info);
  const onlineDevices = deviceEntries.filter((e) => e.live).length;
  const connectedHosts = hostEntries.filter((e) => e.live).length;

  const card = (entry: RemoteEntry) => (
    <RemoteCard
      key={entry.key}
      entry={entry}
      now={now}
      confirming={confirming === entry.key}
      busy={busy === entry.key}
      error={error?.key === entry.key ? error.message : null}
      onOpen={entry.kind === 'host'
        ? () => (entry.status === 'needs-repair'
          ? useStore.getState().requestRemoteRepair(entry.id)
          : setAttach({ hostId: entry.id }))
        : undefined}
      onRemove={() => (confirming === entry.key ? void remove(entry) : setConfirming(entry.key))}
      onCancel={() => setConfirming(null)}
    />
  );

  // Online first, then offline; a device, host or peer alike.
  const connected = [...entries].sort((a, b) => Number(b.live) - Number(a.live));
  const serverOn = reach !== 'off' && reach !== 'unknown';
  const address = info ? webPairUrl(info).replace(/\/pair$/, '') : '';
  const summary = [
    deviceEntries.length > 0 ? t('remotePage.sumOnline', { n: onlineDevices, total: deviceEntries.length }) : '',
    reach === 'unknown' ? '' : serverOn ? t('remotePage.sumServerOn', { reach: t(REACH_SHORT[reach]) }) : t('remotePage.sumServerOff'),
    hostEntries.length > 0 ? t('remotePage.sumHosts', { n: connectedHosts }) : '',
  ].filter(Boolean);
  const copyAddress = () => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };

  return (
    <section
      className="wmux-remote-page"
      aria-labelledby="remote-page-title"
      data-remote-page
      onKeyDown={(e) => {
        // Escape returns to Workspaces, like Fleet, Schedules and Settings.
        // Portalled dialogs bubble here through React; only keys from the
        // page's own DOM leave it (the Schedules rule).
        if (e.key !== 'Escape' || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
        // The palette and the notification panel float above every page and
        // own their keys: Escape closes them first (the Settings rule).
        const above = useStore.getState();
        if (above.commandPaletteVisible || above.notificationPanelVisible) return;
        // Innermost first: the open add-host dialog owns Escape, and an open
        // remove / revoke confirmation is cancelled before the page closes.
        if (attach) return;
        e.preventDefault();
        if (confirming) { setConfirming(null); return; }
        above.setAppRoute('workspaces');
      }}
    >
      <header className="wmux-remote-header">
        <h1 ref={titleRef} tabIndex={-1} id="remote-page-title" className="wmux-remote-title outline-none">{t('remotePage.title')}</h1>
        {summary.length > 0 && (
          <p className="wmux-remote-summary" data-remote-summary>
            {onlineDevices > 0 && <span className="wmux-remote-live" aria-hidden="true" />}
            {summary.join(' · ')}
          </p>
        )}
        {lanMessages > 0 && (
          <Button variant="secondary" size="sm" className="self-start" onClick={openLanInbox} data-remote-lan-inbox>
            {t('fleetBoard.lan', { count: lanMessages })}
          </Button>
        )}
      </header>
      {devicesError && <p className="ui-note px-1" role="status">{t('web.devicesUnavailable')}</p>}

      <div className="wmux-remote-layout">
        <section className="wmux-remote-connected" aria-labelledby="remote-connected-title">
          <h2 id="remote-connected-title" className="wmux-remote-section-title">{t('remotePage.connected')}</h2>
          {loaded && connected.length === 0 ? (
            <div className="wmux-remote-empty" data-remote-empty>
              <IconRemoteDevices size={22} />
              <h3>{t('remotePage.emptyTitle')}</h3>
              <p>{t('remotePage.emptyBody')}</p>
            </div>
          ) : (
            <ul className="wmux-remote-grid">{connected.map(card)}</ul>
          )}
          {/* Cross-PC pane links: requests to accept and the links themselves. */}
          <A2aLinksPanel />
          {/* Cross-PC delivery: each PC's connection, and remote work held for a person. */}
          <A2aDeliveryPanel />
        </section>

        <aside className="wmux-remote-machine" aria-labelledby="remote-machine-title" data-remote-machine>
          <h2 id="remote-machine-title" className="wmux-remote-section-title">{t('remotePage.thisMachine')}</h2>
          <div className="wmux-remote-panel">
            <div className="wmux-remote-panel-row">
              <span>{t('remotePage.server')}</span>
              <span className="wmux-remote-panel-value" data-remote-server>
                {serverOn && <span className="wmux-remote-live" aria-hidden="true" />}
                {serverOn ? t('remotePage.on') : reach === 'unknown' ? t('remotePage.unknown') : t('remotePage.serverOff')}
              </span>
            </div>
            {serverOn && (
              <div className="wmux-remote-panel-row">
                <span>{t('remotePage.reach')}</span>
                <span className="wmux-remote-panel-value">{t(REACH_SHORT[reach])}</span>
              </div>
            )}
            {serverOn && address && (
              <div className="wmux-remote-panel-row">
                <span>{t('remotePage.address')}</span>
                <span className="wmux-remote-panel-value min-w-0">
                  <code className="ui-code truncate" data-remote-address>{address}</code>
                  <Button size="sm" variant="ghost" onClick={copyAddress}>{copied ? t('web.copied') : t('web.copy')}</Button>
                </span>
              </div>
            )}
            {serverOn && (
              <div className="wmux-remote-panel-row">
                <span>{t('remotePage.input')}</span>
                <span className="wmux-remote-panel-value">{info?.allowInput ? t('remotePage.inputOn') : t('remotePage.viewOnly')}</span>
              </div>
            )}
            <div className="wmux-remote-panel-actions">
              <WebToggle variant="page" />
              <Button size="sm" onClick={() => setAttach({})} data-remote-add-host>{t('remotePage.addHost')}</Button>
            </div>
          </div>
          {activity.length > 0 && (
            <>
              <h2 className="wmux-remote-section-title">{t('remotePage.activity')}</h2>
              <ul className="wmux-remote-activity" data-remote-activity>
                {activity.map((item) => (
                  <li key={item.key}>
                    <span className="truncate">{t(`remotePage.event.${item.kind}`, { name: item.name || t('web.deviceUnnamed') })}</span>
                    <span className="wmux-remote-activity-when">{timeAgo(item.at, now)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
      {attach && (
        <AttachRemoteModal
          initialHostId={attach.hostId}
          onClose={() => { setAttach(null); void refresh(); }}
        />
      )}
    </section>
  );
}

const KIND_KEY: Record<RemoteEntry['kind'], string> = {
  phone: 'web.deviceKindPhone',
  computer: 'web.deviceKindComputer',
  device: 'web.deviceKindUnknown',
  host: 'remotePage.kindHost',
  peer: 'remotePage.kindPeer',
};

const ACCESS_KEY: Record<NonNullable<RemoteEntry['access']>, string> = {
  input: 'remotePage.canType',
  'input-when-on': 'remotePage.canTypeWhenOn',
  view: 'remotePage.viewOnly',
  messages: 'remotePage.messagesOnly',
};

function RemoteCard({ entry, now, confirming, busy, error, onOpen, onRemove, onCancel }: {
  entry: RemoteEntry;
  now: number;
  confirming: boolean;
  busy: boolean;
  error: string | null;
  onOpen?: () => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const unknown = <span className="wmux-remote-unknown">{t('remotePage.unknown')}</span>;
  const statusText = entry.kind === 'host'
    ? hostStatusText(t, entry.status === 'unknown' ? undefined : entry.status as RemoteHostStatus)
    : entry.status === 'online' ? t('remotePage.online')
      : entry.status === 'offline' ? t('remotePage.offline')
        : entry.status === 'blocked' ? t('remotePage.blocked')
          : t('remotePage.unknown');
  const icon = entry.kind === 'phone' ? <IconPhone size={16} />
    : entry.kind === 'host' || entry.kind === 'computer' ? <IconComputer size={16} />
      : <IconRemoteDevices size={16} />;
  const removeLabel = entry.kind === 'host' || entry.kind === 'peer' ? t('remotePage.remove') : t('web.revoke');
  return (
    <li className="wmux-remote-card" data-remote-entry={entry.kind} data-live={entry.live ? 'true' : undefined}>
      <div className="wmux-remote-card-head">
        <span className="wmux-remote-card-icon" aria-hidden="true">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="wmux-remote-card-name">{entry.name || t('web.deviceUnnamed')}</div>
          <div className="wmux-remote-card-kind">
            {t(KIND_KEY[entry.kind])}
            {entry.address ? <> · <span className="ui-code">{entry.address}</span></> : null}
            <span className="wmux-remote-card-id"> · #{entry.shortId}</span>
          </div>
        </div>
        <span className="wmux-remote-card-status" data-status={entry.status}>
          {entry.live && <span className="wmux-remote-live" aria-hidden="true" />}
          {statusText}
        </span>
      </div>
      <dl className="wmux-remote-card-facts">
        <dt>{t('remotePage.lastSeen')}</dt>
        {/* A held connection is "now": the roster writes last-seen about once a minute. */}
        <dd>{entry.live ? t('web.deviceActiveNow') : entry.lastSeenAt !== null ? timeAgo(entry.lastSeenAt, now) : unknown}</dd>
        <dt>{t('remotePage.viewing')}</dt>
        <dd>{entry.viewing === null ? unknown
          : entry.viewing.length === 0 ? <span className="wmux-remote-unknown">{t('remotePage.nothingOpen')}</span>
            : <span className="truncate">{entry.viewing.join(', ')}</span>}</dd>
        <dt>{t('remotePage.access')}</dt>
        <dd>{entry.access ? t(ACCESS_KEY[entry.access]) : unknown}</dd>
      </dl>
      {error && <p className="wmux-remote-card-error" role="alert">{error}</p>}
      <div className="wmux-remote-card-actions">
        {onOpen && !confirming && (
          <Button size="sm" variant="ghost" onClick={onOpen} disabled={busy}>
            {entry.status === 'needs-repair' ? t('remote.hubPairAgain') : t('remotePage.open')}
          </Button>
        )}
        {confirming && <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy} autoFocus>{t('remotePage.cancel')}</Button>}
        <Button size="sm" variant={confirming ? 'danger' : 'ghost'} onClick={onRemove} disabled={busy}
          data-remote-remove={entry.kind}>
          {confirming ? (entry.kind === 'host' || entry.kind === 'peer' ? t('remotePage.removeConfirm') : t('web.revokeConfirm')) : removeLabel}
        </Button>
      </div>
    </li>
  );
}
