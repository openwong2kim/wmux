import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { A2A_FEATURE_LINK_OFFER, type A2aLinkOfferRecordV1, type A2aLinkRecordV1, type A2aPeerRecordV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../../shared/rpc';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { refreshA2aRemote } from '../../hooks/useA2aRemoteBridge';
import { buildPaneSnapshot } from '../../hooks/useA2aRemoteSnapshot';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import UiButton from '../ui/Button';
import Checkbox from '../ui/Checkbox';

// ─── "Share this pane with <PC>…" ────────────────────────────────────────────
//
// The sharing PC's one step: this pane, shown to one PC that joined this one,
// offered as a link it may accept within the directions ticked here. The
// other PC's human picks its own pane and accepts there; until then the
// share can be withdrawn. Nothing else is shown to that PC. The view is pure
// (props only) for node tests.

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Why a PC cannot take a share of this pane right now (null: it can). */
export type ShareBlock = 'unsupported' | 'not-connected' | 'linked' | 'shared';

/** The share state of this pane for one PC that joined this one. */
export function shareBlock(
  hostId: string,
  pane: { workspaceId: string; paneId: string },
  feed: { hosts: A2aRemoteHostStatus[]; links: A2aLinkRecordV1[]; offers: A2aLinkOfferRecordV1[] },
): ShareBlock | null {
  const linked = feed.links.some(
    (l) => l.remote.hostId === hostId && l.local.kind === 'pane' && l.local.workspaceId === pane.workspaceId &&
      l.local.paneId === pane.paneId && l.state !== 'revoked' && l.state !== 'broken',
  );
  if (linked) return 'linked';
  if (openShare(hostId, pane, feed.offers)) return 'shared';
  // What that PC supports is known once it connected after this PC's wmux started.
  const features = feed.hosts.find((h) => h.hostId === hostId)?.features;
  if (!features) return 'not-connected';
  return features.includes(A2A_FEATURE_LINK_OFFER) ? null : 'unsupported';
}

/** This PC's open share of the pane with that PC, if any. */
export function openShare(hostId: string, pane: { workspaceId: string; paneId: string }, offers: A2aLinkOfferRecordV1[]): A2aLinkOfferRecordV1 | undefined {
  return offers.find(
    (o) => o.side === 'out' && (o.state === 'open' || o.state === 'claimed') && o.hostId === hostId &&
      o.end.workspaceId === pane.workspaceId && o.end.paneId === pane.paneId,
  );
}

export interface A2aShareDialogViewProps {
  paneName: string;
  /** What that PC will see besides the name. */
  agent?: string;
  cwd?: string;
  repo?: string | null;
  peers: Array<{ hostId: string; name: string }>;
  hostId: string | null;
  onPickHost: (hostId: string) => void;
  block: ShareBlock | null;
  /** The open share can still be withdrawn (not while it is being turned into a link). */
  withdrawable: boolean;
  send: boolean;
  receive: boolean;
  onSend: (v: boolean) => void;
  onReceive: (v: boolean) => void;
  busy: boolean;
  outcome: { ok: true } | { ok: false; error: string } | null;
  onShare: () => void;
  onWithdraw: () => void;
  onClose: () => void;
  t: T;
}

export function A2aShareDialogView(p: A2aShareDialogViewProps) {
  const { t } = p;
  const pc = p.peers.find((h) => h.hostId === p.hostId)?.name ?? '';
  const done = p.outcome?.ok === true;
  const canShare = !!p.hostId && p.block === null && (p.send || p.receive) && !p.busy && !done;
  return (
    <Dialog onClose={p.onClose} width={520} data-testid="a2a-share-dialog">
      <DialogHeader
        title={pc ? t('a2aShare.title', { pane: p.paneName, pc }) : t('a2aShare.titleAny', { pane: p.paneName })}
        description={t('a2aShare.description', { pc: pc || t('a2aShare.thatPc') })}
        closeLabel={t('a2aLink.close')}
      />
      <DialogBody className="flex flex-col gap-3">
        {p.peers.length > 1 && (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('a2aLink.pc')}>
            {p.peers.map((h) => (
              <UiButton
                key={h.hostId}
                role="radio"
                aria-checked={p.hostId === h.hostId}
                variant={p.hostId === h.hostId ? 'secondary' : 'ghost'}
                size="md"
                disabled={p.busy}
                onClick={() => p.onPickHost(h.hostId)}
              >
                {h.name}
              </UiButton>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1" data-testid="a2a-share-shown">
          <span className="text-[13px]" style={{ fontWeight: 500 }}>{p.paneName}</span>
          {(p.agent || p.repo || p.cwd) && (
            <span className="wmux-a2a-meta ui-code truncate">{[p.agent, p.repo, p.cwd].filter(Boolean).join(' · ')}</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox checked={p.receive} onCheckedChange={p.onReceive} disabled={done || p.busy} aria-label={t('a2aShare.receive', { pc: pc || t('a2aShare.thatPc') })} />
            {t('a2aShare.receive', { pc: pc || t('a2aShare.thatPc') })}
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox checked={p.send} onCheckedChange={p.onSend} disabled={done || p.busy} aria-label={t('a2aShare.send', { pc: pc || t('a2aShare.thatPc') })} />
            {t('a2aShare.send', { pc: pc || t('a2aShare.thatPc') })}
          </label>
        </div>
        {p.block && !done && (
          <p className="wmux-a2a-note" data-testid="a2a-share-block">{t(`a2aShare.block.${p.block}`, { pc })}</p>
        )}
        {!p.block && !done && <p className="wmux-a2a-note">{t('a2aShare.how', { pc: pc || t('a2aShare.thatPc') })}</p>}
        {p.outcome && (
          <p className="wmux-a2a-note" data-tone={p.outcome.ok ? undefined : 'danger'} data-testid="a2a-share-outcome">
            {p.outcome.ok ? t('a2aShare.shared', { pc }) : t(`a2aShare.error.${p.outcome.error}`)}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        {p.block === 'shared' && p.withdrawable && !done && (
          <UiButton variant="ghost" size="md" disabled={p.busy} onClick={p.onWithdraw} data-testid="a2a-share-withdraw">{t('a2aShare.withdraw')}</UiButton>
        )}
        <UiButton variant={done ? 'secondary' : 'ghost'} size="md" onClick={p.onClose}>{done ? t('a2aLink.done') : t('a2aLink.cancel')}</UiButton>
        {!done && (
          <UiButton variant="primary" size="md" disabled={!canShare} onClick={p.onShare} data-testid="a2a-share-submit">
            {p.busy ? t('a2aShare.sharing') : t('a2aShare.share')}
          </UiButton>
        )}
      </DialogFooter>
    </Dialog>
  );
}

export interface A2aShareDialogProps {
  workspaceId: string;
  paneId: string;
  onClose: () => void;
}

export default function A2aShareDialog({ workspaceId, paneId, onClose }: A2aShareDialogProps) {
  const t = useT();
  const api = window.electronAPI?.a2aRemote;
  const feed = useStore(useShallow((s) => ({ hosts: s.a2aRemote.hosts, links: s.a2aRemote.links, offers: s.a2aRemote.offers, peers: s.a2aRemote.peers })));
  const peers = useMemo(() => feed.peers.filter((p: A2aPeerRecordV1) => !p.revokedAt).map((p) => ({ hostId: p.hostId, name: p.name })), [feed.peers]);
  const pane = useStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId);
    if (!ws || !getWorkspaceLeafPanes(ws).some((l) => l.id === paneId)) return { name: paneId, agent: '', cwd: '' };
    const snap = buildPaneSnapshot({ workspaces: [ws], surfaceAgent: s.surfaceAgent, paneLabel: s.paneLabel }).workspaces[0].panes.find((x) => x.paneId === paneId);
    return { name: `${ws.name} / ${snap?.label ?? paneId}`, agent: snap?.agent ?? '', cwd: snap?.cwd ?? '' };
  }));
  const [hostId, setHostId] = useState<string | null>(null);
  const [send, setSend] = useState(true);
  const [receive, setReceive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<A2aShareDialogViewProps['outcome']>(null);
  const [repo, setRepo] = useState<string | null>(null);

  useEffect(() => {
    void refreshA2aRemote();
  }, []);
  useEffect(() => {
    if (hostId === null && peers.length === 1) setHostId(peers[0].hostId);
  }, [hostId, peers]);
  useEffect(() => {
    let live = true;
    if (!pane.cwd) { setRepo(null); return; }
    void window.electronAPI?.github?.repoKey(pane.cwd).then((r) => { if (live) setRepo(r?.key ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, [pane.cwd]);

  const end = { workspaceId, paneId };
  const block = hostId ? shareBlock(hostId, end, feed) : null;
  const existing = hostId ? openShare(hostId, end, feed.offers) : undefined;

  const onShare = useCallback(async () => {
    if (!api?.offersCreate || !hostId) return;
    setBusy(true); setOutcome(null);
    try {
      const r = await api.offersCreate({ hostId, workspaceId, paneId, allow: { outbound: send, inbound: receive } });
      setOutcome(r.ok ? { ok: true } : { ok: false, error: r.error });
      void refreshA2aRemote();
    } catch {
      setOutcome({ ok: false, error: 'unavailable' });
    } finally {
      setBusy(false);
    }
  }, [api, hostId, workspaceId, paneId, send, receive]);

  const onWithdraw = useCallback(async () => {
    if (!api?.offersWithdraw || !existing) return;
    setBusy(true); setOutcome(null);
    try {
      const r = await api.offersWithdraw(existing.offerId);
      if (!r.ok) setOutcome({ ok: false, error: 'withdraw' });
      void refreshA2aRemote();
    } catch {
      setOutcome({ ok: false, error: 'withdraw' });
    } finally {
      setBusy(false);
    }
  }, [api, existing]);

  return (
    <A2aShareDialogView
      paneName={pane.name}
      {...(pane.agent ? { agent: pane.agent } : {})}
      {...(pane.cwd ? { cwd: pane.cwd } : {})}
      repo={repo}
      peers={peers}
      hostId={hostId}
      onPickHost={(id) => { setHostId(id); setOutcome(null); }}
      block={block}
      withdrawable={existing?.state === 'open'}
      send={send}
      receive={receive}
      onSend={setSend}
      onReceive={setReceive}
      busy={busy}
      outcome={outcome}
      onShare={() => void onShare()}
      onWithdraw={() => void onWithdraw()}
      onClose={onClose}
      t={t}
    />
  );
}
