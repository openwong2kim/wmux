/**
 * Writing a project's wmux.json from wmux, where saving is the user's trust
 * approval of the bytes written: the "New workspace setup" section
 * (workspacePrepSettings.ts) and a company saved from the New company dialog
 * (projectCompany.ts).
 *
 * Approving on save is only sound when the user can see everything the file
 * would run. A file holding commands, a layout, a setup command or a company
 * the user has not approved is therefore never saved over from here
 * ('review-first'): it is reviewed in the trust dialog first, so a save can
 * never approve somebody else's file unseen. Every key the edit does not
 * touch is kept as it was. Nothing here logs a file's content.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { git as runGit, type GitResult } from '../git/git';
import {
  WMUX_PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_MAX_FILE_BYTES,
  normalizeWmuxProjectConfig,
  type ProjectConfigState,
  type WmuxProjectConfig,
} from '../../shared/wmuxProjectConfig';

/** What a trust grant holds beyond the bytes it approves. */
export interface ProjectTrustGrant {
  /** The unattended reboot consent (ProjectTrustRecord.unattended). */
  unattended: boolean;
  /** The grant showed the company (ProjectTrustRecord.companyReviewed). */
  companyReviewed: boolean;
}

export interface ProjectConfigWriteDeps {
  getState: (cwd: string) => Promise<ProjectConfigState>;
  setTrusted: (root: string, contentHash: string, grant: ProjectTrustGrant) => Promise<void>;
  /** The grant on these bytes; both false unless they are trusted. */
  grantFor: (root: string, contentHash: string) => Promise<ProjectTrustGrant>;
  git?: (args: string[], cwd: string) => Promise<GitResult>;
}

/** Why a save over the current file is refused. */
export type ProjectConfigSaveBlock = 'review-first' | 'invalid' | 'no-project';

