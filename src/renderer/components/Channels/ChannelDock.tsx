// ─── Right-side channel dock (Approach A) ────────────────────────────────
//
// A collapsible flex column on the OPPOSITE edge from the workspace sidebar.
// Holds the channel list (ChannelsPanel) at the top and the active
// conversation (ChannelView) below. This replaces the old `position: fixed`
// ChannelView overlay that covered the terminals — the dock is a flex sibling
// in AppLayout's root row, so it reflows the panes instead of floating over
// them. Mounted only when `channelDockVisible` (uiSlice); auto-opens when a
// channel is selected (channelsSlice.setActiveChannel), collapses via the
// header button, and reopens from the StatusBar channel toggle.
//
// Edge mirroring: the workspace Sidebar sits on `sidebarPosition`; the dock
// sits opposite. AppLayout's root uses `flex-row-reverse` when the sidebar is
// docked right, so placing the dock as the last flex child puts it on the
// correct (opposite) edge automatically — we only flip the inner border side.

import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { IconChevronDir } from '../icons';
import { ChannelsPanel } from './ChannelsPanel';
import { ChannelView } from './ChannelView';

export default function ChannelDock(): React.ReactElement {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const setChannelDockVisible = useStore((s) => s.setChannelDockVisible);

  // Workspace sidebar is on `sidebarPosition`; the dock is on the opposite
  // edge. When the sidebar is on the LEFT (default), the dock is on the RIGHT,
  // so its content border faces left (border-l) and the collapse chevron
  // points right (toward the screen edge it tucks into).
  const dockOnRight = sidebarPosition !== 'right';

  return (
    <div
      className={`flex flex-col h-full bg-[var(--bg-mantle)] ${dockOnRight ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`}
      style={{ width: 320, borderColor: 'var(--border-soft)' }}
      data-channel-dock
      {...tokenAttrs('bgMantle', 'bg')}
      {...tokenAttrs('bgSurface', 'border')}
    >
      {/* Slim header — collapse affordance on the inner edge (mirrors the
          Sidebar footer collapse). The "Channels" section title + unread total
          live in ChannelsPanel's own header just below. */}
      <div
        className={`flex items-center justify-between px-3 py-1.5 border-b border-[var(--bg-surface)] shrink-0 ${dockOnRight ? '' : 'flex-row-reverse'}`}
        style={{ borderColor: 'var(--border-soft)' }}
        {...tokenAttrs('bgSurface', 'border')}
      >
        <span
          className="text-[10px] font-mono tracking-widest uppercase text-[var(--text-muted)]"
          {...tokenAttrs('textMuted', 'text')}
        >
          {t('channels.dockTitle') || 'Channels'}
        </span>
        <button
          type="button"
          className={`flex items-center justify-center w-5 h-5 rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
          onClick={() => setChannelDockVisible(false)}
          title={t('channels.dockCollapse') || 'Collapse channels'}
          aria-label={t('channels.dockCollapse') || 'Collapse channels'}
          data-channel-dock-collapse
        >
          {/* Chevron points toward the edge the dock tucks into. */}
          <IconChevronDir dir={dockOnRight ? 'right' : 'left'} />
        </button>
      </div>

      {/* Channel list — capped so a long catalog can't crowd out the
          conversation; scrolls within its share. */}
      <div className="shrink-0 max-h-[45%] overflow-y-auto">
        <ChannelsPanel />
      </div>

      {/* Active conversation — fills the remaining height. Renders null when no
          channel is active (you still see the list above). */}
      <ChannelView />
    </div>
  );
}
