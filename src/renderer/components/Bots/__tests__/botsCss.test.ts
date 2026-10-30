// Layout does not run in jsdom, so this reads the stylesheet: the bot's
// settings page in the chat's place, the chat header's right end.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.join(__dirname, '..', 'bots.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const m = new RegExp(`(^|[}\\s])${selector.replace(/[.-]/g, (c) => `\\${c}`)}\\s*\\{([^{}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[2];
}

describe('bots.css', () => {
  it('a bot\'s settings page is laid out in the chat\'s place: its back button always shows, its section nav folds away when narrow', () => {
    expect(rule('.wmux-bots-chat')).toMatch(/position:\s*relative/);
    expect(css).toMatch(/\.wmux-bot-settings-head > \.wmux-bot-settings-back \{ display: inline-flex; \}/);
    expect(rule('.wmux-bot-settings-scroll')).toMatch(/overflow-y:\s*auto/);
    const narrow = css.indexOf('@container botsettings (max-width: 639px) {');
    expect(narrow).toBeGreaterThan(-1);
    expect(css.indexOf('.wmux-bot-settings-nav { display: none; }', narrow)).toBeGreaterThan(narrow);
    // The old profile popover is gone.
    expect(css).not.toContain('.wmux-bots-profile');
  });

  it('the chat header\'s workers button shows only in the one-column layout, mirroring the back button', () => {
    expect(rule('.wmux-bots-head-workers')).toMatch(/display:\s*none/);
    expect(rule('.wmux-bots-head-end')).toMatch(/right:\s*16px/);
    const narrow = css.indexOf('@container bots (max-width: 799px) {');
    expect(narrow).toBeGreaterThan(-1);
    expect(css.indexOf('.wmux-bots-head-workers { display: inline-flex; }', narrow)).toBeGreaterThan(narrow);
  });

  it('the worker panel draws no pane done, notification or glow ring (Workspaces keeps them)', () => {
    expect(css).toMatch(/\.wmux-bots-worker-panes \.pane-complete-blink::after,\s*\.wmux-bots-worker-panes \.notification-ring::before,\s*\.wmux-bots-worker-panes \.pane-flash::after \{ display: none; \}/);
    expect(css).toMatch(/\.wmux-bots-worker-panes \.pane-ring-glow \{ box-shadow: none; opacity: 1;/);
  });
});
