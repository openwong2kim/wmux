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
  normalizeFanoutPresets,
  type FanoutPreset,
} from '../../shared/fanoutPreset';

export function getFanoutPresetsPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'fanout-presets.json');
}

export function loadFanoutPresets(dir?: string): FanoutPreset[] {
  const p = getFanoutPresetsPath(dir);
  if (!fs.existsSync(p)) return FANOUT_PRESET_TEMPLATES.map((t) => ({ ...t, items: t.items.map((i) => ({ ...i })) }));
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { presets?: unknown };
    return normalizeFanoutPresets(raw?.presets);
  } catch {
    return [];
  }
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
): Promise<{ ok: true; presets: FanoutPreset[] } | { ok: false; error: string }> {
  if (!Array.isArray(input)) return { ok: false, error: 'presets must be an array' };
  if (input.length > FANOUT_PRESETS_MAX) return { ok: false, error: `at most ${FANOUT_PRESETS_MAX} presets` };
  const out: FanoutPreset[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const r = normalizeFanoutPreset(raw);
    if (!r.ok) return { ok: false, error: r.error };
    const key = fanoutPresetKey(r.preset.name);
    if (seen.has(key)) return { ok: false, error: `two presets are named "${r.preset.name}"` };
    seen.add(key);
    out.push(r.preset);
  }
  await atomicWriteJSON(getFanoutPresetsPath(dir), { presets: out });
  return { ok: true, presets: out };
}
