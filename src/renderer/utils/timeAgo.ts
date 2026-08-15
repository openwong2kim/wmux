/**
 * Relative time formatter for notification timestamps.
 *
 * Branches:
 *   - diff < 60_000ms          → "just now"
 *   - diff < 3_600_000ms       → "{n}m ago"
 *   - diff < 86_400_000ms      → "{n}h ago"
 *   - diff < 7 * 86_400_000ms  → "{n}d ago"
 *   - otherwise                → local date string (toLocaleDateString)
 *
 * A negative diff (future timestamp from clock skew) collapses to "just now"
 * so we never render "0m ago" or a negative count.
 *
 * @param timestamp Epoch ms of the event.
 * @param now       Epoch ms representing "now" (injectable for tests). Defaults to Date.now().
 */
import { t } from '../i18n';

export function timeAgo(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp;

  if (diff < 60_000) return t('timeAgo.justNow');
  if (diff < 3_600_000) return t('timeAgo.minutes', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('timeAgo.hours', { n: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t('timeAgo.days', { n: Math.floor(diff / 86_400_000) });

  return new Date(timestamp).toLocaleDateString();
}
