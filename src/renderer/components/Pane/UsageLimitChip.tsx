// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/ui/UsageLimitNotice.tsx), MIT License, Copyright (c) 2026 Nick
//
// Pane-header chip for a pane held at its provider's usage limit. Lives in the
// tab strip's flow (no new row, so the terminal never shrinks): clock glyph +
// "Limit" + "resets 3:16 PM · 2h 4m", a Resume-at-reset toggle, Resume once the
// reset passed, and a dismiss ×. Compact (narrow pane) = glyph + countdown.
// Muted at rest; only the armed "Resuming at reset" label is warm, because it
// means the system will act on its own.
import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { getLocale } from '../../i18n';
import { updateUsageLimit } from '../../hooks/useUsageLimitBridge';
import { IconClock, IconX } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { usageLimitStatusText, usageLimitView } from './usageLimitPresentation';

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

export default function UsageLimitChip({ ptyId, compact }: { ptyId: string | undefined; compact: boolean }) {
  const t = useT();
  const limit = useStore((s) => (ptyId ? s.usageLimits[ptyId] : undefined));
  const now = useUsageLimitNow(!!limit);
  if (!limit || !ptyId) return null;

  const view = usageLimitView(limit, now, getLocale());
  const status = usageLimitStatusText(view, t);
  const title = [t('usageLimit.title'), status, limit.message].filter(Boolean).join('\n');

  return (
    <span
      data-pane-usage-limit={view.phase}
      data-usage-limit-armed={view.armed || undefined}
      className="shrink min-w-0 overflow-hidden flex items-center gap-0.5 text-[11px] text-[var(--text-muted)] select-none"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="flex items-center gap-1 min-w-0 px-1" title={title} aria-label={title} role="img">
        <span className="shrink-0 flex" aria-hidden="true"><IconClock size={12} /></span>
        {compact ? (
          <span className="shrink-0 tabular-nums" aria-hidden="true">{view.duration ?? t('usageLimit.label')}</span>
        ) : (
          <>
            <span className="shrink-0 text-[var(--text-sub)]" aria-hidden="true">{t('usageLimit.label')}</span>
            <span className="truncate tabular-nums" aria-hidden="true">{status}</span>
          </>
        )}
      </span>
      {!compact && view.canArm && (
        <button
          type="button"
          className={TEXT_BTN}
          aria-pressed={view.armed}
          style={view.armed ? { color: 'var(--accent)' } : undefined}
          title={view.armed ? t('usageLimit.cancelResumeTitle') : t('usageLimit.resumeAtResetTitle')}
          onClick={() => { void updateUsageLimit(ptyId, { autoResume: !view.armed }); }}
          data-usage-limit-action="arm"
        >
          {view.armed ? t('usageLimit.resumingAtReset') : t('usageLimit.resumeAtReset')}
        </button>
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
