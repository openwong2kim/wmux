import { useCallback, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { finalizeSpawnPrompt } from '../../../shared/a2aSpawnPrompt';
import { normalizeSpawnSub, SPAWN_SUB_MAX, SPAWN_TEXT_MAX, type A2aSpawnAskError, type A2aSpawnPlace, type A2aSpawnUiAsk } from '../../../shared/a2aSpawn';
import { agentRow } from '../../../shared/agentIdentity';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { isShadowWorkspaceId } from '../../../shared/pcRail';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { buildPaneSnapshot } from '../../hooks/useA2aRemoteSnapshot';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import UiButton from '../ui/Button';
import Field from '../ui/Field';
import Input from '../ui/Input';
import Select from '../ui/Select';

// ─── "Start an agent…" on another PC ─────────────────────────────────────────
//
// This PC asks a paired PC to start one of the agents it allowed, in one of
// the folders it listed, with a first prompt. Replies come back to the pane
// focused here. That PC may be off: the request waits for it until it expires.
// The view is pure (props only); the default export reads the store and asks.

type T = (key: string, vars?: Record<string, string | number>) => string;

/** How long a request may wait for that PC, in hours. */
export const SPAWN_ASK_HOURS = [1, 4, 24, 72] as const;
const DEFAULT_HOURS = 24;

/** Why this PC cannot ask that PC for anything (null: it can). */
export type SpawnAskBlock = 'unsupported' | 'no-targets' | 'nothing';

export function spawnAskBlock(place: A2aSpawnPlace): SpawnAskBlock | null {
  if (!place.supported) return 'unsupported';
  if (!place.targets) return 'no-targets';
  if (place.targets.roots.length === 0 || place.targets.agents.length === 0) return 'nothing';
  return null;
}

/** A local date and time: a request may wait up to three days. */
export function spawnUntil(at: string | number): string {
  return new Date(at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export interface RemoteSpawnAskDialogViewProps {
  pcName: string;
  place: A2aSpawnPlace;
  /**
   * The pane here that gets the replies. null: no pane is focused, or
   * (`startedFor`) the focused one's workspace was itself started for
   * someone (a fan-out task, or by another PC), which does not ask again.
   */
  end: { workspaceId: string; paneId: string; name: string } | null;
  startedFor?: boolean;
  agent: string;
  root: string;
  sub: string;
  text: string;
  hours: number;
  onAgent: (v: string) => void;
  onRoot: (v: string) => void;
  onSub: (v: string) => void;
  onText: (v: string) => void;
  onHours: (v: number) => void;
  busy: boolean;
  error: A2aSpawnAskError | null;
  now: number;
  onSend: () => void;
  onClose: () => void;
  t: T;
  /** A usage-limit handoff: the note leaves this PC; what was masked in it and which paths were left out. */
  handoff?: { masked: number; leftOut: number };
  /** Values finalizeSpawnPrompt would still mask in `text`: Send shows the result first. */
  pendingMasked?: number;
  /** Send replaced the text with what would be sent: the person reviews it, then sends. */
  reviewing?: boolean;
  /** The longest wait offered (a handoff: until the limit resets). */
  maxHours?: number;
}

export function RemoteSpawnAskDialogView(p: RemoteSpawnAskDialogViewProps) {
  const { t, place } = p;
  const pc = p.pcName;
  const block = spawnAskBlock(place);
  const targets = place.targets;
  const subBad = normalizeSpawnSub(p.sub) === null;
  const textBytes = utf8Bytes(p.text);
  const textBad = textBytes > SPAWN_TEXT_MAX;
  // A pick that PC no longer offers (its list changed while this was open) is not sent.
  const picked = !!targets && targets.agents.some((a) => a === p.agent) && targets.roots.some((r) => r.id === p.root);
  const canSend = block === null && !!p.end && picked && !subBad && !!p.text.trim() && !textBad && !p.busy;
  const offered = SPAWN_ASK_HOURS.filter((h) => p.maxHours === undefined || h <= p.maxHours);
  const hourOptions = offered.includes(p.hours as (typeof SPAWN_ASK_HOURS)[number]) ? offered : [...offered, p.hours].sort((a, b) => a - b);
  return (
    <Dialog onClose={p.onClose} width={520} data-testid="remote-spawn-ask">
      <DialogHeader
        title={t('remoteSpawn.ask.title', { pc })}
        description={block ? undefined : t('remoteSpawn.ask.description', { pc })}
        closeLabel={t('a2aLink.close')}
      />
      <DialogBody className="flex flex-col gap-3">
        {block || !targets ? (
          <p className="wmux-a2a-note" data-testid="remote-spawn-ask-block" data-block={block}>{t(`remoteSpawn.ask.block.${block}`, { pc })}</p>
        ) : (
          <>
            {p.handoff && (
              <p className="wmux-a2a-note" data-testid="remote-spawn-ask-handoff">
                {t('remoteSpawn.ask.handoffLeaves', { pc })}
                {(p.handoff.masked > 0 || p.handoff.leftOut > 0) && <> {t('remoteSpawn.ask.handoffMasked', { masked: p.handoff.masked, leftOut: p.handoff.leftOut })}</>}
              </p>
            )}
            {!place.online && (
              <p className="wmux-a2a-note" data-testid="remote-spawn-ask-offline">
                {t('remoteSpawn.ask.offline', { pc, time: spawnUntil(p.now + p.hours * 3_600_000) })}
              </p>
            )}
            <Field label={t('remoteSpawn.ask.agent')} layout="stacked">
              <Select value={p.agent} disabled={p.busy} onChange={(e) => p.onAgent(e.target.value)} data-testid="remote-spawn-ask-agent">
                {targets.agents.map((slug) => <option key={slug} value={slug}>{agentRow(slug)?.display ?? slug}</option>)}
              </Select>
            </Field>
            <Field label={t('remoteSpawn.ask.folder')} layout="stacked">
              <Select value={p.root} disabled={p.busy} onChange={(e) => p.onRoot(e.target.value)} data-testid="remote-spawn-ask-root">
                {targets.roots.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </Select>
            </Field>
            <Field label={t('remoteSpawn.ask.sub')} description={t('remoteSpawn.ask.subHint')} layout="stacked">
              <Input
                value={p.sub}
                maxLength={SPAWN_SUB_MAX}
                disabled={p.busy}
                spellCheck={false}
                placeholder={t('remoteSpawn.ask.subPlaceholder')}
                aria-invalid={subBad || undefined}
                onChange={(e) => p.onSub(e.target.value)}
                className="w-full ui-code"
                data-testid="remote-spawn-ask-sub"
              />
            </Field>
            {subBad && <p className="wmux-a2a-note" data-tone="danger" data-testid="remote-spawn-ask-sub-error">{t('remoteSpawn.ask.subBad')}</p>}
            <Field label={t('remoteSpawn.ask.prompt')} layout="stacked">
              <textarea
                value={p.text}
                rows={5}
                disabled={p.busy}
                onChange={(e) => p.onText(e.target.value)}
                className="ui-input resize-y w-full"
                data-testid="remote-spawn-ask-text"
              />
            </Field>
            {textBad && <p className="wmux-a2a-note" data-tone="danger" data-testid="remote-spawn-ask-text-error">{t('remoteSpawn.ask.tooLong')}</p>}
            {p.reviewing
              ? <p className="wmux-a2a-note" data-testid="remote-spawn-ask-reviewing">{t('remoteSpawn.ask.reviewMasked')}</p>
              : !!p.pendingMasked && <p className="wmux-a2a-note" data-testid="remote-spawn-ask-will-mask">{t('remoteSpawn.ask.willMask', { count: p.pendingMasked })}</p>}
            <Field label={t('remoteSpawn.ask.repliesTo')} layout="stacked">
              {p.end
                ? <span className="text-[13px]" data-testid="remote-spawn-ask-end">{p.end.name}</span>
                : <span className="wmux-a2a-note" data-testid="remote-spawn-ask-no-pane">{t(p.startedFor ? 'remoteSpawn.ask.paneStartedFor' : 'remoteSpawn.ask.noPane')}</span>}
            </Field>
            <Field label={t('remoteSpawn.ask.expires')} layout="stacked">
              <Select value={String(p.hours)} disabled={p.busy} onChange={(e) => p.onHours(Number(e.target.value))} data-testid="remote-spawn-ask-hours">
                {hourOptions.map((h) => <option key={h} value={h}>{t(h === 1 ? 'remoteSpawn.ask.hour' : 'remoteSpawn.ask.hours', { n: h })}</option>)}
              </Select>
            </Field>
            {p.error && (
              <p className="wmux-a2a-note" data-tone="danger" role="alert" data-testid="remote-spawn-ask-error">{t(`remoteSpawn.ask.error.${p.error}`, { pc })}</p>
            )}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <UiButton variant="ghost" size="md" onClick={p.onClose}>{t('a2aLink.cancel')}</UiButton>
        {block === null && (
          <UiButton variant="primary" size="md" disabled={!canSend} onClick={p.onSend} data-testid="remote-spawn-ask-send">
            {p.busy ? t('remoteSpawn.ask.sending') : t('remoteSpawn.ask.send')}
          </UiButton>
        )}
      </DialogFooter>
    </Dialog>
  );
}

export interface RemoteSpawnAskDialogProps {
  place: A2aSpawnPlace;
  /** This PC's name for that PC. */
  pcName: string;
  onClose: () => void;
  /**
   * A usage-limit handoff (utils/continueOnPc.ts): the note as the first
   * prompt, the held pane as the reply pane, and how long it may wait.
   */
  handoff?: {
    text: string;
    masked: number;
    leftOut: number;
    hours: number;
    end: { workspaceId: string; paneId: string; name: string };
  };
}

/**
 * The focused pane of the active workspace, when it is one of this PC's own
 * and its workspace was not itself started for someone (main refuses those too).
 */
function useReplyPane(): { end: RemoteSpawnAskDialogViewProps['end']; startedFor: boolean } {
  // Flat values: useShallow compares one level deep.
  const pane = useStore(useShallow((s) => {
    const none = { workspaceId: '', paneId: '', name: '', startedFor: false };
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    if (!ws || isShadowWorkspaceId(ws.id) || !ws.activePaneId) return none;
    if (s.fanoutLineage[ws.id] || s.fanoutSpawnOwner[ws.id] || s.missionByPaneGroup[ws.id]) return { ...none, startedFor: true };
    if (!getWorkspaceLeafPanes(ws).some((l) => l.id === ws.activePaneId)) return none;
    const snap = buildPaneSnapshot({ workspaces: [ws], surfaceAgent: s.surfaceAgent, paneLabel: s.paneLabel }).workspaces[0].panes.find((x) => x.paneId === ws.activePaneId);
    return { workspaceId: ws.id, paneId: ws.activePaneId, name: `${ws.name} / ${snap?.label ?? ws.activePaneId}`, startedFor: false };
  }));
  const { workspaceId, paneId, name, startedFor } = pane;
  const end = useMemo(() => (paneId ? { workspaceId, paneId, name } : null), [workspaceId, paneId, name]);
  return { end, startedFor };
}

export default function RemoteSpawnAskDialog({ place, pcName, onClose, handoff }: RemoteSpawnAskDialogProps) {
  const t = useT();
  const focused = useReplyPane();
  // A handoff's replies go to the held pane, judged like the focused one is
  // (main refuses a pane whose workspace was itself started for someone).
  const heldStartedFor = useStore((s) => {
    const id = handoff?.end.workspaceId;
    return !!id && (isShadowWorkspaceId(id) || !!(s.fanoutLineage[id] || s.fanoutSpawnOwner[id] || s.missionByPaneGroup[id]));
  });
  const end = handoff ? (heldStartedFor ? null : handoff.end) : focused.end;
  const startedFor = handoff ? heldStartedFor : focused.startedFor;
  // One per exact request, reused by a retry of it: a request already stored
  // answers again instead of a second one. Any edit makes it a new request.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const edited = (): void => { setError(null); setRequestKey(crypto.randomUUID()); };
  const [reviewing, setReviewing] = useState(false);
  const [agent, setAgent] = useState<string>(() => place.targets?.agents[0] ?? '');
  const [root, setRoot] = useState<string>(() => place.targets?.roots[0]?.id ?? '');
  const [sub, setSub] = useState('');
  const [text, setText] = useState(() => handoff?.text ?? '');
  const [hours, setHours] = useState<number>(() => handoff?.hours ?? DEFAULT_HOURS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<A2aSpawnAskError | null>(null);
  const [now] = useState(() => Date.now());
  // What Send would send: shown before it goes (main refuses anything else).
  const pending = useMemo(() => finalizeSpawnPrompt(text), [text]);

  const onSend = useCallback(async () => {
    const api = window.electronAPI?.a2aRemote;
    const cleanSub = normalizeSpawnSub(sub);
    if (!api?.spawnAsk || !end || cleanSub === null) return;
    if (pending.text !== text) {
      setText(pending.text);
      setReviewing(true);
      return;
    }
    const ask: A2aSpawnUiAsk = {
      hostId: place.hostId,
      agent: agent as A2aSpawnUiAsk['agent'],
      folder: { root, ...(cleanSub ? { sub: cleanSub } : {}) },
      text,
      expiresInHours: hours,
      end: { workspaceId: end.workspaceId, paneId: end.paneId },
      requestKey,
    };
    setBusy(true); setError(null);
    try {
      const r = await api.spawnAsk(ask);
      if (!r.ok) { setError(r.error); return; }
      onClose();
      useStore.getState().pushToast({
        message: r.online
          ? t('remoteSpawn.ask.sent', { pc: pcName })
          : t('remoteSpawn.ask.sentOffline', { pc: pcName, time: spawnUntil(r.spawn.expiresAt) }),
        level: 'info',
      });
    } catch {
      setError('unavailable');
    } finally {
      setBusy(false);
    }
  }, [place.hostId, agent, root, sub, text, pending, hours, end, requestKey, pcName, onClose, t]);

  return (
    <RemoteSpawnAskDialogView
      pcName={pcName}
      place={place}
      end={end}
      startedFor={startedFor}
      agent={agent}
      root={root}
      sub={sub}
      text={text}
      hours={hours}
      onAgent={(v) => { setAgent(v); edited(); }}
      onRoot={(v) => { setRoot(v); edited(); }}
      onSub={(v) => { setSub(v); edited(); }}
      onText={(v) => { setText(v); edited(); setReviewing(false); }}
      onHours={(v) => { setHours(v); edited(); }}
      busy={busy}
      error={error}
      now={now}
      onSend={() => void onSend()}
      onClose={onClose}
      t={t}
      pendingMasked={pending.masked}
      reviewing={reviewing}
      {...(handoff ? { handoff: { masked: handoff.masked, leftOut: handoff.leftOut }, maxHours: handoff.hours } : {})}
    />
  );
}
