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
  browserIdentityArg,
  browserToolsOff,
  BROWSER_PUBLISH_TOOLS,
} from '../scheduleModel';
import { AUTOMATION_TOOL_NAME_RE } from '../../../../shared/automation';
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

  it('the browser publish template fills Claude, Scoped and the browser tools, and asks for an identity', () => {
    const tpl = SCHEDULE_TEMPLATES.find((x) => x.id === 'browserPublish')!;
    expect(tpl.pickBrowserIdentity).toBe(true);
    const form = formFromTemplate(tpl, 'Publish', 'Post the update', '/repo');
    expect(form).toMatchObject({ agent: 'claude', mode: 'scoped', weekdays: WEEKDAYS, time: '10:00', browserWorkspaceId: '', browserPaneId: '' });
    const { tools, invalid } = parseToolNames(form.toolsText);
    expect(invalid).toEqual([]);
    expect(tools).toEqual([...BROWSER_PUBLISH_TOOLS]);
    expect(validateForm(form)).toEqual([]);
    // Filled in, never granted: the permission stays out of the draft and is
    // granted (and confirmed) when the user saves.
    expect(draftFromForm(form)).not.toHaveProperty('permission');
  });

  it('the browser publish tool list: wmux browser tools only, every name a valid scoped name, nothing that reads cookies, storage, network or runs page script', () => {
    expect(BROWSER_PUBLISH_TOOLS).toEqual([
      'mcp__wmux__browser_open', 'mcp__wmux__browser_navigate', 'mcp__wmux__browser_tabs',
      'mcp__wmux__browser_snapshot', 'mcp__wmux__browser_screenshot', 'mcp__wmux__browser_click',
      'mcp__wmux__browser_type', 'mcp__wmux__browser_fill', 'mcp__wmux__browser_press_key',
      'mcp__wmux__browser_select', 'mcp__wmux__browser_scroll', 'mcp__wmux__browser_wait',
      'mcp__wmux__browser_file_upload', 'mcp__wmux__browser_dialog',
    ]);
    for (const name of BROWSER_PUBLISH_TOOLS) expect(AUTOMATION_TOOL_NAME_RE.test(name), name).toBe(true);
    expect(BROWSER_PUBLISH_TOOLS.some((n) => /evaluate|cookies|storage|network|response_body/.test(n))).toBe(false);
  });

  it('the other templates leave the permission at the default', () => {
    for (const tpl of SCHEDULE_TEMPLATES.filter((x) => x.id !== 'browserPublish')) {
      expect(tpl.permission, tpl.id).toBeUndefined();
      expect(formFromTemplate(tpl, 'n', 'p', '/repo')).toMatchObject({ agent: 'claude', mode: 'auto', toolsText: '' });
    }
  });

  it('browser tools are off for Claude in Auto or Bypass without a browser identity', () => {
    const cases: Array<[Parameters<typeof browserToolsOff>[0], boolean]> = [
      [{ agent: 'claude', mode: 'auto', browserPaneId: '' }, true],
      [{ agent: 'claude', mode: 'bypass', browserPaneId: '' }, true],
      [{ agent: 'claude', mode: 'auto', browserPaneId: 'pane-1' }, false],
      [{ agent: 'claude', mode: 'bypass', browserPaneId: 'pane-1' }, false],
      [{ agent: 'claude', mode: 'scoped', browserPaneId: '' }, false],
      [{ agent: 'claude', mode: 'approval', browserPaneId: '' }, false],
      [{ agent: 'codex', mode: 'bypass', browserPaneId: '' }, false],
      [{ agent: 'codex', mode: 'scoped', browserPaneId: '' }, false],
    ];
    for (const [form, off] of cases) expect(browserToolsOff(form), JSON.stringify(form)).toBe(off);
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

describe('browser identity in the editor model', () => {
  const identity = { workspaceId: 'ws-1', paneId: 'pane-a', boundRevision: 2 };

  it('defaults to none, and an untouched schedule without one grants exactly as before', async () => {
    const { automation } = await import('./fixtures');
    expect(emptyForm()).toMatchObject({ browserWorkspaceId: '', browserPaneId: '' });
    const a = automation();
    const form = formFromAutomation(a);
    expect(browserIdentityArg(a, form, '')).toBeUndefined();
    expect(draftFromForm(form).action).not.toHaveProperty('browserIdentity');
  });

  it('picking, changing or removing an identity needs a grant in every mode; a rename does not', async () => {
    const { automation } = await import('./fixtures');
    const plain = automation();
    expect(grantNeeded(plain, { ...formFromAutomation(plain), browserWorkspaceId: 'ws-1', browserPaneId: 'pane-a' }, false)).toBe(true);
    const bound = automation({ action: { ...plain.action, browserIdentity: identity } });
    const form = formFromAutomation(bound);
    expect(form).toMatchObject({ browserWorkspaceId: 'ws-1', browserPaneId: 'pane-a' });
    expect(grantNeeded(bound, { ...form, name: 'renamed' }, false)).toBe(false);
    expect(grantNeeded(bound, { ...form, prompt: 'other' }, false)).toBe(true);
    const removed = { ...form, browserWorkspaceId: '', browserPaneId: '' };
    expect(grantNeeded(bound, removed, false)).toBe(true);
    expect(browserIdentityArg(bound, removed, '')).toBeNull();
    expect(browserIdentityArg(bound, form, 'Shop')).toEqual({ workspaceId: 'ws-1', paneId: 'pane-a', paneLabel: 'Shop' });
  });

  it('a workspace without a pane, or Codex beyond approval, is a form problem', () => {
    expect(validateForm({ ...emptyForm(), name: 'n', prompt: 'p', cwd: '/w', browserWorkspaceId: 'ws-1' })).toContain('browserPane');
    expect(validateForm({ ...emptyForm(), name: 'n', prompt: 'p', cwd: '/w', agent: 'codex', mode: 'scoped', browserWorkspaceId: 'ws-1', browserPaneId: 'p' }))
      .toContain('browserMode');
  });
});
