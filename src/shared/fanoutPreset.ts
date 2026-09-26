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

/** Why a CLI is listed but not selectable. */
export type FanoutDisabledCode = 'unverified';

/**
 * Every refusal the validators below can give, as a code + params. `error`
 * (English) goes over the wire and into logs; the Settings UI translates the
 * code instead, so a ko/pl operator never reads an English sentence.
 */
export type FanoutIssueCode =
  | 'not-object'
  | 'unknown-field'
  | 'agent-unknown'
  | 'agent-unavailable'
  | 'model-not-string'
  | 'model-invalid'
  | 'model-unsupported'
  | 'name-invalid'
  | 'name-reserved'
  | 'rows-empty'
  | 'rows-over-cap'
  | 'folder-invalid'
  | 'folder-reserved'
  | 'duplicate-name'
  | 'presets-not-array'
  | 'presets-over-cap';

export interface FanoutIssue {
  code: FanoutIssueCode;
  params: Record<string, string>;
  /** English, for the wire and logs. */
  error: string;
}

function issue(code: FanoutIssueCode, params: Record<string, string>, error: string): FanoutIssue {
  return { code, params, error };
}

/** One agent CLI as fan-out knows it. */
export interface FanoutAgentSpec {
  /** Launcher stem, as typed in a pane. */
  stem: string;
  /** Display name. */
  label: string;
  /** Verified end to end — may be named by a preset row or a caller. */
  selectable: boolean;
  /** Why it is not selectable, in English (wire messages). */
  disabledReason?: string;
  /** The same reason as a code the Settings UI translates. */
  disabledCode?: FanoutDisabledCode;
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
    disabledCode: 'unverified',
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
): { ok: true; choice: FanoutAgentChoice } | ({ ok: false } & FanoutIssue) {
  const fail = (i: FanoutIssue): { ok: false } & FanoutIssue => ({ ok: false, ...i });
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail(issue('not-object', {}, 'must be an object { agent, model? }'));
  }
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (key !== 'agent' && key !== 'model' && !(opts.allowUnattended && key === 'unattended')) {
      const field = key.slice(0, 40);
      return fail(issue('unknown-field', { field }, `unknown field "${field}" (only agent and model are accepted)`));
    }
  }
  const agent = typeof src.agent === 'string' ? src.agent.trim().slice(0, 48) : '';
  const spec = fanoutAgentSpec(agent);
  const choices = selectableFanoutAgents().join(', ');
  if (!spec) {
    return fail(issue('agent-unknown', { agent, choices }, `unknown agent "${agent}" — use one of ${choices}`));
  }
  if (!spec.selectable) {
    return fail(
      issue(
        'agent-unavailable',
        { agent, reason: spec.disabledCode ?? 'unverified' },
        `agent "${agent}" is not available for fan-out: ${spec.disabledReason ?? 'not verified'}`,
      ),
    );
  }
  const choice: FanoutAgentChoice = { agent };
  if (src.model !== undefined && src.model !== null && src.model !== '') {
    if (typeof src.model !== 'string') return fail(issue('model-not-string', {}, 'model must be a string'));
    const model = src.model.trim();
    if (model.length > ROLE_BINDING_MODEL_MAX || !FANOUT_MODEL_RE.test(model)) {
      const shown = model.slice(0, 80);
      return fail(
        issue(
          'model-invalid',
          { model: shown, max: String(ROLE_BINDING_MODEL_MAX) },
          `model "${shown}" is not a single model id (letters/digits first, then . _ : -; max ${ROLE_BINDING_MODEL_MAX})`,
        ),
      );
    }
    if (!spec.modelFlag) {
      return fail(
        issue('model-unsupported', { agent }, `agent "${agent}" has no verified model flag, so a model cannot be pinned for it`),
      );
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

/** The launcher stem of a command line's first word (`/x/codex.exe …` → `codex`). */
export function commandLauncherStem(command: string): string {
  const first = /^\s*(\S+)/.exec(command)?.[1] ?? '';
  return (first.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/**
 * `-c projects={<cwd>={trust_level=...}}` as one shell word, or undefined when
 * it cannot be spelled safely.
 *
 * POSIX: a TOML basic string inside a single-quoted shell word (verified live).
 *
 * win32 (the pane shell is PowerShell): Windows PowerShell 5.1's legacy native
 * argument passing drops the `"` inside an argument (the reason
 * buildInitialCommand carries PS_LEGACY_ARGV_QUOTE), so a basic string would
 * reach codex as broken TOML. TOML literal strings use `'` and need no
 * escaping, and inside a PowerShell single-quoted word `'` is written `''` —
 * so no `"` is ever on the line. A path that itself contains `'` cannot be a
 * TOML literal string; the override is then left off (the task opens on
 * codex's trust screen instead of launching on a mangled argument).
 */
export function codexTrustOverride(cwd: string, platform: string): string | undefined {
  if (platform === 'win32') {
    if (cwd.includes("'")) return undefined;
    const toml = `projects={'${cwd}'={trust_level='trusted'}}`;
    return `-c '${toml.replace(/'/g, "''")}'`;
  }
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
  /** The pane's platform (the renderer passes electronAPI.platform). */
  platform: string,
): string {
  const spec = fanoutAgentSpec(choice.agent);
  if (!spec) return command;
  const m = /^\s*(\S+)/.exec(command);
  if (!m) return command;
  if (commandLauncherStem(command) !== spec.stem) return command;
  const parts: string[] = [];
  if (spec.stem === 'codex' && cwd) {
    const trust = codexTrustOverride(cwd, platform);
    if (trust) parts.push(trust);
  }
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

/**
 * Names Windows refuses as a file or folder name, with or without an
 * extension (`nul`, `con.txt`), plus a trailing dot or space, which Windows
 * silently strips — so `image.` and `image` would be the same folder.
 */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_RE.test(name) || /[. ]$/.test(name);
}

/** Default output folder for a preset name (never a Windows-reserved name). */
export function fanoutPresetFolderSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, FOLDER_MAX);
  if (slug.length === 0) return 'preset';
  return isWindowsReservedName(slug) ? `${slug}-preset` : slug;
}

/** The output folder a preset's batches land in (one segment). */
export function fanoutPresetOutputFolder(preset: FanoutPreset): string {
  return preset.outputFolder ?? fanoutPresetFolderSlug(preset.name);
}

/**
 * One preset from untrusted input (the Settings write, or a hand-edited file).
 * Returns the reason on refusal — English in `error`, translatable in
 * `code`/`params` (`row` is 1-based when the issue is in an agent row).
 */
export function normalizeFanoutPreset(
  input: unknown,
): { ok: true; preset: FanoutPreset } | ({ ok: false } & FanoutIssue) {
  const fail = (i: FanoutIssue): { ok: false } & FanoutIssue => ({ ok: false, ...i });
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail(issue('not-object', {}, 'preset must be an object'));
  }
  const src = input as Record<string, unknown>;
  const name = typeof src.name === 'string' ? src.name.trim() : '';
  const max = String(FANOUT_PRESET_NAME_MAX);
  if (!name || name.length > FANOUT_PRESET_NAME_MAX || !NAME_RE.test(name)) {
    return fail(issue('name-invalid', { max }, `name must be 1-${max} characters: letters, digits, space . _ -`));
  }
  if (isWindowsReservedName(name)) {
    return fail(issue('name-reserved', { name }, `name "${name}" is reserved on Windows (con, nul, com1…, or a trailing dot)`));
  }
  const rawItems = Array.isArray(src.items) ? src.items : [];
  if (rawItems.length === 0) return fail(issue('rows-empty', { name }, `preset "${name}" has no agent rows`));
  if (rawItems.length > FANOUT_MAX_TASKS) {
    const count = String(rawItems.length);
    const cap = String(FANOUT_MAX_TASKS);
    return fail(issue('rows-over-cap', { name, count, cap }, `preset "${name}" has ${count} rows; the cap is ${cap}`));
  }
  const items: FanoutAgentChoice[] = [];
  for (const [k, raw] of rawItems.entries()) {
    const v = validateFanoutAgentChoice(raw, { allowUnattended: true });
    if (!v.ok) {
      return fail({ code: v.code, params: { ...v.params, name, row: String(k + 1) }, error: `preset "${name}" row ${k + 1}: ${v.error}` });
    }
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
      return fail(issue('folder-invalid', { name }, `preset "${name}": output folder must be one name (letters, digits, . _ -)`));
    }
    if (isWindowsReservedName(folder)) {
      return fail(
        issue('folder-reserved', { name, folder }, `preset "${name}": output folder "${folder}" is reserved on Windows`),
      );
    }
    preset.outputFolder = folder;
  }
  return { ok: true, preset };
}

