import { useCallback, useEffect, useState } from 'react';
import type { ComputerUseSettingsPayload } from '../../../shared/computer/config';
import { useT } from '../../hooks/useT';
import Badge from '../ui/Badge';
import UiButton from '../ui/Button';
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

type PermissionOp = 'request' | 'reset' | 'reveal';
type OptionKey = 'askPerApp' | 'overlay';

// ─── Computer use tab — whether agents may see and drive other desktop apps ───
// The settings live in ~/.wmux/computer-use.json (main owns the write), because
// the MCP server reads them too when it builds an agent's tool list. Read on
// mount and whenever the window gets focus back (the person may have just
// granted a permission in System Settings), flipped optimistically, reconciled
// with what main says is on disk.
export function TabComputerUse() {
  const t = useT();
  const [state, setState] = useState<ComputerUseSettingsPayload | null>(null);
  const [busy, setBusy] = useState<PermissionOp | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback((isCancelled: () => boolean = () => false) => {
    window.electronAPI.computerUse
      ?.get()
      .then((s) => { if (!isCancelled()) setState(s); })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh(() => cancelled);
    const onFocus = () => refresh(() => cancelled);
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  // Without a helper the switch can only go off: on, the tool would appear
  // and every call would fail.
  const noHelper = state ? state.helper !== 'ready' : false;

  const save = (patch: { enabled?: boolean } & Partial<Record<OptionKey, boolean>>) => {
    if (!state) return;
    setState({ ...state, ...patch, error: undefined }); // optimistic
    window.electronAPI.computerUse
      ?.set(patch)
      .then(setState)
      .catch((err: unknown) => setState({ ...state, error: err instanceof Error ? err.message : String(err) }));
  };

  const onChange = (next: boolean) => {
    if (!state || (next && noHelper)) return;
    save({ enabled: next });
  };

  const runPermission = (op: PermissionOp) => {
    setConfirmReset(false);
    setActionError(null);
    setBusy(op);
    window.electronAPI.computerUse
      ?.permissions(op)
      .then(setState)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  const stopKeyUnavailable = state?.stopKeyStatus === 'unavailable';

  const helperBadge = state && (
    state.helper === 'ready'
      ? <Badge tone="success">{t('settings.computerUseHelperReady')}</Badge>
      : <Badge>{t(state.helper === 'missing' ? 'settings.computerUseHelperMissing'
        : state.helper === 'elevated' ? 'settings.computerUseHelperElevated' : 'settings.computerUseHelperUnsupported')}</Badge>
  );

  // Main sends the helper's .app only on macOS, where TCC grants exist.
  const showPermissions = state?.helper === 'ready' && Boolean(state.helperAppPath);
  const grantBadge = (granted: boolean | undefined) =>
    granted === undefined ? null
      : granted ? <Badge tone="success">{t('settings.computerUsePermissionGranted')}</Badge>
        : <Badge tone="warning">{t('settings.computerUsePermissionMissing')}</Badge>;
  const permissionMissing = state?.permissions
    ? !state.permissions.accessibility || !state.permissions.screenRecording
    : false;

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
        <SettingRow id="computeruseask" label={t('settings.computerUseConsent')} description={t('settings.computerUseConsentDesc')}>
          <Switch
            checked={state?.askPerApp ?? false}
            onCheckedChange={(next) => save({ askPerApp: next })}
            aria-label={t('settings.computerUseConsent')}
            disabled={!state}
          />
        </SettingRow>
        <SettingRow id="computeruseoverlay" label={t('settings.computerUseOverlay')} description={t('settings.computerUseOverlayDesc')}>
          <Switch
            checked={state?.overlay ?? true}
            onCheckedChange={(next) => save({ overlay: next })}
            aria-label={t('settings.computerUseOverlay')}
            disabled={!state}
          />
        </SettingRow>
      </SettingsSection>
      {noHelper && state && (
        <SettingNote>
          {t(state.enabled ? 'settings.computerUseOnWithoutHelperNote'
            : state.helper === 'missing' ? 'settings.computerUseNoHelperNote'
              : state.helper === 'elevated' ? 'settings.computerUseElevatedNote' : 'settings.computerUseUnsupportedNote')}
        </SettingNote>
      )}
      {state?.helper === 'ready' && state.helperUnsigned && <SettingNote>{t('settings.computerUseHelperUnsignedNote')}</SettingNote>}
      {stopKeyUnavailable && state && (
        <SettingNote tone="danger">
          {t('settings.computerUseStopKeyUnavailableNote', { key: formatStopKey(state.stopKey, isMac) })}
        </SettingNote>
      )}
      {state?.error && <SettingNote tone="danger">{t('settings.computerUseSaveFailed', { error: state.error })}</SettingNote>}
      {showPermissions && state && (
        <>
          <SettingsSection
            title={t('settings.computerUsePermissions')}
            description={state.permissions ? undefined : t('settings.computerUsePermissionsOffDesc')}
          >
            <SettingRow label={t('settings.computerUseAccessibility')} description={t('settings.computerUseAccessibilityDesc')}>
              {grantBadge(state.permissions?.accessibility)}
            </SettingRow>
            <SettingRow label={t('settings.computerUseScreenRecording')} description={t('settings.computerUseScreenRecordingDesc')}>
              {grantBadge(state.permissions?.screenRecording)}
            </SettingRow>
            <SettingRow label={t('settings.computerUseAccess')} description={t('settings.computerUseAccessDesc')}>
              {confirmReset ? (
                <div className="flex items-center gap-2 shrink-0">
                  <UiButton variant="ghost" size="md" onClick={() => setConfirmReset(false)}>{t('settings.computerUseResetKeep')}</UiButton>
                  <UiButton variant="danger" size="md" onClick={() => runPermission('reset')}>{t('settings.computerUseResetAccess')}</UiButton>
                </div>
              ) : (
                <div className="flex items-center gap-2 shrink-0">
                  <UiButton variant="secondary" size="md" disabled={busy !== null} onClick={() => runPermission('request')}>
                    {t('settings.computerUseRequestAccess')}
                  </UiButton>
                  <UiButton variant="secondary" size="md" disabled={busy !== null} onClick={() => runPermission('reveal')}>
                    {t('settings.computerUseShowHelper')}
                  </UiButton>
                  <UiButton variant="destructive" size="md" disabled={busy !== null} onClick={() => setConfirmReset(true)}>
                    {t('settings.computerUseResetAccess')}
                  </UiButton>
                </div>
              )}
            </SettingRow>
          </SettingsSection>
          {confirmReset && <SettingNote tone="warning">{t('settings.computerUseResetConfirm')}</SettingNote>}
          {permissionMissing && state.helperAppPath && (
            <SettingNote>{t('settings.computerUsePermissionHelp', { path: state.helperAppPath })}</SettingNote>
          )}
          {actionError && <SettingNote tone="danger">{t('settings.computerUsePermissionFailed', { error: actionError })}</SettingNote>}
        </>
      )}
      <SettingsSection title={t('settings.computerUseSafety')}>
        <SettingRow label={t('settings.computerUseBlocked')} description={t('settings.computerUseBlockedDesc')} />
      </SettingsSection>
      <SettingNote>{t('settings.computerUseRestartNote')}</SettingNote>
    </div>
  );
}
