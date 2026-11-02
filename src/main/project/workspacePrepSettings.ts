/**
 * Main side of the "New workspace setup" section: read what a project's
 * wmux.json declares for new worktrees, list the git-ignored files the user
 * can pick, suggest a setup command from the lockfile, and save.
 *
 * Saving is the user's trust approval: the bytes written are trusted at once
 * (projectConfigWrite.ts, which also refuses to save over a file the user
 * has not reviewed).
 *
 * Only `fanout.copy`, `fanout.setup`, `fanout.portRange` and
 * `fanout.copyIntoAutomated` are changed; every other key of the file is kept
 * as it was. Nothing here logs a file's content or a candidate's name.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { git as runGit } from '../git/git';
import {
  WMUX_PROJECT_CONFIG_FILENAME,
  PROJECT_FANOUT_MAX_COPY,
  normFanoutCopyPath,
  normalizeWmuxProjectConfig,
  parseFanoutPortRange,
  type WmuxProjectConfig,
} from '../../shared/wmuxProjectConfig';
import { locateProjectConfig, saveBlock, writeProjectConfig, type ProjectConfigWriteDeps } from './projectConfigWrite';
import { WORKSPACE_PROFILE_COMMAND_MAX } from '../../shared/types';
import {
  WORKSPACE_PREP_MAX_CANDIDATES,
  isDefaultCopyCandidate,
  type WorkspacePrepSaveResult,
  type WorkspacePrepSettings,
  type WorkspacePrepSettingsView,
} from '../../shared/workspacePrepSettings';

/** Largest file offered as a candidate: config files are small; a big ignored
 *  file is a build output or a database, not a setting. */
const MAX_CANDIDATE_BYTES = 1024 * 1024;

export type WorkspacePrepSettingsDeps = ProjectConfigWriteDeps;

/** Lockfile → install command, first match wins (checked in this order). */
const LOCKFILE_SETUP: ReadonlyArray<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
  ['yarn.lock', 'yarn install'],
  ['package-lock.json', 'npm ci'],
  ['uv.lock', 'uv sync'],
  ['poetry.lock', 'poetry install'],
  ['Pipfile.lock', 'pipenv sync'],
  ['Gemfile.lock', 'bundle install'],
  ['composer.lock', 'composer install'],
  ['Cargo.lock', 'cargo fetch'],
  ['go.sum', 'go mod download'],
];

export function suggestSetupCommand(root: string): string | undefined {
  for (const [file, command] of LOCKFILE_SETUP) {
    try {
      if (fs.statSync(path.join(root, file)).isFile()) return command;
    } catch {
      // not this one
    }
  }
  return undefined;
}

/**
 * Git-ignored plain files under `root`, project-relative with forward
 * slashes: what a new worktree would not get from git. Ignored directories
 * (node_modules, build output) are collapsed by git and left out. Files the
 * copy list already declares come first, then `.env*`.
 */
export async function listCopyCandidates(
  root: string,
  gitRun: NonNullable<WorkspacePrepSettingsDeps['git']> = runGit,
  declared: readonly string[] = [],
): Promise<string[]> {
  const r = await gitRun(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'], root);
  if (r.code !== 0) return [];
  const out: string[] = [];
  for (const raw of r.stdout.split('\0')) {
    if (raw.length === 0 || raw.endsWith('/')) continue;
    const rel = normFanoutCopyPath(raw);
    if (rel === undefined || rel === WMUX_PROJECT_CONFIG_FILENAME) continue;
    try {
      const st = fs.lstatSync(path.join(root, ...rel.split('/')));
      if (!st.isFile() || st.size > MAX_CANDIDATE_BYTES) continue;
    } catch {
      continue;
    }
    out.push(rel);
  }
  // Sorted before the cap, so a declared file or a `.env` deep in a big tree
  // is never cut (a cut declared file would read as missing).
  const rank = (f: string) => (declared.includes(f) ? 2 : isDefaultCopyCandidate(f) ? 1 : 0);
  return out
    .sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))
    .slice(0, WORKSPACE_PREP_MAX_CANDIDATES);
}

/** Whether the file names `fanout.copy` at all (an empty list is a choice:
 *  copy nothing, so the `.env` defaults are not ticked again). */
function copyKeyPresent(configPath: string | undefined): boolean {
  if (!configPath) return false;
  try {
    const doc = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { fanout?: { copy?: unknown } };
    return doc?.fanout !== null && typeof doc?.fanout === 'object' && doc.fanout.copy !== undefined;
  } catch {
    return false;
  }
}

