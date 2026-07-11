import { useMemo, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { Notification, Workspace } from '../../../shared/types';
import { StatusClockUsage, StatusClockTime } from './StatusClock';
import { selectActiveWorkspaceSummary } from '../../stores/selectors/workspaceProjections';
import { tokenAttrs } from '../../themes';
import PluginStatusBarWidgets from '../../plugins/PluginStatusBarWidgets';
import { sumUnread } from '../Channels/ChannelsPanel';
import { COMPANY_MODE_ENABLED } from '../../../shared/featureFlags';

/**
 * Compute the unread notification count, excluding notifications whose
 * originating workspace has `metadata.notificationsMuted === true` (CEO A4 +
 * DESIGN bell-math). Pure helper so it can be unit-tested without mounting.
 *
 * T4 (per-workspace notification mute) is merged — `notificationsMuted` is a
 * first-class optional field on `WorkspaceMetadata`, so we read it directly
 * with no structural-widening cast.
 */
export function computeUnreadCount(
  notifications: readonly Notification[],
  workspaces: readonly Workspace[],
): number {
  const mutedIds = new Set<string>();
  for (const w of workspaces) {
    if (w.metadata?.notificationsMuted === true) mutedIds.add(w.id);
  }
  let n = 0;
  for (const notif of notifications) {
    if (!notif.read && !mutedIds.has(notif.workspaceId)) n++;
  }
  return n;
}

/**
 * Format the bell badge contents. >= 1000 clips to "● 999+" per DESIGN D8
 * (no "1k+", no "∞"). 0 returns null — caller hides the badge entirely.
 */
export function formatBellContent(unreadCount: number): string | null {
  if (unreadCount <= 0) return null;
  if (unreadCount >= 1000) return '● 999+';
  return `● ${unreadCount}`;
}

/** ARIA label, with correct singular/plural per a11y spec. */
export function formatBellAriaLabel(unreadCount: number): string {
  const noun = unreadCount === 1 ? 'notification' : 'notifications';
  return `${unreadCount} unread ${noun}, click to open panel`;
}

interface NotificationBellBadgeProps {
  unreadCount: number;
  onActivate: () => void;
}

/**
 * Presentational bell badge. Extracted from StatusBar so the static-markup
 * test in __tests__/StatusBar.test.tsx can assert role / aria-label / focus
 * classes without mounting the full StatusBar tree (vitest runs in `node`
 * env — no jsdom).
 *
 * Renders nothing when unreadCount <= 0 (matches pre-T9 behavior where the
 * bell hid entirely on empty count).
 */
export function NotificationBellBadgeView({ unreadCount, onActivate }: NotificationBellBadgeProps) {
  const label = formatBellContent(unreadCount);
  if (label === null) return null;
  const ariaLabel = formatBellAriaLabel(unreadCount);
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={ariaLabel}
      title={ariaLabel}
      data-testid="statusbar-notification-bell"
      className="text-[var(--accent-blue)] hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-blue)] focus-visible:outline-offset-1 transition-colors px-1.5 py-0.5 min-w-[24px] min-h-[24px] inline-flex items-center justify-center rounded-sm"
      {...tokenAttrs('accent', 'accent')}
    >
      {label}
    </button>
  );
}

