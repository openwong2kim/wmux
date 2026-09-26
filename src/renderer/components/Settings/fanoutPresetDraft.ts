// Pure helpers behind Settings → Roles & fan-out → Fan-out presets.
//
// The editor works on a string-typed draft (an empty model field is '', not
// undefined) and turns it into the wire shape only on save, where
// normalizeFanoutPreset — the same check main runs — has the final word.
// No React or i18n imports, so this module is testable in the node env.

import {
  FANOUT_AGENTS,
  fanoutAgentSpec,
  fanoutPresetKey,
  normalizeFanoutPreset,
  type FanoutIssue,
  type FanoutPreset,
} from '../../../shared/fanoutPreset';
import { FANOUT_MAX_TASKS } from '../../../shared/workTask';

export interface FanoutPresetDraftRow {
  agent: string;
  model: string;
  unattended: boolean;
}

export interface FanoutPresetDraft {
  name: string;
  description: string;
  items: FanoutPresetDraftRow[];
  worktree: boolean;
  outputFolder: string;
}

const DEFAULT_AGENT = FANOUT_AGENTS.find((a) => a.selectable)?.stem ?? 'claude';

export function newDraftRow(agent: string = DEFAULT_AGENT): FanoutPresetDraftRow {
  return { agent, model: '', unattended: false };
}

/** A new preset: one default-agent row, git worktree on. */
export function emptyFanoutPresetDraft(): FanoutPresetDraft {
  return { name: '', description: '', items: [newDraftRow()], worktree: true, outputFolder: '' };
}

export function draftFromPreset(preset: FanoutPreset): FanoutPresetDraft {
  return {
    name: preset.name,
    description: preset.description ?? '',
    items: preset.items.map((it) => ({ agent: it.agent, model: it.model ?? '', unattended: it.unattended === true })),
    worktree: preset.worktree,
    outputFolder: preset.outputFolder ?? '',
  };
}

/** Wire shape for setPresets. Omitted fields are omitted, never sent empty;
 *  a model typed on a CLI without a model flag is kept so validation refuses
 *  it instead of launching a different model than the row says. */
export function draftToPayload(draft: FanoutPresetDraft): Record<string, unknown> {
  const items = draft.items.map((row) => {
    const out: Record<string, unknown> = { agent: row.agent };
    const model = row.model.trim();
    if (model) out.model = model;
    const spec = fanoutAgentSpec(row.agent);
    if (row.unattended && spec && spec.unattendedFlags.length > 0) out.unattended = true;
    return out;
  });
  const payload: Record<string, unknown> = { name: draft.name.trim(), items, worktree: draft.worktree };
  const description = draft.description.trim();
  if (description) payload.description = description;
  const folder = draft.outputFolder.trim();
  if (!draft.worktree && folder) payload.outputFolder = folder;
  return payload;
}

/** Row edit: switching the agent drops what the new CLI cannot carry — a
 *  model when it has no verified model flag (the field shows it disabled and
 *  empty), and unattended when it has no unattended flags. */
export function setRowAgent(row: FanoutPresetDraftRow, agent: string): FanoutPresetDraftRow {
  const spec = fanoutAgentSpec(agent);
  return {
    agent,
    model: spec?.modelFlag ? row.model : '',
    unattended: spec && spec.unattendedFlags.length > 0 ? row.unattended : false,
  };
}

export function addDraftRow(draft: FanoutPresetDraft): FanoutPresetDraft {
  if (draft.items.length >= FANOUT_MAX_TASKS) return draft;
  return { ...draft, items: [...draft.items, newDraftRow()] };
}

export function removeDraftRow(draft: FanoutPresetDraft, index: number): FanoutPresetDraft {
  return { ...draft, items: draft.items.filter((_, k) => k !== index) };
}

/**
 * Validate a draft against the saved list. `editIndex` is the slot being
 * replaced (null for a new preset). Returns the preset list to save, or the
 * reason it cannot be saved.
 */
export function applyDraft(
  presets: readonly FanoutPreset[],
  draft: FanoutPresetDraft,
  editIndex: number | null,
): { ok: true; next: FanoutPreset[] } | { ok: false; issue: FanoutIssue } {
  const r = normalizeFanoutPreset(draftToPayload(draft));
  if (!r.ok) return { ok: false, issue: { code: r.code, params: r.params, error: r.error } };
  const key = fanoutPresetKey(r.preset.name);
  if (presets.some((p, k) => k !== editIndex && fanoutPresetKey(p.name) === key)) {
    const name = r.preset.name;
    return { ok: false, issue: { code: 'duplicate-name', params: { name }, error: `two presets are named "${name}"` } };
  }
  const next = editIndex === null
    ? [...presets, r.preset]
    : presets.map((p, k) => (k === editIndex ? r.preset : p));
  return { ok: true, next };
}

/** One line per preset: "claude · codex --model gpt-5.5 · grok". */
export function summarizeFanoutPresetAgents(preset: FanoutPreset): string {
  // The unattended flags are part of what runs, so the row says so rather than
  // hiding an approval-free CLI behind its bare name.
  return preset.items
    .map((it) => {
      const flags = it.unattended ? fanoutAgentSpec(it.agent)?.unattendedFlags ?? '' : '';
      return [it.agent, it.model ? `--model ${it.model}` : '', flags].filter((p) => p.length > 0).join(' ');
    })
    .join(' · ');
}

export function hasFanoutPresetNamed(presets: readonly FanoutPreset[], name: string): boolean {
  const key = fanoutPresetKey(name);
  return presets.some((p) => fanoutPresetKey(p.name) === key);
}
