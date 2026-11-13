// The usage-limit menu matcher against real Claude Code captures (80x24,
// scrubbed) and the look-alikes it must never match: nothing is pressed on those.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { usageLimitMenuOnScreen } from '../limitMenu';

const capture = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `claude-limit-menu-${name}.json`), 'utf8')) as { screen: string[] }).screen;

describe('the usage-limit menu', () => {
  it('real captures: the menu as the last thing drawn (also under a background-task line)', () => {
    expect(usageLimitMenuOnScreen(capture('a'))).toBe(true);
    expect(usageLimitMenuOnScreen(capture('b'))).toBe(true);
  });

  it('row 2 is matched by its start: its time is redrawn in place', () => {
    const rows = capture('a').map((r) => r.replace('continue automatically shortly', 'continue automatically at Nov 13 at 3am'));
    expect(usageLimitMenuOnScreen(rows)).toBe(true);
  });

  it('row 3 differs by plan and is not part of the match', () => {
    const rows = capture('a').map((r) => r.replace('3. Ask your admin for more usage', '3. Upgrade your plan'));
    expect(usageLimitMenuOnScreen(rows)).toBe(true);
    // A plan with a fourth row is the same menu.
    const four = capture('a');
    four.splice(four.length - 2, 0, '     4. Buy extra usage');
    expect(usageLimitMenuOnScreen(four)).toBe(true);
  });

  it('an option a narrow pane wrapped goes on in rows indented past its number', () => {
    const rows = capture('a').map((r) => r.replace('     3. Ask your admin for more usage', '     3. Ask your admin for more usage, or buy\n        extra usage on your plan')).flatMap((r) => r.split('\n'));
    expect(usageLimitMenuOnScreen(rows)).toBe(true);
    // Not indented past the number: not part of the option.
    const flush = capture('a').map((r) => r.replace('     3. Ask your admin for more usage', '     3. Ask your admin\n     extra usage')).flatMap((r) => r.split('\n'));
    expect(usageLimitMenuOnScreen(flush)).toBe(false);
  });

  it('not the menu: anything drawn after it, a missing header or footer, other first rows', () => {
    const a = capture('a');
    // A composer drawn under it (the menu closed, its text still in scrollback).
    expect(usageLimitMenuOnScreen([...a, '', '╭────╮', '│ >  │', '╰────╯'])).toBe(false);
    // A permission prompt drawn below it.
    expect(usageLimitMenuOnScreen([...a, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'])).toBe(false);
    // A shell waiting for input under the same rows (a tool printed them).
    expect(usageLimitMenuOnScreen([...a, '$ '])).toBe(false);
    expect(usageLimitMenuOnScreen(a.filter((r) => !r.includes('What do you want to do?')))).toBe(false);
    expect(usageLimitMenuOnScreen(a.filter((r) => !r.includes('Esc to cancel')))).toBe(false);
    expect(usageLimitMenuOnScreen(a.map((r) => r.replace('1. Stop and wait for limit to reset', '1. Yes')))).toBe(false);
    expect(usageLimitMenuOnScreen(a.map((r) => r.replace('2. Wait here, then continue automatically', '2. No')))).toBe(false);
    // A row that is not an option between the header and the footer.
    const extra = [...a];
    extra.splice(extra.length - 3, 0, '   some other text');
    expect(usageLimitMenuOnScreen(extra)).toBe(false);
    expect(usageLimitMenuOnScreen([])).toBe(false);
  });
});
