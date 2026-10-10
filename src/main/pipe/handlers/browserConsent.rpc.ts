import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { ChromePaneBindings } from '../../../shared/chromePaneBinding';
import type { BrowserConsentAction } from '../../../shared/browserPolicy';
import { canonicalHost } from '../../../shared/browserHostPolicy';
import type { BrowserPolicyStore } from '../../browser-session/BrowserPolicyStore';
import type { ChromeBackendClient } from '../../browser-session/ChromeLauncher';
import {
  ConsentRefusal,
  CONSENT_METHOD,
  openDownloadPass,
  sameTerms,
  type ConsentCaller,
  type DangerousActionConsent,
  type DownloadGuardPort,
  type DownloadPass,
} from '../../browser-session/dangerousActionConsent';
import { resolvePaneForPty } from '../../workspace/ptyOwnership';
import { callerPaneOf, callerScope } from './browser.rpc';
import { policyDeniedMessage } from '../../../shared/browserPolicy';

// ---------------------------------------------------------------------------
// browser.consent.* — the MCP lane asks main before a dangerous action on a
// protected pane (dangerousActionConsent.ts has the rules).
//
// Identity comes only from main's attestation, along the same path A-core's
// protected gate in browser.rpc.ts takes: callerScope → the attested pane
// (callerPaneOf → resolvePaneForPty) → the pane's own exclusive profile →
// the policy decision. Nothing the caller names (workspace, pane, profile) is
// believed; a caller that is not a confirmed protected pane is refused.
// ---------------------------------------------------------------------------

type GetWindow = () => BrowserWindow | null;

export interface BrowserConsentRpcDeps {
  getWindow: GetWindow;
  store: Pick<BrowserPolicyStore, 'decisionFor'>;
  paneBindings: () => ChromePaneBindings;
  chrome: {
    profileFor(workspaceId: string | undefined, paneId?: string): string;
    forProfile(name: string): ChromeBackendClient;
  };
  backend: () => string;
  consent: DangerousActionConsent;
  /** Test seam: where a pass's directory is created. */
  makeDownloadDir?: () => string;
  /** Test seam: the guard of a profile's Chrome. */
  downloadGuardFor?: (profile: string) => DownloadGuardPort | null;
}

const ACTIONS: ReadonlySet<string> = new Set<BrowserConsentAction>(['evaluate', 'download', 'sensitive']);
const MAX_SENSITIVE_HOSTS = 20;
const MAX_DETAIL_INPUT = 2_000;
export const DOWNLOAD_START_DEFAULT_MS = 30_000;
export const DOWNLOAD_START_MAX_MS = 120_000;
/** A begun download has this long to finish (the tool waits on it). */
export const DOWNLOAD_FINISH_MAX_MS = 30 * 60_000;

function refuse(why: string): ConsentRefusal {
  return new ConsentRefusal('policy_denied', policyDeniedMessage(CONSENT_METHOD, why));
}

/** The canonical host of an http(s) URL, or null. */
export function canonicalUrlHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return canonicalHost(parsed.hostname);
}

/** A host or cookie domain (leading dots dropped) in canonical form, or null. */
export function canonicalDomain(raw: string): string | null {
  return canonicalHost(raw.trim().replace(/^\.+/, '').toLowerCase());
}

/** Resolve the calling pane from main's attestation, or refuse. */
async function resolveCaller(
  deps: BrowserConsentRpcDeps,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
): Promise<ConsentCaller> {
  const decision = callerScope(ctx, params);
  if (decision.kind === 'rejected') throw refuse('the caller could not be identified');
  const ptyId = callerPaneOf(ctx);
  const workspaceId = decision.workspaceId;
  // Consent is a pane's question: no attested pane, nothing to ask about.
  if (!ptyId || !workspaceId) throw refuse('the calling pane could not be identified');
  let paneId: string | null = null;
  try {
    paneId = await resolvePaneForPty(deps.getWindow, ptyId, workspaceId);
  } catch {
    paneId = null;
  }
  if (!paneId) throw refuse('the calling pane could not be identified');
  const currentProfile = deps.chrome.profileFor(workspaceId, paneId);
  const binding = deps.paneBindings()[paneId];
  const ownsProfile =
    !!currentProfile
    && !!binding
    && binding.workspaceId === workspaceId
    && binding.profile.toLowerCase() === currentProfile.toLowerCase();
  const pd = deps.store.decisionFor(paneId, workspaceId, currentProfile, !!binding);
  if (pd.kind === 'legacy') throw refuse('this pane is not protected, so there is nothing to consent to');
  if (pd.kind === 'denied') throw refuse(pd.why);
  if (deps.backend() !== 'chrome') throw refuse('a protected pane runs only on the Chrome browser backend');
  if (!ownsProfile) throw refuse('a protected pane needs a Chrome profile bound to that pane alone');
  if (!pd.confirmed) throw refuse("this pane's site list must be confirmed again by the user");
  return { workspaceId, paneId, profileId: pd.profileId, epoch: pd.epoch, hosts: pd.hosts, ptyId };
}

