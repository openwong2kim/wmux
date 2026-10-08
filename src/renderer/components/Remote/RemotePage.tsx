import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import WebToggle, { webPairUrl } from '../StatusBar/WebToggle';
import AttachRemoteModal from '../Sidebar/AttachRemoteModal';
import { revokeFailureMessage } from '../StatusBar/PairedDevicesModal';
import { A2aExposureChecklist } from '../Settings/A2aExposureChecklist';
import { IconChevron, IconComputer, IconCopy, IconMessage, IconPhone, IconServer } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { timeAgo } from '../../utils/timeAgo';
import type { WebDeviceSummary, WebTerminalInfo } from '../../../shared/web';
import type { RemoteHostPublic, RemoteHostStatus, RemoteWorkspaceSummary } from '../../../shared/remoteHosts';
import { remoteAttachmentKey } from '../../../shared/remoteHosts';
import type { LanLinkPeerSummary } from '../../../shared/lanlink';
import type { A2aLinkRecordV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteHostStatus, A2aRemoteStatus } from '../../../shared/rpc';
import { buildRemoteEntries, paneNamesByPty, serverReach, type RemoteEntry, type ServerReach } from './remoteEntries';
import { selectRemoteInbox } from '../../stores/selectors/remoteInbox';
import { heldNeedsPerson, heldReason, selectRemoteNeedsYou } from '../../stores/slices/a2aRemoteSlice';
import { refreshA2aRemote } from '../../hooks/useA2aRemoteBridge';
import { buildPaneSnapshot, moaBrainEnd } from '../../hooks/useA2aRemoteSnapshot';
import { A2aLinkRequestRow, A2aLinkRow, type LocalNames } from './A2aLinksPanel';
import { A2aHeldRow, A2aIdentityRow, heldPeer } from './A2aDeliveryPanel';
import A2aLinkDialog from './A2aLinkDialog';
import RemoteConnectDialog, { type ConnectTab } from './RemoteConnectDialog';
import RemoteRowMenu, { type RemoteRowMenuItem } from './RemoteRowMenu';

/** How often the page re-reads the roster, the hosts and the server state. */
export const REMOTE_PAGE_POLL_MS = 10_000;

const REACH_KEY: Record<ServerReach, string> = {
  off: 'remotePage.reachOff',
  local: 'remotePage.reachLocal',
  lan: 'remotePage.reachLan',
  tailscale: 'remotePage.reachTailnet',
  unknown: 'remotePage.unknown',
};

/** The three status words the page uses for anything connected. */
type StatusWord = 'connected' | 'disconnected' | 'waiting';

const A2A_STATUS: Record<A2aRemoteHostStatus['state'], StatusWord> = {
  connected: 'connected',
  connecting: 'waiting',
  disconnected: 'disconnected',
  // Nothing is sent to it; the Needs you block says why.
  'identity-changed': 'disconnected',
};

function hostWord(status: RemoteHostStatus | 'unknown'): StatusWord {
  if (status === 'connected') return 'connected';
  if (status === 'reachable' || status === 'unknown') return 'waiting';
  return 'disconnected';
}

/** One line of the recent-activity list. */
interface ActivityItem {
  key: string;
  kind: 'paired' | 'revoked' | 'added' | 'connected' | 'disconnected';
  name: string;
  at: number;
}

/** A paired PC (A2A, either role), with the records behind it. */
interface PcRow {
  hostId: string;
  name: string;
  word: StatusWord;
  pending: number;
  lastSeenAt: number | null;
  address: string | null;
  fingerprint: string | null;
  /** This PC joined it: links can be proposed to it, `hostsRemove` drops it. */
  joined: boolean;
  /** It joined this PC: this PC sets what it can see, `peersRevoke` drops it. */
  peerId: string | null;
  identityChanged: boolean;
  links: A2aLinkRecordV1[];
}

type Confirm = { kind: 'entry' | 'pc' | 'link'; id: string } | null;

