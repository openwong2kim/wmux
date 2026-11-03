// Project config IPC (X5 wmux.json) — thin renderer-facing surface over
// ProjectConfigStore. Both channels are renderer-only (no pipe RPC exposure):
// external MCP clients have no business reading or — far worse — GRANTING
// project trust, so the trust mutation stays behind the first-party IPC
// boundary the same way session.save does.

import * as path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { getProjectConfigStore, type ProjectConfigState } from '../../project/ProjectConfigStore';
import type { ProjectConfigText } from '../../../shared/wmuxProjectConfig';
import {
  parseWorkspacePrepSettings,
  readWorkspacePrepSettings,
  saveWorkspacePrepSettings,
} from '../../project/workspacePrepSettings';
import type { WorkspacePrepSaveResult, WorkspacePrepSettingsView } from '../../../shared/workspacePrepSettings';
import type { ProjectConfigWriteDeps } from '../../project/projectConfigWrite';
import { readProjectCompany, saveProjectCompany } from '../../project/projectCompany';
import type { CompanyFileSaveResult, CompanyFileView } from '../../../shared/companyFile';
import { getWorkspacePrepCards } from '../../worktask/workspacePrepCards';
import { isWorkspacePrepDecision } from '../../../shared/workspacePrepCard';

function writeDeps(): ProjectConfigWriteDeps {
  const store = getProjectConfigStore();
  return {
    getState: (cwd) => store.getState(cwd),
    setTrusted: (root, contentHash, grant) => store.setDecision(root, 'trusted', contentHash, grant.unattended, grant.companyReviewed),
    grantFor: (root, contentHash) => store.grantFor(root, contentHash),
  };
}

const MAX_PATH_LEN = 4096;

/** A company is saved for the absolute folder it was made in. */
function isAbsoluteFolder(folder: unknown): folder is string {
  return typeof folder === 'string' && folder.length > 0 && folder.length <= MAX_PATH_LEN && path.isAbsolute(folder);
}

