// Protected panes on the MCP lane: ask main before a dangerous action.
//
// A protected pane (scope.protection) runs page scripts, downloads and
// sensitive-site cookie/storage access only with the operator's consent. The
// tool asks main right before it acts; main answers from a standing grant,
// refuses at once for an unattended run (needs_consent), or puts one question
// to the operator for this operation alone. Every refusal is final for the
// call (policy_denied / needs_consent) and is rethrown as such.
//
// The agent's own flags (allowDangerous, allowSensitiveDomains) never stand in
// for this on a protected pane. Unprotected panes never reach this file.
import type { Page } from 'playwright-core';
import { sendRpc } from '../wmux-client';
import { canonicalHost } from '../../shared/browserHostPolicy';
import {
  BROWSER_CONSENT_RPC_TIMEOUT_MS,
  BrowserPolicyError,
  POLICY_DENIED_CODE,
  type BrowserConsentAction,
} from '../../shared/browserPolicy';
import { browserCallRefusal, type BrowserTargetScope } from './browserScope';

/** How much of an expression the operator can read (main caps it again). */
const SCRIPT_DETAIL_CHARS = 4_000;

export interface ConsentGranted {
  operationId: string;
  epoch: number;
}

function refusalOf(err: unknown, tool: string): Error {
  return (
    browserCallRefusal(err)
    ?? new BrowserPolicyError(
      POLICY_DENIED_CODE,
      `${tool} needs the operator's consent on a protected pane, and wmux could not ask (${err instanceof Error ? err.message : String(err)}). Do not retry unchanged.`,
    )
  );
}

/** The canonical host of a URL or a cookie domain, or null. */
export function consentHostOf(urlOrDomain: string): string | null {
  if (!urlOrDomain) return null;
  try {
    const parsed = new URL(urlOrDomain);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return canonicalHost(parsed.hostname);
  } catch {
    return canonicalHost(urlOrDomain.trim().replace(/^\.+/, '').toLowerCase());
  }
}

/** The agent-authored code the operator is asked about (whole, up to a cap). */
export function codePreview(expression: string): string {
  const text = expression.trim();
  return text.length > SCRIPT_DETAIL_CHARS ? `${text.slice(0, SCRIPT_DETAIL_CHARS)}…` : text;
}

/**
 * Ask main for consent to one operation. Resolves only when it may run.
 * `url` names the page (evaluate, download); `hosts` the sensitive sites.
 */
export async function requestBrowserConsent(
  scope: BrowserTargetScope,
  tool: string,
  req: {
    action: BrowserConsentAction;
    url?: string;
    hosts?: string[];
    detail?: string;
    /** download only: the tab's target id (its main frame id). */
    targetId?: string;
    startTimeoutMs?: number;
  },
): Promise<ConsentGranted> {
  let res: unknown;
  try {
    res = await sendRpc(
      'browser.consent.request',
      {
        workspaceId: scope.workspaceId,
        ...(scope.surfaceId && { surfaceId: scope.surfaceId }),
        action: req.action,
        ...(req.url !== undefined && { url: req.url }),
        ...(req.hosts && { hosts: req.hosts }),
        ...(req.detail && { detail: req.detail }),
        ...(req.targetId && { targetId: req.targetId }),
        ...(req.startTimeoutMs !== undefined && { startTimeoutMs: req.startTimeoutMs }),
      },
      // Longer than main's own deadline: main's answer, never the transport,
      // ends the wait.
      BROWSER_CONSENT_RPC_TIMEOUT_MS,
    );
  } catch (err) {
    throw refusalOf(err, tool);
  }
  const r = res as { ok?: unknown; operationId?: unknown; epoch?: unknown } | null;
  // Only an explicit, well-formed yes is a yes.
  if (!r || r.ok !== true || typeof r.operationId !== 'string' || typeof r.epoch !== 'number') {
    throw refusalOf(new Error('unexpected consent answer'), tool);
  }
  return { operationId: r.operationId, epoch: r.epoch };
}

/** Wait for the approved download main let through. */
export async function awaitConsentedDownload(
  scope: BrowserTargetScope,
  tool: string,
  operationId: string,
  timeoutMs: number,
): Promise<{ path: string; url: string; suggestedFilename: string }> {
  let res: unknown;
  try {
    res = await sendRpc('browser.consent.awaitDownload', { workspaceId: scope.workspaceId, operationId }, timeoutMs);
  } catch (err) {
    throw browserCallRefusal(err) ?? err;
  }
  const r = res as { ok?: unknown; path?: unknown; url?: unknown; suggestedFilename?: unknown } | null;
  if (!r || r.ok !== true || typeof r.path !== 'string') throw refusalOf(new Error('unexpected download answer'), tool);
  return {
    path: r.path,
    url: typeof r.url === 'string' ? r.url : '',
    suggestedFilename: typeof r.suggestedFilename === 'string' ? r.suggestedFilename : '',
  };
}

/** A page's target id — its main frame id, which a download names. */
export async function pageTargetId(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const res = (await session.send('Target.getTargetInfo')) as { targetInfo?: { targetId?: string } };
    const id = res.targetInfo?.targetId;
    if (typeof id !== 'string' || !id) throw new Error('the tab has no target id');
    return id;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** Withdraw an approved download the tool will not wait for. Best-effort. */
export function releaseConsent(scope: BrowserTargetScope, operationId: string): void {
  sendRpc('browser.consent.release', { workspaceId: scope.workspaceId, operationId }).catch(() => undefined);
}
