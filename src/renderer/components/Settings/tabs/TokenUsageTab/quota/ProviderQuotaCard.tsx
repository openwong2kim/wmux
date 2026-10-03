import type {
  AgySensorStatus,
  ProviderQuotaReading,
  QuotaProviderId,
} from '../../../../../../shared/tokenUsage/quotaTypes';
import Button from '../../../../ui/Button';
import Badge from '../../../../ui/Badge';
import { useT } from '../../../../../hooks/useT';
import { formatAvgTokensPerMessage, formatCapturedAgo, formatCheckedAgo, providerDisplayName } from './quotaFormatters';
import { QuotaWindowRow } from './QuotaWindowRow';

export interface ProviderQuotaCardProps {
  provider: QuotaProviderId;
  reading?: ProviderQuotaReading;
  loading?: boolean;
  onRefresh: () => void;
  agySensorStatus?: AgySensorStatus | null;
  onInstallSensor?: () => void;
  installingSensor?: boolean;
  avgTokensPerMessage?: number | null;
  sampleSize?: number | null;
  partial?: boolean;
}

export function ProviderQuotaCard({
  provider,
  reading,
  loading = false,
  onRefresh,
  agySensorStatus,
  onInstallSensor,
  installingSensor = false,
  avgTokensPerMessage: propsAvgTokens,
  sampleSize: propsSampleSize,
  partial: propsPartial,
}: ProviderQuotaCardProps) {
  const t = useT();
  const quota = reading?.quota;
  const deltas = reading?.deltas ?? [];

  const quotaAny = quota as Record<string, unknown> | undefined;
  const avgTokens = propsAvgTokens !== undefined ? propsAvgTokens : (quota?.avgTokensPerMessage ?? null);
  const sampleSize =
    propsSampleSize !== undefined
      ? propsSampleSize
      : (typeof quotaAny?.sampleSize === 'number'
          ? quotaAny.sampleSize
          : typeof quotaAny?.avgTokensSampleSize === 'number'
            ? quotaAny.avgTokensSampleSize
            : null);
  const isPartial =
    propsPartial !== undefined
      ? propsPartial
      : Boolean(quotaAny?.partial ?? quotaAny?.avgTokensPartial);

  const avgTokensText = formatAvgTokensPerMessage(provider, avgTokens, sampleSize, isPartial, t);

  const displayName = providerDisplayName(provider);
  const planLabel = quota?.planLabel;
  const creditsLabel = quota?.creditsLabel;
  // agy (sensor) and codex (session file) readings are only as new as their source's last write.
  const capturedAgo =
    (provider === 'agy' || provider === 'codex') && quota?.capturedAtMs ? formatCapturedAgo(quota.capturedAtMs, undefined, t) : null;
  const checkedAgo = quota ? formatCheckedAgo(quota.fetchedAtMs, undefined, t) : null;

  const showInstallSensor =
    provider === 'agy' &&
    (agySensorStatus?.state === 'missing' ||
      agySensorStatus?.state === 'error' ||
      quota?.status === 'sensor-missing');

  return (
    <div
      className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-2.5"
      data-testid={`quota-card-${provider}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-semibold text-[var(--text-main)]">{displayName}</span>
          {planLabel && <Badge tone="neutral">{planLabel}</Badge>}
          {creditsLabel && (
            <span className="text-[11px] text-[var(--text-sub)] font-mono">{creditsLabel}</span>
          )}
          {capturedAgo && (
            <span className="text-[11px] text-[var(--text-muted)]">{capturedAgo}</span>
          )}
          {checkedAgo && (
            <span className="text-[11px] text-[var(--text-muted)]" data-testid={`quota-checked-${provider}`}>
              {checkedAgo}
            </span>
          )}
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          aria-label={t('settings.tokenUsage.refreshQuotaAria', { provider: displayName })}
          data-testid={`quota-refresh-${provider}`}
        >
          {loading ? t('settings.tokenUsage.refreshing') : t('settings.tokenUsage.refresh')}
        </Button>
      </div>

      {loading && !reading ? (
        <div className="text-[11px] text-[var(--text-sub)] py-2" data-testid={`quota-loading-${provider}`}>
          {t('settings.tokenUsage.loadingQuota')}
        </div>
      ) : quota && quota.status === 'ok' ? (
        <div className="flex flex-col divide-y divide-[var(--border-subtle)]">
          {quota.windows.length === 0 ? (
            <div className="text-[11px] text-[var(--text-sub)] py-1">{t('settings.tokenUsage.noQuotaWindows')}</div>
          ) : (
            quota.windows.map((w) => (
              <QuotaWindowRow
                key={w.id}
                window={w}
                delta={deltas.find((d) => d.windowId === w.id)}
              />
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 py-1">
          <div className="text-[11px] text-[var(--text-sub)]" data-testid={`quota-message-${provider}`}>
            {quota?.message ?? t('settings.tokenUsage.noQuotaData')}
          </div>

          {showInstallSensor && (
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={onInstallSensor}
                disabled={installingSensor}
                data-testid="agy-install-sensor"
              >
                {installingSensor ? t('settings.tokenUsage.installing') : t('settings.tokenUsage.installSensor')}
              </Button>
            </div>
          )}
        </div>
      )}

      {!(loading && !reading) && avgTokensText && (
        <div
          className="text-[11px] text-[var(--text-sub)] pt-1 border-t border-[var(--border-subtle)]"
          data-testid={`quota-avg-tokens-${provider}`}
        >
          {avgTokensText}
        </div>
      )}
    </div>
  );
}
