import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { ChromePaneBindings } from '../../../shared/chromePaneBinding';
import {
  BROWSER_CONSENT_DOWNLOAD_FINISH_MS,
  BROWSER_CONSENT_DOWNLOAD_START_MAX_MS,
  type BrowserConsentAction,
} from '../../../shared/browserPolicy';
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
  type ConsentedDownload,
  type DownloadPass,
} from '../../browser-session/dangerousActionConsent';
import { resolvePaneForPty } from '../../workspace/ptyOwnership';
import { noteRunBrowserRefusal, type LiveRunIdentity } from '../../automation/runIdentity';
import {
  callerPaneOf,
  callerScope,
  identityRunPane,
  isRunCaller,
  needsConsentMessage,
  staleRunIdentity,
} from './browser.rpc';
import { browserPolicyRefusalCode, bypassDeniedMessage, policyDeniedMessage } from '../../../shared/browserPolicy';
import type { HostPolicy } from '../../../shared/browserHostPolicy';

// ---------------------------------------------------------------------------
// browser.consent.* — the MCP lane asks main before a dangerous action on a
// protected pane (dangerousActionConsent.ts has the rules).
//
// Identity comes only from main's attestation, along the same path A-core's
// protected gate in browser.rpc.ts takes: callerScope → the attested pane
// (callerPaneOf → resolvePaneForPty, or for a scheduled run acting as a
// pane's browser, the pane its live run identity names) → the pane's own
// exclusive profile → the policy decision. Nothing the caller names
// (workspace, pane, profile) is believed; a caller that is not a confirmed
// protected pane is refused.
//
// An unprotected pane's agent asks too (`unprotected: true`) before it skips
// a safety check or keeps a download. Main still decides from the pane's own
// policy: the flag is honoured only for a pane that resolves as unprotected,
// and a protected pane is never asked about on those terms. No download pass
// is opened for it — that pane's browser does not deny downloads.
// ---------------------------------------------------------------------------

type GetWindow = () => BrowserWindow | null;

