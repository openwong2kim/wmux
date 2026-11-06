import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sendRpc } from '../wmux-client';
import {
  browserCallRefusal,
  lastKnownProtection,
  rememberProtection,
  leaseSurfaceScope,
  requireBrowserTargetScope,
  sendScopedBrowserRpc,
  type BrowserTargetScope,
  type BrowserToolDeps,
} from './browserScope';
import {
  BrowserPolicyError,
  POLICY_DENIED_CODE,
  browserPolicyRefusal,
  type BrowserPolicyAuthorization,
} from '../../shared/browserPolicy';

import { hintBlockMeta } from './hintBlock';
import { describeToolError } from './toolError';
import { createEffectProbe, withEffectTrailer, type EffectProbe } from './resultTrailer';
import { takeGuideAnnouncement } from './guideAnnounce';
import { redactPasswordParams } from './redact';
import { invalidateSnapshotBaseline, invalidateSnapshotBaselineIfStale } from './snapshotCache';
import { PlaywrightEngine } from './PlaywrightEngine';
import { drainDialogNotes, renderModalBlock, type DialogNote } from './modalState';
import {
  isServable,
  normalizeUrlKey,
  type TraceRecord,
} from '../../shared/browserReplay/actionTrace';
import {
  renderPromotedHintBlock,
  type PromotedRecord,
} from '../../shared/browserReplay/promotedSkill';
import {
  domainFromUrl,
  renderSiteMemoryBlock,
  type SiteMemoryRecord,
} from '../../shared/browserMemory/siteMemory';
import type { SiteGuideMatch } from '../../shared/browserGuides/siteGuides';

// ---------------------------------------------------------------------------
// Protected panes: every operation is authorized by main first.
//
// The authorization rides the lease acquire the lane already sends
// (`authorize: true`); an operation with no surface to lease sends it as an
// authorization-only request. Main's gate refuses a pane it must refuse
// (policy_denied — rethrown, final) and otherwise says whether the pane is
// protected, which the tools read off the scope.
//
// Fail-open stays exactly as it was for an unprotected scope: an older main or
// a transport failure proceeds unleased. Once this connection has seen its
// pane answered as protected, a transport failure DENIES instead — an
// operation main could not authorize is not run on a protected pane.
// ---------------------------------------------------------------------------

export { resetProtectionMemoryForTests } from './browserScope';

/**
 * The scope an operation gets when main could not be asked at all and this
 * connection has never had an answer: treated as protected with nothing
 * allowed, so page scripts, cookies, storage, downloads and navigation are
 * refused for this one operation. Every one of those needs main to work
 * anyway, so an unprotected pane loses nothing it would otherwise have had.
 */
const UNCONFIRMED_PROTECTION: BrowserPolicyAuthorization = Object.freeze({
  protected: true,
  hosts: { mode: 'allowlist' as const, allow: [], block: [] },
});

function readAuthorization(res: unknown): BrowserPolicyAuthorization | undefined {
  const policy = (res as { policy?: unknown } | null | undefined)?.policy as BrowserPolicyAuthorization | undefined;
  return policy && typeof policy.protected === 'boolean' ? policy : undefined;
}

/**
 * Whether two protected authorizations carry the same terms (the site policy).
 * The epoch also moves for changes that only WIDEN a pane — the operator's
 * "Always on this pane" consent grant — and those must not fail an operation
 * already under way; a change of the site policy (or protection itself) does.
 */
function sameProtectedTerms(a: BrowserPolicyAuthorization, b: BrowserPolicyAuthorization | undefined): boolean {
  return !!b && a.protected === b.protected && JSON.stringify(a.hosts ?? null) === JSON.stringify(b.hosts ?? null);
}

function unconfirmedProtectedError(): BrowserPolicyError {
  return new BrowserPolicyError(
    POLICY_DENIED_CODE,
    "wmux could not confirm this protected pane's browser authorization, so nothing was done. Do not retry unchanged.",
  );
}