function parseOperation(params: Record<string, unknown>): { action: BrowserConsentAction; hosts: string[]; detail?: string } {
  const action = params['action'];
  if (typeof action !== 'string' || !ACTIONS.has(action)) throw refuse('unknown action');
  const detail = typeof params['detail'] === 'string' ? params['detail'].slice(0, MAX_DETAIL_INPUT) : undefined;
  if (action === 'sensitive') {
    const raw = params['hosts'];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SENSITIVE_HOSTS) throw refuse('invalid hosts');
    const hosts: string[] = [];
    for (const h of raw) {
      const host = typeof h === 'string' ? canonicalDomain(h) : null;
      if (!host) throw refuse('invalid hosts');
      if (!hosts.includes(host)) hosts.push(host);
    }
    return { action, hosts, ...(detail && { detail }) };
  }
  const url = typeof params['url'] === 'string' ? params['url'] : '';
  const host = canonicalUrlHost(url);
  if (!host) throw refuse('the page is not an http(s) page');
  return { action: action as BrowserConsentAction, hosts: [host], ...(detail && { detail }) };
}

function boundedMs(raw: unknown, fallback: number, max: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(max, Math.max(1_000, Math.floor(raw))) : fallback;
}

interface PendingDownload {
  caller: ConsentCaller;
  pass: DownloadPass;
}

/** A refusal crosses the pipe as its message (the MCP lane maps the prefix). */
function rethrow(err: unknown): never {
  if (err instanceof ConsentRefusal) throw new Error(err.message);
  throw new Error(policyDeniedMessage(CONSENT_METHOD, 'the consent check failed'));
}

export function registerBrowserConsentRpc(router: Pick<RpcRouter, 'register'>, deps: BrowserConsentRpcDeps): void {
  const downloads = new Map<string, PendingDownload>();

  const guardFor = (profile: string): DownloadGuardPort | null => {
    if (deps.downloadGuardFor) return deps.downloadGuardFor(profile);
    const client = deps.chrome.forProfile(profile) as ChromeBackendClient & {
      consentDownloadGuard?: () => DownloadGuardPort | null;
    };
    return typeof client.consentDownloadGuard === 'function' ? client.consentDownloadGuard() : null;
  };

  /** The pending download `operationId` names, held by this same caller now. */
  const pendingFor = async (params: Record<string, unknown>, ctx: RpcContext | undefined): Promise<[string, PendingDownload]> => {
    const operationId = typeof params['operationId'] === 'string' ? params['operationId'] : '';
    const pending = downloads.get(operationId);
    if (!pending) throw refuse('no such approved download (it may have expired)');
    let caller: ConsentCaller;
    try {
      caller = await resolveCaller(deps, params, ctx);
    } catch (err) {
      pending.pass.cancel('the pane changed before the download finished');
      downloads.delete(operationId);
      throw err;
    }
    if (!sameTerms(pending.caller, caller) || caller.ptyId !== pending.caller.ptyId) {
      // Not the caller it was approved for, or the pane's terms moved: void it.
      pending.pass.cancel('the pane changed before the download finished');
      downloads.delete(operationId);
      throw refuse('the pane changed before the download finished');
    }
    return [operationId, pending];
  };

  router.register('browser.consent.request', async (params, ctx) => {
    try {
      const op = parseOperation(params);
      const caller = await resolveCaller(deps, params, ctx);
      let targetId = '';
      if (op.action === 'download') {
        targetId = typeof params['targetId'] === 'string' ? params['targetId'] : '';
        if (!targetId || targetId.length > 128) throw refuse('a download needs the tab it starts in');
      }
      const decision = await deps.consent.authorize(caller, op, {
        revalidate: () => resolveCaller(deps, params, ctx),
        ...(ctx?.signal && { signal: ctx.signal }),
      });
      if (op.action !== 'download') return { ok: true, operationId: decision.operationId, epoch: decision.epoch, via: decision.via };

      // Right before dispatch: the terms once more, then lift the deny for
      // this one download only.
      if (ctx?.signal?.aborted) throw refuse('the call was cancelled');
      const guard = guardFor(caller.profileId);
      if (!guard) throw refuse("the protected browser's download guard is not ready");
      const dir = deps.makeDownloadDir ? deps.makeDownloadDir() : mkdtempSync(join(tmpdir(), 'wmux-download-'));
      const pass = await openDownloadPass(guard, {
        frameId: targetId,
        dir,
        startTimeoutMs: boundedMs(params['startTimeoutMs'], DOWNLOAD_START_DEFAULT_MS, DOWNLOAD_START_MAX_MS),
        finishTimeoutMs: DOWNLOAD_FINISH_MAX_MS,
        join,
      });
      downloads.set(decision.operationId, { caller: { ...caller, epoch: decision.epoch }, pass });
      // Whatever happens, the record goes when the pass settles.
      void pass.done.then(
        () => undefined,
        () => downloads.delete(decision.operationId),
      );
      return { ok: true, operationId: decision.operationId, epoch: decision.epoch, via: decision.via };
    } catch (err) {
      rethrow(err);
    }
  });

  router.register('browser.consent.awaitDownload', async (params, ctx) => {
    try {
      const [operationId, pending] = await pendingFor(params, ctx);
      const onAbort = () => pending.pass.cancel('the call was cancelled');
      ctx?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await pending.pass.done;
        return { ok: true, ...result };
      } finally {
        ctx?.signal?.removeEventListener('abort', onAbort);
        downloads.delete(operationId);
      }
    } catch (err) {
      rethrow(err);
    }
  });

  router.register('browser.consent.release', async (params, ctx) => {
    try {
      const [operationId, pending] = await pendingFor(params, ctx);
      pending.pass.cancel();
      downloads.delete(operationId);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  });
}
