import { useMemo, useState } from 'react';
import type { OrchestratorRoleBindings, RoleBinding } from '../../../../../shared/orchestratorRole';
import { agyEffortOf } from '../../../../../shared/modelCatalog';
import {
  TOKEN_PROFILES,
  applyTokenProfile,
  matchTokenProfile,
  tokenProfileChanges,
  type TokenProfile,
} from '../../../../../shared/tokenProfiles';
import { SettingNote, SettingRow, SettingsSection } from '../../SettingsLayout';
import SegmentedControl from '../../../ui/SegmentedControl';
import Button from '../../../ui/Button';
import Badge from '../../../ui/Badge';
import { SavedSurfaceProfiles } from './profiles/SavedSurfaceProfiles';

export function effortOf(b: RoleBinding): string | undefined {
  return b.agent === 'agy' && b.model ? agyEffortOf(b.model) : b.effort;
}

export function describeBinding(b: RoleBinding): string {
  return [b.model ?? 'default', effortOf(b) ? `· ${effortOf(b)}` : '', b.tools ? `· tools ${b.tools}` : '']
    .filter(Boolean)
    .join(' ');
}

export const PROFILE_KEYS: Record<TokenProfile | 'custom', string> = {
  full: 'settings.tokenProfileFull',
  coding: 'settings.tokenProfileCoding',
  balanced: 'settings.tokenProfileBalanced',
  minimal: 'settings.tokenProfileMinimal',
  custom: 'settings.tokenProfileCustom',
};

export interface ProfileSectionProps {
  bindings: OrchestratorRoleBindings;
  onApply: (next: OrchestratorRoleBindings) => void;
  onOpenTab: (tab: 'roles' | 'orchestrator') => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  showCustom?: boolean;
  onToggleCustom?: () => void;
  surfaceBadgeText?: string;
  onProfileApplied?: () => void;
}

export function ProfileSection({
  bindings,
  onApply,
  onOpenTab,
  t,
  showCustom = false,
  onToggleCustom,
  surfaceBadgeText,
  onProfileApplied,
}: ProfileSectionProps) {
  const current = matchTokenProfile(bindings);
  const [picked, setPicked] = useState<TokenProfile>(current === 'custom' ? 'minimal' : current);
  const changes = useMemo(() => tokenProfileChanges(bindings, picked), [bindings, picked]);
  const bound = Object.keys(bindings).length > 0;
  const sharedAgy =
    bindings.Builder?.agent && bindings.Builder.agent === bindings.Tester?.agent
      ? bindings.Builder.agent
      : undefined;
  const label = (p: TokenProfile | 'custom') => t(PROFILE_KEYS[p]);

  return (
    <SettingsSection
      id="tokenprofile"
      title={t('settings.tokenProfile')}
      description={t('settings.tokenProfileDesc')}
      action={
        <div className="flex items-center gap-2">
          <Badge
            data-testid="token-profile-current"
            role="button"
            tabIndex={0}
            aria-expanded={showCustom}
            className="cursor-pointer"
            onClick={onToggleCustom}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggleCustom?.();
              }
            }}
          >
            {label(current)}
          </Badge>
          <Badge
            data-testid="token-surface-badge"
            role="button"
            tabIndex={0}
            aria-expanded={showCustom}
            className="cursor-pointer"
            onClick={onToggleCustom}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggleCustom?.();
              }
            }}
          >
            {surfaceBadgeText ?? t('settings.tokenUsage.surfaceDefault')}
          </Badge>
        </div>
      }
    >
      {!bound ? (
        <SettingRow label={t('settings.tokenProfileNoRoles')}>
          <Button variant="secondary" size="sm" onClick={() => onOpenTab('roles')}>
            {t('settings.tokenProfileBindFirst')}
          </Button>
        </SettingRow>
      ) : (
        <>
          <SettingRow label={t('settings.tokenProfile')} description={t(`${PROFILE_KEYS[picked]}Desc`)}>
            <SegmentedControl<TokenProfile>
              value={picked}
              onValueChange={setPicked}
              options={TOKEN_PROFILES.map((p) => ({ value: p, label: label(p) }))}
              data-testid="token-profile-picker"
            />
          </SettingRow>
          {changes.length === 0 ? (
            <SettingNote data-testid="token-profile-nochanges">{t('settings.tokenProfileNoChanges')}</SettingNote>
          ) : (
            <div className="settings-row" data-testid="token-profile-changes">
              {changes.map((c) => (
                <p key={c.role} className="ui-code m-0 text-[11px] text-[var(--text-sub)]" data-token-change={c.role}>
                  {c.role}: {describeBinding(c.before)} → {describeBinding(c.after)}
                </p>
              ))}
              <div className="mt-2 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="token-profile-apply"
                  onClick={() => onApply(applyTokenProfile(bindings, picked))}
                >
                  {t('settings.tokenProfileApply')}
                </Button>
              </div>
            </div>
          )}
          {sharedAgy && (
            <SettingNote data-testid="token-shared-pane">
              {t('settings.tokenSharedPane', { agent: sharedAgy })}
            </SettingNote>
          )}
        </>
      )}
      <SettingRow label={t('settings.tokenUsage.customizeSurface')} description={t('settings.tokenUsage.customizeSurfaceDesc')}>
        <Button
          variant={showCustom ? 'primary' : 'secondary'}
          size="sm"
          aria-expanded={showCustom}
          aria-controls="tokencustom"
          data-testid="token-customize-button"
          onClick={onToggleCustom}
        >
          {showCustom ? t('settings.tokenUsage.customizeSurfaceHide') : t('settings.tokenUsage.customizeSurface')}
        </Button>
      </SettingRow>
      <SavedSurfaceProfiles onApplied={onProfileApplied} />
    </SettingsSection>
  );
}
