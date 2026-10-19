// The bot profile popover must fit a short window: at 800px it ran past the
// chat's foot and its Stop could not be reached. Layout does not run in
// jsdom, so this reads the stylesheet.
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
  it('the profile popover is bounded by the chat and scrolls inside', () => {
    const body = rule('.wmux-bots-profile');
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/max-height:\s*calc\(100% - \d+px\)/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    // The chat it is placed in is the positioned box that bounds it.
    expect(rule('.wmux-bots-chat')).toMatch(/position:\s*relative/);
  });

  it('the chat header\'s workers button shows only in the one-column layout, mirroring the back button', () => {
    expect(rule('.wmux-bots-head-workers')).toMatch(/display:\s*none/);
    expect(rule('.wmux-bots-head-workers')).toMatch(/right:\s*16px/);
    const narrow = css.indexOf('@container bots (max-width: 799px) {');
    expect(narrow).toBeGreaterThan(-1);
    expect(css.indexOf('.wmux-bots-head-workers { display: inline-flex; }', narrow)).toBeGreaterThan(narrow);
  });

  it('the worker panel draws no pane done, notification or glow ring (Workspaces keeps them)', () => {
    expect(css).toMatch(/\.wmux-bots-worker-panes \.pane-complete-blink::after,\s*\.wmux-bots-worker-panes \.notification-ring::before,\s*\.wmux-bots-worker-panes \.pane-flash::after \{ display: none; \}/);
    expect(css).toMatch(/\.wmux-bots-worker-panes \.pane-ring-glow \{ box-shadow: none; opacity: 1;/);
  });
});
