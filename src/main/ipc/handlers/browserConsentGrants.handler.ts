import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  BROWSER_POLICY_IPC,
  type BrowserPolicyWriteResult,
  type PaneConsentGrants,
} from '../../../shared/browserPolicy';
import { BrowserPolicyWriteError, type BrowserPolicyStore } from '../../browser-session/BrowserPolicyStore';
import { isTrustedMainFrameSender, UNTRUSTED_SENDER_ERROR, type BrowserPolicyIpcDeps } from './browserPolicy.handler';
import { wrapHandler } from '../wrapHandler';

/**
 * `browser:policy:grants` — the operator revokes a protected pane's standing
 * consent from the policy editor. Revocation only: a grant is added solely by
 * answering a consent prompt with "Always on this pane", which main checks
 * against the operation it was asked about. Same sender rule as the editor.
 */
export function registerBrowserConsentGrantsIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: Pick<BrowserPolicyIpcDeps, 'getWindow' | 'profileFor' | 'paneWorkspace'> & {
    store: Pick<BrowserPolicyStore, 'setGrants'>;
  },
): void {
  ipcMain.handle(
    BROWSER_POLICY_IPC.grants,
    wrapHandler(BROWSER_POLICY_IPC.grants, async (event: IpcMainInvokeEvent, payload: unknown): Promise<BrowserPolicyWriteResult> => {
      if (!isTrustedMainFrameSender(event, deps.getWindow)) return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      const p = (payload ?? {}) as Record<string, unknown>;
      const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : '';
      const paneId = typeof p.paneId === 'string' ? p.paneId : '';
      const profileId = typeof p.profileId === 'string' ? p.profileId : '';
      const g = p.grants;
      if (!workspaceId || !paneId || !profileId || !g || typeof g !== 'object' || typeof p.expectedEpoch !== 'number') {
        return { ok: false, error: 'invalid payload', code: 'invalid' };
      }
      if (deps.paneWorkspace(paneId) !== workspaceId) return { ok: false, error: 'that pane is not in that workspace', code: 'invalid' };
      if (deps.profileFor(workspaceId, paneId) !== profileId) {
        return { ok: false, error: "the pane's Chrome profile changed; re-read and try again", code: 'stale' };
      }
      const wanted = g as Record<string, unknown>;
      const keepHosts = Array.isArray(wanted.sensitiveHosts)
        ? wanted.sensitiveHosts.filter((h): h is string => typeof h === 'string')
        : [];
      try {
        const epoch = await deps.store.setGrants(
          paneId,
          { workspaceId, profileId },
          // Revoke-only: whatever the payload says, nothing it did not already have.
          (current): PaneConsentGrants => ({
            evaluate: current.evaluate === true && wanted.evaluate === true,
            download: current.download === true && wanted.download === true,
            sensitiveHosts: (current.sensitiveHosts ?? []).filter((h) => keepHosts.includes(h)),
          }),
          p.expectedEpoch,
        );
        return { ok: true, epoch };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: err instanceof BrowserPolicyWriteError ? err.code : 'io',
        };
      }
    }),
  );
}
