import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  QUOTA_PROVIDERS,
  type AgySensorStatus,
  type ProviderQuotaReading,
  type QuotaProviderId,
} from '../../../../../shared/tokenUsage/quotaTypes';
import { SettingNote, SettingsSection } from '../../SettingsLayout';
import Button from '../../../ui/Button';
import { useT } from '../../../../hooks/useT';
import { ProviderQuotaCard } from './quota/ProviderQuotaCard';

import type { ReactElement } from 'react';

function failedReading(provider: QuotaProviderId, message: string): ProviderQuotaReading {
  return {
    quota: {
      provider,
      status: 'error',
      windows: [],
      planLabel: null,
      creditsLabel: null,
      capturedAtMs: null,
      fetchedAtMs: Date.now(),
      contextUsage: null,
      avgTokensPerMessage: null,
      message,
    },
    deltas: [],
  };
}

export interface QuotaSectionProps {
  t?: (key: string, vars?: Record<string, string | number>) => string;
  activeProviders?: QuotaProviderId[];
  providers?: QuotaProviderId[];
}

export function QuotaSection(props: QuotaSectionProps = {}): ReactElement {
  const defaultT = useT();
  const t = props.t ?? defaultT;
  // Read through a ref so a caller's inline `t` never re-triggers the fetch below.
  const tRef = useRef(t);
  tRef.current = t;
  const activeList = props.providers ?? props.activeProviders;
  const active = useMemo<QuotaProviderId[]>(() => {
    return activeList !== undefined ? activeList : [...QUOTA_PROVIDERS];
  }, [activeList]);

  const [readings, setReadings] = useState<Partial<Record<QuotaProviderId, ProviderQuotaReading>>>({});
  const [loading, setLoading] = useState<Record<QuotaProviderId, boolean>>({
    claude: false,
    codex: false,
    agy: false,
  });
  const [loadingAll, setLoadingAll] = useState(false);
  const [agySensorStatus, setAgySensorStatus] = useState<AgySensorStatus | null>(null);
  const [installingAgy, setInstallingAgy] = useState(false);

  const fetchAgySensorStatus = useCallback(async () => {
    if (!window.electronAPI?.tokenUsage?.agySensorStatus) return;
    try {
      const status = await window.electronAPI.tokenUsage.agySensorStatus();
      if (status) setAgySensorStatus(status);
    } catch {
      // Ignore sensor check failure
    }
  }, []);

  const fetchQuota = useCallback(
    async (providers: QuotaProviderId[]) => {
      if (!window.electronAPI?.tokenUsage?.readQuota) return;
      try {
        const res = await window.electronAPI.tokenUsage.readQuota({ providers });
        if (res && Array.isArray(res.readings)) {
          setReadings((prev) => {
            const next = { ...prev };
            for (const reading of res.readings) {
              if (reading?.quota?.provider) {
                next[reading.quota.provider] = reading;
              }
            }
            return next;
          });
        }
      } catch (err) {
        // Shown on the card: a Refresh that fails must not look like a Refresh that did nothing.
        const error = err instanceof Error ? err.message : String(err);
        setReadings((prev) => {
          const next = { ...prev };
          for (const p of providers) next[p] = failedReading(p, tRef.current('settings.tokenUsage.readFailed', { error }));
          return next;
        });
      }
    },
    [],
  );

  const handleUpdateAll = useCallback(async () => {
    if (active.length === 0) return;
    setLoadingAll(true);
    setLoading((prev) => {
      const next = { ...prev };
      for (const p of active) next[p] = true;
      return next;
    });

    try {
      const tasks: Promise<unknown>[] = [fetchQuota(active)];
      if (active.includes('agy')) {
        tasks.push(fetchAgySensorStatus());
      }
      await Promise.all(tasks);
    } finally {
      setLoadingAll(false);
      setLoading((prev) => {
        const next = { ...prev };
        for (const p of active) next[p] = false;
        return next;
      });
    }
  }, [active, fetchQuota, fetchAgySensorStatus]);

  const handleRefresh = useCallback(
    async (provider: QuotaProviderId) => {
      setLoading((prev) => ({ ...prev, [provider]: true }));
      try {
        const tasks: Promise<unknown>[] = [fetchQuota([provider])];
        if (provider === 'agy') {
          tasks.push(fetchAgySensorStatus());
        }
        await Promise.all(tasks);
      } finally {
        setLoading((prev) => ({ ...prev, [provider]: false }));
      }
    },
    [fetchQuota, fetchAgySensorStatus],
  );

  const handleInstallAgySensor = useCallback(async () => {
    if (!window.electronAPI?.tokenUsage?.installAgySensor) return;
    setInstallingAgy(true);
    try {
      const res = await window.electronAPI.tokenUsage.installAgySensor();
      if (res?.status) {
        setAgySensorStatus(res.status);
      }
      await Promise.all([fetchQuota(['agy']), fetchAgySensorStatus()]);
    } finally {
      setInstallingAgy(false);
    }
  }, [fetchQuota, fetchAgySensorStatus]);

  // Read on open, and again only when the set of providers really changes. Keying on the array would
  // re-read every quota whenever a bindings change rebuilds an equal array (refresh on open or click only).
  const updateAllRef = useRef(handleUpdateAll);
  updateAllRef.current = handleUpdateAll;
  const activeKey = active.join(',');
  useEffect(() => {
    if (activeKey) {
      void updateAllRef.current();
    }
  }, [activeKey]);

  const title = t('settings.tokenUsage.quotaTitle');

  return (
    <SettingsSection
      id="tokenquota"
      title={title}
      action={
        <Button
          variant="secondary"
          size="sm"
          onClick={handleUpdateAll}
          disabled={loadingAll || active.length === 0}
          data-testid="quota-update-all"
        >
          {loadingAll ? t('settings.tokenUsage.updating') : t('settings.tokenUsage.updateAll')}
        </Button>
      }
      data-testid="token-quota-section"
    >
      <div className="flex flex-col gap-3 p-3">
        {active.length === 0 ? (
          <SettingNote data-testid="token-quota-empty">
            {t('settings.tokenUsage.noSupportedAgentBound')}
          </SettingNote>
        ) : (
          active.map((provider) => (
            <ProviderQuotaCard
              key={provider}
              provider={provider}
              reading={readings[provider]}
              loading={loading[provider]}
              onRefresh={() => handleRefresh(provider)}
              agySensorStatus={provider === 'agy' ? agySensorStatus : undefined}
              onInstallSensor={provider === 'agy' ? handleInstallAgySensor : undefined}
              installingSensor={installingAgy}
            />
          ))
        )}
      </div>
    </SettingsSection>
  );
}
