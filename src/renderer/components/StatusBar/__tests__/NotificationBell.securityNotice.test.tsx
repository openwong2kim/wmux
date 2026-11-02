// The titlebar bell stays visible while a daemon security notice is pending,
// even with nothing unread: the notices count in, the dot turns the caution
// yellow (never the attention orange), and the label says how many wait.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotificationBellBadgeView } from '../StatusBar';

const renderBell = (unreadCount: number, securityCount?: number) =>
  renderToStaticMarkup(createElement(NotificationBellBadgeView, { unreadCount, securityCount, onActivate: () => undefined }));

describe('NotificationBellBadgeView with pending security notices', () => {
  it('renders with only a pending notice, its dot in --accent-yellow', () => {
    const html = renderBell(0, 1);
    expect(html).toContain('data-testid="statusbar-notification-bell"');
    expect(html).toMatch(/<span class="text-\[var\(--accent-yellow\)\]"[^>]*>●<\/span> 1</);
    expect(html).not.toContain('--attention');
    expect(html).toContain('aria-label="Security notices waiting: 1, 0 unread notifications, click to open panel"');
  });

  it('counts unread and pending notices together', () => {
    const html = renderBell(3, 2);
    expect(html).toContain('</span> 5<');
    expect(html).toContain('Security notices waiting: 2, 3 unread notifications');
  });

  it('keeps the plain neutral dot when nothing is pending', () => {
    const html = renderBell(3, 0);
    expect(html).toContain('● 3');
    expect(html).not.toContain('accent-yellow');
    expect(html).not.toContain('Security');
  });
});
