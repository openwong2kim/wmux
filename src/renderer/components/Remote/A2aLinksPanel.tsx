import { useCallback, useEffect, useMemo, useState } from 'react';
import type { A2aLinkRecordV1 } from '../../../shared/a2aRemote';
import type { Workspace } from '../../../shared/types';
import type { AgentSlug } from '../../../shared/events';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import UiButton from '../ui/Button';
import Badge from '../ui/Badge';
import { buildPaneSnapshot, moaBrainEnd } from '../../hooks/useA2aRemoteSnapshot';
import A2aLinkDialog from './A2aLinkDialog';
import { linkDirection, linkStateWord, localPaneName, remoteAlias, repoMismatch } from './a2aLinkModel';

// ─── Cross-PC pane links on the Remote page ──────────────────────────────────
//
// Requests another PC sent to one of this PC's panes (accept / decline), and
// every link with its state, direction and an Unlink. Links this PC proposed
// wait as "Pending" until the other PC's human accepts; Check re-reads that.
// Draws nothing at all while there is no link (no dead gauges).

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Terminal links shown under the live ones. */
export const ENDED_LINKS_SHOWN = 5;

export interface A2aLinksViewProps {
  links: A2aLinkRecordV1[];
  /** hostId → that PC's name (paired either way). */
  pcNames: Record<string, string>;
  workspaces: Workspace[];
  /** User pane labels and pane agents, for the header's pane names. */
  paneLabel?: Record<string, string>;
  surfaceAgent?: Record<string, { slug?: AgentSlug }>;
  /** `workspaceId/paneId` → this PC's repo key for that pane, when known. */
  localRepos: Record<string, string>;
  busy: string | null;
  confirming: string | null;
  error: string | null;
  onAccept: (linkId: string) => void;
  onReject: (linkId: string) => void;
  onAskRevoke: (linkId: string) => void;
  onCancelRevoke: () => void;
  onRevoke: (linkId: string) => void;
  onCheck: (linkId: string) => void;
  /** Opens "Link this PC's Moa with another PC's Moa…"; absent while this PC has no Moa. */
  onLinkMoa?: () => void;
  t: T;
}

const DIRECTION_KEY = { both: 'a2aLink.dirBoth', send: 'a2aLink.dirSend', receive: 'a2aLink.dirReceive', none: 'a2aLink.dirNone' } as const;

