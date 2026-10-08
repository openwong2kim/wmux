import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { A2A_BRAIN_ALIAS, type A2aEndpointKind, type A2aExposedPane, type A2aRemoteHostRecordV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteCallError } from '../../../shared/rpc';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import UiButton from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Badge from '../ui/Badge';
import { FOCUS_RING } from '../focusRing';
import { autoPickPane, rankExposedPanes, repoMismatch, type RankedPane } from './a2aLinkModel';
import Select from '../ui/Select';
import { isMoaHqWorkspace } from '../../stores/slices/moaSlice';
import { activeAgentSlug, leafDisplayName } from '../../utils/paneNaming';
import { buildPaneSnapshot } from '../../hooks/useA2aRemoteSnapshot';

// ─── "Link with a pane on another PC…" ───────────────────────────────────────
//
// The joiner's matching flow: pick a PC this PC joined, pick one of the panes
// it exposes to us (same repo first, as recommended), choose the directions,
// send the proposal. Opened for this PC's Moa instead, it lists only that
// PC's Moa: v1 links like with like. The other PC's human accepts it there. The view is pure
// (props only) so it renders under renderToStaticMarkup in a node test.

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface A2aLinkDialogViewProps {
  /** My end's kind: a pane links only to panes, Moa only to Moa. */
  localKind: A2aEndpointKind;
  /** My end, as the other PC will see it. */
  localName: string;
  localRemote: string | null;
  hosts: A2aRemoteHostRecordV1[];
  hostId: string | null;
  onPickHost: (hostId: string) => void;
  /** null while loading the selected PC's panes. */
  panes: RankedPane[] | null;
  panesError: A2aRemoteCallError | null;
  selected: A2aExposedPane | null;
  onPickPane: (pane: A2aExposedPane) => void;
  send: boolean;
  receive: boolean;
  onSend: (v: boolean) => void;
  onReceive: (v: boolean) => void;
  busy: boolean;
  /** `uncertain`: sent, no answer — it may have reached that PC; Check settles it. */
  outcome: { ok: true } | { ok: false; error: A2aRemoteCallError; uncertain?: boolean } | null;
  onPropose: () => void;
  onClose: () => void;
  /** Opened without a pane (the Remote page): which of this PC's panes to link. */
  localChoices?: Array<{ key: string; label: string }>;
  localKey?: string;
  onPickLocal?: (key: string) => void;
  t: T;
}