function settingsOf(config: WmuxProjectConfig | undefined): WorkspacePrepSettings {
  const f = config?.fanout;
  return {
    copy: f?.copy ?? [],
    setup: f?.setup ?? '',
    portRange: f?.portRange ? `${f.portRange.min}-${f.portRange.max}` : '',
    copyIntoAutomated: f?.copyIntoAutomated === true,
  };
}

export async function readWorkspacePrepSettings(cwd: string, deps: WorkspacePrepSettingsDeps): Promise<WorkspacePrepSettingsView> {
  const empty: WorkspacePrepSettings = { copy: [], setup: '', portRange: '', copyIntoAutomated: false };
  const found = await locateProjectConfig(cwd, deps);
  if (!found) return { exists: false, settings: empty, copyUnset: true, candidates: [], saveBlocked: 'no-project' };
  const { state, dir } = found;
  const settings = settingsOf(state.config);
  const candidates = await listCopyCandidates(dir, deps.git ?? runGit, settings.copy);
  const suggestedSetup = suggestSetupCommand(dir);
  const blocked = saveBlock(state, { copy: true });
  return {
    root: dir,
    ...(state.found && state.contentHash ? { contentHash: state.contentHash } : {}),
    exists: state.found === true,
    settings,
    copyUnset: state.config?.fanout?.copy === undefined && !copyKeyPresent(state.found ? state.configPath : undefined),
    candidates,
    ...(suggestedSetup ? { suggestedSetup } : {}),
    ...(blocked ? { saveBlocked: blocked } : {}),
  };
}

/** Validate what the renderer sent; undefined when anything is off. */
export function parseWorkspacePrepSettings(raw: unknown): WorkspacePrepSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.copy) || typeof r.setup !== 'string' || typeof r.portRange !== 'string' || typeof r.copyIntoAutomated !== 'boolean') return undefined;
  if (r.copy.length > PROJECT_FANOUT_MAX_COPY) return undefined;
  const copy: string[] = [];
  for (const entry of r.copy) {
    const norm = normFanoutCopyPath(entry);
    if (norm === undefined) return undefined;
    if (!copy.includes(norm)) copy.push(norm);
  }
  if (r.setup.length > WORKSPACE_PROFILE_COMMAND_MAX) return undefined;
  const portRange = r.portRange.trim();
  if (portRange.length > 0 && !parseFanoutPortRange(portRange).ok) return undefined;
  return { copy, setup: r.setup.trim().length > 0 ? r.setup : '', portRange, copyIntoAutomated: r.copyIntoAutomated };
}

/**
 * Write the section's settings into wmux.json and trust the written bytes.
 * `expectedHash` is the hash the section showed (absent: it showed no file);
 * a file changed since then is not overwritten ('changed').
 */
export async function saveWorkspacePrepSettings(
  cwd: string,
  input: WorkspacePrepSettings,
  expectedHash: string | undefined,
  deps: WorkspacePrepSettingsDeps,
): Promise<WorkspacePrepSaveResult> {
  const edit = (doc: Record<string, unknown>): boolean => {
    const prevFanout = doc.fanout && typeof doc.fanout === 'object' && !Array.isArray(doc.fanout) ? { ...(doc.fanout as Record<string, unknown>) } : {};
    const fanout: Record<string, unknown> = { ...prevFanout };
    for (const key of ['copy', 'setup', 'portRange', 'copyIntoAutomated']) delete fanout[key];
    if (input.portRange) fanout.portRange = input.portRange;
    if (input.setup) fanout.setup = input.setup;
    // An empty list is kept: "copy nothing" is remembered as a choice.
    fanout.copy = input.copy;
    if (input.copyIntoAutomated) fanout.copyIntoAutomated = true;
    if (Object.keys(fanout).length > 0) doc.fanout = fanout;
    else delete doc.fanout;

    // The result must read back as exactly what was asked for.
    const check = normalizeWmuxProjectConfig(doc);
    return !!check && (check.fanout?.invalidFields?.length ?? 0) === 0;
  };
  // The unattended reboot consent was given for the layout and the company
  // review for the company; this save touches neither, so both carry over
  // from bytes that were trusted. This is the one deliberate exception to
  // setDecision's "pass the consent every time" rule: the changed bytes are
  // fanout keys only.
  return writeProjectConfig(cwd, expectedHash, edit, (prior) => prior, { copy: true }, deps);
}
