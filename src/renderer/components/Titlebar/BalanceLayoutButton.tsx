import type { CSSProperties } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { Icon } from '../icons';
import { getLeafPanes } from '../../../shared/paneUtils';
import { displayCombo, effectiveBindings } from '../../../shared/keymap';

/**
 * Balance layout: give every column and row of the active workspace an equal
 * share again. A bare 28px icon like the titlebar's panel toggles (no fill at
 * rest, hover fill only). Shown only where it can act: the Workspaces page,
 * on a desktop window, with at least two panes to balance.
 */
export default function BalanceLayoutButton() {
  const t = useT();
  const paneCount = useStore((s) => {
    if (s.appRoute !== 'workspaces' || s.readOnly) return 0;
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws ? getLeafPanes(ws.rootPane).length : 0;
  });
  const overrides = useStore((s) => s.shortcutOverrides);
  if (paneCount < 2) return null;
  const platform = (typeof window === 'undefined' ? undefined : window.electronAPI?.platform) ?? 'linux';
  const combo = effectiveBindings(platform, overrides).find((b) => b.action === 'balanceLayout')?.combo;
  const label = t('pane.balanceLayout');
  return (
    <button
      type="button"
      className={`wmux-panel-toggle ${FOCUS_RING}`}
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      onClick={() => useStore.getState().balanceLayout()}
      title={combo ? `${label} (${displayCombo(combo, platform)})` : label}
      aria-label={label}
      data-balance-layout
    >
      <Icon size={16}>
        <rect x="1.5" y="2" width="11" height="10" rx="1.5" />
        <path d="M5.2 2v10M8.8 2v10" />
      </Icon>
    </button>
  );
}
