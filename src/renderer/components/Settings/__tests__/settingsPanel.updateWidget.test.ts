import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #897 — the Settings update widget.
 *
 * It subscribed to update events and never asked what was already true, so
 * opening Settings AFTER a background download showed a bare version number and
 * a "check for updates" button while a verified installer sat on disk. That is
 * the third place in this subsystem with the same push-only mistake (the
 * refused-install notice was the first, the missing ready-toast the second),
 * which is why it is pinned here rather than left to review.
 */
describe('SettingsPanel — update widget reads state on mount', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'SettingsPanel.tsx'),
    'utf-8',
  );

  function updateWidget(): string {
    const start = source.indexOf('function UpdateStatus()');
    expect(start, 'UpdateStatus not found').toBeGreaterThan(-1);
    const end = source.indexOf('\n// ─── Tab content components', start);
    return source.slice(start, end === -1 ? undefined : end);
  }

  it('pulls the pending install instead of only subscribing', () => {
    expect(updateWidget()).toMatch(/electronAPI\?\.updater\?\.getPendingInstall/);
  });

  it('does not let the mount snapshot stomp a live event', () => {
    // The event that arrived while we were awaiting is fresher than the
    // snapshot; clobbering it would move the widget backwards (e.g. from
    // 'downloading' to 'downloaded', or from an error back to ready).
    const body = updateWidget();
    expect(body).toMatch(/prev === 'idle' \? 'downloaded' : prev/);
    expect(body).toMatch(/prev \|\| pending\.version/);
  });

  it('shows the version you are on AND the version you would move to', () => {
    // "Update ready" alone cannot be reconciled against anything; the reporters
    // on #897 were comparing these two numbers by hand.
    const body = updateWidget();
    expect(body).toMatch(/settings\.currentVersion/);
    expect(body).toMatch(/settings\.latestVersion/);
  });

  it('labels the install button with the action, not the state', () => {
    // It read "Update ready", which the status line already says — a button
    // named after a state does not tell you what pressing it does.
    const body = updateWidget();
    expect(body).toMatch(/onClick=\{handleInstall\}/);
    expect(body).toMatch(/update\.installNow/);
  });

  it('still warns that installing closes every pane', () => {
    // #866 copy. Losing it while rearranging this block would remove the only
    // warning the user gets before the app quits under them.
    expect(updateWidget()).toMatch(/settings\.updateEndsSessions/);
  });

  it('keeps the check button when an install is staged', () => {
    // The check button was the ELSE branch of the install button, so a staged
    // download hid the only way to ask for a newer release. Both must render:
    // the check button unconditionally, the install button gated on
    // 'downloaded' — never a ternary between them.
    const body = updateWidget();
    expect(body).toMatch(/\{state === 'downloaded' && \(\s*<Button\s+onClick=\{handleInstall\}/);
    expect(body).not.toMatch(/state === 'downloaded' \? \(/);
    const checkIdx = body.indexOf('onClick={handleCheck}');
    const installIdx = body.indexOf('onClick={handleInstall}');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(installIdx);
  });
});