export function A2aLinksView(p: A2aLinksViewProps) {
  const { t } = p;
  const requests = p.links.filter((l) => l.state === 'proposed-in');
  const live = p.links.filter((l) => l.state === 'proposed-out' || l.state === 'active');
  const ended = p.links
    .filter((l) => l.state === 'revoked' || l.state === 'broken')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, ENDED_LINKS_SHOWN);
  if (requests.length === 0 && live.length === 0 && ended.length === 0 && !p.onLinkMoa) return null;

  const pcName = (hostId: string): string => p.pcNames[hostId] ?? hostId.slice(0, 6);
  const localLine = (l: A2aLinkRecordV1): string => {
    if (l.local.kind === 'brain') return t('a2aLink.thisMoa');
    const n = localPaneName(p.workspaces, l.local, p.paneLabel, p.surfaceAgent);
    return `${n.workspace} / ${n.pane}`;
  };
  const localRepo = (l: A2aLinkRecordV1): string | undefined => p.localRepos[`${l.local.workspaceId}/${l.local.paneId}`];

  return (
    <section className="flex flex-col gap-3" aria-labelledby="a2a-links-title" data-testid="a2a-links">
      <div className="wmux-a2a-row-line">
        <h2 id="a2a-links-title" className="wmux-remote-section-title flex-1">{t('a2aLink.sectionTitle')}</h2>
        {p.onLinkMoa && (
          <UiButton variant="secondary" size="sm" onClick={p.onLinkMoa} data-testid="a2a-link-moa">{t('a2aLink.moaMenu')}</UiButton>
        )}
      </div>

      {requests.length > 0 && (
        <ul className="wmux-a2a-list" aria-label={t('a2aLink.requests')} data-testid="a2a-link-requests">
          {requests.map((l) => {
            const mine = localRepo(l);
            return (
              <li key={l.linkId} className="wmux-a2a-row" data-link-id={l.linkId}>
                <span className="wmux-a2a-row-line">
                  <span className="truncate" style={{ fontWeight: 500 }}>
                    {l.remote.kind === 'brain'
                      ? t('a2aLink.moaRequestTitle', { pc: pcName(l.remote.hostId) })
                      : t('a2aLink.requestTitle', { pc: pcName(l.remote.hostId) })}
                  </span>
                </span>
                <span className="wmux-a2a-meta" data-testid="a2a-link-reported">{t('a2aLink.reportedBy', { pc: pcName(l.remote.hostId) })}</span>
                <span className="wmux-a2a-meta">{t('a2aLink.theirPane', { pane: remoteAlias(pcName(l.remote.hostId), l.remote) })}</span>
                {l.remote.gitRemote && <span className="wmux-a2a-meta ui-code truncate">{l.remote.gitRemote}</span>}
                <span className="wmux-a2a-meta">{t('a2aLink.yourPane', { pane: localLine(l) })}</span>
                {mine && <span className="wmux-a2a-meta ui-code truncate">{mine}</span>}
                <span className="wmux-a2a-meta">{t(DIRECTION_KEY[linkDirection(l.allow)])}</span>
                {repoMismatch(mine, l.remote.gitRemote) && (
                  <p className="wmux-a2a-note" data-tone="warning" data-testid="a2a-link-request-mismatch">
                    {t('a2aLink.repoMismatch', { mine: mine ?? '', theirs: l.remote.gitRemote ?? '' })}
                  </p>
                )}
                <span className="wmux-a2a-row-line" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
                  <UiButton variant="ghost" size="md" disabled={p.busy === l.linkId} onClick={() => p.onReject(l.linkId)}>
                    {t('a2aLink.decline')}
                  </UiButton>
                  <UiButton variant="primary" size="md" disabled={p.busy === l.linkId} onClick={() => p.onAccept(l.linkId)} data-testid="a2a-link-accept">
                    {t('a2aLink.accept')}
                  </UiButton>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {(live.length > 0 || ended.length > 0) && (
        <ul className="wmux-a2a-list" aria-label={t('a2aLink.links')} data-testid="a2a-link-list">
          {[...live, ...ended].map((l) => {
            const word = linkStateWord(l.state);
            const terminal = word === 'revoked' || word === 'broken';
            return (
              <li key={l.linkId} className="wmux-a2a-row" data-link-id={l.linkId} style={terminal ? { opacity: 0.6 } : undefined}>
                <span className="wmux-a2a-row-line">
                  <span className="truncate flex-1">{`${localLine(l)} ↔ ${remoteAlias(pcName(l.remote.hostId), l.remote)}`}</span>
                  <Badge tone={word === 'active' ? 'success' : word === 'broken' ? 'warning' : 'neutral'} data-state={word}>
                    {t(`a2aLink.state.${word}`)}
                  </Badge>
                </span>
                <span className="wmux-a2a-row-line">
                  <span className="wmux-a2a-meta flex-1">
                    {terminal && l.endedReason ? t(`a2aLink.ended.${l.endedReason}`) : t(DIRECTION_KEY[linkDirection(l.allow)])}
                  </span>
                  {!terminal && l.proposer === 'local' && (
                    <UiButton variant="ghost" size="sm" disabled={p.busy === l.linkId} onClick={() => p.onCheck(l.linkId)}>
                      {t('a2aLink.check')}
                    </UiButton>
                  )}
                  {!terminal && (p.confirming === l.linkId ? (
                    <>
                      <UiButton variant="ghost" size="sm" onClick={p.onCancelRevoke}>{t('a2aLink.keep')}</UiButton>
                      <UiButton variant="danger" size="sm" onClick={() => p.onRevoke(l.linkId)}>{t('a2aLink.unlink')}</UiButton>
                    </>
                  ) : (
                    <UiButton variant="destructive" size="sm" disabled={p.busy === l.linkId} onClick={() => p.onAskRevoke(l.linkId)}>
                      {t('a2aLink.unlink')}
                    </UiButton>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {p.error && <p className="wmux-a2a-note" data-tone="danger">{p.error}</p>}
    </section>
  );
}

/** How often the panel re-reads the links while the Remote page is open. */
export const A2A_LINKS_POLL_MS = 10_000;

export default function A2aLinksPanel() {
  const t = useT();
  const api = window.electronAPI?.a2aRemote;
  const workspaces = useStore((s) => s.workspaces);
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const paneLabel = useStore((s) => s.paneLabel);
  const moa = useStore((s) => s.moa);
  const brain = useMemo(() => moaBrainEnd({ workspaces, surfaceAgent, moa }), [workspaces, surfaceAgent, moa]);
  const [moaDialog, setMoaDialog] = useState(false);
  const [links, setLinks] = useState<A2aLinkRecordV1[]>([]);
  const [pcNames, setPcNames] = useState<Record<string, string>>({});
  const [localRepos, setLocalRepos] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!api?.linksList) return;
    try {
      const [l, h, p] = await Promise.all([api.linksList(), api.hostsList(), api.peersList()]);
      if (Array.isArray(l?.links)) setLinks(l.links);
      const names: Record<string, string> = {};
      for (const peer of p?.peers ?? []) names[peer.hostId] = peer.name;
      for (const host of h?.hosts ?? []) names[host.hostId] = host.name;
      setPcNames(names);
    } catch {
      // The daemon is away; the next poll or nudge tries again.
    }
  }, [api]);

  useEffect(() => {
    void reload();
    const off = api?.onLinkEvent?.(() => void reload());
    const poll = setInterval(() => void reload(), A2A_LINKS_POLL_MS);
    return () => { off?.(); clearInterval(poll); };
  }, [api, reload]);

  // This PC's repo for each pane waiting on a decision (the mismatch warning).
  const pendingCwds = useMemo(() => {
    const snapshot = buildPaneSnapshot({ workspaces, surfaceAgent });
    const out: Record<string, string> = {};
    for (const l of links) {
      if (l.state !== 'proposed-in') continue;
      const pane = snapshot.workspaces.find((w) => w.id === l.local.workspaceId)?.panes.find((x) => x.paneId === l.local.paneId);
      if (pane?.cwd) out[`${l.local.workspaceId}/${l.local.paneId}`] = pane.cwd;
    }
    return out;
  }, [links, workspaces, surfaceAgent]);
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

  const act = useCallback(async (linkId: string, run: () => Promise<{ ok: boolean; error?: string } | undefined>) => {
    setBusy(linkId); setError(null); setConfirming(null);
    try {
      const r = await run();
      if (r && !r.ok) setError(t(`a2aLink.error.${r.error ?? 'failed'}`));
    } catch {
      setError(t('a2aLink.error.failed'));
    } finally {
      setBusy(null);
      void reload();
    }
  }, [reload, t]);

  if (!api?.linksList) return null;
  return (
    <>
    <A2aLinksView
      links={links}
      pcNames={pcNames}
      workspaces={workspaces}
      paneLabel={paneLabel}
      surfaceAgent={surfaceAgent}
      localRepos={localRepos}
      busy={busy}
      confirming={confirming}
      error={error}
      onAccept={(id) => void act(id, () => api.linksAccept(id))}
      onReject={(id) => void act(id, () => api.linksReject(id))}
      onAskRevoke={setConfirming}
      onCancelRevoke={() => setConfirming(null)}
      onRevoke={(id) => void act(id, () => api.linksRevoke(id))}
      onCheck={(id) => void act(id, () => api.linksRefresh(id))}
      onLinkMoa={brain ? () => setMoaDialog(true) : undefined}
      t={t}
    />
    {moaDialog && brain && (
      <A2aLinkDialog local={{ kind: 'brain', workspaceId: brain.workspaceId }} onClose={() => { setMoaDialog(false); void reload(); }} />
    )}
    </>
  );
}
