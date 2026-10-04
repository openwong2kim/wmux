// ─── Settings → Agents → Token usage ──────────────────────────────────────────
//
// One place to see what each bound role costs and to switch every role to a
// cheaper model/effort in one step. The profile is a shortcut over the role
// bindings (src/shared/tokenProfiles.ts), never a second source of truth: the
// selected profile is DERIVED from the bindings, and Apply writes bindings.
// Permissions are the operator's and are never touched here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../stores';
import { useT } from '../../../hooks/useT';
import type { OrchestratorRoleBindings } from '../../../../shared/orchestratorRole';
import { activeProviders } from '../../../../shared/activeProviders';
import { SettingRow, SettingsSection } from '../SettingsLayout';
import Button from '../../ui/Button';
import { QuotaSection } from './TokenUsageTab/QuotaSection';
import { ProfileSection } from './TokenUsageTab/ProfileSection';
import { CustomPanel } from './TokenUsageTab/CustomPanel';

type T = ReturnType<typeof useT>;

export interface TokenUsageViewProps {
  bindings: OrchestratorRoleBindings;
  onApply: (next: OrchestratorRoleBindings) => void;
  onOpenTab: (tab: 'roles' | 'moa') => void;
  deckBrainModel: string;
  deckBrainEffort: string;
  t: T;
}

export function TokenUsageView({ bindings, onApply, onOpenTab, deckBrainModel, deckBrainEffort, t }: TokenUsageViewProps) {
  const [showCustom, setShowCustom] = useState(false);
  // Bumped when a saved surface profile is applied: remounts the Custom panel so it reloads the
  // inventory instead of staging changes against the state from before the apply.
  const [surfaceEpoch, setSurfaceEpoch] = useState(0);
  const [surfaceBadgeText, setSurfaceBadgeText] = useState(() => t('settings.tokenUsage.surfaceDefault'));
  const surfaceReqIdRef = useRef(0);
  const customRef = useRef<HTMLDivElement>(null);

  // The panel renders below the profile card, out of sight on a short window:
  // bring it to the pill or button that was just clicked.
  useEffect(() => {
    if (showCustom) customRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [showCustom]);

  const providers = useMemo(() => activeProviders(bindings), [bindings]);

  const refreshSurfaceState = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.tokenUsage?.readInventory) {
      return;
    }
    const reqId = ++surfaceReqIdRef.current;
    try {
      const results = await Promise.allSettled(
        providers.map((p) => window.electronAPI.tokenUsage.readInventory({ provider: p }))
      );
      if (reqId !== surfaceReqIdRef.current) return;
      let disabledCount = 0;
      let failedCount = 0;
      for (const res of results) {
        if (res.status === 'fulfilled') {
          const val = res.value;
          if (val && Array.isArray(val.items)) {
            for (const item of val.items) {
              const isWmux = Boolean(item.wmuxRequired || item.source === 'wmux' || item.parent === 'wmux');
              if (!isWmux && item.enabled === false) {
                disabledCount++;
              }
            }
          }
        } else {
          failedCount++;
        }
      }
      const baseText = disabledCount === 0
        ? t('settings.tokenUsage.surfaceDefault')
        : t('settings.tokenUsage.surfaceOff', { n: disabledCount });
      setSurfaceBadgeText(
        failedCount > 0
          ? t('settings.tokenUsage.surfaceSomeUnavailable', { surface: baseText })
          : baseText,
      );
    } catch {
      // ignore
    }
  }, [providers, t]);

  useEffect(() => {
    refreshSurfaceState();
  }, [refreshSurfaceState]);

  return (
    <div className="settings-page" data-testid="token-usage-tab">
      <QuotaSection t={t} providers={providers} />

      <ProfileSection
        bindings={bindings}
        onApply={onApply}
        onOpenTab={onOpenTab}
        t={t}
        showCustom={showCustom}
        onToggleCustom={() => setShowCustom((v) => !v)}
        surfaceBadgeText={surfaceBadgeText}
        onProfileApplied={() => {
          void refreshSurfaceState();
          setSurfaceEpoch((n) => n + 1);
        }}
      />

      {showCustom && (
        <div ref={customRef}>
          <CustomPanel key={surfaceEpoch} t={t} providers={providers} onApplied={refreshSurfaceState} />
        </div>
      )}

      <SettingsSection id="tokendeck" title={t('settings.tokenDeck')} description={t('settings.tokenDeckDesc')}>
        <SettingRow
          label={t('settings.tokenDeckModel')}
          description={[deckBrainModel || 'default', deckBrainEffort ? `· ${deckBrainEffort}` : ''].join(' ').trim()}
        >
          <Button variant="secondary" size="sm" onClick={() => onOpenTab('moa')}>
            {t('settings.tokenOpenOrchestrator')}
          </Button>
        </SettingRow>
      </SettingsSection>
    </div>
  );
}

export default function TokenUsageTab({ onOpenTab }: { onOpenTab: (tab: 'roles' | 'moa') => void }) {
  const t = useT();
  const bindings = useStore((s) => s.orchestratorRoleBindings);
  const setBinding = useStore((s) => s.setOrchestratorRoleBinding);
  const deckBrainModel = useStore((s) => s.deckBrainModel);
  const deckBrainEffort = useStore((s) => s.deckBrainEffort);
  return (
    <TokenUsageView
      bindings={bindings}
      onApply={(next) => {
        for (const [role, binding] of Object.entries(next)) {
          if (binding !== bindings[role]) setBinding(role, binding);
        }
      }}
      onOpenTab={onOpenTab}
      deckBrainModel={deckBrainModel}
      deckBrainEffort={deckBrainEffort}
      t={t}
    />
  );
}
