// ─── Fan-out agents and presets ──────────────────────────────────────────────
//
// A fan-out task can run on an agent CLI other than the default, chosen two ways:
//
//   preset: <name>          — an operator-defined list in Settings (agent + model
//                             per row, worktree on/off, output folder,
//                             per-CLI unattended toggle).
//   agents: [{agent, model}] — named by the caller, index-aligned with titles.
//
// Neither carries a command string. The agent is a slug from the CLOSED table
// below, the model is a single token, and there is no `args`. Both become a
// RoleBinding that the renderer feeds through the same launch rewrite a role
// binding uses (marker strip → applyRoleAgent → withRoleBinding → permission
// flags → marker re-attach), so a fan-out never assembles a second kind of
// command line.
//
// The table is the per-CLI verification record. An agent is `selectable` only
// once it was verified end to end on a real machine: its first prompt runs from
// argv, its unattended flags let it act without a keypress, and a file it was
// asked to write landed in the task's folder. Anything else is listed with the
// reason it is not selectable, and is refused rather than launched on a guess.

import { KNOWN_AGENT_STEMS, ROLE_BINDING_MODEL_MAX, type RoleBinding } from './orchestratorRole';
import { FANOUT_MAX_TASKS } from './workTask';

/** One agent CLI as fan-out knows it. */
export interface FanoutAgentSpec {
  /** Launcher stem, as typed in a pane. */
  stem: string;
  /** Display name. */
  label: string;
  /** Verified end to end — may be named by a preset row or a caller. */
  selectable: boolean;
  /** Why it is not selectable (shown next to the disabled option). */
  disabledReason?: string;
  /** The CLI's `--model <m>` grammar is verified, so a model may be pinned. */
  modelFlag: boolean;
  /**
   * Flags inserted right after the launcher when the preset row turns
   * unattended mode on. Empty for claude: its worker permission mode is the
   * existing Settings → Agents switch and applies to every claude worker.
   */
  unattendedFlags: string;
}

/**
 * Verified 2026-09-26 on macOS (claude 2.x, codex-cli 0.157.0, grok 1.0.30):
 * each launched as `<cli> [flags] "<prompt>"` in an empty non-repo folder and
 * asked to write hello.txt.
 */
export const FANOUT_AGENTS: readonly FanoutAgentSpec[] = [
  { stem: 'claude', label: 'Claude Code', selectable: true, modelFlag: true, unattendedFlags: '' },
  { stem: 'codex', label: 'Codex', selectable: true, modelFlag: true, unattendedFlags: '-a never -s workspace-write' },
  { stem: 'grok', label: 'Grok', selectable: true, modelFlag: true, unattendedFlags: '--permission-mode bypassPermissions' },
  {
    stem: 'gemini',
    label: 'Gemini CLI',
    selectable: false,
    disabledReason: 'not verified end to end yet (first prompt, unattended flag, trust screen)',
    modelFlag: false,
    unattendedFlags: '',
  },
];

/** Stems fan-out may launch that the generic role-binding rewrite does not know
 *  (it recognises KNOWN_AGENT_STEMS only). Passed to it as an allow list, so
 *  `grok` is a fan-out-only launcher, not a new agent identity. */
export const FANOUT_EXTRA_AGENT_STEMS: ReadonlySet<string> = new Set(
  FANOUT_AGENTS.map((a) => a.stem).filter((s) => !KNOWN_AGENT_STEMS.has(s)),
);

export function fanoutAgentSpec(stem: string): FanoutAgentSpec | undefined {
  return FANOUT_AGENTS.find((a) => a.stem === stem);
}

/** The selectable stems, for error messages and the Settings dropdown. */
export function selectableFanoutAgents(): string[] {
  return FANOUT_AGENTS.filter((a) => a.selectable).map((a) => a.stem);
}

/**
 * A model is one opaque token whose FIRST character is alphanumeric. The
 * generic role-binding check (`^[A-Za-z0-9._:-]+$`) accepts `-m` and
 * `--dangerously-skip-permissions`, which would land on the command line as a
 * flag; a leading letter or digit makes that impossible.
 */
export const FANOUT_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** One task's agent choice (a preset row, or a caller's `agents[k]`). */
export interface FanoutAgentChoice {
  agent: string;
  model?: string;
  /** Non-claude only: insert the CLI's unattended flags. Preset rows only. */
  unattended?: boolean;
}