/**
 * The Remote rail page: this PC's state on one line, what needs a person
 * (link requests, held work, a PC whose certificate changed), then one list
 * of every other PC with its links, the phones and what each is viewing, and
 * the message links. Web, remote-host and LanLink state is read here while
 * the page is shown; the cross-PC A2A state comes from the a2aRemote slice
 * that the app-wide bridge keeps current (this page only asks it to re-read).
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
  const [a2aStatus, setA2aStatus] = useState<A2aRemoteStatus | null>(null);
  const [devices, setDevices] = useState<WebDeviceSummary[] | null>(null);
  const [devicesError, setDevicesError] = useState(false);
  const [hosts, setHosts] = useState<RemoteHostPublic[] | null>(null);
  const [hostStatus, setHostStatus] = useState<Record<string, RemoteHostStatus>>({});
  const [peers, setPeers] = useState<LanLinkPeerSummary[] | null>(null);
  const [attach, setAttach] = useState<{ hostId?: string } | null>(null);
  const [connect, setConnect] = useState<{ tab?: ConnectTab } | null>(null);
  const [linkDialog, setLinkDialog] = useState<{ hostId: string; moa?: boolean } | null>(null);
  const [exposure, setExposure] = useState<{ hostId: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<Confirm>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [details, setDetails] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hostWorkspaces, setHostWorkspaces] = useState<Record<string, RemoteWorkspaceSummary[] | 'loading' | 'failed'>>({});
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<string | null>(null);
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
    const reads: Promise<unknown>[] = [refreshA2aRemote()];
    if (api?.web?.status) reads.push(api.web.status().then((v) => { if (mounted.current) setInfo(v); }, () => undefined));
    if (api?.a2aRemote?.status) reads.push(api.a2aRemote.status().then((v) => {
      if (mounted.current && typeof v?.port === 'number') setA2aStatus(v);
    }, () => undefined));
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

  const feed = useStore((s) => s.a2aRemote);
  const needsCount = useStore(selectRemoteNeedsYou);
  const workspaces = useStore((s) => s.workspaces);
  const paneLabel = useStore((s) => s.paneLabel);
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const moa = useStore((s) => s.moa);
  const brain = useMemo(() => moaBrainEnd({ workspaces, surfaceAgent, moa }), [workspaces, surfaceAgent, moa]);
  const names: LocalNames = useMemo(() => ({ workspaces, paneLabel, surfaceAgent }), [workspaces, paneLabel, surfaceAgent]);

  const remoteWorkspaces = useStore(useShallow((s) => s.remoteWorkspaces));
  const openByHost = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const w of remoteWorkspaces) (out[w.hostId] ??= []).push(w.label || w.name || w.workspaceId.slice(0, 8));
    return out;
  }, [remoteWorkspaces]);
  const paneNameByPty = useMemo(() => paneNamesByPty(workspaces, paneLabel, surfaceAgent), [workspaces, paneLabel, surfaceAgent]);
  const entries = useMemo(
    () => buildRemoteEntries({ devices, info, hosts, hostStatus, peers, openByHost, paneNameByPty }),
    [devices, info, hosts, hostStatus, peers, openByHost, paneNameByPty],
  );
  const deviceEntries = entries.filter((e) => e.kind !== 'host' && e.kind !== 'peer');
  const hostEntries = entries.filter((e) => e.kind === 'host');
  const peerEntries = entries.filter((e) => e.kind === 'peer');

  // Every paired PC, either role: its connection, its records, its links.
  const pcs = useMemo<PcRow[]>(() => {
    const ids = [...new Set([
      ...feed.hosts.map((h) => h.hostId),
      ...feed.joined.map((h) => h.hostId),
      ...feed.peers.map((p) => p.hostId),
    ])];
    return ids.map((hostId) => {
      const st = feed.hosts.find((h) => h.hostId === hostId);
      const joined = feed.joined.find((h) => h.hostId === hostId);
      const peer = feed.peers.find((p) => p.hostId === hostId);
      const seenAt = Date.parse(joined?.lastSeenAt ?? peer?.lastSeenAt ?? '');
      return {
        hostId,
        name: st?.name || joined?.name || peer?.name || hostId.slice(0, 6),
        word: st ? A2A_STATUS[st.state] : 'waiting',
        pending: st?.pending ?? 0,
        lastSeenAt: Number.isFinite(seenAt) ? seenAt : null,
        address: joined?.addresses[0] ?? null,
        fingerprint: joined?.fingerprint256 ?? null,
        joined: !!joined,
        peerId: peer?.peerId ?? null,
        identityChanged: st?.state === 'identity-changed',
        links: feed.links.filter((l) => l.remote.hostId === hostId && (l.state === 'active' || l.state === 'proposed-out')),
      };
    });
  }, [feed]);
  const pcName = useCallback((hostId: string) => pcs.find((p) => p.hostId === hostId)?.name ?? hostId.slice(0, 6), [pcs]);
  const requests = feed.links.filter((l) => l.state === 'proposed-in');
  // Holds for Moa clear by themselves: a quiet line, not a Needs you row.
  const personHeld = feed.held.filter(heldNeedsPerson);
  const moaHeld = feed.held.filter((x) => !heldNeedsPerson(x));
  const changedPcs = pcs.filter((p) => p.identityChanged);

  // This PC's repo for each pane a request names (the same-repo evidence).
  const [localRepos, setLocalRepos] = useState<Record<string, string>>({});
  const pendingCwds = useMemo(() => {
    const snapshot = buildPaneSnapshot({ workspaces, surfaceAgent });
    const out: Record<string, string> = {};
    for (const l of requests) {
      const pane = snapshot.workspaces.find((w) => w.id === l.local.workspaceId)?.panes.find((x) => x.paneId === l.local.paneId);
      if (pane?.cwd) out[`${l.local.workspaceId}/${l.local.paneId}`] = pane.cwd;
    }
    return out;
  }, [requests, workspaces, surfaceAgent]);
  const pendingKey = JSON.stringify(pendingCwds);
  useEffect(() => {
    let live = true;
    const repoKey = window.electronAPI?.github?.repoKey;
    if (!repoKey) return;
    void Promise.all(
      Object.entries(pendingCwds).map(async ([key, cwd]) => [key, (await repoKey(cwd).catch(() => null))?.key ?? null] as const),
    ).then((pairs) => {
      if (!live) return;
      const next: Record<string, string> = {};
      for (const [key, repo] of pairs) if (repo) next[key] = repo;
      setLocalRepos(next);
    });
    return () => { live = false; };
    // pendingKey stands in for pendingCwds (a new object every render of the store).
  }, [pendingKey]);

  const loaded = devices !== null || hosts !== null || peers !== null || feed.loaded;
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

  /** Run one row action; a message it returns is shown on that row. */
  const run = useCallback(async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    try {
      const message = await action();
      if (message && mounted.current) setError({ key, message });
    } catch {
      if (mounted.current) setError({ key, message: t('a2aLink.error.failed') });
    } finally {
      if (mounted.current) {
        setBusy(null);
        setConfirming(null);
      }
      await refresh();
    }
  }, [refresh, t]);

  const a2a = window.electronAPI?.a2aRemote;
  const linkCall = (key: string, call: () => Promise<{ ok: boolean; error?: string }>) => run(key, async () => {
    const r = await call();
    return r.ok ? null : t(`a2aLink.error.${r.error ?? 'failed'}`);
  });
  const heldCall = (key: string, call: () => Promise<{ ok: boolean }>) => run(key, async () => {
    const r = await call();
    return r.ok ? null : t('a2aDelivery.failed');
  });

  const removeEntry = (entry: RemoteEntry) => run(entry.key, async () => {
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

  // A PC paired either way is dropped on both records this PC holds for it.
  // The outcome is a page notice, not a row error: the row is gone after it.
  const removePc = (pc: PcRow) => run(`pc:${pc.hostId}`, async () => {
    if (!a2a) return t('settings.a2aRemoteActionFailed');
    const lines: string[] = [];
    let hostOk = true;
    let peerOk = true;
    if (pc.joined) {
      const r = await a2a.hostsRemove(pc.hostId).catch(() => null);
      hostOk = r?.ok === true;
      // Removed here, but that PC was not told: it still holds this PC's pairing.
      if (hostOk && r?.remoteRevoked !== true) lines.push(t('settings.a2aRemoteRemovedLocalOnly', { name: pc.name }));
    }
    if (pc.peerId) {
      const r = await a2a.peersRevoke(pc.peerId).catch(() => null);
      peerOk = r?.ok === true;
    }
    if (!hostOk && !peerOk) return t('settings.a2aRemoteActionFailed');
    if (!hostOk) lines.push(t('remotePage.removeHostKept', { name: pc.name }));
    if (!peerOk) lines.push(t('remotePage.removePeerKept', { name: pc.name }));
    if (mounted.current) setNotice(lines.length > 0 ? lines.join(' ') : null);
    return null;
  });

  const toggleHost = async (hostId: string) => {
    if (expanded === hostId) { setExpanded(null); return; }
    setExpanded(hostId);
    const remote = window.electronAPI?.remote;
    if (!remote?.workspacesList) return;
    setHostWorkspaces((m) => ({ ...m, [hostId]: 'loading' }));
    try {
      const res = await remote.workspacesList(hostId);
      if (!mounted.current) return;
      if (res.ok) setHostWorkspaces((m) => ({ ...m, [hostId]: res.workspaces }));
      else {
        if (res.reason === 'auth-rejected') useStore.getState().setRemoteHostAuthRejected(hostId, true);
        setHostWorkspaces((m) => ({ ...m, [hostId]: 'failed' }));
      }
    } catch {
      if (mounted.current) setHostWorkspaces((m) => ({ ...m, [hostId]: 'failed' }));
    }
  };
  const openHostWorkspace = (host: RemoteEntry, ws: RemoteWorkspaceSummary) => {
    const s = useStore.getState();
    s.attachRemoteWorkspace({
      key: remoteAttachmentKey(host.id, ws.id),
      hostId: host.id,
      hostLabel: host.name,
      workspaceId: ws.id,
      name: ws.name,
      panes: ws.panes,
    });
    s.setAppRoute('workspaces');
  };

  const reach = serverReach(info);
  const serverOn = reach !== 'off' && reach !== 'unknown';
  const address = info ? webPairUrl(info).replace(/\/pair$/, '') : '';
  const livePhones = deviceEntries.filter((e) => e.live).length;
  const livePcs = pcs.filter((p) => p.word === 'connected').length + hostEntries.filter((e) => e.status === 'connected').length;
  const pcTotal = pcs.length + hostEntries.length;
  const nothing = loaded && pcTotal === 0 && deviceEntries.length === 0 && peerEntries.length === 0;
  const summary = [
    pcTotal > 0 ? t('remotePage.sumPcs', { n: livePcs, total: pcTotal }) : '',
    deviceEntries.length > 0 ? t('remotePage.sumPhones', { n: livePhones, total: deviceEntries.length }) : '',
  ].filter(Boolean);
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    }, () => undefined);
  };
  const a2aWord = !a2aStatus ? null
    : !a2aStatus.enabled ? t('remotePage.a2aOff')
      : a2aStatus.listening ? t('remotePage.a2aListening', { port: a2aStatus.port })
        : t('remotePage.a2aError', { error: a2aStatus.lastError ?? t('remotePage.unknown') });
  const dialogOpen = !!(attach || connect || linkDialog || exposure);
  const isConfirming = (kind: NonNullable<Confirm>['kind'], id: string) => confirming?.kind === kind && confirming.id === id;
  const rowError = (key: string) => (error?.key === key ? <p className="wmux-remote-row-error" role="alert">{error.message}</p> : null);
  const statusCell = (word: StatusWord, live: boolean, since: number | null) => (
    <span className="wmux-remote-st" data-status={word}>
      <span className={`wmux-remote-dot${live ? '' : ' is-off'}`} aria-hidden="true" />
      {word === 'disconnected' && since !== null
        ? t('remotePage.disconnectedAgo', { time: timeAgo(since, now) })
        : t(`remotePage.st.${word}`)}
    </span>
  );
  const twoStep = (key: string, kind: NonNullable<Confirm>['kind'], ask: string, confirm: string, onConfirm: () => void, testId?: string) => (
    isConfirming(kind, key) ? (
      <>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(null)} autoFocus>{t('remotePage.cancel')}</Button>
        <Button size="sm" variant="danger" disabled={busy !== null} onClick={onConfirm} data-remote-confirm={testId}>{confirm}</Button>
      </>
    ) : (
      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming({ kind, id: key })} data-remote-remove={testId}>{ask}</Button>
    )
  );

  // Rows of the one list, by group.
  const pcRows: ReactNode[] = pcs.flatMap((pc) => {
    const key = `pc:${pc.hostId}`;
    const paneLinks = pc.links.filter((l) => l.remote.kind === 'pane').length;
    const moaLink = pc.links.some((l) => l.remote.kind === 'brain');
    const meta = [
      paneLinks > 0 ? t('remotePage.paneLinks', { count: paneLinks }) : '',
      moaLink ? t('remotePage.moaLink') : '',
      pc.pending > 0 ? t('remotePage.toSend', { count: pc.pending }) : '',
    ].filter(Boolean).join(' · ');
    const menu: RemoteRowMenuItem[] = [
      ...(pc.joined ? [{ id: 'link', label: t('remotePage.menu.linkPanes'), onSelect: () => setLinkDialog({ hostId: pc.hostId }) }] : []),
      ...(pc.joined && brain ? [{ id: 'moa', label: t('remotePage.menu.linkMoa'), onSelect: () => setLinkDialog({ hostId: pc.hostId, moa: true }) }] : []),
      ...(pc.peerId ? [{ id: 'exposure', label: t('remotePage.menu.exposure'), onSelect: () => setExposure({ hostId: pc.hostId, name: pc.name }) }] : []),
      { id: 'remove', label: t('remotePage.remove'), danger: true, onSelect: () => setConfirming({ kind: 'pc', id: pc.hostId }) },
    ];
    return [
      <li key={key} className="wmux-remote-row" data-remote-pc={pc.hostId} data-live={pc.word === 'connected' ? 'true' : undefined}>
        <span className="wmux-remote-ic" aria-hidden="true"><IconComputer size={16} /></span>
        <span className="wmux-remote-nm"><span className="truncate">{pc.name}</span></span>
        <span className="wmux-remote-meta">
          {pc.address && <span className="ui-code">{pc.address}</span>}
          {pc.address && meta ? ' · ' : ''}
          {meta}
        </span>
        {statusCell(pc.word, pc.word === 'connected', pc.lastSeenAt)}
        <span className="wmux-remote-acts">
          {/* A PC whose certificate changed confirms its removal in the Needs you block. */}
          {isConfirming('pc', pc.hostId) && !pc.identityChanged
            ? twoStep(pc.hostId, 'pc', '', t('remotePage.removeConfirm'), () => void removePc(pc), 'pc')
            : <RemoteRowMenu label={t('remotePage.menu.label', { name: pc.name })} items={menu} />}
        </span>
        {rowError(key)}
      </li>,
      ...pc.links.map((l) => (
        <A2aLinkRow
          key={l.linkId}
          link={l}
          pcName={pc.name}
          names={names}
          confirming={isConfirming('link', l.linkId)}
          busy={busy === l.linkId}
          onCheck={() => a2a && void linkCall(l.linkId, () => a2a.linksRefresh(l.linkId))}
          onAskUnlink={() => setConfirming({ kind: 'link', id: l.linkId })}
          onCancelUnlink={() => setConfirming(null)}
          onUnlink={() => a2a && void linkCall(l.linkId, () => a2a.linksRevoke(l.linkId))}
          t={t}
        />
      )),
    ];
  });
  const hostRows: ReactNode[] = hostEntries.flatMap((h) => {
    const status = h.status as RemoteHostStatus | 'unknown';
    const word = hostWord(status);
    const open = expanded === h.id;
    const list = hostWorkspaces[h.id];
    const meta = [
      t('remotePage.workspaceShare'),
      h.viewing && h.viewing.length > 0 ? t('remotePage.openHere', { names: h.viewing.join(', ') }) : '',
      h.access === 'input' ? t('remotePage.canType') : h.access === 'view' ? t('remotePage.viewOnly') : '',
    ].filter(Boolean).join(' · ');
    return [
      <li key={h.key} className="wmux-remote-row" data-remote-entry="host" data-live={h.live ? 'true' : undefined}>
        <span className="wmux-remote-ic" aria-hidden="true"><IconServer size={16} /></span>
        <span className="wmux-remote-nm"><span className="truncate">{h.name}</span></span>
        <span className="wmux-remote-meta">{meta}</span>
        {statusCell(word, h.live, null)}
        <span className="wmux-remote-acts">
          {status === 'needs-repair' ? (
            <Button size="sm" variant="secondary" onClick={() => useStore.getState().requestRemoteRepair(h.id)}>{t('remote.hubPairAgain')}</Button>
          ) : !isConfirming('entry', h.key) && (
            <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => void toggleHost(h.id)} data-remote-open={h.id}>
              {t('remotePage.open')}
              <span className={`wmux-remote-chev${open ? ' is-open' : ''}`} aria-hidden="true"><IconChevron size={12} /></span>
            </Button>
          )}
          {twoStep(h.key, 'entry', t('remotePage.remove'), t('remotePage.removeConfirm'), () => void removeEntry(h), 'host')}
        </span>
        {rowError(h.key)}
      </li>,
      ...(open ? [
        list === 'loading' || list === undefined ? <li key={`${h.key}:loading`} className="wmux-remote-link"><span /><span className="wmux-remote-link-what">{t('remote.loading')}</span></li>
          : list === 'failed' ? <li key={`${h.key}:failed`} className="wmux-remote-link"><span /><span className="wmux-remote-link-what">{t('remote.workspacesFailed')}</span></li>
            : list.length === 0 ? <li key={`${h.key}:none`} className="wmux-remote-link"><span /><span className="wmux-remote-link-what">{t('remotePage.noWorkspaces')}</span></li>
              : list.map((ws) => (
                <li key={`${h.key}:${ws.id}`} className="wmux-remote-link" data-remote-workspace={ws.id}>
                  <span />
                  <span className="wmux-remote-link-what">{ws.name || ws.id.slice(0, 8)} · {t('remotePage.panes', { count: ws.panes.length })}</span>
                  <span className="wmux-remote-acts">
                    <Button size="sm" variant="ghost" onClick={() => openHostWorkspace(h, ws)}>{t('remotePage.open')}</Button>
                  </span>
                </li>
              )),
      ].flat() : []),
    ];
  });
  const phoneRows: ReactNode[] = deviceEntries.map((d) => {
    const meta = [
      d.kind === 'computer' ? t('web.deviceKindComputer') : '',
      d.viewing && d.viewing.length > 0 ? t('remotePage.viewingNames', { names: d.viewing.join(', ') }) : '',
      d.access === 'input' ? t('remotePage.canType') : d.access === 'input-when-on' ? t('remotePage.canTypeWhenOn') : t('remotePage.viewOnly'),
    ].filter(Boolean).join(' · ');
    return (
      <li key={d.key} className="wmux-remote-row" data-remote-entry={d.kind} data-live={d.live ? 'true' : undefined}>
        <span className="wmux-remote-ic" aria-hidden="true">{d.kind === 'computer' ? <IconComputer size={16} /> : <IconPhone size={16} />}</span>
        <span className="wmux-remote-nm"><span className="truncate">{d.name || t('web.deviceUnnamed')}</span></span>
        <span className="wmux-remote-meta" data-remote-viewing>{meta}</span>
        {statusCell(d.live ? 'connected' : 'disconnected', d.live, d.live ? null : d.lastSeenAt)}
        <span className="wmux-remote-acts">
          {twoStep(d.key, 'entry', t('web.revoke'), t('web.revokeConfirm'), () => void removeEntry(d), d.kind)}
        </span>
        {rowError(d.key)}
      </li>
    );
  });
  const messageRows: ReactNode[] = peerEntries.map((p) => (
    <li key={p.key} className="wmux-remote-row" data-remote-entry="peer">
      <span className="wmux-remote-ic" aria-hidden="true"><IconMessage size={16} /></span>
      <span className="wmux-remote-nm"><span className="truncate">{p.name}</span></span>
      <span className="wmux-remote-meta">
        {[t('remotePage.messagesOnly'), p.lastSeenAt !== null ? t('remotePage.lastSeenAgo', { time: timeAgo(p.lastSeenAt, now) }) : ''].filter(Boolean).join(' · ')}
      </span>
      {statusCell(p.status === 'blocked' ? 'disconnected' : 'waiting', false, null)}
      <span className="wmux-remote-acts">
        {twoStep(p.key, 'entry', t('remotePage.remove'), t('remotePage.removeConfirm'), () => void removeEntry(p), 'peer')}
      </span>
      {rowError(p.key)}
    </li>
  ));

  const group = (id: string, title: string, rows: ReactNode[], hint?: string) => rows.length > 0 && [
    <li key={`g:${id}`} className="wmux-remote-grp" data-remote-group={id}>
      <span>{title}</span>
      <span className="wmux-remote-count">{id === 'pcs' ? pcTotal : id === 'phones' ? deviceEntries.length : peerEntries.length}</span>
      {hint && <span className="wmux-remote-hint">{hint}</span>}
    </li>,
    ...rows,
  ];

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
        // Innermost first: an open dialog owns Escape, and an open remove /
        // revoke / unlink confirmation is cancelled before the page closes.
        if (dialogOpen) return;
        e.preventDefault();
        if (confirming) { setConfirming(null); return; }
        above.setAppRoute('workspaces');
      }}
    >
      <header className="wmux-remote-header">
        <div className="wmux-remote-head-line">
          <h1 ref={titleRef} tabIndex={-1} id="remote-page-title" className="wmux-remote-title outline-none">{t('remotePage.title')}</h1>
          <span className="flex-1" />
          {lanMessages > 0 && (
            <Button variant="secondary" size="sm" onClick={openLanInbox} data-remote-lan-inbox>
              {t('fleetBoard.lan', { count: lanMessages })}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setConnect({})} data-remote-connect>{t('remotePage.connect.button')}</Button>
        </div>
        <p className="wmux-remote-summary" data-remote-summary>
          {summary.length > 0 ? summary.join(' · ') : loaded ? t('remotePage.sumNothing') : ''}
        </p>
      </header>
      {devicesError && <p className="ui-note px-1" role="status">{t('web.devicesUnavailable')}</p>}
      {notice && <p className="wmux-a2a-note" data-tone="warning" role="status" data-remote-notice>{notice}</p>}

      <div className="wmux-remote-machine" data-remote-machine>
        <div className="wmux-remote-machine-line">
          <span className="wmux-remote-machine-lbl">{t('remotePage.thisComputer')}</span>
          {a2aStatus?.name && <span className="wmux-remote-machine-it ui-code">{a2aStatus.name}</span>}
          <span className="wmux-remote-machine-it" data-remote-server>
            <span className={`wmux-remote-dot${serverOn ? '' : ' is-off'}`} aria-hidden="true" />
            {t('remotePage.phoneAccess', { reach: t(REACH_KEY[reach]) })}
          </span>
          {a2aWord && (
            <span className="wmux-remote-machine-it" data-remote-a2a>
              <span className={`wmux-remote-dot${a2aStatus?.listening ? '' : ' is-off'}`} aria-hidden="true" />
              {a2aWord}
            </span>
          )}
          {/* Phone access off: its switch (the share popover's Start) is one click away. */}
          {reach === 'off' && <WebToggle variant="page" />}
          <span className="flex-1" />
          <button
            type="button"
            className={`ui-btn ui-btn-ghost ui-btn-sm ${FOCUS_RING}`}
            aria-expanded={details}
            aria-controls="remote-machine-detail"
            onClick={() => setDetails((v) => !v)}
            data-remote-details
          >
            {t('remotePage.details')}
            <span className={`wmux-remote-chev${details ? ' is-open' : ''}`} aria-hidden="true"><IconChevron size={12} /></span>
          </button>
        </div>
        {details && (
          <dl className="wmux-remote-machine-detail" id="remote-machine-detail">
            {serverOn && address && (
              <>
                <dt>{t('remotePage.address')}</dt>
                <dd><code className="ui-code" data-remote-address>{address}</code></dd>
                <dd>
                  <button type="button" className={`ui-icon-btn wmux-remote-icon-btn ${FOCUS_RING}`} aria-label={copied === 'address' ? t('web.copied') : t('remotePage.copyAddress')} title={t('remotePage.copyAddress')} onClick={() => copy('address', address)}>
                    <IconCopy size={14} />
                  </button>
                </dd>
              </>
            )}
            {serverOn && (
              <>
                <dt>{t('remotePage.input')}</dt>
                <dd>{info?.allowInput ? t('remotePage.inputOn') : t('remotePage.viewOnly')}</dd>
                <dd />
              </>
            )}
            {reach !== 'off' && (
              <>
                <dt>{t('remotePage.phones')}</dt>
                <dd><WebToggle variant="page" /></dd>
                <dd />
              </>
            )}
            {a2aStatus && (
              <>
                <dt>{t('remotePage.a2aPort')}</dt>
                <dd className="ui-code">{a2aStatus.port}</dd>
                <dd />
              </>
            )}
            {a2aStatus?.fingerprint256 && (
              <>
                <dt>{t('remotePage.fingerprint')}</dt>
                <dd><code className="ui-code wmux-remote-wrap" data-remote-fingerprint>{a2aStatus.fingerprint256}</code></dd>
                <dd>
                  <button type="button" className={`ui-icon-btn wmux-remote-icon-btn ${FOCUS_RING}`} aria-label={copied === 'fp' ? t('web.copied') : t('remotePage.copyFingerprint')} title={t('remotePage.copyFingerprint')} onClick={() => copy('fp', a2aStatus.fingerprint256 ?? '')}>
                    <IconCopy size={14} />
                  </button>
                </dd>
              </>
            )}
            <dt>{t('remotePage.workspaceShares')}</dt>
            <dd>{t('remotePage.workspaceSharesDesc')}</dd>
            <dd><Button size="sm" variant="ghost" onClick={() => setAttach({})} data-remote-add-host>{t('remotePage.addHost')}</Button></dd>
          </dl>
        )}
      </div>

      <div aria-live="polite" data-remote-needs-live>
        {needsCount > 0 && (
          <section className="wmux-remote-needs" aria-labelledby="remote-needs-title" data-remote-needs>
            <h2 id="remote-needs-title" className="wmux-remote-needs-title">
              {t('remotePage.needs.title')} <span className="wmux-remote-count">{needsCount}</span>
            </h2>
            <ul className="wmux-remote-needs-list">
              {requests.map((l, i) => (
                <A2aLinkRequestRow
                  key={l.linkId}
                  link={l}
                  pcName={pcName(l.remote.hostId)}
                  names={names}
                  localRepo={localRepos[`${l.local.workspaceId}/${l.local.paneId}`]}
                  fingerprint={pcs.find((p) => p.hostId === l.remote.hostId)?.fingerprint ?? null}
                  now={now}
                  primary={i === 0}
                  busy={busy === l.linkId}
                  onAccept={() => a2a && void linkCall(l.linkId, () => a2a.linksAccept(l.linkId))}
                  onReject={() => a2a && void linkCall(l.linkId, () => a2a.linksReject(l.linkId))}
                  t={t}
                />
              ))}
              {personHeld.map((task) => (
                <A2aHeldRow
                  key={task.id}
                  task={task}
                  now={now}
                  busy={busy === task.id}
                  onRetry={() => a2a && void heldCall(task.id, () => a2a.heldRetry(task.id))}
                  onReject={() => a2a && void heldCall(task.id, () => a2a.heldReject(task.id))}
                  t={t}
                />
              ))}
              {changedPcs.map((pc) => (
                <A2aIdentityRow
                  key={pc.hostId}
                  hostId={pc.hostId}
                  name={pc.name}
                  links={feed.links.filter((l) => l.remote.hostId === pc.hostId && l.state !== 'revoked' && l.state !== 'broken').length}
                  confirming={isConfirming('pc', pc.hostId)}
                  busy={busy === `pc:${pc.hostId}`}
                  // Joiner side: the other PC must send a new invite. Server side: this PC sends one.
                  onPairAgain={() => setConnect({ tab: pc.joined ? 'paste' : 'invite' })}
                  onAskRemove={() => setConfirming({ kind: 'pc', id: pc.hostId })}
                  onCancelRemove={() => setConfirming(null)}
                  onRemove={() => void removePc(pc)}
                  t={t}
                />
              ))}
            </ul>
            {error && (requests.some((l) => l.linkId === error.key) || feed.held.some((x) => x.id === error.key)) && (
              <p className="wmux-remote-row-error" role="alert">{error.message}</p>
            )}
          </section>
        )}
      </div>
      {moaHeld.map((task) => (
        <p key={task.id} className="wmux-remote-quiet" data-remote-moa-hold={task.id}>
          {`${t('remotePage.needs.heldTitle', { pc: heldPeer(task) })} · ${t(`a2aDelivery.reason.${heldReason(task)}`)}`}
        </p>
      ))}

      {nothing ? (
        <div className="wmux-remote-empty" data-remote-empty>
          <p>{t('remotePage.emptyBody')}</p>
          <Button variant={needsCount > 0 ? 'secondary' : 'primary'} size="md" onClick={() => setConnect({})}>{t('remotePage.connect.button')}</Button>
        </div>
      ) : (
        <ul className="wmux-remote-list" aria-label={t('remotePage.connections')} data-remote-list>
          {group('pcs', t('remotePage.groupPcs'), [...pcRows, ...hostRows])}
          {group('phones', t('remotePage.groupPhones'), phoneRows)}
          {group('messages', t('remotePage.groupMessages'), messageRows, t('remotePage.groupMessagesHint'))}
        </ul>
      )}

      {activity.length > 0 && (
        <ul className="wmux-remote-list wmux-remote-activity" aria-label={t('remotePage.activity')} data-remote-activity>
          <li className="wmux-remote-grp"><span>{t('remotePage.activity')}</span></li>
          {activity.map((item) => (
            <li key={item.key} className="wmux-remote-activity-row">
              <span className="truncate">{t(`remotePage.event.${item.kind}`, { name: item.name || t('web.deviceUnnamed') })}</span>
              <span className="wmux-remote-activity-when">{timeAgo(item.at, now)}</span>
            </li>
          ))}
        </ul>
      )}

      {attach && (
        <AttachRemoteModal
          initialHostId={attach.hostId}
          onClose={() => { setAttach(null); void refresh(); }}
        />
      )}
      {connect && (
        <RemoteConnectDialog
          initialTab={connect.tab}
          onClose={() => { setConnect(null); void refresh(); }}
          onLinkPane={(hostId) => { setConnect(null); setLinkDialog({ hostId }); }}
        />
      )}
      {linkDialog && (
        <A2aLinkDialog
          initialHostId={linkDialog.hostId}
          {...(linkDialog.moa && brain ? { local: { kind: 'brain' as const, workspaceId: brain.workspaceId } } : {})}
          onClose={() => { setLinkDialog(null); void refresh(); }}
        />
      )}
      {exposure && (
        <Dialog onClose={() => setExposure(null)} width={520} data-testid="remote-exposure">
          <DialogHeader title={t('remotePage.exposureTitle', { name: exposure.name })} closeLabel={t('remotePage.connect.close')} />
          <DialogBody>
            <A2aExposureChecklist hostId={exposure.hostId} pcName={exposure.name} t={t} />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setExposure(null)}>{t('remotePage.connect.done')}</Button>
          </DialogFooter>
        </Dialog>
      )}
    </section>
  );
}