/** A preset the loader could not keep, and why (shown in Settings). */
export interface FanoutPresetDropped {
  /** The entry's name, when it had a readable one. */
  name?: string;
  issue: FanoutIssue;
}

/**
 * A whole preset list from untrusted input: bad entries and duplicate names
 * are dropped (first wins), the count is capped. Never throws. What was
 * dropped is REPORTED, not just skipped — Settings saves the whole list, so a
 * silently dropped row would otherwise be deleted from disk on the next save.
 */
export function normalizeFanoutPresetsReport(input: unknown): { presets: FanoutPreset[]; dropped: FanoutPresetDropped[] } {
  const presets: FanoutPreset[] = [];
  const dropped: FanoutPresetDropped[] = [];
  if (!Array.isArray(input)) return { presets, dropped };
  const seen = new Set<string>();
  const nameOf = (raw: unknown): string | undefined => {
    const n = (raw as { name?: unknown } | null)?.name;
    return typeof n === 'string' && n.trim() ? n.trim().slice(0, FANOUT_PRESET_NAME_MAX) : undefined;
  };
  for (const raw of input) {
    if (presets.length >= FANOUT_PRESETS_MAX) {
      const cap = String(FANOUT_PRESETS_MAX);
      dropped.push({ ...withName(nameOf(raw)), issue: issue('presets-over-cap', { cap }, `more than ${cap} presets`) });
      continue;
    }
    const r = normalizeFanoutPreset(raw);
    if (!r.ok) {
      dropped.push({ ...withName(nameOf(raw)), issue: { code: r.code, params: r.params, error: r.error } });
      continue;
    }
    const key = fanoutPresetKey(r.preset.name);
    if (seen.has(key)) {
      dropped.push({
        name: r.preset.name,
        issue: issue('duplicate-name', { name: r.preset.name }, `two presets are named "${r.preset.name}"`),
      });
      continue;
    }
    seen.add(key);
    presets.push(r.preset);
  }
  return { presets, dropped };
}

function withName(name: string | undefined): { name?: string } {
  return name ? { name } : {};
}

/** {@link normalizeFanoutPresetsReport} without the report. */
export function normalizeFanoutPresets(input: unknown): FanoutPreset[] {
  return normalizeFanoutPresetsReport(input).presets;
}

/**
 * One task's agent choice as the approval preview and the audit print it —
 * everything that changes what the CLI is allowed to do, including codex's
 * one-session trust of its task folder.
 */
export function describeFanoutAgentChoice(c: FanoutAgentChoice): string {
  const spec = fanoutAgentSpec(c.agent);
  return [
    c.agent,
    c.agent === 'codex' ? '-c projects.<task folder>.trust_level=trusted' : '',
    c.model ? `--model ${c.model}` : '',
    c.unattended && spec?.unattendedFlags ? spec.unattendedFlags : '',
  ]
    .filter((p) => p.length > 0)
    .join(' ');
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