export function registerProjectConfigHandlers(): () => void {
  ipcMain.removeHandler(IPC.PROJECT_CONFIG_GET);
  ipcMain.handle(IPC.PROJECT_CONFIG_GET, wrapHandler(IPC.PROJECT_CONFIG_GET, async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: unknown,
  ): Promise<ProjectConfigState> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_LEN) {
      return { found: false };
    }
    return getProjectConfigStore().getState(cwd);
  }));

  // The whole file, read now, for the company review's view of it.
  ipcMain.removeHandler(IPC.PROJECT_CONFIG_TEXT);
  ipcMain.handle(IPC.PROJECT_CONFIG_TEXT, wrapHandler(IPC.PROJECT_CONFIG_TEXT, async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: unknown,
  ): Promise<ProjectConfigText | null> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_LEN) return null;
    return getProjectConfigStore().readText(cwd);
  }));

  ipcMain.removeHandler(IPC.PROJECT_CONFIG_SET_TRUST);
  ipcMain.handle(IPC.PROJECT_CONFIG_SET_TRUST, wrapHandler(IPC.PROJECT_CONFIG_SET_TRUST, async (
    _event: Electron.IpcMainInvokeEvent,
    root: unknown,
    decision: unknown,
    contentHash: unknown,
    unattended: unknown,
    companyReviewed: unknown,
  ): Promise<{ ok: boolean }> => {
    if (typeof root !== 'string' || root.length === 0 || root.length > MAX_PATH_LEN) {
      throw new Error('Invalid project root');
    }
    const store = getProjectConfigStore();
    if (decision === 'clear') {
      await store.clearDecision(root);
      return { ok: true };
    }
    if (decision !== 'trusted' && decision !== 'denied') {
      throw new Error('Invalid trust decision');
    }
    if (typeof contentHash !== 'string') throw new Error('Invalid content hash');
    // Unattended reboot-survival consent and the company review are strict
    // opt-in booleans; anything that isn't literally true is treated as no.
    await store.setDecision(root, decision, contentHash, unattended === true, companyReviewed === true);
    return { ok: true };
  }));

  // New workspace setup (renderer-only, like the trust decision: saving
  // approves the written bytes).
  ipcMain.removeHandler(IPC.PROJECT_PREP_GET);
  ipcMain.handle(IPC.PROJECT_PREP_GET, wrapHandler(IPC.PROJECT_PREP_GET, async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: unknown,
  ): Promise<WorkspacePrepSettingsView> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_LEN) {
      return { exists: false, settings: { copy: [], setup: '', portRange: '', copyIntoAutomated: false }, copyUnset: true, candidates: [], saveBlocked: 'no-project' };
    }
    return readWorkspacePrepSettings(cwd, writeDeps());
  }));

  ipcMain.removeHandler(IPC.PROJECT_PREP_SAVE);
  ipcMain.handle(IPC.PROJECT_PREP_SAVE, wrapHandler(IPC.PROJECT_PREP_SAVE, async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: unknown,
    rawSettings: unknown,
    expectedHash: unknown,
  ): Promise<WorkspacePrepSaveResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_LEN) return { ok: false, error: 'no-project' };
    const settings = parseWorkspacePrepSettings(rawSettings);
    if (!settings) return { ok: false, error: 'invalid-input' };
    const hash = typeof expectedHash === 'string' && /^[0-9a-f]{64}$/.test(expectedHash) ? expectedHash : undefined;
    if (expectedHash !== null && expectedHash !== undefined && hash === undefined) return { ok: false, error: 'invalid-input' };
    return saveWorkspacePrepSettings(cwd, settings, hash, writeDeps());
  }));

  // The folder's company (renderer-only, like the trust decision: saving
  // approves the written bytes).
  ipcMain.removeHandler(IPC.PROJECT_COMPANY_GET);
  ipcMain.handle(IPC.PROJECT_COMPANY_GET, wrapHandler(IPC.PROJECT_COMPANY_GET, async (
    _event: Electron.IpcMainInvokeEvent,
    folder: unknown,
  ): Promise<CompanyFileView> => {
    if (!isAbsoluteFolder(folder)) return { exists: false, saveBlocked: 'no-project' };
    return readProjectCompany(folder, writeDeps());
  }));

  ipcMain.removeHandler(IPC.PROJECT_COMPANY_SAVE);
  ipcMain.handle(IPC.PROJECT_COMPANY_SAVE, wrapHandler(IPC.PROJECT_COMPANY_SAVE, async (
    _event: Electron.IpcMainInvokeEvent,
    folder: unknown,
    company: unknown,
    expectedHash: unknown,
  ): Promise<CompanyFileSaveResult> => {
    if (!isAbsoluteFolder(folder)) return { ok: false, error: 'no-project' };
    const hash = typeof expectedHash === 'string' && /^[0-9a-f]{64}$/.test(expectedHash) ? expectedHash : undefined;
    if (expectedHash !== null && expectedHash !== undefined && hash === undefined) return { ok: false, error: 'invalid-input' };
    return saveProjectCompany(folder, company, hash, writeDeps());
  }));

  ipcMain.removeHandler(IPC.WORKSPACE_PREP_LIST);
  ipcMain.handle(IPC.WORKSPACE_PREP_LIST, wrapHandler(IPC.WORKSPACE_PREP_LIST, async () => getWorkspacePrepCards().list()));

  ipcMain.removeHandler(IPC.WORKSPACE_PREP_DECIDE);
  ipcMain.handle(IPC.WORKSPACE_PREP_DECIDE, wrapHandler(IPC.WORKSPACE_PREP_DECIDE, async (
    _event: Electron.IpcMainInvokeEvent,
    id: unknown,
    decision: unknown,
  ): Promise<{ ok: boolean }> => {
    if (typeof id !== 'string' || id.length > 64) return { ok: false };
    if (!isWorkspacePrepDecision(decision)) return { ok: false };
    return { ok: getWorkspacePrepCards().decide(id, decision) };
  }));

  return () => {
    ipcMain.removeHandler(IPC.WORKSPACE_PREP_LIST);
    ipcMain.removeHandler(IPC.WORKSPACE_PREP_DECIDE);
    ipcMain.removeHandler(IPC.PROJECT_CONFIG_GET);
    ipcMain.removeHandler(IPC.PROJECT_CONFIG_SET_TRUST);
    ipcMain.removeHandler(IPC.PROJECT_CONFIG_TEXT);
    ipcMain.removeHandler(IPC.PROJECT_PREP_GET);
    ipcMain.removeHandler(IPC.PROJECT_PREP_SAVE);
    ipcMain.removeHandler(IPC.PROJECT_COMPANY_GET);
    ipcMain.removeHandler(IPC.PROJECT_COMPANY_SAVE);
  };
}
