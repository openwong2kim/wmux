// StatusBar mini widget for Anthropic 5h/7d usage utilization.
//
// Rendered to the right of the per-pane token display. Hidden entirely
// when the Settings toggle is off (status === 'idle'). Color tiers match
// the threshold conventions established in the Settings card:
//   < 70%  → neutral (text-muted)
//   70–89% → warning (accent-yellow)
//   ≥ 90%  → danger  (accent-red)
//
// The component itself is presentational — pure (props in / JSX out).
// `StatusBar.tsx` reads `uiSlice.anthropicUsage` and passes it down so
// vitest's `renderToStaticMarkup` can drive snapshots without a real
// store. Helpers (`tierColorClass`, `formatResetCountdown`) are exported
// so they can be unit-tested independently.

import type { ReactElement } from 'react';
import { useT } from '../../hooks/useT';

export type UsageStatus =
  | 'idle'
  | 'ok'
  | 'token-missing'
  | 'unauthorized'
  | 'http-error'
  | 'network-error'
  | 'read-error';

export interface UsageWidgetProps {
  status: UsageStatus;
  snapshot: {
    sessionPct: number;
    sessionResetEpochSec: number;
    weeklyPct: number;
    weeklyResetEpochSec: number;
    fetchedAtMs: number;
  } | null;
  lastError: string | null;
  subscriptionType: string | null;
  /** Provides current clock for relative-time math. Pulled from a parent
   *  `useState`/`setInterval` cursor so the widget refreshes its
   *  countdowns without forcing parent rerenders on every clock tick. */
  nowMs: number;
}

/** Pure tier mapping. Exported for unit tests. */
export function tierColorClass(pct: number): string {
  if (pct >= 90) return 'text-[var(--accent-red)]';
  if (pct >= 70) return 'text-[var(--accent-yellow)]';
  return 'text-[var(--text-sub2)]';
}

/** Format a Unix epoch (seconds) as a coarse "Xh Ym" countdown. Used
 *  for the tooltip's reset display. Negative or zero → empty string
 *  (caller decides how to render "unknown"). Exported for unit tests. */
export function formatResetCountdown(epochSec: number, nowMs: number): string {
  if (!epochSec || epochSec <= 0) return '';
  const remainingSec = epochSec - Math.floor(nowMs / 1000);
  if (remainingSec <= 0) return '';
  const days = Math.floor(remainingSec / 86_400);
  const hours = Math.floor((remainingSec % 86_400) / 3_600);
  const minutes = Math.floor((remainingSec % 3_600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/** Format the last-fetched timestamp as a coarse "Xm ago". */
export function formatFetchedAgo(fetchedAtMs: number, nowMs: number): string {
  if (!fetchedAtMs) return '';
  const ageMs = Math.max(0, nowMs - fetchedAtMs);
  const ageMin = Math.floor(ageMs / 60_000);
  if (ageMin <= 0) return 'just now';
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageHr = Math.floor(ageMin / 60);
  if (ageHr < 24) return `${ageHr}h ago`;
  const ageDay = Math.floor(ageHr / 24);
  return `${ageDay}d ago`;
}

/**
 * Presentational StatusBar widget. Renders nothing when status === 'idle'.
 *
 * Error states get a colored dot prefix instead of percentages so a
 * stale widget can't masquerade as a live one — `5h 23% · 7d 8%`
 * pretending to be fresh during an outage was the failure mode we want
 * to avoid.
 */
export function UsageWidgetView(props: UsageWidgetProps): ReactElement | null {
  const { status, snapshot, lastError, subscriptionType, nowMs } = props;
  if (status === 'idle') return null;

  // ─── Error states ──────────────────────────────────────────────────────
  if (status !== 'ok' || !snapshot) {
    // TS doesn't narrow through the disjunction (status !== 'ok' could
    // still type-include 'ok' if snapshot is null). Explicit cast to
    // the error-only subset since 'idle' was filtered above and 'ok'
    // never reaches this branch via the runtime check.
    return (
      <ErrorChip
        status={status as Exclude<UsageStatus, 'idle' | 'ok'>}
        lastError={lastError}
      />
    );
  }

  // ─── OK state — main display ───────────────────────────────────────────
  const { sessionPct, sessionResetEpochSec, weeklyPct, weeklyResetEpochSec, fetchedAtMs } =
    snapshot;
  const sessionColor = tierColorClass(sessionPct);
  const weeklyColor = tierColorClass(weeklyPct);
  const tooltip = buildOkTooltip({
    sessionPct,
    sessionResetEpochSec,
    weeklyPct,
    weeklyResetEpochSec,
    fetchedAtMs,
    subscriptionType,
    nowMs,
  });
  return (
    <span title={tooltip} data-testid="usage-widget-ok">
      <span className={sessionColor}>5h {sessionPct}%</span>
      <span className="text-[var(--text-muted)]"> {'·'} </span>
      <span className={weeklyColor}>7d {weeklyPct}%</span>
    </span>
  );
}

function ErrorChip({
  status,
  lastError,
}: {
  status: Exclude<UsageStatus, 'idle' | 'ok'>;
  lastError: string | null;
}) {
  const t = useT();
  // We pull the human-readable label and tooltip body from i18n so the
  // chip is localizable. The dot color is fixed because semantic meaning
  // ("something broken, click for detail") is what we want to convey.
  const labelKey = `claudeIntegration.usage.status.${status}` as const;
  const tooltipParts = [t(labelKey)];
  if (lastError) tooltipParts.push(lastError);
  return (
    <span
      title={tooltipParts.join(' — ')}
      className="text-[var(--accent-red)] font-mono"
      data-testid={`usage-widget-${status}`}
    >
      {'●'} {t(labelKey)}
    </span>
  );
}

function buildOkTooltip(args: {
  sessionPct: number;
  sessionResetEpochSec: number;
  weeklyPct: number;
  weeklyResetEpochSec: number;
  fetchedAtMs: number;
  subscriptionType: string | null;
  nowMs: number;
}): string {
  const session = formatResetCountdown(args.sessionResetEpochSec, args.nowMs);
  const weekly = formatResetCountdown(args.weeklyResetEpochSec, args.nowMs);
  const fetched = formatFetchedAgo(args.fetchedAtMs, args.nowMs);
  const lines = [
    `5h: ${args.sessionPct}%${session ? ` (reset ${session})` : ''}`,
    `7d: ${args.weeklyPct}%${weekly ? ` (reset ${weekly})` : ''}`,
  ];
  if (args.subscriptionType) lines.push(`Plan: ${args.subscriptionType}`);
  if (fetched) lines.push(`Fetched: ${fetched}`);
  return lines.join(' · ');
}
