// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/ui/UsageLimitNotice.tsx), MIT License, Copyright (c) 2026 Nick
//
// Pane-header chip for a pane held at its provider's usage limit. Lives in the
// tab strip's flow (no new row, so the terminal never shrinks): clock glyph +
// "Limit" + "resets 3:16 PM · 2h 4m" as the button that opens the usage-limit
// card (UsageLimitCard: resume automatically, another account, another
// agent), Resume once the reset passed, and a dismiss ×. Compact (narrow
// pane) = glyph + countdown. Muted at rest; only the armed state is warm,
// because it means the system will act on its own. The card opens by itself
// once per limit when the pane is the one in front, for a limit hit since the
// app started (a restart does not reopen it).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { getLocale } from '../../i18n';
import { updateUsageLimit } from '../../hooks/useUsageLimitBridge';
import { IconClock, IconX } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { usageLimitStatusText, usageLimitView } from './usageLimitPresentation';
import { usePaneContinueOnAccount } from './usePaneContinueOnAccount';
import UsageLimitCard, { type UsageLimitPcHandoff } from './UsageLimitCard';
import RemoteSpawnAskDialog from '../Remote/RemoteSpawnAskDialog';

/** Re-render every 30s while `active`, so countdowns stay current. */
export function useUsageLimitNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

const TEXT_BTN = `ui-icon-btn ${FOCUS_RING} h-6 px-1.5 shrink-0 text-[11px] leading-none whitespace-nowrap`;

/** Limits whose card already opened by itself (`ptyId:detectedAt`). */
const autoOpened = new Set<string>();
/** A limit detected before this renderer started does not open its card by
 *  itself: an earlier run already did, or it was hit while wmux was closed. */
const STARTED_AT = Date.now();

export default function UsageLimitChip({ ptyId, compact, readOnly = false, workspaceId, paneId, cwd }: {
  ptyId: string | undefined;
  compact: boolean;
  readOnly?: boolean;
  workspaceId?: string;
  /** The pane the chip is in: "Continue in another agent" opens its tab here. */
  paneId?: string;
  cwd?: string;
}) {
  const t = useT();
  const limit = useStore((s) => (ptyId ? s.usageLimits[ptyId] : undefined));
  const now = useUsageLimitNow(!!limit);
  // Another Claude account can take the conversation over while this one waits.
  const continueAccount = usePaneContinueOnAccount({ ptyId, allowed: !!limit && !readOnly, workspaceId });
  const reloadContinueAccount = continueAccount.reload;
  useEffect(() => { reloadContinueAccount(); }, [reloadContinueAccount]);
  const cardBtnRef = useRef<HTMLButtonElement>(null);
  const [cardAnchor, setCardAnchor] = useState<{ top: number; left: number; right: number; bottom: number } | null>(null);
  const canOpenCard = !readOnly && !!workspaceId && !!paneId;
  // "Continue on another PC": the ask dialog outlives the card that opened it.
  const [pcHandoff, setPcHandoff] = useState<UsageLimitPcHandoff | null>(null);
  const workspaceName = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? '');
  const onContinueOnPc = useCallback((h: UsageLimitPcHandoff) => { setCardAnchor(null); setPcHandoff(h); }, []);
  const inFront = useStore((s) => !!paneId && s.activeWorkspaceId === workspaceId
    && s.workspaces.find((w) => w.id === workspaceId)?.activePaneId === paneId);
  const limitKey = limit && ptyId && limit.detectedAt >= STARTED_AT ? `${ptyId}:${limit.detectedAt}` : null;
  useEffect(() => {
    if (!limitKey || !canOpenCard || !inFront || autoOpened.has(limitKey) || !cardBtnRef.current) return;
    autoOpened.add(limitKey);
    setCardAnchor(cardBtnRef.current.getBoundingClientRect());
  }, [limitKey, canOpenCard, inFront]);
  if (!limit || !ptyId) return null;

  const view = usageLimitView(limit, now, getLocale());
  const status = usageLimitStatusText(view, t);
  const title = [t('usageLimit.title'), status, limit.message].filter(Boolean).join('\n');
  const label = (
    <>
      <span className="shrink-0 flex" aria-hidden="true" style={view.armed ? { color: 'var(--accent)' } : undefined}><IconClock size={12} /></span>
      {compact ? (
        <span className="shrink-0 tabular-nums" aria-hidden="true">{view.duration ?? t('usageLimit.label')}</span>
      ) : (
        <>
          <span className="shrink-0 text-[var(--text-sub)]" aria-hidden="true">{t('usageLimit.label')}</span>
          <span className="truncate tabular-nums" aria-hidden="true">{status}</span>
        </>
      )}
    </>
  );

  return (
    <span
      data-pane-usage-limit={view.phase}
      data-usage-limit-armed={view.armed || undefined}
      className="shrink min-w-0 overflow-hidden flex items-center gap-0.5 text-[11px] text-[var(--text-muted)] select-none"
      onClick={(e) => e.stopPropagation()}
    >
      {canOpenCard ? (
        <button
          ref={cardBtnRef}
          type="button"
          className={`${FOCUS_RING} flex items-center gap-1 min-w-0 px-1 h-6 rounded-[var(--chip-radius)] hover:bg-[var(--selection-hover)] hover:[--text-muted:var(--text-subtle)]`}
          title={title}
          aria-label={`${t('usageLimit.openCard')}: ${title}`}
          aria-haspopup="dialog"
          aria-expanded={!!cardAnchor}
          onClick={(e) => {
            if (cardAnchor) { setCardAnchor(null); return; }
            setCardAnchor(e.currentTarget.getBoundingClientRect());
          }}
          data-usage-limit-action="card"
        >
          {label}
        </button>
      ) : (
        <span className="flex items-center gap-1 min-w-0 px-1" title={title} aria-label={title} role="img">{label}</span>
      )}
      {!compact && view.canResumeNow && (
        <button
          type="button"
          className={TEXT_BTN}
          title={t('usageLimit.resumeTitle')}
          onClick={() => { void updateUsageLimit(ptyId, { resumeNow: true }); }}
          data-usage-limit-action="resume"
        >
          {t('usageLimit.resume')}
        </button>
      )}
      {cardAnchor && canOpenCard && (
        <UsageLimitCard
          ptyId={ptyId}
          workspaceId={workspaceId}
          paneId={paneId}
          {...(cwd ? { cwd } : {})}
          now={now}
          accountItems={continueAccount.enabled ? continueAccount.subItems : []}
          anchor={cardAnchor}
          triggerRef={cardBtnRef}
          onClose={() => setCardAnchor(null)}
          onContinueOnPc={onContinueOnPc}
        />
      )}
      {pcHandoff && workspaceId && paneId && (
        <RemoteSpawnAskDialog
          place={pcHandoff.place}
          pcName={pcHandoff.pcName}
          onClose={() => setPcHandoff(null)}
          handoff={{ text: pcHandoff.text, masked: pcHandoff.masked, leftOut: pcHandoff.leftOut, hours: pcHandoff.hours, end: { workspaceId, paneId, name: workspaceName } }}
        />
      )}
      {!compact && (
        <button
          type="button"
          className={`ui-icon-btn ${FOCUS_RING} w-6 h-6 shrink-0`}
          title={t('usageLimit.dismiss')}
          aria-label={t('usageLimit.dismiss')}
          onClick={() => updateUsageLimit(ptyId, { dismiss: true })}
          data-usage-limit-action="dismiss"
        >
          <IconX size={10} />
        </button>
      )}
    </span>
  );
}