export type ProjectConfigWriteResult =
  | { ok: true; contentHash: string }
  | { ok: false; error: 'changed' | 'invalid-input' | ProjectConfigSaveBlock | 'write-failed'; detail?: string };

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** The file still holds the bytes with this hash (absent: there is no file). */
function sameBytes(configPath: string, hash: string | undefined): boolean {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(configPath);
  } catch (err) {
    return hash === undefined && (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  return hash !== undefined && sha256Hex(bytes) === hash;
}

/** One folder however it is spelled: symlinks resolved, case folded on Windows. */
export function sameFolder(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const x = real(a);
  const y = real(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** One wmux.json however its folder is spelled. */
function sameConfigFile(a: string, b: string): boolean {
  return path.basename(a) === path.basename(b) && sameFolder(path.dirname(a), path.dirname(b));
}

/** The file's top-level object as it is on disk, or undefined when it cannot be read as one. */
export function readConfigDoc(configPath: string): Record<string, unknown> | undefined {
  try {
    const st = fs.lstatSync(configPath);
    if (!st.isFile() || st.size > PROJECT_CONFIG_MAX_FILE_BYTES) return undefined;
    const bytes = fs.readFileSync(configPath);
    if (bytes.length > PROJECT_CONFIG_MAX_FILE_BYTES) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Where the project's wmux.json is (or would be): the discovered file, else
 *  the checkout's top. */
export async function locateProjectConfig(
  cwd: string,
  deps: Pick<ProjectConfigWriteDeps, 'getState' | 'git'>,
): Promise<{ state: ProjectConfigState; dir: string } | null> {
  const state = await deps.getState(cwd).catch((): ProjectConfigState => ({ found: false }));
  if (state.found && state.configPath) return { state, dir: path.dirname(state.configPath) };
  const top = await (deps.git ?? runGit)(['rev-parse', '--show-toplevel'], cwd);
  if (top.code !== 0) return null;
  return { state, dir: path.resolve(top.stdout.trim()) };
}

/** What a save puts in front of the user before it approves: New workspace
 *  setup shows the copy list (and rewrites it); a company save does not. */
export interface SaveShows {
  copy: boolean;
  /** The top-level keys the save shows in full. A file not approved here that
   *  holds any other key, known or not, is reviewed first. */
  only?: readonly string[];
}

/**
 * True when an unapproved file can start something the save did not show:
 * commands, a layout, a setup command, a company somebody else wrote, or a
 * copy list. A one-line field is no place to review a shell command (a long
 * tail or a newline hides in it), so such a file is reviewed in the trust
 * dialog, which shows it verbatim, before wmux may save over it.
 */
function hasRunnables(config: WmuxProjectConfig | undefined, shows: SaveShows): boolean {
  if (!config) return false;
  return config.layout !== undefined || (config.commands?.length ?? 0) > 0 || config.fanout?.setup !== undefined
    || config.company !== undefined || (!shows.copy && (config.fanout?.copy?.length ?? 0) > 0);
}

/** The file holds a top-level key the save does not show. */
function holdsUnshown(doc: Record<string, unknown> | undefined, shows: SaveShows): boolean {
  const only = shows.only;
  return only !== undefined && doc !== undefined && Object.keys(doc).some((key) => !only.includes(key));
}

/** The live bytes are the approved ones (not just a cached verdict). */
function trustedNow(state: ProjectConfigState, liveHash: string | undefined): boolean {
  return state.trust === 'trusted' && liveHash !== undefined && state.contentHash === liveHash;
}

/** Trusted by a decision that never listed the setup command or the copy
 *  list (no review mark): that one re-approval happens in the trust dialog,
 *  which shows them verbatim, not here. */
function awaitsPrepReview(state: ProjectConfigState): boolean {
  const f = state.config?.fanout;
  return state.trust === 'trusted' && state.prepReviewed !== true && (f?.setup !== undefined || (f?.copy?.length ?? 0) > 0);
}

/** Why wmux cannot save over the file (undefined when it can). `doc` is the
 *  file as read (readConfigDoc), for a save that shows only some keys. */
export function saveBlock(state: ProjectConfigState, shows: SaveShows, doc?: Record<string, unknown>): ProjectConfigSaveBlock | undefined {
  if (!state.found) return undefined;
  if (state.invalid) return 'invalid';
  // 'denied' is sticky: the trust dialog is where it is lifted.
  if (state.trust === 'denied') return 'review-first';
  if (state.trust !== 'trusted' && (hasRunnables(state.config, shows) || holdsUnshown(doc, shows))) return 'review-first';
  if (awaitsPrepReview(state)) return 'review-first';
  return undefined;
}

/**
 * Apply `edit` to the wmux.json found from `cwd` and trust the written bytes.
 * `expectedHash` is the hash the user was shown (absent: no file); a file
 * changed since then is not overwritten ('changed'). `edit` changes the
 * parsed document in place and returns false when the result is not what was
 * asked for ('invalid-input'). `grant` turns the grant on the bytes being
 * replaced (both false unless they are trusted) into the one on the new bytes.
 * `shows` is what the save put on screen, which it may approve unreviewed.
 * `expectedPath` is the wmux.json the caller decided to save into; another
 * one found from `cwd` is not written ('changed'). The written bytes are
 * trusted only for the file they were written to.
 */
export async function writeProjectConfig(
  cwd: string,
  expectedHash: string | undefined,
  edit: (doc: Record<string, unknown>) => boolean,
  grant: (prior: ProjectTrustGrant) => ProjectTrustGrant,
  shows: SaveShows,
  deps: ProjectConfigWriteDeps,
  expectedPath?: string,
): Promise<ProjectConfigWriteResult> {
  const found = await locateProjectConfig(cwd, deps);
  if (!found) return { ok: false, error: 'no-project' };
  const configPath = path.join(found.dir, WMUX_PROJECT_CONFIG_FILENAME);
  if (expectedPath !== undefined && !sameConfigFile(configPath, expectedPath)) return { ok: false, error: 'changed' };

  let before: Buffer | null = null;
  try {
    const st = fs.lstatSync(configPath);
    if (!st.isFile() || st.size > PROJECT_CONFIG_MAX_FILE_BYTES) return { ok: false, error: 'invalid' };
    before = fs.readFileSync(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: 'write-failed' };
  }
  const liveHash = before ? sha256Hex(before) : undefined;
  if (liveHash !== expectedHash) return { ok: false, error: 'changed' };

  let doc: Record<string, unknown> = { version: 1 };
  if (before) {
    try {
      const parsed: unknown = JSON.parse(before.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'invalid' };
      doc = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, error: 'invalid' };
    }
    // Re-checked against the bytes about to be replaced, not the view the
    // renderer had: never approve what the user has not reviewed.
    const state: ProjectConfigState = found.state.found ? found.state : { found: true };
    const config = normalizeWmuxProjectConfig(doc);
    if (state.invalid) return { ok: false, error: 'invalid' };
    if (state.trust === 'denied') return { ok: false, error: 'review-first' };
    if (!trustedNow(state, liveHash) && (hasRunnables(config, shows) || holdsUnshown(doc, shows))) return { ok: false, error: 'review-first' };
    if (awaitsPrepReview(state)) return { ok: false, error: 'review-first' };
  }

  if (!edit(doc)) return { ok: false, error: 'invalid-input' };

  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  // A file past the size cap is not read at all: it would stop the rest of it working.
  if (bytes.length > PROJECT_CONFIG_MAX_FILE_BYTES) return { ok: false, error: 'invalid-input' };
  const tmp = path.join(found.dir, `.${WMUX_PROJECT_CONFIG_FILENAME}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    // Checked again right before the swap, so an edit made since the read is not lost.
    if (!sameBytes(configPath, liveHash)) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, error: 'changed' };
    }
    fs.renameSync(tmp, configPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    return { ok: false, error: 'write-failed', detail: (err as NodeJS.ErrnoException).code ?? 'unknown' };
  }
  const contentHash = sha256Hex(bytes);
  // The trust key is the root the store finds from this cwd (it keeps a
  // symlinked spelling git's top resolves away), read back from the file
  // just written.
  const after = await deps.getState(cwd).catch((): ProjectConfigState => ({ found: false }));
  // Something rewrote the file in between, or the bytes read back are another
  // file's: approve nothing rather than guess.
  if (!after.found || after.contentHash !== contentHash || !after.root || !after.configPath || !sameConfigFile(after.configPath, configPath)) {
    return { ok: false, error: 'changed' };
  }
  const root = after.root;
  // What the old grant held carries over only from bytes that were trusted.
  const prior = trustedNow(found.state, liveHash) && liveHash !== undefined
    ? await deps.grantFor(root, liveHash)
    : { unattended: false, companyReviewed: false };
  try {
    await deps.setTrusted(root, contentHash, grant(prior));
  } catch {
    // The file is written but not approved: it reads as untrusted, so
    // nothing in it runs; the caller says the approval did not take.
    return { ok: false, error: 'write-failed', detail: 'trust' };
  }
  return { ok: true, contentHash };
}
