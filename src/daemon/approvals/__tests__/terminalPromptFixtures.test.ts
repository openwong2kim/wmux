// Measured terminal prompts: real TUI screens captured in an isolated HOME,
// with the key bytes that produced each one (fixtures/terminal-prompts/, key
// semantics in KEYS.md there).
//
// These tests PIN what today's screen predicates make of the real screens.
// They are not targets: some rows below are gaps the phone-prompt track
// closes later (an unboxed ExitPlanMode dialog nothing parses). #1567 closed
// two (Edit/Write dialogs whose wrapped option cut the parse, a 207-character
// command over the 200-character summary cap) and says so on each row. A
// change that moves one of these is a behaviour change and has to say so.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseTerminalPrompt, terminalPromptAnswerability, toolFromDialogTitle } from '../terminalPromptParse';
import { looksLikeApprovalPrompt } from '../approvalKeystrokes';

interface Fixture {
  tui: 'claude' | 'codex' | 'opencode';
  version: string;
  cols: number;
  rows: number;
  modes: string[];
  cursor: [number, number];
  keysSent: string;
  note: string;
  screen: string[];
}

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts');
const FILES = fs.readdirSync(DIR).filter((n) => n.endsWith('.json')).sort();
const load = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as Fixture;

/** What today's parser makes of the permission-shaped screens. */
interface Parsed {
  tool?: string;
  options: number;
  active: boolean;
  topRuleFound: boolean;
  answerable: boolean;
}

// null = parseTerminalPrompt finds no permission dialog.
const EXPECTED: Record<string, { looksLikePrompt: boolean; parsed: Parsed | null }> = {
  'claude-ask-multi-01-q1.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-multi-02-q2.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-multi-03-toggle1.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-multi-04-cheese-basil.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-multi-05-submit-screen.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-multi-06-other-toggled.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-multi-07-other-text.json': { looksLikePrompt: true, parsed: null },
  // The cursor sits on the in-question "Submit" row, which has no digit.
  'claude-ask-multi-08-submit-row.json': { looksLikePrompt: false, parsed: null },
  'claude-ask-multi-09-review.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-multi-10-answered.json': { looksLikePrompt: false, parsed: null },
  'claude-ask-other-01-after-digit4.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-other-02-after-paste.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-single-01-initial.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-single-02-after-down.json': { looksLikePrompt: true, parsed: null },
  'claude-ask-single-03-after-digit3.json': { looksLikePrompt: false, parsed: null },
  // #1567: the 207-character command no longer blocks answering — the
  // summary is capped for display only; the record binds the whole command.
  'claude-bash-long-01.json': {
    looksLikePrompt: true,
    parsed: { tool: 'Bash', options: 4, active: true, topRuleFound: true, answerable: true },
  },
  // #1567: top rule scrolled off. The options may be answered, but the record
  // binds only with the pane's own PermissionRequest for exactly this call
  // (ApprovalRegistry), never from the screen alone.
  'claude-bash-long-02-top-cut-100x16.json': {
    looksLikePrompt: true,
    parsed: { tool: 'Bash', options: 4, active: true, topRuleFound: false, answerable: true },
  },
  // Command top cut AND the option list windowed ("↓ 3." marker, no "4. No"):
  // not active, so no record ever binds it (#1567 only dropped the length cap).
  'claude-bash-long-03-top-cut-80x11.json': {
    looksLikePrompt: true,
    parsed: { options: 2, active: false, topRuleFound: false, answerable: true },
  },
  // No digits: arrows + Enter only.
  'claude-bypass-warning-menu.json': { looksLikePrompt: false, parsed: null },
  // #1567: the wrapped option 2 is one option now, so "3. No" is kept and the
  // dialog reads active. No "<Tool> command" title binds it, so its record
  // stays informational.
  'claude-edit-01.json': {
    looksLikePrompt: true,
    parsed: { options: 3, active: true, topRuleFound: true, answerable: true },
  },
  // ExitPlanMode ("Would you like to proceed?", indented, unboxed): unparsed.
  'claude-plan-01-initial.json': { looksLikePrompt: true, parsed: null },
  'claude-plan-02-after-digit3.json': { looksLikePrompt: true, parsed: null },
  'claude-plan-03-feedback-typed.json': { looksLikePrompt: true, parsed: null },
  'claude-plan-04-replanned.json': { looksLikePrompt: true, parsed: null },
  // The Write dialog that followed the approved plan (#1567: wrapped option, as above).
  'claude-plan-05-digit2-approved.json': {
    looksLikePrompt: true,
    parsed: { options: 3, active: true, topRuleFound: true, answerable: true },
  },
  'claude-plan-06-bypass-row.json': { looksLikePrompt: true, parsed: null },
  'claude-plan-07-empty-feedback.json': { looksLikePrompt: false, parsed: null },
  'claude-write-01-create.json': {
    looksLikePrompt: true,
    parsed: { options: 3, active: true, topRuleFound: true, answerable: true },
  },
  // Tab turned "Yes" into the amend field: no plain Yes left.
  'claude-write-02-tab-amend.json': {
    looksLikePrompt: true,
    parsed: { options: 3, active: true, topRuleFound: true, answerable: false },
  },
  'claude-write-03-no-rejected.json': { looksLikePrompt: false, parsed: null },
  // Codex approval overlays (phone-decision PR0). Reference only: Codex
  // approvals are answered over the app-server protocol (native channel),
  // never by keys, so these must stay unparsed.
  'codex-approval-exec-01.json': { looksLikePrompt: true, parsed: null },
  'codex-approval-patch-01.json': { looksLikePrompt: true, parsed: null },
  // A false positive of the cursor-row check: Codex's `> 1.` sign-in menu.
  'codex-login-menu.json': { looksLikePrompt: true, parsed: null },
  // OpenCode's permission buttons are horizontal and selected by colour only.
  'opencode-permission-bash-01.json': { looksLikePrompt: false, parsed: null },
  'opencode-permission-bash-02-rejected.json': { looksLikePrompt: false, parsed: null },
};

