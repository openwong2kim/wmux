// Protected panes on the MCP lane: the checks a tool applies when main has
// authorized the operation as protected (scope.protection, set by
// withAutomationLease). Main's proxy enforces the site list on the network;
// these refuse up front what the proxy cannot see — page scripts, downloads,
// non-network navigation, and cookies of hosts outside the list.
import {
  compileHostPolicy,
  cookieDomainAllowed,
  navigationVerdict,
  type HostPolicy,
} from '../../shared/browserHostPolicy';
import { BrowserPolicyError, POLICY_DENIED_CODE } from '../../shared/browserPolicy';
import { isProtectedScope, type BrowserTargetScope } from './browserScope';

export { isProtectedScope };

/** A final refusal for `tool` on a protected pane. */
export function protectedRefusal(tool: string, why: string): BrowserPolicyError {
  return new BrowserPolicyError(
    POLICY_DENIED_CODE,
    `${tool} is not available on a protected pane: ${why}. Do not retry unchanged.`,
  );
}

function hostsOf(scope: BrowserTargetScope): HostPolicy {
  // Protected with no hosts in the answer: nothing is allowed.
  return scope.protection?.hosts ?? { mode: 'allowlist', allow: [], block: [] };
}

/** Throw when a protected pane may not be sent to `url`. No-op otherwise. */
export function assertProtectedNavigation(scope: BrowserTargetScope, tool: string, url: string): void {
  if (!isProtectedScope(scope)) return;
  const verdict = navigationVerdict(compileHostPolicy(hostsOf(scope)), url);
  if (verdict.allowed) return;
  throw protectedRefusal(
    tool,
    verdict.reason === 'host'
      ? "that host is not on this pane's allowed list"
      : 'only http(s) pages on the allowed hosts can be opened here',
  );
}

/** Whether a cookie domain belongs to an allowed host of a protected pane. */
export function protectedCookieAllowed(scope: BrowserTargetScope, domain: string | undefined): boolean {
  return cookieDomainAllowed(hostsOf(scope), domain ?? '');
}

/** Whether `url` is on a protected pane's allowed list (http(s) only). */
export function protectedUrlAllowed(scope: BrowserTargetScope, url: string): boolean {
  if (url === 'about:blank') return false; // the bootstrap page holds no site data
  return navigationVerdict(compileHostPolicy(hostsOf(scope)), url).allowed;
}