/**
 * Validate one agent choice from untrusted input. Refuses — never drops — a
 * field it cannot honour: a model on a CLI without a verified model flag is an
 * error, because launching without it would run a different model than the
 * caller or operator asked for.
 */
export function validateFanoutAgentChoice(
  input: unknown,
  opts: { allowUnattended?: boolean } = {},
): { ok: true; choice: FanoutAgentChoice } | { ok: false; error: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'must be an object { agent, model? }' };
  }
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (key !== 'agent' && key !== 'model' && !(opts.allowUnattended && key === 'unattended')) {
      return { ok: false, error: `unknown field "${key}" (only agent and model are accepted)` };
    }
  }
  const agent = typeof src.agent === 'string' ? src.agent.trim() : '';
  const spec = fanoutAgentSpec(agent);
  if (!spec) {
    return { ok: false, error: `unknown agent "${agent}" — use one of ${selectableFanoutAgents().join(', ')}` };
  }
  if (!spec.selectable) {
    return { ok: false, error: `agent "${agent}" is not available for fan-out: ${spec.disabledReason ?? 'not verified'}` };
  }
  const choice: FanoutAgentChoice = { agent };
  if (src.model !== undefined && src.model !== null && src.model !== '') {
    if (typeof src.model !== 'string') return { ok: false, error: 'model must be a string' };
    const model = src.model.trim();
    if (model.length > ROLE_BINDING_MODEL_MAX || !FANOUT_MODEL_RE.test(model)) {
      return {
        ok: false,
        error: `model "${model.slice(0, 80)}" is not a single model id (letters/digits first, then . _ : -; max ${ROLE_BINDING_MODEL_MAX})`,
      };
    }
    if (!spec.modelFlag) {
      return { ok: false, error: `agent "${agent}" has no verified model flag, so a model cannot be pinned for it` };
    }
    choice.model = model;
  }
  if (opts.allowUnattended && src.unattended === true && spec.unattendedFlags.length > 0) {
    choice.unattended = true;
  }
  return { ok: true, choice };
}

/** The RoleBinding a choice becomes on the launch path. */
export function fanoutChoiceBinding(choice: FanoutAgentChoice): RoleBinding {
  return choice.model ? { agent: choice.agent, model: choice.model } : { agent: choice.agent };
}

// ─── Launch flags the role rewrite does not cover ────────────────────────────

/** TOML basic string, then a POSIX single-quoted shell word. */
function codexTrustOverride(cwd: string): string {
  const toml = `projects={"${cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"={trust_level="trusted"}}`;
  return `-c '${toml.replace(/'/g, "'\\''")}'`;
}

/**
 * Per-CLI flags inserted right after the launcher token (both CLIs are
 * `[OPTIONS] [PROMPT]`, so a flag after the quoted prompt would be read as
 * part of it):
 *
 *  - codex: the task folder is new, so codex opens on "Trust this folder?" and
 *    the first prompt never runs. A `-c projects=…` override trusts exactly the
 *    task's cwd for this session only — nothing is written to ~/.codex. Added
 *    whenever the cwd is known. Unattended adds `-a never -s workspace-write`.
 *  - grok: no trust screen observed. Unattended adds
 *    `--permission-mode bypassPermissions`.
 *  - claude: nothing here — its trust screen is CLAUDE_CODE_SANDBOXED (main) and
 *    its permission flags are applyWorkerPermissionFlags.
 *
 * Only a command whose launcher IS `agent` is touched.
 */
export function applyFanoutAgentFlags(
  command: string,
  choice: FanoutAgentChoice,
  cwd: string,
): string {
  const spec = fanoutAgentSpec(choice.agent);
  if (!spec) return command;
  const m = /^\s*(\S+)/.exec(command);
  if (!m) return command;
  const launcher = m[1];
  const stem = (launcher.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (stem !== spec.stem) return command;
  const parts: string[] = [];
  if (spec.stem === 'codex' && cwd) parts.push(codexTrustOverride(cwd));
  if (choice.unattended && spec.unattendedFlags) parts.push(spec.unattendedFlags);
  if (parts.length === 0) return command;
  const at = m.index + m[0].length;
  return `${command.slice(0, at)} ${parts.join(' ')}${command.slice(at)}`;
}

// ─── Presets (operator data) ─────────────────────────────────────────────────

export interface FanoutPreset {
  /** Unique (case-insensitive) name the caller passes as `preset`. */
  name: string;
  description?: string;
  /** Task k runs on items[k]; a fan-out with more titles than items is refused. */
  items: FanoutAgentChoice[];
  /** false = no git worktree: each task gets its own folder under outputs/. */
  worktree: boolean;
  /** worktree:false only — the folder under `<wmux data>/outputs/` the batches
   *  land in. One path segment; defaults to the name's slug. */
  outputFolder?: string;
}

export const FANOUT_PRESET_NAME_MAX = 40;
export const FANOUT_PRESET_DESCRIPTION_MAX = 200;
export const FANOUT_PRESETS_MAX = 32;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FOLDER_MAX = 64;

/** Lookup key for a preset name. */
export function fanoutPresetKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Default output folder for a preset name. */
export function fanoutPresetFolderSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, FOLDER_MAX);
  return slug.length > 0 ? slug : 'preset';
}

