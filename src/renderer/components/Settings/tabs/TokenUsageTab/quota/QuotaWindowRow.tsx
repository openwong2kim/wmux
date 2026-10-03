import type { QuotaWindow, QuotaWindowDelta } from '../../../../../../shared/tokenUsage/quotaTypes';
import { useT } from '../../../../../hooks/useT';
import { formatDeltaLine, formatResetsIn } from './quotaFormatters';

export interface QuotaWindowRowProps {
  window: QuotaWindow;
  delta?: QuotaWindowDelta | null;
  nowMs?: number;
}

export function QuotaWindowRow({ window, delta, nowMs }: QuotaWindowRowProps) {
  const t = useT();
  const usedPct = window.usedPct;
  const pctClamped = usedPct != null ? Math.min(100, Math.max(0, usedPct)) : 0;

  const barColor =
    usedPct != null && usedPct >= 90
      ? 'bg-[var(--accent-red)]'
      : usedPct != null && usedPct >= 70
        ? 'bg-[var(--accent)]'
        : 'bg-[var(--text-sub)]';

  const resetsIn = formatResetsIn(window.resetAtMs, nowMs, t);
  const deltaText = formatDeltaLine(delta, t);

  return (
    <div className="flex flex-col gap-1 py-1.5" data-testid={`quota-window-${window.id}`}>
      <div className="flex items-center justify-between text-[13px]">
        <span className="font-medium text-[var(--text-main)]">{window.label}</span>
        <span className="font-mono text-[12px] text-[var(--text-main)]">
          {usedPct != null ? `${usedPct}%` : '—'}
        </span>
      </div>

      <div
        className="w-full h-1.5 rounded-full bg-[var(--bg-surface)] overflow-hidden border border-[var(--border-subtle)]"
        role="progressbar"
        aria-valuenow={usedPct ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('settings.tokenUsage.quotaUtilizationAria', { label: window.label })}
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${pctClamped}%` }}
        />
      </div>

      <div className="flex items-baseline justify-between text-[11px] text-[var(--text-sub)]">
        <span>{deltaText ?? ''}</span>
        <span>{resetsIn ?? ''}</span>
      </div>
    </div>
  );
}
