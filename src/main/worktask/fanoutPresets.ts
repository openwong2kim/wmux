// ─── Fan-out presets (Settings → Agents → Fanout presets) ────────────────────
//
// Operator data, kept main-side next to fanout-worker-policy.json and for the
// same reason: a preset decides which executable an unattended fan-out runs and
// whether it runs with its approval prompts off, so it lives where only the
// Settings IPC writes it, not in session.json (which the renderer restores and
// writes back freely). The pipe handler reads it on every `preset:` request.
//
// A missing file is the shipped templates (Image, Video). A file that exists
// but cannot be parsed is NO presets — a preset request then fails with the
// (empty) list of names instead of running on a guess.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import {
  FANOUT_PRESETS_MAX,
  FANOUT_PRESET_TEMPLATES,
  fanoutPresetKey,
  normalizeFanoutPreset,
  normalizeFanoutPresetsReport,
  type FanoutIssue,
  type FanoutPreset,
  type FanoutPresetDropped,
} from '../../shared/fanoutPreset';

export function getFanoutPresetsPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'fanout-presets.json');
}

/**
 * The presets in force plus what could not be kept. `dropped` is shown in
 * Settings: the save below replaces the whole list, so an entry the loader
 * skipped in silence (hand-edited, or a CLI that is no longer selectable)
 * would be deleted on the operator's next save without them ever seeing it.
 * `unreadable` = the file exists but is not JSON.
 */
export function loadFanoutPresetsReport(
  dir?: string,
): { presets: FanoutPreset[]; dropped: FanoutPresetDropped[]; unreadable?: true } {
  const p = getFanoutPresetsPath(dir);
  if (!fs.existsSync(p)) {
    return { presets: FANOUT_PRESET_TEMPLATES.map((t) => ({ ...t, items: t.items.map((i) => ({ ...i })) })), dropped: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { presets?: unknown };
    return normalizeFanoutPresetsReport(raw?.presets);
  } catch {
    return { presets: [], dropped: [], unreadable: true };
  }
}

export function loadFanoutPresets(dir?: string): FanoutPreset[] {
  return loadFanoutPresetsReport(dir).presets;
}

/** Case-insensitive lookup by name. */
export function findFanoutPreset(name: string, dir?: string): FanoutPreset | undefined {
  const key = fanoutPresetKey(name);
  return loadFanoutPresets(dir).find((p) => fanoutPresetKey(p.name) === key);
}

/**
 * Replace the whole list. Strict, unlike the loader: a preset the operator is
 * saving that fails validation is reported (with its reason) and nothing is
 * written, so the Settings form can show what to fix.
 */
export async function saveFanoutPresets(
  input: unknown,
  dir?: string,
): Promise<{ ok: true; presets: FanoutPreset[] } | ({ ok: false } & FanoutIssue)> {
  if (!Array.isArray(input)) return { ok: false, code: 'presets-not-array', params: {}, error: 'presets must be an array' };
  if (input.length > FANOUT_PRESETS_MAX) {
    const cap = String(FANOUT_PRESETS_MAX);
    return { ok: false, code: 'presets-over-cap', params: { cap }, error: `at most ${cap} presets` };
  }
  const out: FanoutPreset[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const r = normalizeFanoutPreset(raw);
    if (!r.ok) return { ok: false, code: r.code, params: r.params, error: r.error };
    const key = fanoutPresetKey(r.preset.name);
    if (seen.has(key)) {
      const name = r.preset.name;
      return { ok: false, code: 'duplicate-name', params: { name }, error: `two presets are named "${name}"` };
    }
    seen.add(key);
    out.push(r.preset);
  }
  const p = getFanoutPresetsPath(dir);
  // One backup of what is being replaced: the loader may have dropped entries
  // this save no longer carries, and they stay recoverable from here.
  if (fs.existsSync(p)) {
    try {
      fs.copyFileSync(p, `${p}.bak`);
    } catch {
      // best-effort — the new list is still written
    }
  }
  await atomicWriteJSON(p, { presets: out });
  return { ok: true, presets: out };
}
