import { describe, expect, it } from 'vitest';
import {
  draftFromForm,
  emptyForm,
  formFromAutomation,
  grantNeeded,
  parseToolNames,
  shouldWarnPermissionReset,
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

describe('permission reset warning', () => {
  const granted = automation({ permission: { mode: 'bypass', grantedRevision: 3 } });

  it('warns before saving a revision-bumping edit of a non-approval schedule', () => {
    const form = formFromAutomation(granted);
    expect(shouldWarnPermissionReset(granted, form, false)).toBe(false);
    expect(shouldWarnPermissionReset(granted, { ...form, name: 'Renamed' }, false)).toBe(false);
    expect(shouldWarnPermissionReset(granted, { ...form, prompt: 'Something else' }, false)).toBe(true);
    expect(shouldWarnPermissionReset(granted, { ...form, cwd: '/elsewhere' }, false)).toBe(true);
    expect(shouldWarnPermissionReset(granted, { ...form, model: 'opus' }, false)).toBe(true);
  });

  it('does not warn for approval schedules, new schedules or a fresh permission pick', () => {
    const approval = automation();
    expect(shouldWarnPermissionReset(approval, { ...formFromAutomation(approval), prompt: 'x' }, false)).toBe(false);
    expect(shouldWarnPermissionReset(null, emptyForm(), false)).toBe(false);
    expect(shouldWarnPermissionReset(granted, { ...formFromAutomation(granted), prompt: 'x' }, true)).toBe(false);
  });

  it('grants only for a new non-approval schedule or an explicit pick', () => {
    expect(grantNeeded(null, { ...emptyForm(), mode: 'approval' }, false)).toBe(false);
    expect(grantNeeded(null, { ...emptyForm(), mode: 'bypass' }, false)).toBe(true);
    expect(grantNeeded(granted, formFromAutomation(granted), false)).toBe(false);
    expect(grantNeeded(granted, formFromAutomation(granted), true)).toBe(true);
    expect(grantNeeded(granted, { ...formFromAutomation(granted), mode: 'approval' }, true)).toBe(true);
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
});
