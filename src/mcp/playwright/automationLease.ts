import { sendRpc } from '../wmux-client';

// Renew well inside main's 30s RPC-lease TTL so a long-running tool op
// (browser_wait_for, slow page interactions) never lapses mid-flight.
const RENEW_INTERVAL_MS = 10_000;

/**
 * Automation lease for Playwright-direct operations (#517 lightweight mode).
 *
 * Playwright drives the guest <webview> over CDP directly, bypassing the
 * lease-wrapped browser.* RPC handlers in main. Without a lease, a hidden
 * guest under lightweight mode stays background-throttled while being
 * automated — the #353 silent-blank-screenshot failure. Every Playwright MCP
 * tool invocation wraps its body in withAutomationLease().
 *
 * Fail-open by design: if lease RPCs fail (older main without the handlers,
 * pipe hiccup), the operation proceeds unleased — behavior is then identical
 * to pre-#517 builds with lightweight mode unavailable.
 */
export async function withAutomationLease<T>(
  surfaceId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  let token: string | null = null;
  try {
    const res = (await sendRpc('browser.lease.acquire', {
      ...(surfaceId && { surfaceId }),
    })) as { token: string | null };
    token = res?.token ?? null;
  } catch {
    /* lease unavailable — proceed unleased */
  }

  if (!token) return fn();

  const heldToken = token;
  const renewTimer = setInterval(() => {
    sendRpc('browser.lease.renew', { token: heldToken }).catch(() => {
      /* best-effort — TTL expiry in main is the backstop */
    });
  }, RENEW_INTERVAL_MS);
  // Do not keep the MCP process alive just to renew a lease.
  (renewTimer as { unref?: () => void }).unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(renewTimer);
    sendRpc('browser.lease.release', { token: heldToken }).catch(() => {
      /* TTL expiry cleans up */
    });
  }
}
