// The usage-limit card: what a pane held at its provider's limit can do now,
// opened from its limit chip (and by itself once, when the active pane hits
// the limit). A popover, so the terminal never shrinks and nothing covers it
// at rest:
//   - Resume automatically when it reopens (on by default, per pane);
//   - Continue on another account, with 2+ accounts, and the opt-in "Always
//     switch automatically" (the vendor's switch-by-quota setting);
//   - Continue in another agent that is installed and signed in: a new tab
//     with the handoff typed in, not sent (utils/continueInAgent.ts), the
//     note previewed here with its length, an unsent draft carried only when
//     the owner ticks it;
//   - Continue on another PC that lets this one start an agent there: the
//     Remote page's ask dialog, opened by the chip with a note for that PC
//     (utils/continueOnPc.ts); not from a pane that was itself started for
//     someone, since its replies could not come back to it;
//   - when every account is out, the earliest time one reopens.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { getLocale } from '../../i18n';
import { updateUsageLimit } from '../../hooks/useUsageLimitBridge';
import { getAgentSetupState, refreshAgentStatus, useAgentSetup } from '../../utils/agentSetupRuns';
import { continueInAgent, continueInAgentText, handoffFacts, type HandoffFacts } from '../../utils/continueInAgent';
import { continueOnPcText, remoteHandoffHours } from '../../utils/continueOnPc';
import { spawnAskBlock } from '../Remote/RemoteSpawnAskDialog';
import { REMOTE_SPAWN_UI_ENABLED } from '../Remote/remoteSpawnFlag';
import { isShadowWorkspaceId } from '../../../shared/pcRail';
import type { A2aSpawnPlace } from '../../../shared/a2aSpawn';
import { agentRow } from '../../../shared/agentIdentity';
import { formatResetClock } from '../../../shared/usageLimit';
import { placePopover } from '../AgentToolbar/placePopover';
import { useAccountRotation } from '../Settings/AccountRotationControls';
import Popover, { PopoverSection } from '../ui/Popover';
import Switch from '../ui/Switch';
import Checkbox from '../ui/Checkbox';
import Button from '../ui/Button';
import { usageLimitStatusText, usageLimitView, everyAccountOutUntil } from './usageLimitPresentation';
import type { PaneActionItem } from './PaneActionsMenu';

export const USAGE_LIMIT_CARD_WIDTH = 300;

/** What the chip needs to open the ask dialog for a handoff to another PC. */
export interface UsageLimitPcHandoff {
  place: A2aSpawnPlace;
  pcName: string;
  text: string;
  masked: number;
  leftOut: number;
  hours: number;
}

