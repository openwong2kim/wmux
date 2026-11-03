import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { finalizeSpawnPrompt } from '../../../shared/a2aSpawnPrompt';
import {
  normalizeSpawnSub,
  SPAWN_SUB_MAX,
  SPAWN_TEXT_MAX,
  type A2aSpawnAskError,
  type A2aSpawnOutgoingList,
  type A2aSpawnPlace,
  type A2aSpawnUiAsk,
} from '../../../shared/a2aSpawn';
import { agentRow } from '../../../shared/agentIdentity';
import { remoteSeatIntro } from '../../../shared/company';
import { freeSeatLabels, SEAT_LABEL_MAX } from '../../../shared/companyPreset';
import { normalizePaneLabel, paneLabelShapeError } from '../../../shared/paneLabelRules';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { PANE_METADATA_LABEL_MAX } from '../../../shared/types';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { paneLabelRejectionKey } from '../../utils/paneNaming';
import { localPaneName } from '../Remote/a2aLinkModel';
import { DEFAULT_HOURS, SPAWN_ASK_HOURS, spawnAskBlock, spawnUntil, utf8Bytes } from '../Remote/RemoteSpawnAskDialog';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import UiButton from '../ui/Button';
import Field from '../ui/Field';
import Input from '../ui/Input';
import Select from '../ui/Select';
import TextArea from '../ui/TextArea';
import { remoteSeatsOf } from './companyBoard';

// ─── "Add a seat on another PC…" ─────────────────────────────────────────────
//
// A company asks a paired PC to start an agent whose replies come to the
// company's CEO pane: the Remote page's person ask, with a seat name (the
// started agent's link label here), what it owns, and a first message written
// for the seat (remoteSeatIntro), sent exactly as shown.

/**
 * A free default name for a seat on `pc`: that PC's name as a pane label,
 * then `-dev` (`linux-build-box-dev`), with `-2`, `-3`… when it is taken.
 */
export function defaultSeatName(pc: string, taken: Iterable<string>): string {
  let base = pc.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'seat';
  // A leading digit or a `w1-2` coordinate is not a pane label.
  if (paneLabelShapeError(base)) base = `pc-${base}`;
  return freeSeatLabels([`${base.slice(0, SEAT_LABEL_MAX - 4)}-dev`], taken)[0];
}

const placeName = (p: A2aSpawnPlace): string => p.name?.trim() || p.hostId.slice(0, 8);