export function A2aLinkDialogView(p: A2aLinkDialogViewProps) {
  const { t } = p;
  const brainMode = p.localKind === 'brain';
  const mismatch = p.selected && !brainMode ? repoMismatch(p.localRemote, p.selected.gitRemote) : false;
  // Like with like only: the other kind is left out, with a word on why.
  const choices = p.panes?.filter((r) => r.pane.kind === p.localKind) ?? null;
  const hiddenOther = (p.panes?.length ?? 0) - (choices?.length ?? 0);
  const canSend = !!p.selected && p.selected.kind === p.localKind && (p.send || p.receive) && !p.busy && !p.outcome?.ok;
  const hostName = p.hosts.find((h) => h.hostId === p.hostId)?.name ?? '';
  return (
    <Dialog onClose={p.onClose} width={560} data-testid="a2a-link-dialog">
      <DialogHeader
        title={t(brainMode ? 'a2aLink.moaTitle' : 'a2aLink.title')}
        description={t(brainMode ? 'a2aLink.moaDescription' : 'a2aLink.description', { pane: p.localName })}
        closeLabel={t('a2aLink.close')}
      />
      <DialogBody className="flex flex-col gap-3">
        {p.localChoices && p.onPickLocal && (
          <label className="flex flex-col gap-1 text-[12px] text-[var(--text-sub)]">
            {t('a2aLink.yourPaneLabel')}
            <Select
              value={p.localKey ?? ''}
              onChange={(e) => p.onPickLocal?.(e.target.value)}
              data-testid="a2a-link-local"
            >
              {p.localChoices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </Select>
          </label>
        )}
        {p.hosts.length === 0 ? (
          <p className="wmux-a2a-note" data-testid="a2a-link-no-hosts">{t('a2aLink.noHosts')}</p>
        ) : (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('a2aLink.pc')}>
            {p.hosts.map((h) => (
              <UiButton
                key={h.hostId}
                role="radio"
                aria-checked={p.hostId === h.hostId}
                variant={p.hostId === h.hostId ? 'secondary' : 'ghost'}
                size="md"
                onClick={() => p.onPickHost(h.hostId)}
              >
                {h.name}
              </UiButton>
            ))}
          </div>
        )}

        {p.hostId && p.panesError && (
          <p className="wmux-a2a-note" data-tone="danger" data-testid="a2a-link-panes-error">
            {t(`a2aLink.error.${p.panesError}`)}
          </p>
        )}
        {p.hostId && !p.panesError && p.panes === null && (
          <p className="wmux-a2a-note">{t('a2aLink.loading')}</p>
        )}
        {p.hostId && choices && choices.length === 0 && (
          <p className="wmux-a2a-note" data-testid="a2a-link-none-exposed">{t(brainMode ? 'a2aLink.noMoaExposed' : 'a2aLink.noneExposed')}</p>
        )}
        {choices && choices.length > 0 && (
          <ul className="wmux-a2a-list" role="listbox" aria-label={t(brainMode ? 'a2aLink.moaSection' : 'a2aLink.panes')} data-testid="a2a-link-panes">
            {choices.map(({ pane, recommended }) => {
              const on = p.selected?.kind === pane.kind && p.selected?.workspaceId === pane.workspaceId && p.selected?.paneId === pane.paneId;
              return (
                <li key={`${pane.kind}/${pane.workspaceId}/${pane.paneId ?? ''}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-pane-id={pane.paneId ?? 'moa'}
                    className={`wmux-a2a-row ${FOCUS_RING}`}
                    onClick={() => p.onPickPane(pane)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate">
                        {pane.kind === 'brain' ? t('a2aLink.moaOf', { pc: hostName }) : `${pane.workspaceName} / ${pane.label ?? pane.paneId}`}
                      </span>
                      {pane.agent && <Badge>{pane.agent}</Badge>}
                      {recommended && <Badge tone="success" data-testid="a2a-link-recommended">{t('a2aLink.recommended')}</Badge>}
                    </span>
                    {(pane.gitRemote || pane.cwd) && (
                      <span className="wmux-a2a-meta ui-code truncate">
                        {[pane.gitRemote && `${pane.gitRemote}${pane.gitBranch ? ` @ ${pane.gitBranch}` : ''}`, pane.cwd].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {hiddenOther > 0 && (
          <p className="wmux-a2a-note" data-testid="a2a-link-kind-note">{t(brainMode ? 'a2aLink.moaOnlyNote' : 'a2aLink.paneOnlyNote')}</p>
        )}
        {p.selected && (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox checked={p.send} onCheckedChange={p.onSend} aria-label={t('a2aLink.send')} />
              {t('a2aLink.send')}
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox checked={p.receive} onCheckedChange={p.onReceive} aria-label={t('a2aLink.receive')} />
              {t('a2aLink.receive')}
            </label>
          </div>
        )}
        {mismatch && (
          <p className="wmux-a2a-note" data-tone="warning" data-testid="a2a-link-mismatch">
            {t('a2aLink.repoMismatch', { mine: p.localRemote ?? '', theirs: p.selected?.gitRemote ?? '' })}
          </p>
        )}
        {p.outcome && (
          <p className="wmux-a2a-note" data-tone={p.outcome.ok ? undefined : 'danger'} data-testid="a2a-link-outcome">
            {p.outcome.ok ? t('a2aLink.sent') : p.outcome.uncertain ? t('a2aLink.uncertain') : t(`a2aLink.error.${p.outcome.error}`)}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <UiButton variant="ghost" size="md" onClick={p.onClose}>{p.outcome?.ok || (p.outcome && p.outcome.uncertain) ? t('a2aLink.done') : t('a2aLink.cancel')}</UiButton>
        {!p.outcome?.ok && !(p.outcome && p.outcome.uncertain) && (
          <UiButton variant="primary" size="md" disabled={!canSend} onClick={p.onPropose} data-testid="a2a-link-propose">
            {p.busy ? t('a2aLink.sending') : t('a2aLink.propose')}
          </UiButton>
        )}
      </DialogFooter>
    </Dialog>
  );
}

type LocalEnd = { kind: 'pane'; workspaceId: string; paneId: string } | { kind: 'brain'; workspaceId: string };

export interface A2aLinkDialogProps {
  /**
   * My end: a pane (from the pane menu) or this PC's Moa (its HQ workspace).
   * Absent (the Remote page): the dialog offers this PC's panes, starting on
   * the active workspace's focused pane.
   */
  local?: LocalEnd;
  /** Start on this PC (otherwise the only one, when there is one). */
  initialHostId?: string;
  onClose: () => void;
}

export default function A2aLinkDialog({ local: fixed, initialHostId, onClose }: A2aLinkDialogProps) {
  // This PC's panes, for the picker shown when no end was handed in. The
  // Moa HQ is left out: Moa links through its own entry.
  const workspaces = useStore((s) => s.workspaces);
  const paneLabels = useStore((s) => s.paneLabel);
  const agents = useStore((s) => s.surfaceAgent);
  const hqView = useStore(useShallow((s) => ({ moa: s.moa, moaHqSeed: s.moaHqSeed })));
  const localChoices = useMemo(() => (fixed ? undefined : workspaces
    .filter((ws) => !isMoaHqWorkspace(hqView, ws.id))
    .flatMap((ws) => getWorkspaceLeafPanes(ws).map((leaf) => ({
      key: `${ws.id}/${leaf.id}`,
      label: `${ws.name} / ${leafDisplayName(paneLabels, ws, leaf, activeAgentSlug(agents, leaf))}`,
    })))), [fixed, workspaces, paneLabels, agents, hqView]);
  const [pickedKey, setPickedKey] = useState<string | null>(() => {
    if (fixed) return null;
    const s = useStore.getState();
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.activePaneId ? `${ws.id}/${ws.activePaneId}` : null;
  });
  const localKey = localChoices?.some((c) => c.key === pickedKey) ? pickedKey : localChoices?.[0]?.key ?? null;
  const end: LocalEnd = fixed ?? (localKey
    ? { kind: 'pane', workspaceId: localKey.split('/')[0], paneId: localKey.slice(localKey.indexOf('/') + 1) }
    : { kind: 'pane', workspaceId: '', paneId: '' });
  const workspaceId = end.workspaceId;
  const paneId = end.kind === 'pane' ? end.paneId : '';
  const t = useT();
  const api = window.electronAPI?.a2aRemote;
  // My pane as the snapshot describes it (label, cwd), from the live store.
  const local = useStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId);
    if (ws && !paneId) return { found: true, workspaceName: ws.name, label: A2A_BRAIN_ALIAS, cwd: '' };
    if (!ws || !getWorkspaceLeafPanes(ws).some((l) => l.id === paneId)) return { found: false, workspaceName: '', label: paneId, cwd: '' };
    const pane = buildPaneSnapshot({ workspaces: [ws], surfaceAgent: s.surfaceAgent, paneLabel: s.paneLabel }).workspaces[0].panes.find((x) => x.paneId === paneId);
    return { found: true, workspaceName: ws.name, label: pane?.label ?? paneId, cwd: pane?.cwd ?? '' };
  }));

  const [hosts, setHosts] = useState<A2aRemoteHostRecordV1[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [exposed, setExposed] = useState<A2aExposedPane[] | null>(null);
  const [panesError, setPanesError] = useState<A2aRemoteCallError | null>(null);
  const [selected, setSelected] = useState<A2aExposedPane | null>(null);
  const [send, setSend] = useState(true);
  const [receive, setReceive] = useState(true);
  const [myRemote, setMyRemote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<A2aLinkDialogViewProps['outcome']>(null);

  useEffect(() => {
    let live = true;
    void api?.hostsList().then((r) => {
      if (!live || !Array.isArray(r?.hosts)) return;
      setHosts(r.hosts);
      if (initialHostId && r.hosts.some((h) => h.hostId === initialHostId)) setHostId(initialHostId);
      else if (r.hosts.length === 1) setHostId(r.hosts[0].hostId);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [api, initialHostId]);

  const cwd = local.cwd;
  useEffect(() => {
    let live = true;
    if (!cwd) { setMyRemote(null); return; }
    void window.electronAPI?.github?.repoKey(cwd).then((r) => { if (live) setMyRemote(r?.key ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, [cwd]);

  useEffect(() => {
    if (!api || !hostId) return;
    let live = true;
    setExposed(null); setPanesError(null); setSelected(null); setOutcome(null);
    void api.hostsExposed(hostId).then((r) => {
      if (!live) return;
      if (r.ok) setExposed(r.panes);
      else setPanesError(r.error);
    }).catch(() => { if (live) setPanesError('failed'); });
    return () => { live = false; };
  }, [api, hostId]);

  const ranked = useMemo(() => (exposed ? rankExposedPanes(exposed, myRemote) : null), [exposed, myRemote]);
  // One choice, or one on my repo: picked already, the person only confirms.
  const autoPane = useMemo(() => autoPickPane(ranked, end.kind), [ranked, end.kind]);
  useEffect(() => {
    if (autoPane) setSelected((cur) => cur ?? autoPane);
  }, [autoPane]);

  const onPropose = useCallback(async () => {
    if (!api || !hostId || !selected || !local.found) return;
    setBusy(true); setOutcome(null);
    try {
      const r = await api.linksPropose({
        hostId,
        local: end.kind === 'brain'
          ? { kind: 'brain', workspaceId, workspaceName: local.workspaceName }
          : {
              kind: 'pane',
              workspaceId,
              paneId,
              label: local.label,
              workspaceName: local.workspaceName,
              ...(myRemote ? { gitRemote: myRemote } : {}),
            },
        remote: selected.kind === 'brain'
          ? { kind: 'brain', workspaceId: selected.workspaceId, workspaceName: selected.workspaceName }
          : {
              kind: 'pane',
              workspaceId: selected.workspaceId,
              paneId: selected.paneId,
              ...(selected.label ? { label: selected.label } : {}),
              workspaceName: selected.workspaceName,
              ...(selected.gitRemote ? { gitRemote: selected.gitRemote } : {}),
            },
        allow: { outbound: send, inbound: receive },
      });
      setOutcome(r.ok ? { ok: true } : { ok: false, error: r.error, ...(r.uncertain ? { uncertain: true } : {}) });
    } catch {
      setOutcome({ ok: false, error: 'failed' });
    } finally {
      setBusy(false);
    }
  }, [api, hostId, selected, local, end.kind, workspaceId, paneId, myRemote, send, receive]);

  return (
    <A2aLinkDialogView
      localKind={end.kind}
      localName={end.kind === 'brain' ? t('a2aLink.thisMoa') : local.found ? `${local.workspaceName} / ${local.label}` : paneId}
      localRemote={myRemote}
      hosts={hosts}
      hostId={hostId}
      onPickHost={setHostId}
      panes={ranked}
      panesError={panesError}
      selected={selected}
      onPickPane={setSelected}
      send={send}
      receive={receive}
      onSend={setSend}
      onReceive={setReceive}
      busy={busy}
      outcome={outcome}
      onPropose={() => void onPropose()}
      onClose={onClose}
      {...(localChoices ? { localChoices, localKey: localKey ?? '', onPickLocal: setPickedKey } : {})}
      t={t}
    />
  );
}
