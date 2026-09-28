// The ExitPlanMode dialog parser against the measured Claude Code 2.1.283
// captures (fixtures/terminal-prompts/claude-plan-*.json, KEYS.md).

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlanPrompt, parseTerminalPrompt } from '../terminalPromptParse';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts');
// Read with fs, not a JSON import: a JSON import breaks the daemon build.
const screen = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as { screen: string[] }).screen;

describe('parsePlanPrompt', () => {
  it('reads the initial dialog: keys and labels off the screen, the cursor on row 1', () => {
    const p = parsePlanPrompt(screen('claude-plan-01-initial.json'))!;
    expect(p).not.toBeNull();
    expect(p.question).toBe('Claude has written up a plan and is ready to execute. Would you like to proceed?');
    expect(p.options).toEqual([
      { key: '1', label: 'Yes, and use auto mode', selected: true },
      { key: '2', label: 'Yes, manually approve edits', selected: false },
      { key: '3', label: 'Tell Claude what to change', selected: false },
    ]);
    expect(p.active).toBe(true);
    expect(p.cut).toBe(false);
    expect(p.topRuleFound).toBe(true);
    expect(p.plan).toMatchObject({
      approve: { key: '2', label: 'Yes, manually approve edits' },
      feedback: { key: '3', label: 'Tell Claude what to change' },
      bypass: false,
    });
  });

  it('keeps the fingerprint when only the cursor moves (digit 3)', () => {
    const a = parsePlanPrompt(screen('claude-plan-01-initial.json'))!;
    const b = parsePlanPrompt(screen('claude-plan-02-after-digit3.json'))!;
    expect(b.options.find((o) => o.selected)?.key).toBe('3');
    expect(b.active).toBe(true);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.plan!.frameFingerprint).toBe(a.plan!.frameFingerprint);
  });

  it('reads typed feedback as the feedback row label; the frame hash ignores it', () => {
    const a = parsePlanPrompt(screen('claude-plan-02-after-digit3.json'))!;
    const typed = parsePlanPrompt(screen('claude-plan-03-feedback-typed.json'))!;
    expect(typed.plan!.feedback).toEqual({ key: '3', label: 'use bye instead' });
    expect(typed.fingerprint).not.toBe(a.fingerprint);
    expect(typed.plan!.frameFingerprint).toBe(a.plan!.frameFingerprint);
    expect(typed.active).toBe(true);
  });

  it('reads the re-drawn dialog after a re-plan, with the same dialog text', () => {
    const again = parsePlanPrompt(screen('claude-plan-04-replanned.json'))!;
    expect(again.active).toBe(true);
    expect(again.fingerprint).toBe(parsePlanPrompt(screen('claude-plan-01-initial.json'))!.fingerprint);
  });

  it('marks the bypass-permissions row', () => {
    const p = parsePlanPrompt(screen('claude-plan-06-bypass-row.json'))!;
    expect(p.plan!.bypass).toBe(true);
    expect(p.options[0]!.label).toMatch(/BYPASS PERMISSIONS/);
    expect(p.plan!.approve?.key).toBe('2');
  });

  it('finds no plan dialog once it is answered or on other dialogs', () => {
    expect(parsePlanPrompt(screen('claude-plan-05-digit2-approved.json'))).toBeNull();
    expect(parsePlanPrompt(screen('claude-plan-07-empty-feedback.json'))).toBeNull();
    for (const name of fs.readdirSync(DIR).filter((n) => n.endsWith('.json') && !n.startsWith('claude-plan-'))) {
      expect(parsePlanPrompt(screen(name)), name).toBeNull();
    }
  });

  it('is stable when the TUI wraps the question and a label at another width', () => {
    const base = parsePlanPrompt(screen('claude-plan-06-bypass-row.json'))!;
    const rows = screen('claude-plan-06-bypass-row.json');
    const q = rows.findIndex((r) => r.includes('Would you like to proceed?'));
    const o1 = rows.findIndex((r) => r.includes('BYPASS PERMISSIONS'));
    const narrow = [
      ...rows.slice(0, q),
      '   Claude has written up a plan and is ready to execute. Would you like',
      '   to proceed?',
      ...rows.slice(q + 1, o1),
      '   ❯ 1. Yes, and switch to BYPASS PERMISSIONS (no further prompts) for',
      '        this session',
      ...rows.slice(o1 + 1),
    ];
    const wrapped = parsePlanPrompt(narrow)!;
    expect(wrapped.question).toBe(base.question);
    expect(wrapped.options).toEqual(base.options);
    expect(wrapped.fingerprint).toBe(base.fingerprint);
  });

  it('is not active when something is drawn under the footer', () => {
    const rows = [...screen('claude-plan-01-initial.json'), '   stray output'];
    expect(parsePlanPrompt(rows)!.active).toBe(false);
  });

  it('refuses out-of-order option numbers', () => {
    const rows = screen('claude-plan-01-initial.json').map((r) => r.replace('2. Yes, manually', '4. Yes, manually'));
    expect(parsePlanPrompt(rows)).toBeNull();
  });

  it('leaves the permission parser untouched: a plan dialog is not a permission dialog', () => {
    expect(parseTerminalPrompt(screen('claude-plan-01-initial.json'))).toBeNull();
  });
});