/** The output folder a preset's batches land in (one segment). */
export function fanoutPresetOutputFolder(preset: FanoutPreset): string {
  return preset.outputFolder ?? fanoutPresetFolderSlug(preset.name);
}

/**
 * One preset from untrusted input (the Settings write, or a hand-edited file).
 * Returns the reason on refusal so the Settings UI can show it.
 */
export function normalizeFanoutPreset(input: unknown): { ok: true; preset: FanoutPreset } | { ok: false; error: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'preset must be an object' };
  }
  const src = input as Record<string, unknown>;
  const name = typeof src.name === 'string' ? src.name.trim() : '';
  if (!name || name.length > FANOUT_PRESET_NAME_MAX || !NAME_RE.test(name)) {
    return { ok: false, error: `name must be 1-${FANOUT_PRESET_NAME_MAX} characters: letters, digits, space . _ -` };
  }
  const rawItems = Array.isArray(src.items) ? src.items : [];
  if (rawItems.length === 0) return { ok: false, error: `preset "${name}" has no agent rows` };
  if (rawItems.length > FANOUT_MAX_TASKS) {
    return { ok: false, error: `preset "${name}" has ${rawItems.length} rows; the cap is ${FANOUT_MAX_TASKS}` };
  }
  const items: FanoutAgentChoice[] = [];
  for (const [k, raw] of rawItems.entries()) {
    const v = validateFanoutAgentChoice(raw, { allowUnattended: true });
    if (!v.ok) return { ok: false, error: `preset "${name}" row ${k + 1}: ${v.error}` };
    items.push(v.choice);
  }
  const worktree = src.worktree !== false;
  const preset: FanoutPreset = { name, items, worktree };
  if (typeof src.description === 'string') {
    // eslint-disable-next-line no-control-regex -- single line, no control chars
    const d = src.description.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, FANOUT_PRESET_DESCRIPTION_MAX);
    if (d) preset.description = d;
  }
  if (!worktree && typeof src.outputFolder === 'string' && src.outputFolder.trim()) {
    const folder = src.outputFolder.trim();
    if (folder.length > FOLDER_MAX || !FOLDER_RE.test(folder)) {
      return { ok: false, error: `preset "${name}": output folder must be one name (letters, digits, . _ -)` };
    }
    preset.outputFolder = folder;
  }
  return { ok: true, preset };
}

/** A whole preset list from untrusted input: bad entries and duplicate names
 *  are dropped (first wins), the count is capped. Never throws. */
export function normalizeFanoutPresets(input: unknown): FanoutPreset[] {
  if (!Array.isArray(input)) return [];
  const out: FanoutPreset[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= FANOUT_PRESETS_MAX) break;
    const r = normalizeFanoutPreset(raw);
    if (!r.ok) continue;
    const key = fanoutPresetKey(r.preset.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.preset);
  }
  return out;
}

/** Shipped when no preset file exists yet: agents filled, models blank,
 *  unattended off, no worktree. */
export const FANOUT_PRESET_TEMPLATES: readonly FanoutPreset[] = [
  {
    name: 'Image',
    description: 'Same image prompt on several agents; compare the files side by side.',
    items: [{ agent: 'claude' }, { agent: 'codex' }, { agent: 'grok' }],
    worktree: false,
  },
  {
    name: 'Video',
    description: 'Same video prompt on several agents; compare the files side by side.',
    items: [{ agent: 'claude' }, { agent: 'codex' }, { agent: 'grok' }],
    worktree: false,
  },
];
