/**
 * A company saved to its folder's wmux.json from the New company dialog
 * (insight 170), and what the dialog reads before it saves.
 *
 * The file names no folder: a company started from it works in the folder
 * the file is in. So a company is saved only into the wmux.json of the
 * folder it was made for ('other-folder' otherwise). Saving trusts the bytes
 * written and marks the company reviewed, since the user wrote it here; the
 * unattended consent carries over from bytes that were trusted
 * (projectConfigWrite.ts). Only the `company` key changes.
 */

import * as path from 'node:path';
import {
  companyFileJson,
  normalizeCompanyFile,
  type CompanyFileSaveResult,
  type CompanyFileView,
} from '../../shared/companyFile';
import { normalizeWmuxProjectConfig, WMUX_PROJECT_CONFIG_FILENAME } from '../../shared/wmuxProjectConfig';
import {
  locateProjectConfig,
  readConfigDoc,
  sameFolder,
  saveBlock,
  writeProjectConfig,
  type ProjectConfigWriteDeps,
  type SaveShows,
} from './projectConfigWrite';

/** The dialog shows the company and nothing else of the file. */
const COMPANY_SAVE_SHOWS: SaveShows = { copy: false, only: ['version', 'company'] };

export async function readProjectCompany(folder: string, deps: ProjectConfigWriteDeps): Promise<CompanyFileView> {
  const found = await locateProjectConfig(folder, deps);
  if (!found) return { exists: false, saveBlocked: 'no-project' };
  const { state, dir } = found;
  const doc = state.found && state.configPath ? readConfigDoc(state.configPath) : undefined;
  const blocked = sameFolder(dir, folder) ? saveBlock(state, COMPANY_SAVE_SHOWS, doc) : 'other-folder';
  return {
    dir,
    exists: state.found === true,
    ...(state.found && state.contentHash ? { contentHash: state.contentHash } : {}),
    ...(state.config?.company ? { company: state.config.company } : {}),
    ...(blocked ? { saveBlocked: blocked } : {}),
  };
}

/**
 * Write `raw` (the `company` key as the file holds it) into the folder's
 * wmux.json and trust the bytes written. `expectedHash` is the hash the
 * dialog read (absent: no file); a file changed since then is not
 * overwritten ('changed').
 */
export async function saveProjectCompany(
  folder: string,
  raw: unknown,
  expectedHash: string | undefined,
  deps: ProjectConfigWriteDeps,
): Promise<CompanyFileSaveResult> {
  const company = normalizeCompanyFile(raw);
  if (!company) return { ok: false, error: 'invalid-input' };
  const found = await locateProjectConfig(folder, deps);
  if (!found) return { ok: false, error: 'no-project' };
  if (!sameFolder(found.dir, folder)) return { ok: false, error: 'other-folder' };
  const json = companyFileJson(company);
  const edit = (doc: Record<string, unknown>): boolean => {
    doc.company = json;
    // The result must read back as exactly the company asked for.
    const check = normalizeWmuxProjectConfig(doc)?.company;
    return check !== undefined && JSON.stringify(companyFileJson(check)) === JSON.stringify(json);
  };
  // Through the folder as given: the trust key is the spelling the store finds
  // from it, which git's top would resolve away for a linked folder. Only into
  // the file the folder check above was made for.
  const grant = (prior: { unattended: boolean }) => ({ unattended: prior.unattended, companyReviewed: true });
  return writeProjectConfig(folder, expectedHash, edit, grant, COMPANY_SAVE_SHOWS, deps, path.join(found.dir, WMUX_PROJECT_CONFIG_FILENAME));
}
