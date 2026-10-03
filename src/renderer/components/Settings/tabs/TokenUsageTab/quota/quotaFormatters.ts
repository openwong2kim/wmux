import type { QuotaProviderId, QuotaWindowDelta } from '../../../../../../shared/tokenUsage/quotaTypes';
import { t as defaultT } from '../../../../../i18n';

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

export function providerDisplayName(provider: QuotaProviderId): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'agy':
      return 'Antigravity';
    default:
      return provider;
  }
}

export function formatTime(epochMs: number): string {
  if (!epochMs || epochMs <= 0) return '';
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatDeltaLine(delta?: QuotaWindowDelta | null, t: TranslateFn = defaultT as TranslateFn): string | null {
  if (!delta) return null;
  if (delta.windowReset) return t('settings.tokenUsage.windowReset');
  if (delta.deltaPct !== null) {
    const sign = delta.deltaPct > 0 ? '+' : '';
    const pct = delta.deltaPct;
    if (delta.previousCheckedAtMs > 0) {
      const time = formatTime(delta.previousCheckedAtMs);
      return t('settings.tokenUsage.deltaSince', { sign, pct, time });
    }
    return t('settings.tokenUsage.deltaOnly', { sign, pct });
  }
  return null;
}

export function formatResetsIn(resetAtMs: number | null, nowMs = Date.now(), t: TranslateFn = defaultT as TranslateFn): string | null {
  if (resetAtMs === null || resetAtMs <= 0) return null;
  const diff = resetAtMs - nowMs;
  if (diff <= 0) return t('settings.tokenUsage.resetsSoon');
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return t('settings.tokenUsage.resetsInMinutes', { m: mins });
  if (mins < 1440) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (m > 0) {
      return t('settings.tokenUsage.resetsInHoursMinutes', { h, m });
    }
    return t('settings.tokenUsage.resetsInHours', { h });
  }
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (h > 0) {
    return t('settings.tokenUsage.resetsInDaysHours', { d, h });
  }
  return t('settings.tokenUsage.resetsInDays', { d });
}

export function formatCapturedAgo(capturedAtMs: number | null, nowMs = Date.now(), t: TranslateFn = defaultT as TranslateFn): string | null {
  if (capturedAtMs === null || capturedAtMs <= 0) return null;
  const diff = Math.max(0, nowMs - capturedAtMs);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('settings.tokenUsage.capturedJustNow');
  return t('settings.tokenUsage.capturedMinutesAgo', { m: mins });
}

/** When wmux last read the provider: what makes a Refresh visible even when the numbers did not move. */
export function formatCheckedAgo(fetchedAtMs: number | null, nowMs = Date.now(), t: TranslateFn = defaultT as TranslateFn): string | null {
  if (fetchedAtMs === null || fetchedAtMs <= 0) return null;
  const mins = Math.floor(Math.max(0, nowMs - fetchedAtMs) / 60000);
  if (mins < 1) return t('settings.tokenUsage.checkedJustNow');
  return t('settings.tokenUsage.checkedMinutesAgo', { m: mins });
}

export function formatAvgTokensPerMessage(
  provider: QuotaProviderId,
  avgTokens: number | null,
  sampleSize?: number | null,
  partial?: boolean,
  t: TranslateFn = defaultT as TranslateFn,
): string | null {
  if (avgTokens !== null) {
    const hasSample = sampleSize != null && sampleSize > 0;
    if (hasSample && partial) {
      return t('settings.tokenUsage.avgTokensSampledPartial', { count: avgTokens, sampleSize: sampleSize! });
    }
    if (hasSample) {
      return t('settings.tokenUsage.avgTokensSampled', { count: avgTokens, sampleSize: sampleSize! });
    }
    if (partial) {
      return t('settings.tokenUsage.avgTokensPartial', { count: avgTokens });
    }
    return t('settings.tokenUsage.avgTokens', { count: avgTokens });
  }
  if (provider === 'agy') {
    return t('settings.tokenUsage.avgTokensNotAvailableAgy');
  }
  return null;
}

