import { describe, expect, it } from 'vitest';
import {
  DAILY,
  SCHEDULE_TEMPLATES,
  WEEKDAYS,
  daysForPreset,
  effectivePreset,
  toggleDay,
  deriveName,
  formFromTemplate,
  presetOf,
  draftFromForm,
  emptyForm,
  formFromAutomation,
  grantNeeded,
  modeAfterAgentChange,
  modesFor,
  parseToolNames,
  validateForm,
} from '../scheduleModel';
import { automation } from './fixtures';

describe('parseToolNames (scoped mode)', () => {
  it('accepts bare tool names and rejects rule patterns and junk', () => {
    expect(parseToolNames('Read, Edit\nGrep  Read')).toEqual({ tools: ['Read', 'Edit', 'Grep'], invalid: [] });
    expect(parseToolNames('Read, Bash(rm -rf *), 9lives')).toEqual({
      tools: ['Read'],
      invalid: ['Bash(rm', '-rf', '*)', '9lives'],
    });
  });

  it('blocks saving scoped mode without a valid tool list', () => {
    const base = { ...emptyForm(), name: 'n', prompt: 'p', cwd: '/w', mode: 'scoped' as const };
    expect(validateForm({ ...base, toolsText: '' })).toContain('tools');
    expect(validateForm({ ...base, toolsText: 'Read, Bash(git push)' })).toContain('tools');
    expect(validateForm({ ...base, toolsText: 'Read, Grep' })).toEqual([]);
    // Codex scoped is a fixed sandbox: no tool list to validate.
    expect(validateForm({ ...base, agent: 'codex', toolsText: '' })).toEqual([]);
  });
});

describe('permission defaults and re-grant', () => {
  const granted = automation({ permission: { mode: 'bypass', grantedRevision: 3 } });

  it('a new schedule defaults to Claude auto, Codex scoped; auto is offered to Claude only', () => {
    expect(emptyForm()).toMatchObject({ agent: 'claude', mode: 'auto' });
    expect(modesFor('codex')).not.toContain('auto');
    expect(modeAfterAgentChange('codex', 'auto', false)).toBe('scoped');
    expect(modeAfterAgentChange('claude', 'scoped', false)).toBe('auto');
    // A pick is kept where it still applies; auto falls back on Codex.
    expect(modeAfterAgentChange('codex', 'approval', true)).toBe('approval');
    expect(modeAfterAgentChange('codex', 'auto', true)).toBe('scoped');
  });

  it('grants for a new non-approval schedule, an explicit pick, or a what-runs edit of a granted mode', () => {
    expect(grantNeeded(null, { ...emptyForm(), mode: 'approval' }, false)).toBe(false);
    expect(grantNeeded(null, emptyForm(), false)).toBe(true);
    const form = formFromAutomation(granted);
    expect(grantNeeded(granted, form, false)).toBe(false);
    expect(grantNeeded(granted, { ...form, name: 'Renamed' }, false)).toBe(false);
    expect(grantNeeded(granted, { ...form, prompt: 'Something else' }, false)).toBe(true);
    expect(grantNeeded(granted, { ...form, cwd: '/elsewhere' }, false)).toBe(true);
    expect(grantNeeded(granted, { ...form, model: 'opus' }, false)).toBe(true);
    expect(grantNeeded(granted, form, true)).toBe(true);
    expect(grantNeeded(granted, { ...form, mode: 'approval' }, true)).toBe(true);
    const approval = automation();
    expect(grantNeeded(approval, { ...formFromAutomation(approval), prompt: 'x' }, false)).toBe(false);
  });
});

describe('draftFromForm', () => {
  it('never carries a permission and round-trips the editable fields', () => {
    const a = automation({ action: { kind: 'launch', cwd: '/w', agent: 'codex', accountId: 'acc', model: 'm', prompt: 'p' } });
    const draft = draftFromForm(formFromAutomation(a));
    expect(draft).not.toHaveProperty('permission');
    expect(draft.action).toEqual(a.action);
    expect(draft.trigger).toEqual(a.trigger);
  });

  it('keeps the run limit and response timeout through an edit', () => {
    const a = automation({ policy: { overlap: 'skip_if_active', maxRunMinutes: 30, awaitTimeoutMinutes: 15 } });
    expect(draftFromForm({ ...formFromAutomation(a), prompt: 'changed' }).policy)
      .toEqual({ maxRunMinutes: 30, awaitTimeoutMinutes: 15 });
  });
});

describe('schedule composer helpers', () => {
  it('reads a day set as a preset and back', () => {
    expect(presetOf(DAILY)).toBe('daily');
    expect(presetOf([5, 4, 3, 2, 1])).toBe('weekdays');
    expect(presetOf([3])).toBe('weekly');
    expect(presetOf([0, 6])).toBe('custom');
    expect(daysForPreset('weekly', [1, 2, 3, 4, 5])).toEqual([1]);
    expect(daysForPreset('weekly', [4])).toEqual([4]);
    expect(daysForPreset('custom', [0, 6])).toEqual([0, 6]);
  });

  it('names a schedule after its prompt\'s first non-empty line, capped at 80', () => {
    expect(deriveName('\n\n  Run the tests  \nthen report')).toBe('Run the tests');
    expect(deriveName('x'.repeat(100))).toHaveLength(80);
    expect(deriveName('')).toBe('');
  });

  it('fills a template into a valid form once a folder is known', () => {
    const tpl = SCHEDULE_TEMPLATES.find((x) => x.id === 'triage')!;
    const form = formFromTemplate(tpl, 'Issue triage', 'Sort new issues', '/repo');
    expect(form).toMatchObject({ name: 'Issue triage', prompt: 'Sort new issues', cwd: '/repo', weekdays: WEEKDAYS, time: '09:30', mode: 'auto' });
    expect(validateForm(form)).toEqual([]);
    expect(validateForm({ ...form, cwd: '' })).toEqual(['cwd']);
  });
});

describe('schedule chip mode', () => {
  it('keeps Pick days as the mode while the days still read as one day', () => {
    expect(effectivePreset(null, [3])).toBe('weekly');
    expect(effectivePreset('custom', [3])).toBe('custom');
  });

  it('toggles days in Pick days, picks one in Weekly, and never clears the last day', () => {
    expect(toggleDay('custom', [1], 5)).toEqual([1, 5]);
    expect(toggleDay('custom', [1, 5], 1)).toEqual([5]);
    expect(toggleDay('custom', [5], 5)).toEqual([5]);
    expect(toggleDay('weekly', [1], 4)).toEqual([4]);
  });
});