export default function StatusBar() {
  const t = useT();
  // A1: 통트리 구독 해체. StatusBar는 활성 ws의 name/branch 요약과 unreadCount
  // 파생값만 필요하다 — workspaces 전체를 구독하지 않는다.
  //  - activeWs 요약: 활성 ws의 name/gitBranch가 바뀔 때만 리렌더(useShallow).
  //  - unreadCount: computeUnreadCount를 셀렉터 안으로 옮겨 number를 직접 구독.
  //    number 반환이라 zustand 기본 Object.is 비교로 값이 바뀔 때만 리렌더된다.
  const activeWs = useStore(useShallow(selectActiveWorkspaceSummary));
  const unreadCount = useStore((s) => computeUnreadCount(s.notifications, s.workspaces));
  const toggleNotificationPanel = useStore((s) => s.toggleNotificationPanel);
  const toggleSettingsPanel = useStore((s) => s.toggleSettingsPanel);

  // Channel dock toggle + aggregate unread. The dock is the only home of the
  // channel list now, so this StatusBar control is the reopen affordance when
  // it's collapsed (and a quick toggle otherwise).
  const channelUnread = useStore((s) => s.channelUnread);
  const channelDockVisible = useStore((s) => s.channelDockVisible);
  const toggleChannelDock = useStore((s) => s.toggleChannelDock);
  const channelUnreadTotal = useMemo(() => sumUnread(channelUnread), [channelUnread]);

  // Prefix mode (tmux-style Ctrl+B)
  const prefixMode = useStore((s) => s.prefixMode);
  const prefixError = useStore((s) => s.prefixError);

  // Company 모드 여부(사이드바 모드 기준). 비용/경과 분·시각·메모리는 시계
  // 커서에 의존하므로 A5에서 StatusClock{Usage,Time}로 분리됐다 — 시계 틱이
  // StatusBar 본체를 리렌더하지 않게 하기 위함.
  const sidebarMode = useStore((s) => s.sidebarMode);

  const branch = activeWs.branch;
  // Company-mode UI is gated behind COMPANY_MODE_ENABLED (paid "wmux max").
  // Even with a leftover persisted `sidebarMode === 'company'` (from a build
  // where company mode was reachable), the status-bar badge + cost must stay
  // hidden so the deactivated build shows zero company traces.
  const isCompanyMode = COMPANY_MODE_ENABLED && sidebarMode === 'company';

  // Bridge redesign P1.5 — the status strip lives INSIDE the custom titlebar
  // now (owner feedback: the empty titlebar center read as wasted space, and
  // the separate status row doubled the top chrome). The component renders a
  // transparent, full-height flex strip: the titlebar supplies bg + height +
  // the drag region; the two content clusters opt OUT of dragging so their
  // buttons stay clickable, and the flex-1 gap between them stays draggable.
  // The workspace NAME moved to the titlebar's mantle segment (Titlebar.tsx)
  // — rendering it here again would duplicate it 20px away.
  const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties;
  return (
    <div className="flex items-center flex-1 min-w-0 h-full px-3 text-[10px] text-[var(--text-muted)] select-none font-mono" data-onboarding-target="status-bar" {...tokenAttrs('textMuted', 'text')}>
      {/* Left: transient indicators (prefix mode, branch, company badge) */}
      <div className="flex items-center gap-3" style={noDrag}>
        {prefixMode && (
          <span className="text-[var(--accent-red)] font-bold animate-pulse" {...tokenAttrs('danger', 'accent')}>
            [PREFIX]
          </span>
        )}
        {prefixError && (
          <span className="text-[var(--accent-yellow)]" {...tokenAttrs('warning', 'accent')}>
            {prefixError}
          </span>
        )}
        {branch && (
          <span>
            <span className="text-[var(--accent-yellow)]" {...tokenAttrs('warning', 'accent')}>⎇</span> {branch}
          </span>
        )}
        {/* Company 모드 배지 */}
        {isCompanyMode && (
          <span className="text-[8px] font-mono px-1.5 py-px bg-[var(--bg-surface)] text-[var(--accent-blue)] rounded">
            {t('statusBar.company')}
          </span>
        )}
        {/* Plugin status-bar widgets (B-1 ui.statusbar, left-aligned) */}
        <PluginStatusBarWidgets alignment="left" />
      </div>

      {/* Draggable gap — the titlebar's remaining grab surface. */}
      <div className="flex-1" />

      {/* Right: status indicators */}
      <div className="flex items-center gap-3" style={noDrag}>
        {/* A5: company 비용 + 사용량 위젯(시계 커서 의존) — 분리된 소형 컴포넌트. */}
        <StatusClockUsage isCompanyMode={isCompanyMode} />
        {/* Plugin status-bar widgets (B-1 ui.statusbar, right-aligned) */}
        <PluginStatusBarWidgets alignment="right" />
        <button
          type="button"
          onClick={toggleChannelDock}
          className={`flex items-center gap-1 transition-colors ${channelDockVisible ? 'text-[var(--accent-blue)]' : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'}`}
          title={t('statusBar.channelsTooltip') || 'Toggle channels'}
          aria-label={t('statusBar.channelsTooltip') || 'Toggle channels'}
          aria-pressed={channelDockVisible}
          data-statusbar-channels
        >
          <span aria-hidden="true" className="font-mono">#</span>
          {channelUnreadTotal > 0 && (
            <span className="text-[var(--accent-blue)]" data-statusbar-channel-unread {...tokenAttrs('accentSecondary', 'text')}>
              {channelUnreadTotal > 99 ? '99+' : channelUnreadTotal}
            </span>
          )}
        </button>
        <NotificationBellBadgeView unreadCount={unreadCount} onActivate={toggleNotificationPanel} />
        {/* A5: 메모리 + 시각(시계 커서 의존) — 분리된 소형 컴포넌트. */}
        <StatusClockTime />
        <button
          onClick={toggleSettingsPanel}
          className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors ml-1"
          title={t('statusBar.settingsTooltip')}
          data-onboarding-target="settings-button"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
