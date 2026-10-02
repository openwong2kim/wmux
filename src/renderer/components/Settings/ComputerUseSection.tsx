import { useEffect, useState } from 'react';
import type { ComputerUseSettingsPayload } from '../../../shared/computer/config';
import { useT } from '../../hooks/useT';
import Badge from '../ui/Badge';
import Switch from '../ui/Switch';
import { SettingNote, SettingRow, SettingsSection } from './SettingsLayout';

/** Electron accelerator → the keys a person presses on this OS. */
export function formatStopKey(accelerator: string, mac: boolean): string {
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'CommandOrControl') return mac ? 'Cmd' : 'Ctrl';
      if (part === 'Alt' && mac) return 'Option';
      if (part === 'Escape') return 'Esc';
      return part;
    })
    .join('+');
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

// ─── Computer use tab — whether agents may see and drive other desktop apps ───
// The switch lives in ~/.wmux/computer-use.json (main owns the write), because the
// MCP server reads it too when it builds an agent's tool list. Read on mount,
// flipped optimistically, reconciled with what main says is on disk.
export function TabComputerUse() {
  const t = useT();
  const [state, setState] = useState<ComputerUseSettingsPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.computerUse
      ?.get()
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // Without a helper the switch can only go off: on, the tool would appear
  // and every call would fail.
  const noHelper = state ? state.helper !== 'ready' : false;

  const onChange = (next: boolean) => {
    if (!state || (next && noHelper)) return;
    setState({ ...state, enabled: next, error: undefined }); // optimistic
    window.electronAPI.computerUse
      ?.set(next)
      .then(setState)
      .catch((err: unknown) => setState({ ...state, error: err instanceof Error ? err.message : String(err) }));
  };

  const stopKeyUnavailable = state?.stopKeyStatus === 'unavailable';

  const helperBadge = state && (
    state.helper === 'ready'
      ? <Badge tone="success">{t('settings.computerUseHelperReady')}</Badge>
      : <Badge>{t(state.helper === 'missing' ? 'settings.computerUseHelperMissing' : 'settings.computerUseHelperUnsupported')}</Badge>
  );

  return (
    <div className="settings-page">
      <SettingsSection>
        <SettingRow id="computeruse" label={t('settings.computerUse')} description={t('settings.computerUseDesc')}>
          <Switch
            checked={state?.enabled ?? false}
            onCheckedChange={onChange}
            aria-label={t('settings.computerUse')}
            disabled={!state || (noHelper && !state.enabled)}
          />
        </SettingRow>
        <SettingRow id="computerusehelper" label={t('settings.computerUseHelper')} description={t('settings.computerUseHelperDesc')}>
          {helperBadge}
        </SettingRow>
        {/* A stop key that is not held is never advertised as working: input
            is refused until wmux can hold it (main fails closed). */}
        <SettingRow
          id="computerusestop"
          label={t('settings.computerUseStopKey')}
          description={t(
            stopKeyUnavailable ? 'settings.computerUseStopKeyUnavailableDesc'
              : noHelper ? 'settings.computerUseStopKeyNoHelperDesc'
                : state?.stopKeyStatus === 'held' ? 'settings.computerUseStopKeyDesc'
                  : 'settings.computerUseStopKeyOffDesc',
          )}
        >
          {state && (
            <>
              <span className="ui-code">{formatStopKey(state.stopKey, isMac)}</span>
              {stopKeyUnavailable && <Badge tone="danger">{t('settings.computerUseStopKeyUnavailable')}</Badge>}
            </>
          )}
        </SettingRow>
      </SettingsSection>
      {noHelper && state && (
        <SettingNote>
          {t(state.enabled ? 'settings.computerUseOnWithoutHelperNote'
            : state.helper === 'missing' ? 'settings.computerUseNoHelperNote' : 'settings.computerUseUnsupportedNote')}
        </SettingNote>
      )}
      {stopKeyUnavailable && state && (
        <SettingNote tone="danger">
          {t('settings.computerUseStopKeyUnavailableNote', { key: formatStopKey(state.stopKey, isMac) })}
        </SettingNote>
      )}
      {state?.error && <SettingNote tone="danger">{t('settings.computerUseSaveFailed', { error: state.error })}</SettingNote>}
      <SettingsSection title={t('settings.computerUseSafety')}>
        <SettingRow label={t('settings.computerUseConsent')} description={t('settings.computerUseConsentDesc')} />
        <SettingRow label={t('settings.computerUseBlocked')} description={t('settings.computerUseBlockedDesc')} />
      </SettingsSection>
      <SettingNote>{t('settings.computerUseRestartNote')}</SettingNote>
    </div>
  );
}