export interface BrowserConsentRpcDeps {
  getWindow: GetWindow;
  store: Pick<BrowserPolicyStore, 'decisionFor' | 'entryFor'> & Partial<Pick<BrowserPolicyStore, 'onChange'>>;
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
const MAX_DETAIL_INPUT = 8_000;
export const DOWNLOAD_START_DEFAULT_MS = 30_000;

function refuse(why: string): ConsentRefusal {
  return new ConsentRefusal('policy_denied', policyDeniedMessage(CONSENT_METHOD, why));
}

function refuseBypass(why: string): ConsentRefusal {
  return new ConsentRefusal('policy_denied', bypassDeniedMessage(CONSENT_METHOD, why));
}

/** The refusal wording a request asked in (protected unless it says not). */
function refusalFor(params: Record<string, unknown>): (why: string) => ConsentRefusal {
  return params['unprotected'] === true ? refuseBypass : refuse;
}

/** An unprotected pane has no site list; this stands in for one in its caller. */
const NO_SITE_LIST: HostPolicy = { mode: 'off', allow: [], block: [] };

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
  const unprotected = params['unprotected'] === true;
  const fail = refusalFor(params);
  const decision = callerScope(ctx, params);
  if (decision.kind === 'rejected') throw fail('the caller could not be identified');
  const ptyId = callerPaneOf(ctx);
  const workspaceId = decision.workspaceId;
  // Consent is a pane's question: no attested pane, nothing to ask about.
  if (!ptyId || !workspaceId) throw fail('the calling pane could not be identified');
  let paneId: string | null = null;
  let run: LiveRunIdentity | null = null;
  if (isRunCaller(ctx)) {
    // The gate's own mapping: the pane the run's identity names, or a refusal
    // it has already recorded on the run.
    try {
      ({ run, paneId } = await identityRunPane(CONSENT_METHOD, ptyId, workspaceId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConsentRefusal(browserPolicyRefusalCode(err) === 'needs_consent' ? 'needs_consent' : 'policy_denied', message);
    }
  } else {
    try {
      paneId = await resolvePaneForPty(deps.getWindow, ptyId, workspaceId);
    } catch {
      paneId = null;
    }
  }
  if (!paneId) throw fail('the calling pane could not be identified');
  const currentProfile = deps.chrome.profileFor(workspaceId, paneId);
  const binding = deps.paneBindings()[paneId];
  const ownsProfile =
    !!currentProfile
    && !!binding
    && binding.workspaceId === workspaceId
    && binding.profile.toLowerCase() === currentProfile.toLowerCase();
  const pd = deps.store.decisionFor(paneId, workspaceId, currentProfile, !!binding);
  if (run) {
    // Only under the identity the operator granted, held as the gate holds it.
    const why = staleRunIdentity(run, pd, currentProfile, deps.store.entryFor(paneId), binding?.profile);
    if (why && pd.kind !== 'denied') {
      noteRunBrowserRefusal(run.runId, 'browser_needs_consent');
      throw new ConsentRefusal('needs_consent', needsConsentMessage(CONSENT_METHOD, `${why}; grant the schedule again in wmux`));
    }
  }
  if (pd.kind === 'legacy') {
    if (!unprotected) throw fail('this pane is not protected, so there is nothing to consent to');
    return {
      workspaceId,
      paneId,
      profileId: currentProfile ?? '',
      epoch: 0,
      hosts: NO_SITE_LIST,
      ptyId,
      ...(run && { runId: run.runId }),
      unprotected: true,
    };
  }
  if (pd.kind === 'denied') throw fail(pd.why);
  // Asked on an unprotected pane's terms, but the pane is protected now: its
  // own checks apply, and the call must be made again under them.
  if (unprotected) throw fail('this pane is protected now; try the call again without skipping its checks');
  if (deps.backend() !== 'chrome') throw fail('a protected pane runs only on the Chrome browser backend');
  if (!ownsProfile) throw fail('a protected pane needs a Chrome profile bound to that pane alone');
  if (!pd.confirmed) throw fail("this pane's site list must be confirmed again by the user");
  return {
    workspaceId,
    paneId,
    profileId: pd.profileId,
    epoch: pd.epoch,
    hosts: pd.hosts,
    ptyId,
    ...(run && { runId: run.runId }),
  };
}

function parseOperation(params: Record<string, unknown>): { action: BrowserConsentAction; hosts: string[]; detail?: string } {
  const refuse = refusalFor(params);
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
  /** The approved file, moved out of the pass directory, once it finished. */
  result: Promise<ConsentedDownload>;
}

/**
 * Move the approved file to a fresh directory of its own and remove the pass
 * directory. The browser wrote into the pass directory while it allowed
 * downloads, so anything else that landed there before its cancel took hold
 * goes with it, and the caller never learns that directory.
 */
function collectApproved(passDir: string, got: ConsentedDownload): ConsentedDownload {
  try {
    const out = mkdtempSync(join(tmpdir(), 'wmux-download-'));
    const dest = join(out, basename(got.path));
    renameSync(got.path, dest);
    return { ...got, path: dest };
  } finally {
    rmSync(passDir, { recursive: true, force: true });
  }
}

/** A refusal crosses the pipe as its message (the MCP lane maps the prefix). */
function rethrow(err: unknown): never {
  if (err instanceof ConsentRefusal) throw new Error(err.message);
  throw new Error(policyDeniedMessage(CONSENT_METHOD, 'the consent check failed'));
}

export function registerBrowserConsentRpc(router: Pick<RpcRouter, 'register'>, deps: BrowserConsentRpcDeps): void {
  const downloads = new Map<string, PendingDownload>();
  // A change of a pane's terms (site edit, protection off, rebind, move) voids
  // that pane's approved download still in flight; another pane's change, or
  // a consent grant, does not.
  deps.store.onChange?.(() => {
    for (const [id, pending] of downloads) {
      const c = pending.caller;
      const d = deps.store.decisionFor(c.paneId, c.workspaceId, c.profileId);
      if (
        d.kind === 'protected' && d.confirmed && d.profileId === c.profileId
        && JSON.stringify(d.hosts) === JSON.stringify(c.hosts)
      ) {
        continue;
      }
      pending.pass.cancel("the pane's browser policy changed before the download finished");
      downloads.delete(id);
    }
  });

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
    let runId: string | undefined;
    try {
      const op = parseOperation(params);
      const caller = await resolveCaller(deps, params, ctx);
      runId = caller.runId;
      let targetId = '';
      if (op.action === 'download' && !caller.unprotected) {
        targetId = typeof params['targetId'] === 'string' ? params['targetId'] : '';
        if (!targetId || targetId.length > 128) throw refuse('a download needs the tab it starts in');
      }
      const decision = await deps.consent.authorize(caller, op, {
        revalidate: () => resolveCaller(deps, params, ctx),
        ...(ctx?.signal && { signal: ctx.signal }),
      });
      // An unprotected pane's download is the tool's own to take once allowed.
      if (op.action !== 'download' || caller.unprotected) {
        return { ok: true, operationId: decision.operationId, epoch: decision.epoch, via: decision.via };
      }

      // Right before dispatch: the terms once more, then lift the deny for
      // this one download only.
      if (ctx?.signal?.aborted) throw refuse('the call was cancelled');
      const guard = guardFor(caller.profileId);
      if (!guard) throw refuse("the protected browser's download guard is not ready");
      const dir = deps.makeDownloadDir ? deps.makeDownloadDir() : mkdtempSync(join(tmpdir(), 'wmux-download-'));
      let pass: DownloadPass;
      try {
        pass = await openDownloadPass(guard, {
          frameId: targetId,
          approvedHost: op.hosts[0],
          hostOf: canonicalUrlHost,
          dir,
          startTimeoutMs: boundedMs(params['startTimeoutMs'], DOWNLOAD_START_DEFAULT_MS, BROWSER_CONSENT_DOWNLOAD_START_MAX_MS),
          finishTimeoutMs: BROWSER_CONSENT_DOWNLOAD_FINISH_MS,
          join,
        });
      } catch (err) {
        // No pass was opened: the directory made for it goes too.
        rmSync(dir, { recursive: true, force: true });
        throw err;
      }
      const result = pass.done.then(
        (got) => collectApproved(dir, got),
        (err: unknown) => {
          // Whatever happens, the record and the pass directory go with it.
          downloads.delete(decision.operationId);
          rmSync(dir, { recursive: true, force: true });
          throw err;
        },
      );
      result.catch(() => undefined);
      downloads.set(decision.operationId, { caller: { ...caller, epoch: decision.epoch }, pass, result });
      return { ok: true, operationId: decision.operationId, epoch: decision.epoch, via: decision.via };
    } catch (err) {
      // A scheduled run asked for what only a person can allow: say so on the
      // run, not only in the agent's transcript.
      if (runId && err instanceof ConsentRefusal && err.code === 'needs_consent') {
        noteRunBrowserRefusal(runId, 'browser_consent_unattended');
      }
      rethrow(err);
    }
  });

  router.register('browser.consent.awaitDownload', async (params, ctx) => {
    try {
      const [operationId, pending] = await pendingFor(params, ctx);
      const onAbort = () => pending.pass.cancel('the call was cancelled');
      ctx?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await pending.result;
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