export default function UsageLimitCard({ ptyId, workspaceId, paneId, cwd, now, accountItems, anchor, triggerRef, onClose, onContinueOnPc }: {
  ptyId: string;
  workspaceId: string;
  paneId: string;
  cwd?: string;
  now: number;
  /** One per account the conversation can move to (usePaneContinueOnAccount). */
  accountItems: PaneActionItem[];
  anchor: { top: number; left: number; right: number; bottom: number };
  triggerRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Absent: no handoff to another PC from here. */
  onContinueOnPc?: (handoff: UsageLimitPcHandoff) => void;
}) {
  const t = useT();
  const limit = useStore((s) => s.usageLimits[ptyId]);
  const rotation = useAccountRotation();
  const setup = useAgentSetup();
  const cardRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(240);
  const [facts, setFacts] = useState<HandoffFacts | null>(null);
  const [carryDraft, setCarryDraft] = useState(false);
  const canHandOff = !!limit && (setup.statuses ?? []).some((s) => s.readiness === 'ready' && s.agent !== limit.provider);
  // Main refuses a reply pane whose workspace was itself started for someone (depth 1).
  const startedFor = useStore((s) => isShadowWorkspaceId(workspaceId) || !!(s.fanoutLineage[workspaceId] || s.fanoutSpawnOwner[workspaceId] || s.missionByPaneGroup[workspaceId]));
  const [places, setPlaces] = useState<A2aSpawnPlace[]>([]);
  // Whole hours the request may wait; null once the limit has reset (the pane can simply resume).
  const pcHours = limit ? remoteHandoffHours(limit.resetsAt, now) : null;
  const pcs = pcHours !== null && onContinueOnPc && !startedFor ? places.filter((p) => spawnAskBlock(p) === null) : [];

  // Probed once; later opens reuse what that found.
  useEffect(() => { if (!getAgentSetupState().statuses) void refreshAgentStatus(); }, []);
  // The paired PCs that let this one start an agent there: read on open, and again on a click.
  const readPlaces = useCallback(async (): Promise<A2aSpawnPlace[] | null> => {
    const read = window.electronAPI?.a2aRemote?.spawnOutgoing;
    if (!REMOTE_SPAWN_UI_ENABLED || !read) return null;
    const v = await read().catch(() => null);
    return v && Array.isArray(v.places) ? v.places : null;
  }, []);
  useEffect(() => {
    if (!onContinueOnPc) return;
    let live = true;
    void readPlaces().then((v) => { if (live && v) setPlaces(v); });
    return () => { live = false; };
  }, [onContinueOnPc, readPlaces]);
  // Gathered once another agent or PC can take over, so the note previewed is the one sent.
  const canHandOffAnywhere = canHandOff || pcs.length > 0;
  useEffect(() => {
    if (!canHandOffAnywhere) return;
    let live = true;
    void handoffFacts(ptyId, cwd).then((f) => { if (live) setFacts(f); }, () => undefined);
    return () => { live = false; };
  }, [canHandOffAnywhere, ptyId, cwd]);
  // Measured after each render, so placePopover can flip it above the chip.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight;
    if (h && h !== height) setHeight(h);
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Focus elsewhere (the terminal under a card that opened by itself):
      // close, and let the Esc reach it too.
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) return;
      onClose();
    };
    // Capture on keydown: the terminal swallows keys.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, triggerRef]);

  if (!limit) return null;
  const view = usageLimitView(limit, now, getLocale());
  const vendor = limit.provider;
  const fromAgent = agentRow(vendor)?.display ?? vendor;
  const rotationOn = rotation.state?.settings[vendor] === true;
  const outUntil = everyAccountOutUntil(rotation.state?.rows ?? [], vendor, now);
  const agents = (setup.statuses ?? []).filter((s) => s.readiness === 'ready' && s.agent !== vendor);
  const pos = placePopover(anchor, { width: USAGE_LIMIT_CARD_WIDTH, height });
  const note = facts ? continueInAgentText(fromAgent, facts, { carryDraft }) : undefined;

  return createPortal(
    <Popover
      ref={cardRef}
      padded
      aria-label={t('usageLimit.cardTitle')}
      data-usage-limit-card={view.phase}
      className="fixed"
      style={{ top: pos.top, left: pos.left, width: USAGE_LIMIT_CARD_WIDTH, zIndex: 'var(--z-popover-top)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <PopoverSection title={t('usageLimit.cardTitle')}>
        <p className="text-[12px] text-[var(--text-sub)] tabular-nums" data-usage-limit-card-status>{usageLimitStatusText(view, t)}</p>
        {outUntil !== undefined && (
          <p className="text-[12px] text-[var(--text-sub)] tabular-nums" data-usage-limit-card-all-out>
            {outUntil === null ? t('usageLimit.allAccountsOutUnknown') : t('usageLimit.allAccountsOut', { clock: formatResetClock(outUntil, now, getLocale()) })}
          </p>
        )}
        {view.canArm && (
          <label className="mt-2 flex items-center gap-2 text-[13px] text-[var(--text-main)]">
            <Switch
              checked={view.armed}
              onCheckedChange={(on) => { void updateUsageLimit(ptyId, { autoResume: on }); }}
              data-usage-limit-card-action="auto-resume"
            />
            {t('usageLimit.resumeAutomatically')}
          </label>
        )}
        {view.canResumeNow && (
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => { void updateUsageLimit(ptyId, { resumeNow: true }); onClose(); }} data-usage-limit-card-action="resume">
            {t('usageLimit.resume')}
          </Button>
        )}
      </PopoverSection>
      {accountItems.length >= 2 && (
        <PopoverSection title={t('usageLimit.continueOnAccountTitle')} data-testid="usage-limit-card-accounts">
          <div className="flex flex-col gap-1">
            {accountItems.map((item) => (
              <Button
                key={item.key}
                size="sm"
                variant="ghost"
                className="justify-start"
                disabled={item.disabled}
                title={item.title}
                onClick={() => { item.onSelect(); onClose(); }}
                data-usage-limit-card-account={item.key}
              >
                {item.label}
              </Button>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
            <Checkbox
              checked={rotationOn}
              onCheckedChange={(on) => { void window.electronAPI?.accountRotation?.set(vendor, on).then(rotation.reload).catch(() => undefined); }}
              data-usage-limit-card-action="always-switch"
            />
            {t('usageLimit.alwaysSwitch')}
          </label>
        </PopoverSection>
      )}
      {agents.length > 0 && (
        <PopoverSection title={t('usageLimit.continueInAgentTitle')} data-testid="usage-limit-card-agents">
          <div className="flex flex-col gap-1">
            {agents.map((s) => {
              const name = agentRow(s.agent)?.display ?? s.agent;
              return (
                <Button
                  key={s.agent}
                  size="sm"
                  variant="ghost"
                  className="justify-start"
                  title={t('usageLimit.continueInAgentHint')}
                  onClick={() => {
                    void continueInAgent({ heldPtyId: ptyId, fromAgent, agent: s.agent, workspaceId, paneId, ...(cwd ? { cwd } : {}), ...(note ? { note } : {}) })
                      .catch((err: unknown) => { console.warn('[usageLimit] continue in agent failed', err); });
                    onClose();
                  }}
                  data-usage-limit-card-agent={s.agent}
                >
                  {t('usageLimit.continueInAgent', { agent: name })}
                </Button>
              );
            })}
          </div>
          {note !== undefined && (
            <>
              {facts?.draft && (
                <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
                  <Checkbox checked={carryDraft} onCheckedChange={setCarryDraft} data-usage-limit-card-action="carry-draft" />
                  {t('usageLimit.carryDraft')}
                </label>
              )}
              <pre
                aria-label={t('usageLimit.handoffPreview')}
                tabIndex={0}
                className="mt-2 max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--chip-radius)] bg-[var(--selection)] p-2 font-mono text-[11px] text-[var(--text-sub)]"
                data-usage-limit-card-memo
              >
                {note}
              </pre>
              <p className="mt-1 text-[11px] text-[var(--text-muted)] tabular-nums" data-usage-limit-card-memo-length>
                {t('usageLimit.handoffLength', { count: note.length })}
              </p>
            </>
          )}
        </PopoverSection>
      )}
      {pcs.length > 0 && onContinueOnPc && (
        <PopoverSection title={t('usageLimit.continueOnPcTitle')} data-testid="usage-limit-card-pcs">
          <div className="flex flex-col gap-1">
            {pcs.map((place) => {
              const pcName = place.name ?? place.hostId.slice(0, 8);
              return (
                <Button
                  key={place.hostId}
                  size="sm"
                  variant="ghost"
                  className="justify-start"
                  disabled={!facts}
                  title={t('usageLimit.continueOnPcHint', { pc: pcName })}
                  onClick={() => {
                    if (!facts) return;
                    // That PC's word may have changed since the card opened: it is asked again first.
                    void readPlaces().then((fresh) => {
                      const now2 = Date.now();
                      const current = fresh?.find((p) => p.hostId === place.hostId);
                      const hours = remoteHandoffHours(limit.resetsAt, now2);
                      if (fresh) setPlaces(fresh);
                      if (!current || spawnAskBlock(current) !== null || hours === null) {
                        useStore.getState().pushToast({ level: 'warn', message: t('usageLimit.continueOnPcGone', { pc: pcName }) });
                        return;
                      }
                      const { text, masked, leftOut } = continueOnPcText(fromAgent, facts, { carryDraft, ...(cwd ? { cwd } : {}) });
                      onContinueOnPc({ place: current, pcName: current.name ?? pcName, text, masked, leftOut, hours });
                    });
                  }}
                  data-usage-limit-card-pc={place.hostId}
                >
                  {t('usageLimit.continueOnPc', { pc: pcName })}
                </Button>
              );
            })}
          </div>
          {facts?.draft && !(agents.length > 0 && note !== undefined) && (
            <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
              <Checkbox checked={carryDraft} onCheckedChange={setCarryDraft} data-usage-limit-card-action="carry-draft" />
              {t('usageLimit.carryDraft')}
            </label>
          )}
        </PopoverSection>
      )}
    </Popover>,
    document.body,
  );
}
