import { describe, it, expect } from 'vitest';
import { FANOUT_PRESET_TEMPLATES } from '../../../../shared/fanoutPreset';
import { FANOUT_MAX_TASKS } from '../../../../shared/workTask';
import {
  addDraftRow,
  applyDraft,
  draftFromPreset,
  emptyFanoutPresetDraft,
  setRowAgent,
  summarizeFanoutPresetAgents,
} from '../fanoutPresetDraft';

describe('fan-out preset draft helpers', () => {
  it('summarizes agents, caps rows, and drops unattended on a CLI without flags', () => {
    expect(summarizeFanoutPresetAgents({
      name: 'X',
      items: [{ agent: 'claude' }, { agent: 'codex', model: 'gpt-5.5' }, { agent: 'grok' }],
      worktree: true,
    })).toBe('claude · codex --model gpt-5.5 · grok');

    let draft = emptyFanoutPresetDraft();
    expect(draft.worktree).toBe(true);
    for (let k = 0; k < FANOUT_MAX_TASKS + 3; k++) draft = addDraftRow(draft);
    expect(draft.items).toHaveLength(FANOUT_MAX_TASKS);

    const codex = { agent: 'codex', model: 'gpt-5.5', unattended: true };
    expect(setRowAgent(codex, 'claude')).toEqual({ agent: 'claude', model: 'gpt-5.5', unattended: false });
  });

  it('refuses a bad model and a duplicate name, and replaces the edited slot', () => {
    const presets = [...FANOUT_PRESET_TEMPLATES];
    const draft = { ...emptyFanoutPresetDraft(), name: 'Mixed' };

    const badModel = applyDraft(presets, { ...draft, items: [{ agent: 'codex', model: '--yolo', unattended: false }] }, null);
    expect(badModel.ok).toBe(false);

    const dup = applyDraft(presets, { ...draft, name: 'image' }, null);
    expect(dup).toMatchObject({ ok: false, duplicate: true });

    // Renaming the edited preset to its own name (case change) is not a duplicate.
    const edited = applyDraft(presets, { ...draftFromPreset(presets[0]), name: 'IMAGE', outputFolder: 'imgs' }, 0);
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.next).toHaveLength(2);
      expect(edited.next[0]).toMatchObject({ name: 'IMAGE', worktree: false, outputFolder: 'imgs' });
    }
  });
});