describe('measured terminal-prompt fixtures', () => {
  it('every fixture is pinned, and every pin has a fixture', () => {
    expect(FILES).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(FILES)('%s is well-formed and sanitized', (name) => {
    const fx = load(name);
    expect(fx.version).toMatch(/^(Claude Code|codex-cli|opencode) \d+\.\d+\.\d+$/);
    expect(fx.screen).toHaveLength(fx.rows);
    for (const row of fx.screen) expect(row.length).toBeLessThanOrEqual(fx.cols);
    const text = fx.screen.join('\n') + fx.note;
    // No home paths, users or hosts from the capture machine.
    expect(text).not.toMatch(/\/Users\/|\/home\/|pp1h/);
  });

  it.each(FILES)('%s: today\'s screen predicates', (name) => {
    const fx = load(name);
    const want = EXPECTED[name];
    expect(looksLikeApprovalPrompt(fx.screen)).toBe(want.looksLikePrompt);
    const parsed = parseTerminalPrompt(fx.screen, { cols: fx.cols });
    if (want.parsed === null) {
      expect(parsed).toBeNull();
      return;
    }
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect({
      tool: toolFromDialogTitle(parsed.title),
      options: parsed.options.length,
      active: parsed.active,
      topRuleFound: parsed.topRuleFound,
      answerable: terminalPromptAnswerability(parsed).answerable,
    }).toEqual({ tool: undefined, ...want.parsed });
  });

  it('all three TUIs ran their dialogs in the alternate screen with bracketed paste on', () => {
    for (const name of FILES) {
      // Claude's startup bypass warning comes before the TUI proper; its mode
      // set was not captured reliably (see KEYS.md), so it pins nothing here.
      if (name === 'claude-bypass-warning-menu.json') continue;
      expect(load(name).modes, name).toEqual(expect.arrayContaining(['1049', '2004']));
    }
  });
});
