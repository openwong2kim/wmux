// ─── Channel row used inside ChannelsPanel ───────────────────────────────────
//
// Single-row representation of a channel in the sidebar. Modeled on
// `WorkspaceItem` (Sidebar/WorkspaceItem.tsx): same active-highlight
// convention (`bg-[var(--bg-surface)]` + accent text), the same
// rounded-md + px-3 py-1.5 spacing, and the same unread-badge slot.
// Click → setActiveChannel; no context menu in v1 (archive / rename are
// deferred per plan §Scope Boundaries).
//
// Single export (`ChannelItemView`): pure presentational — every prop
// is a primitive or a stable callback. The parent (`ChannelsPanel`)
// resolves `isActive` and `unreadCount` from the store and passes them
// in as props, so this component can be tested via `renderToStaticMarkup`
// in the project's node-environment vitest config (no jsdom).

import type { Channel } from '../../../shared/channels';
import { tokenAttrs } from '../../themes';

export interface ChannelItemViewProps {
  channel: Channel;
  isActive: boolean;
  unreadCount: number;
  onSelect: (channelId: string) => void;
}

/** Sidebar row for a single channel. Renders `#name`, an unread badge
 *  when `unreadCount > 0`, and an active highlight when `isActive`.
 *
 *  No hex literals — theme tokens only (see plan U7 test "no literal
 *  hex colors; theme tokens only"). */
export function ChannelItemView({
  channel,
  isActive,
  unreadCount,
  onSelect,
}: ChannelItemViewProps): React.ReactElement {
  const showBadge = unreadCount > 0;
  return (
    <div
      role="button"
      tabIndex={0}
      data-channel-id={channel.id}
      data-active={isActive ? 'true' : 'false'}
      data-unread={showBadge ? String(unreadCount) : '0'}
      onClick={() => onSelect(channel.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(channel.id);
        }
      }}
      {...tokenAttrs('bgSurface', 'bg')}
      className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded-md select-none ${
        isActive
          ? 'text-[var(--text-main)]'
          : 'text-[var(--text-subtle)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)] hover:text-[var(--text-sub)]'
      }`}
    >
      <span className="text-[var(--text-muted)] font-mono text-[11px] flex-shrink-0" aria-hidden="true">
        #
      </span>
      <span className="text-[11px] font-mono truncate flex-1 min-w-0">{channel.name}</span>
      {showBadge && (
        <span
          className="bg-[var(--accent-blue)] text-[var(--bg-base)] text-[9px] font-bold min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 flex-shrink-0"
          {...tokenAttrs('accent', 'accent')}
          {...tokenAttrs('bgBase', 'bg')}
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </div>
  );
}

export default ChannelItemView;