import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  QUICK_LAUNCH_DEFAULT_ACCELERATOR,
  acceleratorFromKeyEvent,
  formatAccelerator,
  type QuickLaunchSettingsPayload,
} from '../../../shared/quickLaunch';
import { useT } from '../../hooks/useT';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import { SettingNote, SettingRow, SettingsSection } from './SettingsLayout';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

// ─── Shortcuts tab › Quick launch — the global composer chord ───
// Main owns the setting (~/.wmux/quick-launch.json) and registers the chord;
// this section only asks. A chord the OS refuses is never saved, and a saved
// one another app has since taken shows as not registered — never silently.
export function QuickLaunchSection({
  renderCapture,
}: {
  /** The tab's key recorder, given a recorder for global accelerators. */
  renderCapture: (props: {
    label: string;
    record: (e: KeyboardEvent) => string | null;
    onCapture: (accelerator: string) => void;
    onCancel: () => void;
  }) => ReactNode;
}) {
  const t = useT();
  const api = window.electronAPI.quickLaunch;
  const [state, setState] = useState<QuickLaunchSettingsPayload | null>(null);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      ?.settingsGet()
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [api]);

  const update = useCallback((patch: { enabled?: boolean; accelerator?: string }) => {
    api
      ?.settingsSet(patch)
      .then(setState)
      .catch((err: unknown) => setState((s) => s && { ...s, error: err instanceof Error ? err.message : String(err) }));
  }, [api]);

  const record = useCallback((e: KeyboardEvent) => acceleratorFromKeyEvent(e, isMac), []);
  const onCapture = useCallback((accelerator: string) => {
    setCapturing(false);
    update({ accelerator });
  }, [update]);
  const onCancel = useCallback(() => setCapturing(false), []);

  // Rows render before main answers (disabled), so search can jump to them.
  const loaded = state !== null;
  const shown = state ?? { enabled: false, accelerator: QUICK_LAUNCH_DEFAULT_ACCELERATOR, status: 'off' as const };
  const unavailable = shown.status === 'unavailable';
  const keys = formatAccelerator(shown.accelerator, isMac);

  return (
    <>
      <SettingsSection>
        <SettingRow id="quicklaunch" label={t('settings.quickLaunch')} description={t('settings.quickLaunchDesc')}>
          <Switch
            checked={shown.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
            aria-label={t('settings.quickLaunch')}
            disabled={!loaded}
          />
        </SettingRow>
        <SettingRow id="quicklaunchkey" label={t('settings.quickLaunchShortcut')} description={t('settings.quickLaunchShortcutDesc')}>
          <span className="flex items-center gap-3">
            {unavailable && <Badge tone="danger">{t('settings.quickLaunchUnavailable')}</Badge>}
            {shown.accelerator !== QUICK_LAUNCH_DEFAULT_ACCELERATOR && (
              <Button variant="ghost" size="sm" onClick={() => update({ accelerator: QUICK_LAUNCH_DEFAULT_ACCELERATOR })}>
                {t('settings.quickLaunchReset')}
              </Button>
            )}
            <kbd className="ui-kbd settings-kbd-hint" data-disabled={!shown.enabled || undefined}>{keys}</kbd>
            <Button variant="secondary" size="sm" disabled={!shown.enabled} onClick={() => setCapturing(true)}>
              {t('settings.quickLaunchChange')}
            </Button>
          </span>
        </SettingRow>
      </SettingsSection>
      {unavailable ? (
        <SettingNote tone="danger">
          {t('settings.quickLaunchUnavailableNote', { key: keys, error: state?.error ?? '' })}
        </SettingNote>
      ) : state?.error ? (
        <SettingNote tone="danger">{t('settings.quickLaunchSaveFailed', { error: state.error })}</SettingNote>
      ) : null}
      {capturing && renderCapture({ label: t('settings.quickLaunchPress'), record, onCapture, onCancel })}
    </>
  );
}
