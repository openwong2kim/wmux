import { sendRpc } from '../wmux-client';
import {
  requireBrowserTargetScope,
  sendScopedBrowserRpc,
  type BrowserTargetScope,
  type BrowserToolDeps,
} from './browserScope';

import { invalidateSnapshotBaseline } from './snapshotCache';
import { PlaywrightEngine } from './PlaywrightEngine';

// Renew well inside main's 30s RPC-lease TTL so a long-running tool op
// (browser_wait_for, slow page interactions) never lapses mid-flight.
const RENEW_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Inline lifecycle events: before each tool body runs, drain the browser
// lifecycle ring (navigations / loads / closes since the last tool call) from
// main and prepend them to the tool's result, so the agent never needs a
// polling round-trip to learn the page moved underneath it. Drain failure is
// silent — older mains without browser.lifecycle.get must not break tools.
// ---------------------------------------------------------------------------

interface LifecycleEventWire {
  type: 'navigated' | 'loaded' | 'closed';
  url?: string;
  ts: number;
}

async function drainLifecycleEvents(scope: BrowserTargetScope): Promise<LifecycleEventWire[]> {
  try {
    const res = await sendScopedBrowserRpc<{ entries?: LifecycleEventWire[] }>(
      'browser.lifecycle.get',
      scope,
    ).catch(() => ({ entries: [] as LifecycleEventWire[] }));
    // Chrome backend: main cannot see chrome tabs — merge the engine-side
    // mirror (attached in getPageForScope) so #1063's inline events survive
    // the backend switch (dogfood P1).
    const local = PlaywrightEngine.getInstance().drainLocalLifecycle(
      scope.workspaceId,
      scope.surfaceId,
    );
    const entries = [...(Array.isArray(res?.entries) ? res.entries : []), ...local];
    // A navigation or close means any cached snapshot baseline for this
    // surface describes a page that no longer exists.
    if (entries.some((e) => e.type === 'navigated' || e.type === 'closed')) {
      invalidateSnapshotBaseline(scope.workspaceId, scope.surfaceId);
    }
    return entries;
  } catch {
    return [];
  }
}

function formatAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

/**
 * Prepend drained events to an MCP tool result. Only results that duck-type
 * as { content: [...] } are touched (isError results included) — anything
 * else passes through unchanged.
 */
function prependBrowserEvents<T>(result: T, events: LifecycleEventWire[]): T {
  if (events.length === 0) return result;
  const shaped = result as { content?: Array<{ type: string; text?: string }> } | null | undefined;
  if (!shaped || !Array.isArray(shaped.content)) return result;
  const lines = events.map(
    (e) => `- ${e.type}${e.url ? `: ${e.url}` : ''} (${formatAgo(e.ts)})`,
  );
  shaped.content.unshift({
    type: 'text',
    text: `[browser events since last tool call]\n${lines.join('\n')}`,
  });
  return result;
}

/**
 * Automation lease for Playwright-direct operations (#517 lightweight mode).
 *
 * Playwright drives the guest <webview> over CDP directly, bypassing the
 * lease-wrapped browser.* RPC handlers in main. Without a lease, a hidden
 * guest under lightweight mode stays background-throttled while being
 * automated — the #353 silent-blank-screenshot failure. Every Playwright MCP
 * tool invocation wraps its body in withAutomationLease().
 *
 * Workspace identity is resolved before the first lease RPC and reused for
 * the operation's page selection and fallback RPCs (#695). Identity failure
 * is fail-closed; lease transport failure remains fail-open for compatibility
 * with older mains that do not implement leases.
 */
export async function withAutomationLease<T>(
  deps: BrowserToolDeps,
  surfaceId: string | undefined,
  fn: (scope: BrowserTargetScope) => Promise<T>,
): Promise<T> {
  const scope = await requireBrowserTargetScope(deps, surfaceId);
  let token: string | null = null;
  try {
    const res = await sendScopedBrowserRpc<{ token: string | null }>(
      'browser.lease.acquire',
      scope,
    );
    token = res?.token ?? null;
  } catch {
    /* lease unavailable — proceed unleased */
  }

  if (!token) {
    // No target registered yet (codex P2, PR #528): the tool body may
    // auto-open a browser via getPage(); once that guest registers, this op
    // must not run against a throttled guest. Main grants a fresh-registration
    // grace, and this late-acquire loop picks up a real lease as soon as a
    // target exists, holding it for the remainder of the op.
    let lateToken: string | null = null;
    let done = false;
    const lateTimer = setInterval(() => {
      if (done || lateToken) return;
      sendScopedBrowserRpc<{ token: string | null }>('browser.lease.acquire', scope)
        .then((r) => {
          const tok = r?.token ?? null;
          if (!tok) return;
          if (done || lateToken) {
            // Op already ended, or a slower earlier acquire raced us and a
            // token is already held — release this duplicate immediately so
            // it cannot pin the guest unthrottled until TTL expiry.
            sendRpc('browser.lease.release', { token: tok }).catch(() => {});
            return;
          }
          lateToken = tok;
        })
        .catch(() => { /* keep trying until the op ends */ });
    }, 2_000);
    (lateTimer as { unref?: () => void }).unref?.();
    const lateRenew = setInterval(() => {
      if (lateToken) sendRpc('browser.lease.renew', { token: lateToken }).catch(() => {});
    }, RENEW_INTERVAL_MS);
    (lateRenew as { unref?: () => void }).unref?.();
    const lateEvents = await drainLifecycleEvents(scope);
    try {
      return prependBrowserEvents(await fn(scope), lateEvents);
    } finally {
      done = true;
      clearInterval(lateTimer);
      clearInterval(lateRenew);
      if (lateToken) {
        sendRpc('browser.lease.release', { token: lateToken }).catch(() => {});
      }
    }
  }

  const heldToken = token;
  const renewTimer = setInterval(() => {
    sendRpc('browser.lease.renew', { token: heldToken }).catch(() => {
      /* best-effort — TTL expiry in main is the backstop */
    });
  }, RENEW_INTERVAL_MS);
  // Do not keep the MCP process alive just to renew a lease.
  (renewTimer as { unref?: () => void }).unref?.();

  const events = await drainLifecycleEvents(scope);
  try {
    return prependBrowserEvents(await fn(scope), events);
  } finally {
    clearInterval(renewTimer);
    sendRpc('browser.lease.release', { token: heldToken }).catch(() => {
      /* TTL expiry cleans up */
    });
  }
}