// ---------------------------------------------------------------------------
// Tools that run caller-supplied code (browser_repl, repl_run).
//
// Their code runs in this process, not in the page: it can read the pane's
// Chrome profile from disk, start processes and open sockets, none of which
// passes main's gate or this lane's per-operation checks. So they are refused
// on a protected pane outright, and unlike the lease there is no fail-open:
// only main's explicit "not protected" answer lets them run.
// ---------------------------------------------------------------------------

/** A code-running tool's refusal; `paneProtected` is false when main gave no usable answer. */
export class CodeToolRefusal extends BrowserPolicyError {
  constructor(message: string, readonly paneProtected: boolean) {
    super(POLICY_DENIED_CODE, message);
    this.name = 'CodeToolRefusal';
  }
}

function protectedCodeToolRefusal(tool: string, detail?: string): CodeToolRefusal {
  return new CodeToolRefusal(
    `${tool} is not available on a protected pane: this pane's browser is protected, and code ` +
      `run by ${tool} would not be held to the pane's browser checks.` +
      (detail ? ` wmux answered: ${detail}` : '') +
      ' Use the individual browser_* tools instead. Do not retry unchanged.',
    true,
  );
}

function unconfirmedCodeToolRefusal(tool: string): CodeToolRefusal {
  return new CodeToolRefusal(
    `${tool} was refused: wmux could not confirm that this pane's browser is not protected, ` +
      'so no code was run. It runs only once wmux answers that the pane is unprotected.',
    false,
  );
}

/**
 * Resolve when main answers that the calling pane is NOT protected; throw a
 * CodeToolRefusal otherwise — protected, refused by main's gate, or no usable
 * answer (no workspace identity, transport failure, a reply without a policy).
 *
 * Asked fresh on every call: a pane can be protected at any time. The request
 * names no surface, so it is authorization only and holds no lease.
 */
export async function assertCodeToolAllowed(deps: BrowserToolDeps, tool: string): Promise<void> {
  let workspaceId: string;
  try {
    workspaceId = await deps.resolveWorkspaceId();
  } catch {
    throw unconfirmedCodeToolRefusal(tool);
  }
  if (!workspaceId) throw unconfirmedCodeToolRefusal(tool);
  let res: unknown;
  try {
    res = await sendRpc('browser.lease.acquire', { workspaceId, authorize: true });
  } catch (err) {
    // A protected pane's refusal says the pane is protected; anything else —
    // the pane-profile refusal (caller not identified) included — says only
    // that main did not answer "unprotected".
    const refusal = browserPolicyRefusal(err);
    if (refusal) throw protectedCodeToolRefusal(tool, refusal.message);
    throw unconfirmedCodeToolRefusal(tool);
  }
  // A main that predates authorization leases its default surface for an
  // unnamed acquire. Not ours to hold.
  const token = (res as { token?: unknown } | null | undefined)?.token;
  if (typeof token === 'string' && token) {
    sendRpc('browser.lease.release', { token }).catch(() => undefined);
  }
  const authorization = readAuthorization(res);
  if (!authorization) throw unconfirmedCodeToolRefusal(tool);
  rememberProtection(workspaceId, authorization.protected);
  if (authorization.protected) throw protectedCodeToolRefusal(tool);
}

// Renew well inside main's 30s RPC-lease TTL so a long-running tool op
// (browser_wait_for, slow page interactions) never lapses mid-flight.
const RENEW_INTERVAL_MS = 10_000;
// A renew parks on main for up to this long (main caps it the same), so the
// user's Stop / Take over reaches the op at once instead of at the next poll.
const LEASE_WATCH_MS = 8_000;
// The parked renew's client timeout: the park plus room for the reply.
const LEASE_WATCH_RPC_TIMEOUT_MS = LEASE_WATCH_MS + 4_000;
// The watch starts this long into the op: most actions are over sooner and so
// cost no extra RPC, and a Stop pressed earlier is still heard by then (main
// keeps the revocation for the parked renew to read).
const LEASE_WATCH_START_MS = 500;

