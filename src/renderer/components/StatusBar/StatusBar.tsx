import { useState, useEffect, useMemo } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { Notification, Workspace } from '../../../shared/types';
import { UsageWidgetView } from './UsageWidget';
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
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
  // T9: derive unreadCount from workspaces + notifications, excluding muted
  // workspaces. Read the source slices (stable refs under immer) and compute
  // the primitive in useMemo so consumers re-render only when the count changes.
  const notifications = useStore((s) => s.notifications);
  const unreadCount = useMemo(
    () => computeUnreadCount(notifications, workspaces),
    [notifications, workspaces],
  );
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

  // Company 모드 비용 정보
  const sidebarMode = useStore((s) => s.sidebarMode);
  const totalCost = useStore((s) => s.company?.totalCostEstimate ?? 0);
  const sessionStartTime = useStore((s) => s.sessionStartTime);

  const [time, setTime] = useState(new Date());
  const [memUsage, setMemUsage] = useState('');
  const [sessionMin, setSessionMin] = useState(0);

  // Update clock every second
  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
      if (sessionStartTime) {
        setSessionMin(Math.floor((Date.now() - sessionStartTime) / 60_000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  // Update memory usage every 5 seconds. Reads the TOTAL app footprint from
  // main (app.getAppMetrics summed RSS across the whole Electron process tree)
  // instead of the renderer-only performance.memory.usedJSHeapSize, which
  // measured just this renderer's V8 JS heap (~10MB) and under-reported real
  // memory usage by roughly an order of magnitude.
  useEffect(() => {
    let cancelled = false;
    const update = () => {
      void window.electronAPI.system.getMemoryUsage().then((bytes) => {
        if (cancelled || typeof bytes !== 'number' || bytes <= 0) return;
        setMemUsage(`${Math.round(bytes / 1024 / 1024)}MB`);
      }).catch(() => { /* main not ready / handler swapped — keep last value */ });
    };
    update();
    const timer = setInterval(update, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const branch = activeWs?.metadata?.gitBranch;
  // Company-mode UI is gated behind COMPANY_MODE_ENABLED (paid "wmux max").
  // Even with a leftover persisted `sidebarMode === 'company'` (from a build
  // where company mode was reachable), the status-bar badge + cost must stay
  // hidden so the deactivated build shows zero company traces.
  const isCompanyMode = COMPANY_MODE_ENABLED && sidebarMode === 'company';

  // Anthropic 5h/7d usage state. Hidden entirely when status === 'idle'
  // (Settings toggle off). `nowMs` is the existing per-second clock used
  // for time display — countdown math reuses the same cursor.
  const usage = useStore((s) => s.anthropicUsage);
  const nowMs = time.getTime();

  return (
    <div className="flex items-center justify-between h-6 px-3 border-b border-[var(--bg-surface)] text-[10px] text-[var(--text-muted)] shrink-0 select-none font-mono" style={{ backgroundColor: 'var(--bg-mantle)' }} data-onboarding-target="status-bar" {...tokenAttrs('bgMantle', 'bg')} {...tokenAttrs('bgSurface', 'border')} {...tokenAttrs('textMuted', 'text')}>
      {/* Left: workspace + branch */}
      <div className="flex items-center gap-3">
        <span className="text-[var(--text-main)] font-medium" {...tokenAttrs('textMain', 'text')}>{activeWs?.name || 'wmux'}</span>
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

      {/* Right: status indicators */}
      <div className="flex items-center gap-3">
        {/* Company 모드일 때 비용 표시 */}
        {isCompanyMode && (
          <span className="text-[var(--text-sub2)]" title={t('statusBar.session', { min: sessionMin })}>
            ~${totalCost.toFixed(2)}
          </span>
        )}
        <UsageWidgetView
          status={usage.status}
          snapshot={usage.snapshot}
          lastError={usage.lastError}
          subscriptionType={usage.subscriptionType}
          nowMs={nowMs}
        />
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
            <span className="text-[var(--accent-blue)]" data-statusbar-channel-unread {...tokenAttrs('accent', 'text')}>
              {channelUnreadTotal > 99 ? '99+' : channelUnreadTotal}
            </span>
          )}
        </button>
        <NotificationBellBadgeView unreadCount={unreadCount} onActivate={toggleNotificationPanel} />
        {memUsage && <span>{memUsage}</span>}
        <span>{timeStr}</span>
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
