import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { eventBus } from '../../events/EventBus';
import {
  WMUX_EVENT_TYPES,
  RING_CAPACITY,
  POLL_DEFAULT_MAX,
  type WmuxEventType,
  type WmuxEvent,
  type A2aTaskEvent,
  type ChannelMessageEvent,
  type ChannelCatalogEvent,
} from '../../../shared/events';
import type { PluginIdentityRecord } from '../../../shared/rpc';
import { isHostedCaller, hostedBindingOf } from '../../../shared/rpc';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { MAX_PIPE_CONNECTIONS } from '../PipeServer';

type GetWindow = () => BrowserWindow | null;

const TYPE_SET = new Set<WmuxEventType>(WMUX_EVENT_TYPES);

/**
 * The confidentiality-sensitive event types whose per-recipient / dual-party
 * workspace scope IS a real boundary: each is DROPPED entirely for an unscoped
 * poll, so the caller-supplied `workspaceId` is the only thing gating another
 * workspace's private task pointer / channel conversation (audit B3). Every
 * OTHER (lifecycle) type falls through to an all-workspace firehose on an
 * unscoped poll — already reachable by any `events.subscribe` caller — so its
 * workspace scope is a convenience filter, not a confidentiality boundary.
 */
const PRIVATE_EVENT_TYPES: ReadonlySet<WmuxEventType> = new Set<WmuxEventType>([
  'a2a.task',
  'channel.message',
  'channel.catalog',
  'channel.nudgeExhausted',
]);

/**
 * Ceiling on `blockMs`. Deliberately UNDER the MCP host's stdio idle window
 * (30 min by default), so a single held poll can never be the thing that trips
 * it even if the progress-notification keepalive is unavailable. A caller that
 * wants to wait longer re-polls — the cursor makes that lossless.
 */
const MAX_BLOCK_MS = 600_000;

/**
 * How many polls may be parked at once, process-wide.
 *
 * A parked poll holds a pipe connection open (the MCP client opens one socket
 * per call), so this IS the back-pressure knob: without it a fleet plus retries
 * plus a buggy caller can pin main's pipe server. Over the cap we do not queue
 * or reject — we answer immediately with whatever the ring has, which is
 * exactly the pre-block behavior, and flag it so the caller can back off.
 *
 * DERIVED from the pipe server's connection budget rather than picked, because
 * the two are spending the same resource. A flat 32 against MAX_PIPE_CONNECTIONS=50
 * leaves only 18 for everything else: parking a fleet plus ordinary traffic
 * exhausts the server, Node stops accepting, and EVERY other MCP tool starts
 * failing with what the client reports as "wmux is not running" — a self-inflicted
 * outage that looks like a crash and does not point back here. A quarter keeps
 * the majority of the budget for the connect → send → close traffic that is the
 * normal shape.
 */
const MAX_PARKED_POLLS = Math.floor(MAX_PIPE_CONNECTIONS / 4);

let parkedPolls = 0;

/**
 * Park until an event this caller could care about is emitted, or the deadline
 * passes. Resolves `true` if an event woke us, `false` on timeout.
 *
 * `interesting` is a CHEAP per-event pre-filter run inside the emitter's stack.
 * Without it every emit wakes every parked poll and each one re-scans the whole
 * 1024-entry ring through the full scope chain — O(parked × ring) of synchronous
 * work in the main process per event, on a bus that ticks once per shell command
 * under OSC 133. The predicate is deliberately allowed to be over-permissive:
 * it exists to skip obvious non-matches, and `collect()` remains the authority.
 *
 * The unsubscribe is DEFERRED to a microtask, and that is load-bearing. EventBus
 * fans out with `for (const sub of this.subscribers)`, so removing an entry from
 * that array mid-iteration shifts the remaining ones and the iterator SKIPS the
 * next subscriber. Unsubscribing synchronously here meant the first parked poll
 * to wake silently stole the wake from the next one — measured: subscribers
 * [A,B,C] with A self-removing fires A and C, never B. The skipped poll then sat
 * until some later event or its full deadline, even though its event was already
 * in the ring. Exactly the fleet case this feature is for, and invisible with a
 * single waiter. `done` makes the extra callbacks that arrive before the
 * microtask runs into no-ops.
 */
