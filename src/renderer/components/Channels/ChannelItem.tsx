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

import { useState } from 'react';
import type { Channel } from '../../../shared/channels';
import { tokenAttrs } from '../../themes';

export interface ChannelItemViewProps {
  channel: Channel;
  isActive: boolean;
  unreadCount: number;
  /** True when at least one unseen message @-mentions this workspace. Promotes
   *  the unread badge to a stronger red `@` badge. */
  mentioned?: boolean;
  /** W1 (operator observation) — localized label for the read-only "observed"
   *  badge shown when `channel.observed` is set (a private agent channel the
   *  local human operator watches but has not joined). Defaults to 'observed'. */
  observedLabel?: string;
  onSelect: (channelId: string) => void;
  /** Optional trailing action, revealed on row hover/focus. Wired by the panel
   *  for the trash affordance (and the restore affordance on trashed rows) —
   *  the row itself stays presentational and does not know what it does. */
  action?: {
    label: string;
    /** Single glyph rendered in the button. */
    glyph: string;
    onClick: (channelId: string) => void;
    /** Diagnostic attribute name, e.g. `data-channel-trash`. */
    testAttr: string;
    /**
     * Two-step armed confirm before firing — the repo's existing pattern for a
     * one-way action (ChannelView's archive button). The first click ARMS (the
     * glyph flips to a check), the second commits; leaving the row or blurring
     * disarms.
     *
     * Set this for trashing an ACTIVE channel: that archives it in the same
     * commit and `restore` does NOT un-archive (there is no un-archive op), so
     * a single misclick permanently read-onlies a live room. Reversible
     * actions — restore, and trashing a row that is already archived — stay
     * one click.
     */
    requiresConfirm?: boolean;
    /** Label/tooltip shown while armed. Falls back to `label`. */
    confirmLabel?: string;
  };
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
  mentioned = false,
  observedLabel = 'observed',
  onSelect,
  action,
}: ChannelItemViewProps): React.ReactElement {
  const showBadge = unreadCount > 0 || mentioned;
  const observed = channel.observed === true;
  // Armed state for a `requiresConfirm` action (see the prop's doc comment).
  const [armed, setArmed] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      data-channel-id={channel.id}
      data-active={isActive ? 'true' : 'false'}
      data-unread={showBadge ? String(unreadCount) : '0'}
      onClick={() => onSelect(channel.id)}
      // Leaving the row cancels a pending confirm — the same "clicking elsewhere
      // disarms" contract ChannelView's archive button gets from onBlur.
      onMouseLeave={() => setArmed(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(channel.id);
        }
      }}
      data-channel-observed={observed ? 'true' : undefined}
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
      {observed && (
        <span
          data-channel-observed-badge
          title={observedLabel}
          className="flex-shrink-0 text-[10px] font-mono uppercase tracking-wide px-1 py-0.5 rounded text-[var(--text-muted)] bg-[rgba(var(--bg-surface-rgb),0.6)]"
          {...tokenAttrs('textMuted', 'text')}
        >
          {observedLabel}
        </span>
      )}
      {showBadge && (
        <span
          data-channel-mention={mentioned ? 'true' : undefined}
          className={`text-[var(--bg-base)] text-[10px] font-bold min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 flex-shrink-0 ${
            mentioned ? 'bg-[var(--accent-red)]' : 'bg-[var(--accent)]'
          }`}
          {...tokenAttrs(mentioned ? 'danger' : 'accent', 'accent')}
          {...tokenAttrs('bgBase', 'bg')}
        >
          {mentioned && <span aria-hidden="true">@</span>}
          {unreadCount > 0 ? (unreadCount > 99 ? '99+' : unreadCount) : ''}
        </span>
      )}
      {action && (
        <button
          type="button"
          {...{ [action.testAttr]: 'true' }}
          {...(action.requiresConfirm ? { 'data-armed': armed ? 'true' : 'false' } : {})}
          title={armed ? (action.confirmLabel ?? action.label) : action.label}
          aria-label={armed ? (action.confirmLabel ?? action.label) : action.label}
          // Hidden until the row is hovered/focused so the resting sidebar
          // stays as quiet as it is today (DESIGN.md: no decoration at rest).
          // An armed button stays visible — it is asking a question.
          className={`flex-shrink-0 text-[10px] font-mono transition-opacity ${
            armed
              ? 'opacity-100 text-[var(--accent-red)]'
              : 'opacity-0 group-hover:opacity-100 focus:opacity-100 text-[var(--text-muted)] hover:text-[var(--text-main)]'
          }`}
          onClick={(e) => {
            e.stopPropagation(); // never let the action double as a row select
            if (action.requiresConfirm && !armed) {
              setArmed(true);
              return;
            }
            setArmed(false);
            action.onClick(channel.id);
          }}
          // The row is itself a role="button" with an Enter/Space handler, so a
          // key press on this button reaches BOTH: the browser synthesizes the
          // click here AND the same keydown bubbles up and selects the channel.
          // Trashing a room while also opening it is not what either press
          // meant, and on the armed path the first press would arm and navigate
          // at once. Stop the key event at the button; the click handler above
          // still runs and owns the action.
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
          }}
          onBlur={() => setArmed(false)}
          {...tokenAttrs(armed ? 'danger' : 'textMuted', armed ? 'accent' : 'text')}
        >
          {armed ? '✓' : action.glyph}
        </button>
      )}
    </div>
  );
}

export default ChannelItemView;