// ---------------------------------------------------------------------------
// Stop / Take over (src/shared/browserAgentControl.ts).
//
// The user can end an agent's action on an in-app tab from the pane. Main
// revokes the op's lease and answers the parked renew with the refusal; the op
// then fails with it at once, and the Playwright connection is dropped so the
// action stops inside the page too (a click still waiting for its element
// would otherwise land after the user said stop). The connection is per agent
// process and is re-made by the next call, so the cost of dropping it is one
// reconnect — and any other action this same agent had in flight fails with
// it, which is the honest outcome of "stop" as well.
// ---------------------------------------------------------------------------

interface CancelSignal {
  /** Rejects with the user's refusal; never resolves. */
  readonly promise: Promise<never>;
  /** Aborted with the same refusal: the op's own code reads it (see below). */
  readonly signal: AbortSignal;
  fire(error: Error): void;
}

function cancelSignal(): CancelSignal {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, rej) => {
    reject = rej;
  });
  // Unobserved whenever the op finishes first.
  promise.catch(() => undefined);
  const controller = new AbortController();
  return {
    promise,
    signal: controller.signal,
    fire: (error) => {
      if (controller.signal.aborted) return;
      controller.abort(error);
      reject(error);
    },
  };
}

// The stopped op's body keeps running after the refusal is returned (nothing
// can preempt it), and dropping its connection only makes its next page call
// fail — which page discovery would answer by reconnecting and carrying on. So
// the op's signal travels with its async context, and page discovery
// (PlaywrightEngine getPage / ensureConnected) treats an aborted one as final.
const opSignals = new AsyncLocalStorage<AbortSignal>();

/** The signal of the browser op the caller runs inside, if any. Aborted, with
 *  the user's refusal as its reason, once the user stops or takes over the tab. */
export function currentBrowserOpSignal(): AbortSignal | undefined {
  return opSignals.getStore();
}

/**
 * Keep a held lease renewed, and call `onRevoked` with main's refusal if the
 * user stops or takes over the tab while it is held. Returns the stop handle.
 *
 * A main that predates the parked renew answers at once without `watched`; the
 * loop then paces itself at RENEW_INTERVAL_MS, exactly the old renew timer.
 */
function watchLease(token: string, onRevoked: (error: Error) => void): () => void {
  let stopped = false;
  let wake: (() => void) | null = null;
  let pause: ReturnType<typeof setTimeout> | undefined;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      pause = setTimeout(resolve, ms);
      (pause as { unref?: () => void }).unref?.();
    });
  void (async () => {
    await sleep(LEASE_WATCH_START_MS);
    while (!stopped) {
      const started = Date.now();
      try {
        const params = { token, waitMs: LEASE_WATCH_MS };
        const res = (await sendRpc('browser.lease.renew', params, LEASE_WATCH_RPC_TIMEOUT_MS)) as {
          ok?: boolean;
          watched?: boolean;
        } | null;
        if (stopped || res?.ok === false) return;
        if (res?.watched === true) continue;
        await sleep(Math.max(0, RENEW_INTERVAL_MS - (Date.now() - started)));
      } catch (err) {
        if (stopped) return;
        const refusal = browserCallRefusal(err);
        if (refusal) {
          onRevoked(refusal);
          return;
        }
        /* best-effort — TTL expiry in main is the backstop */
        await sleep(RENEW_INTERVAL_MS);
      }
    }
  })();
  return () => {
    stopped = true;
    if (pause) clearTimeout(pause);
    wake?.();
  };
}

/**
 * The op's result, or the user's refusal the moment they stop it — in which
 * case the agent's Playwright connection is dropped so the abandoned action
 * stops in the page as well.
 */
function untilCancelled<T>(run: () => Promise<T>, cancel: CancelSignal): Promise<T> {
  const work = opSignals.run(cancel.signal, run);
  return Promise.race([
    work,
    cancel.promise.catch((error: unknown) => {
      // The abandoned op now fails on its own; that failure is expected.
      work.catch(() => undefined);
      void PlaywrightEngine.getInstance().disconnect().catch(() => undefined);
      throw error;
    }),
  ]);
}

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
  type: 'navigated' | 'loaded' | 'closed' | 'dialog';
  url?: string;
  ts: number;
  /** type 'dialog': one main answered on the RPC lane. */
  dialog?: DialogNote;
}

