import type { CSSProperties } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { Icon } from '../icons';
import { displayCombo, effectiveBindings } from '../../../shared/keymap';

/**
 * The sidebar's show/hide toggle, in the titlebar's left segment right after
 * the `wmux` wordmark (the slot the + used). It is the tools-panel toggle (DeckToggle) mirrored:
 * same 28px square, stroke and hover, with the bar drawn on the sidebar's
 * side, so the two read as a pair. Neither has a fill at rest or when on:
 * the state is the icon's filled bar and `aria-pressed`. The name stays put;
 * the tooltip names the action and the shortcut.
 */
export default function SidebarToggle({ className }: { className?: string } = {}) {
  const t = useT();
  const visible = useStore((s) => s.sidebarVisible);
  const onLeft = useStore((s) => s.sidebarPosition) !== 'right';
  const overrides = useStore((s) => s.shortcutOverrides);
  const platform = (typeof window === 'undefined' ? undefined : window.electronAPI?.platform) ?? 'linux';
  const combo = effectiveBindings(platform, overrides).find((b) => b.action === 'toggleSidebar')?.combo;
  const action = visible ? t('sidebar.toggleHide') : t('sidebar.toggleShow');
  return (
    <button
      type="button"
      className={`wmux-panel-toggle ${className ?? ''} ${FOCUS_RING}`}
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      onClick={() => useStore.getState().toggleSidebar()}
      title={combo ? `${action} (${displayCombo(combo, platform)})` : action}
      aria-label={t('sidebar.toggleShow')}
      aria-pressed={visible}
      data-sidebar-toggle
    >
      <Icon size={16}>
        <rect x="1.5" y="2" width="11" height="10" rx="1.5" />
        <path d={onLeft ? 'M5 2v10' : 'M9 2v10'} />
        {visible && <path d={onLeft ? 'M3.5 4v6' : 'M10.5 4v6'} opacity="0.5" strokeWidth="2" />}
      </Icon>
    </button>
  );
}
