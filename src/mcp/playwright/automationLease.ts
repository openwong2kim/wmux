import { sendRpc } from '../wmux-client';
import {
  requireBrowserTargetScope,
  sendScopedBrowserRpc,
  type BrowserTargetScope,
  type BrowserToolDeps,
} from './browserScope';

import { invalidateSnapshotBaseline, invalidateSnapshotBaselineIfStale } from './snapshotCache';
import { PlaywrightEngine } from './PlaywrightEngine';

// Renew well inside main's 30s RPC-lease TTL so a long-running tool op
// (browser_wait_for, slow page interactions) never lapses mid-flight.
const RENEW_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Inline lifecycle events: the lifecycle ring (navigations / loads / closes)
// is drained TWICE per tool op and the merged list is prepended to the tool's
// result, so the agent never needs a polling round-trip to learn the page
// moved underneath it:
//   - pre-drain, before the body: events from between tool calls, plus (on
//     builtin) the lazy Page.enable warm-up — the first drain is what turns
//     capture on, so it must stay ahead of the body.
//   - post-drain, after the body: events the body itself caused (a click that
//     navigated, the navigation the tool performed), attributed to THIS
//     result instead of leaking one call late.
// The two drains cannot double-report: both rings are drained destructively,
// and the two sources are mutually exclusive (main cannot see chrome tabs).
// An event that lands after the post-drain (builtin `loaded` fires after the
// commit the navigate RPC resolves on) is delayed, not lost — the next op's
// pre-drain picks it up. When the body throws, the post-drain is skipped and
// its events likewise survive in the ring for the next op; the PRE-drained
// events are lost with the error (destructive drain — no re-queue), which
// matches the pre-#1063 behavior. Drain failure is silent — older mains
// without browser.lifecycle.get must not break tools.
// ---------------------------------------------------------------------------

interface LifecycleEventWire {
  type: 'navigated' | 'loaded' | 'closed';
  url?: string;
  ts: number;
}

async function collectLifecycleEvents(scope: BrowserTargetScope): Promise<LifecycleEventWire[]> {
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
  return [...(Array.isArray(res?.entries) ? res.entries : []), ...local];
}

async function drainLifecycleEvents(scope: BrowserTargetScope): Promise<LifecycleEventWire[]> {
  try {
    const entries = await collectLifecycleEvents(scope);
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

/**
 * Post-body drain. Unlike the pre-drain, a `navigated` here must NOT nuke a
 * baseline the body itself just wrote for the navigation's final URL (the
 * browser_snapshot-during-navigation case) — that would self-destruct the
 * diff cache the call just primed. Conditional invalidation keeps a baseline
 * matching the LAST drained navigated URL and drops everything else;
 * `closed` always invalidates.
 */
async function drainLifecycleEventsPost(scope: BrowserTargetScope): Promise<LifecycleEventWire[]> {
  try {
    const entries = await collectLifecycleEvents(scope);
    if (entries.some((e) => e.type === 'closed')) {
      invalidateSnapshotBaseline(scope.workspaceId, scope.surfaceId);
    } else {
      const lastNavigated = [...entries].reverse().find((e) => e.type === 'navigated');
      if (lastNavigated) {
        invalidateSnapshotBaselineIfStale(scope.workspaceId, scope.surfaceId, lastNavigated.url);
      }
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
    // Trailing newline: MCP clients render adjacent content blocks with no
    // separator of their own, so without it the block ran straight into the
    // tool's own first line ("...(24s ago)Navigated to https://...").
    text: `[browser events]\n${lines.join('\n')}\n`,
  });
  return result;
}

/** Options for withAutomationLease (navigation self-echo suppression). */
export interface AutomationLeaseOpts<T> {
  /**
   * When the tool's own result already states the navigation it performed
   * (browser_navigate's "Navigated to <url>"), return that URL here and the
   * LAST `navigated` of the post-drain slice is dropped iff its URL matches
   * exactly. Deliberately narrow: a redirect chain (navigated: A, then B)
   * keeps A visible, and a mismatching final URL suppresses nothing.
   */
  redundantNavigationUrl?: (result: T) => string | undefined;
}

/**
 * Drop the self-echo `navigated` event, if the tool declared one.
 * Applied to the POST-drain slice only: a same-URL `navigated` in the
 * pre-drain is a delayed record of a PREVIOUS operation's navigation, not
 * this call's echo, and must stay visible.
 *
 * The echo candidate is the last `navigated` in the slice, not the last event
 * (#1072): when `loaded` lands inside the same settle window the slice is
 * [navigated, loaded], and an end-of-array-only check let the duplicate
 * through. The rest of the rule is unchanged — post-drain slice only, exact
 * URL match, at most one entry removed.
 */
function suppressSelfEcho<T>(
  events: LifecycleEventWire[],
  result: T,
  opts: AutomationLeaseOpts<T> | undefined,
): LifecycleEventWire[] {
  const url = opts?.redundantNavigationUrl?.(result);
  if (!url) return events;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'navigated') continue;
    if (events[i].url !== url) return events;
    return [...events.slice(0, i), ...events.slice(i + 1)];
  }
  return events;
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
  opts?: AutomationLeaseOpts<T>,
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
      const result = await fn(scope);
      // Post-drain runs in the return expression, i.e. still inside this
      // finally's lease bracket — browser.lifecycle.get is a leased RPC and
      // must not hit a re-throttled guest.
      const postEvents = await drainLifecycleEventsPost(scope);
      return prependBrowserEvents(
        result,
        [...lateEvents, ...suppressSelfEcho(postEvents, result, opts)],
      );
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
    const result = await fn(scope);
    // Post-drain still inside the lease bracket (see the late-acquire branch).
    const postEvents = await drainLifecycleEventsPost(scope);
    return prependBrowserEvents(
      result,
      [...events, ...suppressSelfEcho(postEvents, result, opts)],
    );
  } finally {
    clearInterval(renewTimer);
    sendRpc('browser.lease.release', { token: heldToken }).catch(() => {
      /* TTL expiry cleans up */
    });
  }
}