async function collectLifecycleEvents(scope: BrowserTargetScope): Promise<LifecycleEventWire[]> {
  // No surface of this caller's to drain. An unnamed drain is DESTRUCTIVE on
  // main's workspace default — another connection's ring — so the events would
  // be removed from that agent's next result and reported in this one.
  if (!scope.surfaceId) return [];
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
function prependBrowserEvents<T>(result: T, allEvents: LifecycleEventWire[]): T {
  if (allEvents.length === 0) return result;
  const shaped = result as { content?: Array<{ type: string; text?: string }> } | null | undefined;
  if (!shaped || !Array.isArray(shaped.content)) return result;
  const dialogs = allEvents.flatMap((e) => (e.type === 'dialog' && e.dialog ? [e.dialog] : []));
  if (dialogs.length > 0) shaped.content.unshift({ type: 'text', text: renderModalBlock(dialogs) });
  const events = allEvents.filter((e) => e.type !== 'dialog');
  if (events.length === 0) return result;
  // Lifecycle URLs are rendered into the tool result like any other URL, so a
  // credential in a query string or in `scheme://user:pass@host` is masked here
  // too. The self-echo match above runs on the RAW url and is unaffected.
  const lines = events.map(
    (e) => `- ${e.type}${e.url ? `: ${redactPasswordParams(e.url)}` : ''} (${formatAgo(e.ts)})`,
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

/**
 * Prepend a [modal] note for each dialog that appeared on this surface since
 * the last result, error results included. Drained after the body, so a
 * dialog the body's own action raised is reported in the same result.
 */
function prependModalNotes<T>(result: T, scope: BrowserTargetScope): T {
  const shaped = result as { content?: Array<{ type: string; text?: string }> } | null | undefined;
  if (!shaped || !Array.isArray(shaped.content)) return result;
  const notes = drainDialogNotes(scope.workspaceId, scope.surfaceId);
  if (notes.length > 0) shaped.content.unshift({ type: 'text', text: renderModalBlock(notes) });
  return result;
}

/**
 * Tell the agent a recorded flow exists for the page it just landed on.
 *
 * Attached ONLY to a successful navigation, and never to a snapshot footer.
 * A footer would be self-defeating: browser_replay exists to spare the agent
 * the snapshot, so paying for the hint with snapshot bytes on every single
 * snapshot spends more than the feature saves. A navigation is also the one
 * moment the hint is actionable — the flow starts here or it does not start.
 *
 * Only PROVEN, unquarantined traces are named (isServable): suggesting a flow
 * that has never worked costs the agent an attempt it did not ask for.
 *
 * PROMOTED flows are announced here too, and this is the whole push half of
 * promotion. A promoted flow gets its own line carrying a one-line contract
 * and a literal, runnable call, so the agent can act on it in its very next
 * tool use rather than having to call list first. That line is rendered
 * through renderPromotedHint, which admits exactly one page-derived string
 * (the host, character-whitelisted and length-capped) — a hint is
 * instruction-adjacent text in the agent's context, and anything richer would
 * let a page the agent merely visited write into its prompt on some later,
 * unrelated navigation.
 *
 * Failure is silence. An older main without the actionCache methods, a torn
 * cache, an unresolvable scope — none of them may turn a working navigation
 * into a failed one.
 */
async function prependReplayHints<T>(
  result: T,
  events: LifecycleEventWire[],
  scope: BrowserTargetScope,
): Promise<T> {
  const shaped = result as
    | {
        content?: Array<{ type: string; text?: string; _meta?: Record<string, unknown> }>;
        isError?: boolean;
      }
    | null
    | undefined;
  if (!shaped || !Array.isArray(shaped.content)) return result;
  // A protected pane's hints come from its own per-account namespace, which
  // main resolves from the pane it attests; nothing is filtered here.
  // A failed tool call is not a landing, and hinting on one would advertise a
  // flow for a page the agent is not on.
  if (shaped.isError === true) return result;

  const landed = [...events].reverse().find((e) => e.type === 'navigated' && e.url);
  if (!landed?.url) return result;

  try {
    const urlKey = normalizeUrlKey(landed.url);
    // Both stores, in one round trip pair. A promoted flow may have outlived
    // its recording, so consulting only the cache would go silent on exactly
    // the flows the user chose to keep.
    const domain = domainFromUrl(landed.url);
    // Guide loading is isolated in its own try/catch, not only a `.catch`:
    // null means "unknown" (older main, transport failure, a synchronous
    // throw) and must neither break the other hints nor reset what this
    // surface last announced.
    const guidesLoad = (async (): Promise<SiteGuideMatch[] | null> => {
      try {
        const r = await sendScopedBrowserRpc<{ guides?: SiteGuideMatch[] }>(
          'browser.siteGuides.match',
          scope,
          { url: urlKey },
        );
        return Array.isArray(r?.guides) ? r.guides : [];
      } catch {
        return null;
      }
    })();
    const [res, promotedRes, siteRes, guides] = await Promise.all([
      sendScopedBrowserRpc<{ traces?: TraceRecord[] }>('browser.actionCache.list', scope, {
        urlKey,
      }),
      sendScopedBrowserRpc<{ promoted?: PromotedRecord[] }>(
        'browser.actionCache.promoted',
        scope,
        { urlKey },
      ).catch(() => ({ promoted: [] as PromotedRecord[] })),
      // The `.catch` is not optional. Without it, attaching to a main that
      // predates this method rejects the whole Promise.all, the outer
      // try/catch swallows it, and the EXISTING [replay] and [skill] hints
      // vanish too — a new feature silently deleting two working ones.
      domain
        ? sendScopedBrowserRpc<{ memory?: SiteMemoryRecord | null }>(
            'browser.siteMemory.list',
            scope,
            { domain },
          ).catch(() => ({ memory: null }))
        : Promise.resolve({ memory: null }),
      guidesLoad,
    ]);
    const promoted = promotedRes?.promoted ?? [];
    const promotedNames = new Set(promoted.map((r) => r.name));
    // A promoted flow is announced by its own richer line, so it must not
    // also appear in the plain [replay] list — one flow, one hint.
    const names = (res?.traces ?? [])
      .filter(isServable)
      .map((t) => t.name)
      .filter((name) => !promotedNames.has(name));

    // Promoted first: it is the stronger claim (permanent, proven at least
    // three times, chosen by hand) and it carries a call the agent can make
    // without any further lookup.
    const promotedBlock = renderPromotedHintBlock(promoted);
    const replayBlock =
      names.length > 0
        ? `[replay] ${names.length} recorded flow(s) for this page: ${names.join(', ')} — ` +
          `browser_replay {action:"run", name:"..."} repeats one without a snapshot.\n`
        : '';
    // What this domain has cost before. First, because it is the only block
    // that can stop the agent from doing something rather than offer it
    // something to do — and re-rendered from the record rather than served
    // from a stored string, so a hand-edited file still meets the guards.
    const siteBlock = renderSiteMemoryBlock(siteRes?.memory ?? null, urlKey);
    // siteBlock is part of the early return, not just the concatenation. The
    // main scenario for this feature is a domain with NO recorded flows —
    // failure memory and nothing else — and checking only the other two would
    // mean the block never appears on exactly those pages.
    // Guide rendering is isolated too: any exception yields no guide lines and
    // the blocks above are still assembled.
    let guideBlock = '';
    try {
      if (guides !== null) {
        guideBlock = takeGuideAnnouncement(
          scope.workspaceId,
          scope.surfaceId,
          guides,
          siteRes?.memory ?? null,
        );
      }
    } catch {
      guideBlock = '';
    }
    if (!promotedBlock && !replayBlock && !siteBlock && !guideBlock) return result;
    // Marked, not just prefixed: browser_repl separates hints from tool output
    // by this marker, and a page must not be able to forge one. See hintBlock.ts.
    shaped.content.unshift({
      type: 'text',
      text: `${siteBlock}${guideBlock}${promotedBlock}${replayBlock}`,
      _meta: hintBlockMeta(),
    });
  } catch {
    /* no hint is always an acceptable outcome */
  }
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
  // Settle the surface BEFORE the lease: an unnamed browser.lease.acquire
  // resolves to the workspace's first live session, so under lightweight mode
  // the lease kept ANOTHER connection's guest unthrottled while Playwright
  // drove this caller's own.
  const routed = await leaseSurfaceScope(await requireBrowserTargetScope(deps, surfaceId));
  let token: string | null = null;
  let protection: BrowserPolicyAuthorization | undefined;
  // Only ever leased BY NAME. Without a surface to name, the acquire would be
  // answered with the workspace's first live session, and holding a lease on
  // somebody else's guest is worse than holding none: it exempts their page
  // from lightweight mode and leaves this caller's own page throttled. The
  // late-acquire loop below covers the body that opens its own surface — it
  // picks up the pin as soon as there is one. Unnamed, the request is
  // authorization only: main answers it without resolving any surface.
  try {
    const res = await sendScopedBrowserRpc<{ token: string | null }>(
      'browser.lease.acquire',
      routed,
      { authorize: true },
    );
    protection = readAuthorization(res);
    if (protection) rememberProtection(routed.workspaceId, protection.protected);
    if (routed.surfaceId) {
      token = res?.token ?? null;
    } else if (res?.token) {
      // A main that predates authorization leased its default surface for an
      // unnamed acquire. Not ours to hold.
      sendRpc('browser.lease.release', { token: res.token }).catch(() => undefined);
    }
  } catch (err) {
    const refusal = browserCallRefusal(err);
    if (refusal) throw refusal;
    const known = lastKnownProtection(routed.workspaceId);
    if (known === true) throw unconfirmedProtectedError();
    // Never answered: proceed unleased, but under deny-all protection checks.
    if (known === undefined) protection = UNCONFIRMED_PROTECTION;
    /* lease unavailable — proceed unleased */
  }
  const scope: BrowserTargetScope = protection ? Object.freeze({ ...routed, protection }) : routed;
  /** Set when a late authorization took the pane's permission away mid-operation. */
  let revoked: Error | null = null;
  /** The epoch this operation's terms were last confirmed at (moves on a grants-only change). */
  let termsEpoch = protection?.epoch;

  if (!token) {
    // No target registered yet (codex P2, PR #528): the tool body may
    // auto-open a browser via getPage(); once that guest registers, this op
    // must not run against a throttled guest. Main grants a fresh-registration
    // grace, and this late-acquire loop picks up a real lease as soon as a
    // target exists, holding it for the remainder of the op.
    let lateToken: string | null = null;
    let done = false;
    const lateCancel = cancelSignal();
    // Held in an object: set from a callback, which TS's narrowing of a
    // `let` initialised to null cannot see.
    const lateWatch: { stop: (() => void) | null } = { stop: null };
    const lateTimer = setInterval(() => {
      if (done || lateToken) return;
      sendScopedBrowserRpc<{ token: string | null }>('browser.lease.acquire', scope, { authorize: true })
        .then((r) => {
          // The protection answer is re-read on every late acquire: a pane
          // that became protected (or changed epoch) under this operation
          // fails the operation instead of finishing it on the old terms.
          const late = readAuthorization(r);
          if (
            late
            // Already held to deny-all: no later answer is stricter than that.
            && protection !== UNCONFIRMED_PROTECTION
            && (late.protected !== (protection?.protected ?? false)
              || (late.protected && late.epoch !== termsEpoch))
          ) {
            if (late.protected && sameProtectedTerms(late, protection)) {
              // Same site policy at a new epoch: a consent grant, not a
              // revocation. Continue under the terms already in force.
              termsEpoch = late.epoch;
            } else {
              if (late.protected) rememberProtection(scope.workspaceId, true);
              revoked = unconfirmedProtectedError();
            }
          }
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
          lateWatch.stop = watchLease(tok, lateCancel.fire);
        })
        .catch((err) => {
          // A refusal is final; anything else keeps trying until the op ends.
          // It also ends the op now rather than when its body finishes: a tab
          // the user stopped must not keep being driven until then.
          const refusal = browserCallRefusal(err);
          if (refusal) {
            revoked = refusal;
            if (!done) lateCancel.fire(refusal);
          }
        });
    }, 2_000);
    (lateTimer as { unref?: () => void }).unref?.();
    const lateEvents = await drainLifecycleEvents(scope);
    try {
      const result = prependModalNotes(await untilCancelled(() => fn(scope), lateCancel), scope);
      if (revoked) throw revoked;
      // Post-drain runs in the return expression, i.e. still inside this
      // finally's lease bracket — browser.lifecycle.get is a leased RPC and
      // must not hit a re-throttled guest.
      const postEvents = await drainLifecycleEventsPost(scope);
      // The hint reads the RAW post-drain slice, before self-echo suppression:
      // browser_navigate's own `navigated` is exactly the landing worth
      // hinting on, and it is the event suppression removes.
      const withEvents = prependBrowserEvents(
        result,
        [...lateEvents, ...suppressSelfEcho(postEvents, result, opts)],
      );
      return prependReplayHints(withEvents, [...lateEvents, ...postEvents], scope);
    } finally {
      done = true;
      clearInterval(lateTimer);
      lateWatch.stop?.();
      if (lateToken) {
        sendRpc('browser.lease.release', { token: lateToken }).catch(() => {});
      }
    }
  }

  const heldToken = token;
  const cancel = cancelSignal();
  const stopWatch = watchLease(heldToken, cancel.fire);

  const events = await drainLifecycleEvents(scope);
  try {
    const result = prependModalNotes(await untilCancelled(() => fn(scope), cancel), scope);
    // Post-drain still inside the lease bracket (see the late-acquire branch).
    const postEvents = await drainLifecycleEventsPost(scope);
    const withEvents = prependBrowserEvents(
      result,
      [...events, ...suppressSelfEcho(postEvents, result, opts)],
    );
    return prependReplayHints(withEvents, [...events, ...postEvents], scope);
  } finally {
    stopWatch();
    sendRpc('browser.lease.release', { token: heldToken }).catch(() => {
      /* TTL expiry cleans up */
    });
  }
}

/**
 * withAutomationLease for a MUTATING tool: the effect trailer covers whatever
 * escapes the lease, not only what the body catches itself.
 *
 * The lease settles the workspace scope BEFORE it calls the body — that is the
 * whole point of requireBrowserTargetScope — so a scope refusal, or a surface
 * that was opened and never became addressable, rejects outside the body's own
 * try/catch. Those were the one failure shape reaching the agent with no
 * `effect_state` at all, while the tool's description promises one on every
 * result. They are `none` as reliably as any refusal: nothing can have been
 * dispatched before the scope exists.
 *
 * The probe is created here and handed to the body, so both catch sites read the
 * same dispatch flag.
 */
export async function leasedMutation<T extends CallToolResult>(
  deps: BrowserToolDeps,
  surfaceId: string | undefined,
  body: (scope: BrowserTargetScope, effect: EffectProbe) => Promise<T>,
  opts?: AutomationLeaseOpts<T>,
): Promise<T | CallToolResult> {
  const effect = createEffectProbe();
  let settled: BrowserTargetScope | undefined;
  try {
    return await withAutomationLease(
      deps,
      surfaceId,
      (scope) => {
        settled = scope;
        return body(scope, effect);
      },
      opts,
    );
  } catch (error) {
    const failed = withEffectTrailer(
      {
        content: [{ type: 'text' as const, text: describeToolError(error) }],
        isError: true,
      },
      effect.failure(error),
    );
    // A body that threw past its own catch skipped the lease's drain; a dialog
    // its action raised is reported here instead of one call late.
    return settled ? prependModalNotes(failed, settled) : failed;
  }
}
