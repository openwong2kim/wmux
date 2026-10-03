import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { IconGear } from '../icons';
import { FOCUS_RING } from '../focusRing';

/**
 * Settings, at the titlebar's right end beside the tools-panel toggle (the
 * rail carries pages only). It swaps the sheet to the Settings page and shows
 * the selection fill while that page is up. Same size and hover as the
 * toggle (`wmux-panel-toggle`).
 */
export default function SettingsButton() {
  const t = useT();
  const active = useStore((s) => s.appRoute === 'settings');
  const label = t('settings.title');
  return (
    <button
      type="button"
      className={`wmux-panel-toggle ${FOCUS_RING}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-onboarding-target="settings-button"
      data-titlebar-settings
      onClick={() => useStore.getState().setAppRoute('settings')}
    >
      <IconGear size={16} />
    </button>
  );
}