function waitForEmit(
  timeoutMs: number,
  interesting: (event: WmuxEvent) => boolean,
  signal?: AbortSignal,
): Promise<'event' | 'timeout' | 'aborted'> {
  // Already gone: don't arm a timer or take an EventBus subscription just to
  // tear both down a tick later. A client that hangs up mid-loop would pay that
  // churn on every remaining iteration.
  if (signal?.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    let done = false;
    // Declared before anything can call finish(), and armed first. EventBus's
    // subscribe() only pushes today, so ordering these the other way happens to
    // work — but if it ever replayed, or an emit re-entered during subscribe,
    // finish() would touch `timer` in its temporal dead zone and throw. That
    // throw lands inside EventBus's per-subscriber try/catch, so it would be
    // SWALLOWED: the promise never settles, and the parkedPolls slot it holds
    // is leaked for the life of the process. Enough of those and parking is
    // silently off for everyone, with nothing in the logs pointing here. Cheap
    // to make order-independent instead.
    const teardown: {
      timer?: ReturnType<typeof setTimeout>;
      unsubscribe?: () => void;
    } = {};
    const finish = (outcome: 'event' | 'timeout' | 'aborted'): void => {
      if (done) return;
      done = true;
      if (teardown.timer !== undefined) clearTimeout(teardown.timer);
      signal?.removeEventListener('abort', onAbort);
      if (teardown.unsubscribe) queueMicrotask(teardown.unsubscribe);
      resolve(outcome);
    };
    const onAbort = (): void => finish('aborted');
    teardown.timer = setTimeout(() => finish('timeout'), timeoutMs);
    teardown.unsubscribe = eventBus.subscribe((event) => {
      if (done) return;
      // A throwing predicate would be swallowed by EventBus and cost this
      // caller its whole budget waiting for a wake it already earned. Treat a
      // failure as "might match" and let collect() — the authority — decide.
      let match = true;
      try {
        match = interesting(event);
      } catch {
        match = true;
      }
      if (match) finish('event');
    });
    // An already-aborted signal never fires the event, so check before listening.
    if (signal?.aborted) finish('aborted');
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resolve the caller's OWN workspace from a verified `senderPtyId` — the same
 * anchor a2a.channel.* mutations use (resolved via the renderer's
 * `input.findOwnerWorkspace`, which owns the authoritative pane→workspace map).
 * Returns '' when there is no resolvable senderPtyId (no PTY identity, or the
 * renderer is unavailable), so the agent-transport private scope fails closed.
 * NOT bound to the pipe connection's PID, so it remains ADVISORY attribution
 * under the #113 same-user ceiling — but it raises events.poll's bar from
 * "name any workspace id" (B3) to "hold a live pane's ptyId", matching the
 * a2a.channel.* write/read forge bar. A true unforgeable fix is peer-PID
 * (GetNamedPipeClientProcessId), deferred with the rest of the #113 track.
 */
async function resolveCallerWorkspace(
  getWindow: GetWindow,
  params: Record<string, unknown>,
): Promise<string> {
  const raw = params['senderPtyId'];
  const senderPtyId = typeof raw === 'string' ? raw.trim() : '';
  if (!senderPtyId) return '';
  try {
    // Mirror-first (workspace/ptyOwnership.ts) — this runs on every private-
    // scoped agent poll, so the renderer round-trip is fallback, not hot path.
    const wsId = await resolvePtyOwnerWorkspace(getWindow, senderPtyId);
    return wsId ?? '';
  } catch {
    // Renderer unavailable (early boot / reload) — treat as unresolvable.
    return '';
  }
}

/**
 * Async trust lookup, wired by main/index.ts to PluginTrustStore.get.
 * Optional so unit tests (and transitional callers) keep the unfiltered
 * pre-B-1 behavior.
 */
type TrustLookup = (clientName: string) => Promise<PluginIdentityRecord | undefined>;

/**
 * `notification.received` events carry terminal-program-controlled text, so
 * they are opt-in: a plugin with a declared capability set must include
 * `notifications.read` (bare or with a glob) to receive them
 * (schema-freeze §1/§4). Callers without an identity envelope or without a
 * declaration are grandfathered (consistent with the legacy/shadow ladder —
 * first-party and pre-declaration clients keep full visibility).
 */
function allowsNotifications(trust: PluginIdentityRecord | undefined): boolean {
  if (!trust?.declaredCapabilities || trust.declaredCapabilities.length === 0) return true;
  return trust.declaredCapabilities.some(
    (c) => c === 'notifications.read' || c.startsWith('notifications.read:'),
  );
}

function parseTypes(raw: unknown): WmuxEventType[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: WmuxEventType[] = [];
  for (const t of raw) {
    if (typeof t === 'string' && TYPE_SET.has(t as WmuxEventType)) {
      out.push(t as WmuxEventType);
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Upper bound on `workspaceIds` entries. A renderer polls its own local
 *  workspaces (single digits in practice); 64 is hygiene against a
 *  pathological caller flooding the filter set, not a functional limit. */
const MAX_WORKSPACE_IDS = 64;

/**
 * FIX-MULTI-WS — parse the optional `workspaceIds` union-scope param.
 * Non-string / empty entries are dropped; the list is capped. Returns
 * undefined when the param is absent or yields nothing, so the single
 * `workspaceId` path stays byte-for-byte the pre-existing behavior.
 *
 * Security note: this does NOT widen the pipe threat model — `workspaceId`
 * was already caller-supplied on this router (a pipe client could poll any
 * workspace one id at a time), and the MCP layer builds its params
 * server-side with a pinned `workspaceId` only, so an MCP client can never
 * inject `workspaceIds`.
 */
function parseWorkspaceIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const w of raw) {
    if (typeof w === 'string' && w.length > 0) {
      out.push(w);
      if (out.length >= MAX_WORKSPACE_IDS) break;
    }
  }
  return out.length > 0 ? out : undefined;
}

export function registerEventsRpc(
  router: RpcRouter,
  getWindow: GetWindow,
  trustLookup?: TrustLookup,
): void {
  /**
   * events.poll — pull events newer than `cursor`.
   * params: { cursor?: number, types?: WmuxEventType[], workspaceId?: string,
   *           workspaceIds?: string[], senderPtyId?: string, max?: number }
   *
   * Default cursor is 0 (replay from oldest in the ring). The renderer hop is
   * bypassed — main answers directly from the in-process ring.
   *
   * Scoping is split by trust (audit B3 — see the scope-resolution block below):
   * LIFECYCLE events honor the caller-supplied `workspaceId` scope, but PRIVATE
   * events (a2a.task, channel.*) are gated by a SERVER-RESOLVED workspace for an
   * agent transport (from a verified `senderPtyId`) — the caller-supplied
   * workspaceId cannot open another workspace's channels over the wire. The
   * first-party operator (renderer bridge / plugin host, `ctx.firstParty`) keeps
   * scoping every local workspace it names.
   */
  router.register('events.poll', async (params, ctx) => {
    const cursor = typeof params['cursor'] === 'number' && Number.isFinite(params['cursor'])
      ? Math.max(0, Math.floor(params['cursor']))
      : 0;
    const workspaceId = typeof params['workspaceId'] === 'string' && params['workspaceId'].length > 0
      ? params['workspaceId']
      : undefined;
    // FIX-MULTI-WS: optional union scope. A multi-workspace renderer passes
    // every LOCAL workspace id in ONE poll so a channel.message addressed to a
    // background workspace still reaches it (the single-workspace filter
    // silently dropped those — delivery only worked for the active workspace).
    const workspaceIds = parseWorkspaceIds(params['workspaceIds']);
    const max = typeof params['max'] === 'number' && Number.isFinite(params['max'])
      ? Math.max(1, Math.floor(params['max']))
      : undefined;
    const types = parseTypes(params['types']);

    // ── Optional block + narrowing (additive; every default is the old behavior)
    //
    // `blockMs` absent or <= 0 keeps this an immediate-return poll, byte for
    // byte. Only a caller that asks to wait ever parks.
    const blockMs = typeof params['blockMs'] === 'number' && Number.isFinite(params['blockMs'])
      ? Math.min(MAX_BLOCK_MS, Math.max(0, Math.floor(params['blockMs'])))
      : 0;
    // Narrow to one pane. Events that carry no ptyId are DROPPED when this is
    // set — "events about this pty" cannot honestly include events that are not
    // about any pty. Without it a caller waiting on one pane wakes on every
    // pane's traffic and has to re-filter, which is the polling loop we are
    // removing.
    const ptyId = typeof params['ptyId'] === 'string' && params['ptyId'].length > 0
      ? params['ptyId']
      : undefined;
    // Narrow `agent.lifecycle` by its `kind` (agent.stop / agent.subagent_stop /
    // agent.awaiting_input). Applies ONLY to that type — every other type passes
    // through untouched, so `kinds` never silently empties a mixed poll.
    // An EMPTY array normalizes to "no filter", matching how `types` behaves on
    // this same call (EventBus treats an empty type list as unfiltered). Left as
    // an empty Set it would mean the opposite — drop every agent.lifecycle — so
    // the same shape would widen one param and silently blind the other.
    const kindList = Array.isArray(params['kinds'])
      ? (params['kinds'] as unknown[]).filter((k): k is string => typeof k === 'string')
      : [];
    const kinds = kindList.length > 0 ? new Set(kindList) : undefined;

    // Workspace scoping is applied as a POST-filter here (placement B), NOT via
    // the EventBus wsFilter, for ONE load-bearing reason: an a2a.task's base
    // `workspaceId === from`, but the *receiver* (`caller === to`) must also
    // see it. EventBus.poll's wsFilter (`ev.workspaceId !== wsFilter → drop`)
    // would pre-drop the `created`/`updated` event before the `to`-receiver
    // could ever match it. So we poll WITHOUT the strict wsFilter and re-impose
    // scoping below: strict (`workspaceId === caller`) for every non-a2a type —
    // identical to the old EventBus gate — and dual-party (`from`/`to`) for
    // a2a.task only.
    //
    // `max` is ALSO deferred to after the scope filter (placement B): handing it
    // to EventBus would let unrelated workspaces' events fill the page and then
    // get post-filtered away, starving a small-`max` scoped subscriber (its own
    // matching event sits just past the foreign ones, so it takes one extra poll
    // per foreign event). Instead we over-fetch the whole ring window, scope,
    // THEN truncate to the caller's page size and rewind nextCursor to the last
    // delivered event — so the next poll resumes exactly after it and no
    // matching event is ever skipped.
    // The ring read itself moved into `collect()` below so a parked poll can
    // re-run it on wake WITHOUT redoing the scope resolution (which can cost a
    // renderer round-trip). Scope is a property of the caller, not of the
    // attempt, so resolving it once per call is both cheaper and more correct:
    // a mid-park identity change cannot flip a private scope open.
    //
    // ── Caller scope resolution (audit B3 — events.poll identity) ─────────────
    //
    // Two scopes, because the ring carries two classes of event with different
    // trust properties:
    //
    //   • PRIVATE types (a2a.task, channel.*) are DROPPED entirely for an
    //     unscoped poll, so their workspace scope IS the confidentiality
    //     boundary — a caller-supplied `workspaceId` is the only thing gating
    //     another workspace's private task pointer / channel conversation.
    //   • LIFECYCLE types (pane.*, process.*, agent.lifecycle,
    //     workspace.metadata.changed, notification.received) fall through to an
    //     all-workspace firehose on an unscoped poll, so their workspace scope
    //     is a CONVENIENCE filter — every events.subscribe caller can already
    //     read them unscoped, so tightening it would close no leak.
    //
    // clientScope = the caller-supplied workspaceId/workspaceIds union. Trusted
    // for LIFECYCLE always, and for PRIVATE too WHEN the caller is the
    // first-party operator (the renderer bridge / plugin host — a human operates
    // every local workspace; ctx.firstParty is set only by those trusted
    // in-process dispatch entry points, never by the external wire).
    //
    // For an AGENT transport (pipe/MCP off the external wire) the caller-supplied
    // workspaceId is self-asserted and MUST NOT gate a private conversation
    // (B3: a same-user pipe client could poll any workspace's channels by naming
    // its id). privateScope is instead SERVER-RESOLVED from a verified
    // senderPtyId and the caller-supplied workspaceId is IGNORED for private
    // types. No resolvable identity ⇒ empty privateScope ⇒ every private event
    // fails closed (exactly the unscoped-drop that already applied, so no honest
    // lifecycle subscriber regresses). The MCP `wmux_events_poll` tool forwards
    // its own PID-walked senderPtyId, so a legitimately-placed agent resolves to
    // its OWN workspace.
    // FIX-MULTI-WS: clientScope is a SET — the single `workspaceId` plus the
    // optional `workspaceIds` union. Empty set keeps the pre-existing unscoped
    // lifecycle semantics.
    const clientSet = new Set<string>(workspaceIds ?? []);
    if (workspaceId) clientSet.add(workspaceId);
    const clientScoped = clientSet.size > 0;

    // Resolve privateScope only when a private type could actually appear in the
    // page (types omitted ⇒ all types) — a lifecycle-only poll never pays the
    // renderer round-trip. First-party operators reuse clientSet; the agent path
    // resolves server-side ('' ⇒ empty set ⇒ private types fail closed).
    const wantsPrivate = !types || types.some((t) => PRIVATE_EVENT_TYPES.has(t));
    let privateSet: Set<string>;
    if (ctx?.firstParty && !isHostedCaller(ctx)) {
      // The OPERATOR (renderer bridge): a human operates every local
      // workspace, so the caller-supplied scope is trusted for private types.
      privateSet = clientSet;
    } else if (isHostedCaller(ctx)) {
      // #922 E — the plugin host also dispatches first-party, but it is NOT
      // the operator (RpcContext.hostedWorkspace doc). Treating it as one let
      // an approved plugin gate another workspace's a2a.task / channel.*
      // events by simply naming its id. Same rule as the B3 agent path: the
      // caller-supplied workspaceId is IGNORED for private types and the
      // scope is the server-derived binding — the workspace the host is
      // showing. An unbound hosted caller (`null`) resolves to the empty set,
      // so private types fail closed exactly like an unresolvable agent;
      // lifecycle types keep their every-subscriber semantics either way.
      const bound = hostedBindingOf(ctx);
      privateSet = bound ? new Set<string>([bound]) : new Set<string>();
    } else if (wantsPrivate) {
      const resolved = await resolveCallerWorkspace(getWindow, params);
      privateSet = resolved ? new Set<string>([resolved]) : new Set<string>();
    } else {
      privateSet = new Set<string>();
    }
    const privateScoped = privateSet.size > 0;

    // notifications.read opt-in gate (see allowsNotifications). Resolved ONCE,
    // before any collect: it depends only on the caller's identity, and a parked
    // poll must not re-hit the trust DB on every wake.
    let allowNotifications = true;
    const refreshNotificationsGate = async (): Promise<void> => {
      if (!ctx?.clientName || !trustLookup) return;
      let trust: PluginIdentityRecord | undefined;
      try {
        trust = await trustLookup(ctx.clientName);
      } catch {
        trust = undefined; // unreadable trust DB → grandfather, enforcer handles the rest
      }
      // NARROW-ONLY. A park can last minutes, so an entitlement revoked during
      // it must take effect before the page is written — but a grant that
      // arrives mid-park must NOT retroactively open the page the caller was
      // already waiting on. `&&` gives exactly that: this can turn true→false
      // and never false→true. The private-workspace scope is deliberately NOT
      // re-resolved (it costs a renderer round-trip per check, and unlike this
      // it fails closed already), so its revocation lands on the next poll.
      allowNotifications = allowNotifications && allowsNotifications(trust);
    };
    await refreshNotificationsGate();

    /**
     * One attempt: read the ring from `cursor`, apply every scope/narrowing
     * filter, page it. Pure and synchronous, so a parked poll can re-run it on
     * each wake for the cost of a ring scan.
     *
     * Always reads from the ORIGINAL `cursor`, never from the previous
     * attempt's nextCursor — an attempt that matched nothing must not advance
     * the caller past events it never received.
     */
    const collect = () => {
      const result = eventBus.poll(cursor, { types, max: RING_CAPACITY });

    result.events = result.events.filter((e) => {
      if (e.type === 'a2a.task') {
        // Dual-party: visible to sender (`from`) and receiver (`to`) ONLY. The
        // `privateScoped &&` clause is LOAD-BEARING — an unresolved / unscoped
        // caller must receive ZERO a2a.task events, else a bare events.subscribe
        // plugin (or a workspaceId-forging pipe client) reads every pair's task.
        return privateScoped &&
          (privateSet.has((e as A2aTaskEvent).from) || privateSet.has((e as A2aTaskEvent).to));
      }
      if (e.type === 'channel.message') {
        // Per-recipient scoping: same load-bearing drop as a2a.task.
        // `e.workspaceId` is the sender (base scope); every member workspace
        // appears in `recipientWorkspaceIds` so a post reaches its full set
        // without leaking to third parties. Gated on privateSet — the
        // caller-supplied workspaceId never gates this for an agent transport.
        const ce = e as ChannelMessageEvent;
        if (!privateScoped) return false;
        if (privateSet.has(ce.workspaceId)) return true;
        return ce.recipientWorkspaceIds.some((r) => privateSet.has(r));
      }
      if (e.type === 'channel.catalog') {
        // A1 — same per-recipient scoping as channel.message: base workspaceId
        // is the actor; recipientWorkspaceIds is the member set + any removed ws.
        const ce = e as ChannelCatalogEvent;
        if (!privateScoped) return false;
        // '*' sentinel = broadcast to every workspace. A public channel's
        // creation is discoverable by all scoped callers, but the member-scoped
        // recipient list wouldn't reach non-members (codex+GLM P2), so create()
        // emits '*' for public channels.
        if (ce.recipientWorkspaceIds.includes('*')) return true;
        if (privateSet.has(ce.workspaceId)) return true;
        return ce.recipientWorkspaceIds.some((r) => privateSet.has(r));
      }
      if (e.type === 'channel.nudgeExhausted') {
        // Channels v2 — same drop discipline as the other channel.* events
        // (channel existence must not leak to a bare / unresolved subscribe).
        // Base workspaceId is the affected member's workspace; only it sees it.
        return privateScoped && privateSet.has(e.workspaceId);
      }
      // Lifecycle types: caller-supplied scope (UNCHANGED). Not a confidentiality
      // boundary — an unscoped poll already returns the all-workspace firehose to
      // any events.subscribe caller — so honoring the client's workspaceId here
      // is a convenience filter and preserves external lifecycle subscribers.
      return clientScoped ? clientSet.has(e.workspaceId) : true;
    });

      // pty / kind narrowing. AFTER scope, so it can only ever remove events
      // the caller was already entitled to see — never widen.
      if (ptyId) {
        result.events = result.events.filter(
          (e) => (e as { ptyId?: unknown }).ptyId === ptyId,
        );
      }
      if (kinds) {
        result.events = result.events.filter(
          (e) => e.type !== 'agent.lifecycle'
            || kinds.has(String((e as { kind?: unknown }).kind)),
        );
      }

      // Re-impose the caller's page size AFTER scoping (see the over-fetch note
      // above). EventBus drained the ring for us, so if the scoped page still
      // exceeds `max` we truncate here and rewind nextCursor to the last delivered
      // event's seq — the next poll resumes right after it. seq is monotonic, so
      // this never skips a withheld matching event (it only defers it one page).
      const pageMax = max ?? POLL_DEFAULT_MAX;
      if (result.events.length > pageMax) {
        const page = result.events.slice(0, pageMax);
        result.nextCursor = page[page.length - 1].seq;
        result.events = page;
      }

      // NOTE on nextCursor and filters — deliberately NOT "fixed" here.
      //
      // EventBus advances nextCursor over everything it scanned, matched or not,
      // so a filtered poller does not re-walk the ring each time. A cursor is one
      // scalar, so it can only mean "everything up to here, under the filter you
      // just used". Carry it to a poll with a DIFFERENT filter and the events the
      // old filter skipped are already behind it. That is pre-existing behavior
      // for `types`; `ptyId`/`kinds` join it.
      //
      // Rewinding looks like the fix and is not. Rewinding to the last delivered
      // event still steps over non-matches interleaved BEFORE it (measured:
      // deliver seq 1 and 3, cursor lands on 3, seq 2 is gone anyway). Rewinding
      // to the first dropped event is genuinely lossless but then a steady stream
      // of other panes' traffic pins the cursor, and the caller re-receives its
      // own matches forever. Neither is better than saying what is true.
      //
      // So: one cursor chain per filter combination. A caller watching several
      // panes keeps a cursor per pane, or polls unfiltered and narrows its own
      // side. The tool description says this outright rather than promising a
      // losslessness that a scalar cursor cannot deliver.

      // notifications.read opt-in gate (see allowsNotifications). Applied as
      // a post-poll filter — NOT by rewriting `types` — because EventBus
      // treats an empty types array as "no filter", so a types-rewrite that
      // drains to [] would deliver everything to an unentitled caller.
      // Filtering the result keeps the cursor math intact (the caller's
      // nextCursor still advances past withheld events; they can never see
      // them anyway).
      if (!allowNotifications) {
        return {
          ...result,
          events: result.events.filter((e) => e.type !== 'notification.received'),
        };
      }

      return result;
    };

    // Cheap pre-filter for the parked path (see waitForEmit). Mirrors the
    // narrowing filters only — never the scope filters, which is why it can be
    // over-permissive without being wrong: a false positive costs one extra
    // collect(), a false NEGATIVE would be a missed wake, so anything uncertain
    // must pass.
    const interesting = (event: WmuxEvent): boolean => {
      if (types && !types.includes(event.type)) return false;
      if (ptyId && (event as { ptyId?: unknown }).ptyId !== ptyId) return false;
      if (kinds && event.type === 'agent.lifecycle'
        && !kinds.has(String((event as { kind?: unknown }).kind))) return false;
      // Workspace scope, for the lifecycle types ONLY — the ones collect()
      // actually decides with `clientSet`. Without this a poll that named no
      // pane and no types (which the tool allows) has nothing to filter on, so
      // every event on the bus wakes it, costs a full ring re-scan through the
      // whole scope chain, yields an empty page and parks again. Under OSC 133
      // the bus ticks once per shell command, so at fleet scale that is
      // O(parked × ring) of synchronous main-process work per command.
      //
      // The PRIVATE types are deliberately exempt and must stay that way: they
      // are scoped per RECIPIENT, not by the base workspaceId. A
      // channel.message carries the SENDER in `workspaceId` and the member set
      // in `recipientWorkspaceIds`; a2a.task is dual-party; channel.catalog can
      // carry a '*' broadcast. Testing `clientSet` against `workspaceId` on any
      // of those would skip a wake the caller is entitled to — and a missed
      // wake is the single failure this pre-filter must never introduce, since
      // the event is already in the ring and nothing will re-announce it.
      if (clientScoped
        && !PRIVATE_EVENT_TYPES.has(event.type)
        && !clientSet.has(event.workspaceId)) return false;
      // An unentitled caller has these stripped by collect() anyway, so waking
      // for them is pure churn — and a caller that asked ONLY for them would
      // wake on every one for its whole budget and deliver nothing.
      if (!allowNotifications && event.type === 'notification.received') return false;
      return true;
    };

    // ── Immediate path — unchanged behavior ───────────────────────────────────
    // No `blockMs`, or the ring already has something for this caller: answer
    // now. Every pre-existing caller lands here.
    //
    // `resync` also short-circuits: it means the cursor fell out of the ring, so
    // events this caller never saw are already gone. Parking on that waits up to
    // ten more minutes to deliver a page that cannot contain them — the caller
    // needs to reconcile via pane_list NOW, and every extra minute is more
    // history sliding out of the window.
    const first = collect();
    if (blockMs <= 0 || first.events.length > 0 || first.resync) return first;

    // ── Parked path ───────────────────────────────────────────────────────────
    // Over the cap we degrade to the immediate answer rather than queueing:
    // parking is a convenience, and a caller that cannot park is strictly better
    // off polling than waiting behind others for a connection slot.
    if (parkedPolls >= MAX_PARKED_POLLS) {
      return { ...first, parked: false, parkedCapReached: true };
    }

    parkedPolls++;
    try {
      // Monotonic, not wall-clock: a backward system clock step (NTP correction,
      // a VM resuming) would inflate `remaining` off Date.now() and hold the
      // socket past the client's own deadline — the client gives up, the slot
      // stays taken. The remaining time is also re-clamped to the original
      // budget so no single wait can exceed what the caller asked for.
      const startedAt = performance.now();
      for (;;) {
        // The client is gone — stop holding its connection slot. Collect once
        // more below anyway: the response write is already no-op'd on a dead
        // socket, and bailing early keeps the exit path single.
        if (ctx?.signal?.aborted) break;
        const remaining = Math.min(blockMs, blockMs - (performance.now() - startedAt));
        if (remaining <= 0) break;
        // A wake means "an event that passed the cheap pre-filter" — collect()
        // is still the authority, so re-collect and keep waiting when the wake
        // turns out not to match after full scoping, instead of returning an
        // empty page and making the caller re-poll (the loop this removes).
        const outcome = await waitForEmit(remaining, interesting, ctx?.signal);
        if (outcome === 'aborted') break;
        const next = collect();
        // Same reasoning as above: a mid-park resync is terminal, not a reason
        // to keep waiting.
        if (next.events.length > 0 || next.resync) break;
        if (outcome === 'timeout') break;
      }
    } finally {
      parkedPolls--;
    }

    // Nobody is reading. Skip the trust-DB read and the ring re-scan that only
    // exist to shape a response the socket will discard — a fleet dying at once
    // (app quit, crash) would otherwise pay both per dead caller.
    if (ctx?.signal?.aborted) return { ...first, parked: true, aborted: true };

    // An entitlement can be revoked while a poll is parked; re-check before the
    // page is written, then re-collect so the gate is applied to it.
    await refreshNotificationsGate();

    // One final collect for BOTH exits (matched, or budget spent). Re-reading
    // from the original cursor is idempotent, so this cannot lose the page the
    // loop just found, and it picks up anything that landed between the last
    // wake and here — a lost wakeup of our own making otherwise.
    return { ...collect(), parked: true };
  });
}