export default function AddRemoteSeatDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const paneLabel = useStore((s) => s.paneLabel);
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const remoteLinks = useStore((s) => s.a2aRemote.links);
  const remoteHosts = useStore((s) => s.a2aRemote.hosts);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const company = workspace?.company;
  // The CEO's seat while it is a pane of the workspace: replies go there.
  const ceoPaneId = workspace && company?.coordinatorPaneId && getWorkspaceLeafPanes(workspace).some((l) => l.id === company.coordinatorPaneId)
    ? company.coordinatorPaneId
    : null;
  const ceoName = ceoPaneId ? localPaneName(workspaces, { kind: 'pane', workspaceId, paneId: ceoPaneId }, paneLabel, surfaceAgent).pane : '';

  // The paired PCs and what each lets this PC ask for, as the Remote page
  // reads them; again on every link nudge. A failed read keeps the last list.
  const [list, setList] = useState<A2aSpawnOutgoingList | null>(null);
  const read = useCallback(async () => {
    const get = window.electronAPI?.a2aRemote?.spawnOutgoing;
    if (!get) return;
    const v = await get().catch(() => null);
    if (v && Array.isArray(v.requests) && Array.isArray(v.places)) setList(v);
  }, []);
  useEffect(() => {
    void read();
    return window.electronAPI?.a2aRemote?.onLinkEvent?.(() => void read());
  }, [read]);
  const askable = useMemo(() => (list?.places ?? []).filter((p) => spawnAskBlock(p) === null), [list]);
  const [hostId, setHostId] = useState('');
  const place = askable.find((p) => p.hostId === hostId) ?? askable[0];
  const targets = place?.targets;
  const [agentPick, setAgentPick] = useState('');
  const [rootPick, setRootPick] = useState('');
  // A pick that PC no longer offers falls back to its first offer, in view.
  const agent = targets?.agents.find((a) => a === agentPick) ?? targets?.agents[0] ?? '';
  const root = targets?.roots.find((r) => r.id === rootPick)?.id ?? targets?.roots[0]?.id ?? '';
  const [sub, setSub] = useState('');
  const [typedName, setTypedName] = useState<string | null>(null);
  const [hours, setHours] = useState<number>(DEFAULT_HOURS);
  const [owns, setOwns] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<A2aSpawnAskError | null>(null);
  const [now] = useState(() => Date.now());

  const pc = place ? placeName(place) : '';
  // Names a new seat may not take: pane labels, and the company's seats on
  // other PCs, started or still asked for. An expired ask counts while it is
  // listed: a late `started` still makes it a seat under its name.
  const taken = useMemo(() => {
    const out = new Set(Object.values(paneLabel).map(normalizePaneLabel));
    for (const seat of remoteSeatsOf({ workspaceId, coordinatorPaneId: ceoPaneId, links: remoteLinks, hosts: remoteHosts })) out.add(normalizePaneLabel(seat.name));
    for (const r of list?.requests ?? []) {
      if (r.label && (r.state === 'sent' || r.state === 'waiting' || r.state === 'expired')) out.add(normalizePaneLabel(r.label));
    }
    return out;
  }, [paneLabel, workspaceId, ceoPaneId, remoteLinks, remoteHosts, list]);
  const name = (typedName ?? (pc ? defaultSeatName(pc, taken) : '')).trim();
  const nameShape = name ? paneLabelShapeError(name) : null;
  const nameError = nameShape
    ? t(paneLabelRejectionKey(nameShape))
    : typedName !== null && taken.has(normalizePaneLabel(name)) ? t('company.addSeat.nameTaken') : null;
  const cleanSub = normalizeSpawnSub(sub);
  const subBad = cleanSub === null;

  const intro = workspace && ceoPaneId && place
    ? remoteSeatIntro({
      name,
      company: workspace.name,
      ...(company?.mission ? { mission: company.mission } : {}),
      owns,
      ceo: ceoName,
      ...(company?.standingOrders ? { standingOrders: company.standingOrders } : {}),
    })
    : '';
  // Send shows what the final pass would send before sending it: the text in
  // view is what goes, and a change to any field writes the message anew.
  const [reviewed, setReviewed] = useState<{ from: string; text: string } | null>(null);
  const reviewing = reviewed !== null && reviewed.from === intro;
  const text = reviewing ? reviewed.text : intro;
  const pending = useMemo(() => finalizeSpawnPrompt(text), [text]);
  const tooLong = utf8Bytes(text) > SPAWN_TEXT_MAX;
  const canSend = !!ceoPaneId && !!place && !!agent && !!root && !!name && !nameError && !subBad && !!text.trim() && !tooLong && !busy;

  // One key per exact request, reused by a retry of it: a request already
  // stored answers again instead of a second one. Any change is a new request.
  const keyRef = useRef<{ of: string; key: string } | null>(null);
  const edited = (): void => setError(null);

  const onSend = async (): Promise<void> => {
    const api = window.electronAPI?.a2aRemote;
    if (!api?.spawnAsk || !canSend || !place || !ceoPaneId || cleanSub === null) return;
    if (pending.text !== text) {
      setReviewed({ from: intro, text: pending.text });
      return;
    }
    const request = {
      hostId: place.hostId,
      agent: agent as A2aSpawnUiAsk['agent'],
      folder: { root, ...(cleanSub ? { sub: cleanSub } : {}) },
      text,
      expiresInHours: hours,
      end: { workspaceId, paneId: ceoPaneId },
      label: name,
    };
    const of = JSON.stringify(request);
    const requestKey = keyRef.current?.of === of ? keyRef.current.key : crypto.randomUUID();
    keyRef.current = { of, key: requestKey };
    const ask: A2aSpawnUiAsk = { ...request, requestKey };
    setBusy(true); setError(null);
    try {
      const r = await api.spawnAsk(ask);
      if (!r.ok) { setError(r.error); return; }
      onClose();
      useStore.getState().pushToast({
        message: r.online ? t('remoteSpawn.ask.sent', { pc }) : t('remoteSpawn.ask.sentOffline', { pc, time: spawnUntil(r.spawn.expiresAt) }),
        level: 'info',
      });
    } catch {
      setError('unavailable');
    } finally {
      setBusy(false);
    }
  };

  const openRemote = (): void => {
    onClose();
    useStore.getState().setAppRoute('remote');
  };
  // Nothing to ask: no CEO, or no paired PC lets this one start an agent.
  const blocked = !ceoPaneId || (list !== null && askable.length === 0);

  return (
    <Dialog onClose={onClose} width={640} data-testid="add-remote-seat">
      <DialogHeader
        title={t('company.addSeat.title')}
        description={ceoPaneId && workspace ? t('company.addSeat.description', { company: workspace.name, ceo: ceoName }) : undefined}
        closeLabel={t('company.close')}
      />
      <DialogBody className="flex flex-col gap-3">
        {!ceoPaneId ? (
          <p className="wmux-a2a-note" data-testid="add-remote-seat-no-ceo">{t('company.addSeat.noCeo')}</p>
        ) : blocked ? (
          <>
            {list && list.places.length === 0 ? (
              <p className="wmux-a2a-note" data-testid="add-remote-seat-no-pc">{t('company.addSeat.noPc')}</p>
            ) : (
              list?.places.map((p) => (
                <p key={p.hostId} className="wmux-a2a-note" data-testid="add-remote-seat-block" data-block={spawnAskBlock(p) ?? undefined}>
                  {t(`remoteSpawn.ask.block.${spawnAskBlock(p)}`, { pc: placeName(p) })}
                </p>
              ))
            )}
            <p className="text-[12px] text-[var(--text-sub)]">{t('company.addSeat.remotePointer')}</p>
          </>
        ) : place && targets ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('company.addSeat.pc')} layout="stacked">
                <Select value={place.hostId} disabled={busy} onChange={(e) => { setHostId(e.target.value); edited(); }} data-testid="add-remote-seat-pc">
                  {askable.map((p) => (
                    <option key={p.hostId} value={p.hostId}>
                      {t(p.online ? 'company.addSeat.pcOnline' : 'company.addSeat.pcOffline', { pc: placeName(p) })}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('remoteSpawn.ask.agent')} layout="stacked">
                <Select value={agent} disabled={busy} onChange={(e) => { setAgentPick(e.target.value); edited(); }} data-testid="add-remote-seat-agent">
                  {targets.agents.map((slug) => <option key={slug} value={slug}>{agentRow(slug)?.display ?? slug}</option>)}
                </Select>
              </Field>
              <Field label={t('remoteSpawn.ask.folder')} description={t('company.addSeat.folderHint')} layout="stacked">
                <Select value={root} disabled={busy} onChange={(e) => { setRootPick(e.target.value); edited(); }} data-testid="add-remote-seat-root">
                  {targets.roots.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </Select>
              </Field>
              <Field label={t('company.addSeat.sub')} description={t('company.optional')} layout="stacked">
                <Input
                  value={sub}
                  maxLength={SPAWN_SUB_MAX}
                  disabled={busy}
                  spellCheck={false}
                  placeholder={t('remoteSpawn.ask.subPlaceholder')}
                  aria-invalid={subBad || undefined}
                  onChange={(e) => { setSub(e.target.value); edited(); }}
                  className="w-full ui-code"
                  data-testid="add-remote-seat-sub"
                />
              </Field>
              <Field label={t('company.addSeat.name')} layout="stacked">
                <Input
                  value={typedName ?? name}
                  maxLength={PANE_METADATA_LABEL_MAX}
                  disabled={busy}
                  spellCheck={false}
                  aria-invalid={!!nameError || !name || undefined}
                  onChange={(e) => { setTypedName(e.target.value); edited(); }}
                  className="w-full"
                  data-testid="add-remote-seat-name"
                />
              </Field>
              <Field label={t('company.addSeat.wait')} layout="stacked">
                <Select value={String(hours)} disabled={busy} onChange={(e) => { setHours(Number(e.target.value)); edited(); }} data-testid="add-remote-seat-hours">
                  {SPAWN_ASK_HOURS.map((h) => <option key={h} value={h}>{t(h === 1 ? 'remoteSpawn.ask.hour' : 'remoteSpawn.ask.hours', { n: h })}</option>)}
                </Select>
              </Field>
            </div>
            {subBad && <p className="wmux-a2a-note" data-tone="danger" data-testid="add-remote-seat-sub-error">{t('remoteSpawn.ask.subBad')}</p>}
            {nameError && <p className="wmux-a2a-note" data-tone="danger" data-testid="add-remote-seat-name-error">{nameError}</p>}
            {!place.online && (
              <p className="wmux-a2a-note" data-testid="add-remote-seat-offline">
                {t('remoteSpawn.ask.offline', { pc, time: spawnUntil(now + hours * 3_600_000) })}
              </p>
            )}
            <Field label={t('company.addSeat.owns')} description={t('company.addSeat.ownsHint')} layout="stacked">
              <Input
                value={owns}
                disabled={busy}
                onChange={(e) => { setOwns(e.target.value); edited(); }}
                className="w-full"
                data-testid="add-remote-seat-owns"
              />
            </Field>
            <Field label={t('company.addSeat.firstMessage')} description={t('company.addSeat.firstMessageHint')} layout="stacked">
              <TextArea
                value={text}
                readOnly
                rows={8}
                className="w-full font-mono text-[11px] text-[var(--text-sub)]"
                data-testid="add-remote-seat-text"
              />
            </Field>
            {tooLong && <p className="wmux-a2a-note" data-tone="danger" data-testid="add-remote-seat-too-long">{t('remoteSpawn.ask.tooLong')}</p>}
            {reviewing
              ? <p className="wmux-a2a-note" data-testid="add-remote-seat-reviewing">{t('remoteSpawn.ask.reviewMasked')}</p>
              : pending.masked > 0 && <p className="wmux-a2a-note" data-testid="add-remote-seat-will-mask">{t('remoteSpawn.ask.willMask', { count: pending.masked })}</p>}
            {error && (
              <p className="wmux-a2a-note" data-tone="danger" role="alert" data-testid="add-remote-seat-error">{t(`remoteSpawn.ask.error.${error}`, { pc })}</p>
            )}
          </>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {!blocked && place && (
          <p className="mr-auto max-w-[360px] text-[11px] text-[var(--text-muted)]" data-testid="add-remote-seat-hint">{t('company.addSeat.hint', { pc })}</p>
        )}
        <UiButton variant="ghost" size="md" onClick={onClose}>{t('a2aLink.cancel')}</UiButton>
        {blocked && ceoPaneId && (
          <UiButton variant="secondary" size="md" onClick={openRemote} data-testid="add-remote-seat-open-remote">{t('company.addSeat.openRemote')}</UiButton>
        )}
        {!blocked && place && (
          <UiButton variant="primary" size="md" disabled={!canSend} onClick={() => void onSend()} data-testid="add-remote-seat-send">
            {busy ? t('remoteSpawn.ask.sending') : t('company.addSeat.send', { pc })}
          </UiButton>
        )}
      </DialogFooter>
    </Dialog>
  );
}
