import type { RpcRouter } from '../RpcRouter';
import { eventBus } from '../../events/EventBus';
import {
  WMUX_EVENT_TYPES,
  RING_CAPACITY,
  POLL_DEFAULT_MAX,
  type WmuxEventType,
  type A2aTaskEvent,
  type ChannelMessageEvent,
} from '../../../shared/events';
import type { PluginIdentityRecord } from '../../../shared/rpc';

const TYPE_SET = new Set<WmuxEventType>(WMUX_EVENT_TYPES);

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

export function registerEventsRpc(router: RpcRouter, trustLookup?: TrustLookup): void {
  /**
   * events.poll — pull events newer than `cursor`.
   * params: { cursor?: number, types?: WmuxEventType[], workspaceId?: string, max?: number }
   *
   * Default cursor is 0 (replay from oldest in the ring). External callers
   * SHOULD scope to their own `workspaceId` so they don't see other
   * workspaces' lifecycle. The renderer hop is bypassed — main answers
   * directly from the in-process ring.
   */
  router.register('events.poll', async (params, ctx) => {
    const cursor = typeof params['cursor'] === 'number' && Number.isFinite(params['cursor'])
      ? Math.max(0, Math.floor(params['cursor']))
      : 0;
    const workspaceId = typeof params['workspaceId'] === 'string' && params['workspaceId'].length > 0
      ? params['workspaceId']
      : undefined;
    const max = typeof params['max'] === 'number' && Number.isFinite(params['max'])
      ? Math.max(1, Math.floor(params['max']))
      : undefined;
    const types = parseTypes(params['types']);

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
    const result = eventBus.poll(cursor, { types, max: RING_CAPACITY });

    // Dual-party + per-recipient + strict scoping post-filter. `caller` is the
    // verified wsFilter (server-pinned for MCP via requireWorkspaceId), or
    // undefined for an unscoped poll (e.g. the plugin-host forwarding poll).
    //
    // Three cases:
    //   - a2a.task:  fixed 2 workspaces — visible to sender (`from`) and
    //                receiver (`to`); dropped unscoped.
    //   - channel.message: N recipients in M workspaces — visible to sender
    //                (`workspaceId`) AND every member workspace in
    //                `recipientWorkspaceIds`; dropped unscoped.
    //                Generalizes the a2a.task pattern from 2 → N. Sender is
    //                always in the recipient list (membership is a
    //                precondition of post), so the dual-party code path
    //                would have missed the recipient-other-than-sender case.
    //   - everything else: strict `workspaceId === caller` (unchanged).
    const caller = workspaceId;
    result.events = result.events.filter((e) => {
      if (e.type === 'a2a.task') {
        // The `!!caller &&` clause is LOAD-BEARING — an unscoped poll
        // (no workspaceId) must receive ZERO a2a.task events, else a bare
        // `events.subscribe` plugin reads every pair's task.
        return !!caller &&
          ((e as A2aTaskEvent).from === caller || (e as A2aTaskEvent).to === caller);
      }
      if (e.type === 'channel.message') {
        // Per-recipient scoping: same load-bearing unscoped-drop as a2a.task.
        // `e.workspaceId` is the sender (base scope); every member
        // workspace appears in `recipientWorkspaceIds` so a post reaches
        // its full set without leaking to third parties.
        const ce = e as ChannelMessageEvent;
        if (!caller) return false;
        if (ce.workspaceId === caller) return true;
        return ce.recipientWorkspaceIds.includes(caller);
      }
      // every other type: strict scope, UNCHANGED from the old EventBus gate
      return caller ? e.workspaceId === caller : true;
    });

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

    // notifications.read opt-in gate (see allowsNotifications). Applied as
    // a post-poll filter — NOT by rewriting `types` — because EventBus
    // treats an empty types array as "no filter", so a types-rewrite that
    // drains to [] would deliver everything to an unentitled caller.
    // Filtering the result keeps the cursor math intact (the caller's
    // nextCursor still advances past withheld events; they can never see
    // them anyway).
    if (ctx?.clientName && trustLookup) {
      let trust: PluginIdentityRecord | undefined;
      try {
        trust = await trustLookup(ctx.clientName);
      } catch {
        trust = undefined; // unreadable trust DB → grandfather, enforcer handles the rest
      }
      if (!allowsNotifications(trust)) {
        return {
          ...result,
          events: result.events.filter((e) => e.type !== 'notification.received'),
        };
      }
    }

    return result;
  });
}
