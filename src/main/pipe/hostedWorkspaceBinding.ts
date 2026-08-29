// #922 PR2 — dispatch-level hosted workspace binding.
//
// PR1 (#941) gave the iframe plugin host a server-derived workspace on
// `RpcContext.hostedWorkspace` and taught `browser.rpc.ts`'s `callerScope` to
// scope on it. Only that one handler file consults the binding; the rest of
// the method space still resolves a workspace out of the REQUEST BODY, and for
// a family of methods that resolution happens in the renderer:
//
//   `typeof params.workspaceId === 'string' ? params.workspaceId : store.activeWorkspaceId`
//
// Nine sites in `useRpcBridge.ts` have that shape. Each then resolves inside
// the named workspace with no ownership check, so an approved plugin that
// names a foreign workspace is answered about it — enumerating that
// workspace's panes (`pane.list`), reading its scrollback and viewport
// (`pane.search`, `input.readScreen`), creating a pane in it (`pane.split`),
// or opening and closing browser surfaces in it (`browser.open`,
// `browser.close`, the two `browser.*` methods that never reach `callerScope`).
//
// The check that looks like it covers the terminal-content pair does not.
// `assertWorkspaceOwnsPty` takes its caller workspace from `params.workspaceId`
// (`input.rpc.ts`) and early-returns when it is absent, so it answers "do the
// named workspace and this pty agree" — never "is the named workspace the
// caller's". It is a consistency check; the binding is the missing half.
//
// ── What this module decides ─────────────────────────────────────────────
//
// For a HOSTED caller only, and only for the methods listed below:
//
//   omitted workspaceId   -> resolved to the binding, at dispatch. It already
//                            landed on the right workspace via the renderer
//                            fallback, but that fallback re-reads the active
//                            workspace LATER, so a switch between dispatch and
//                            handling resolved the call somewhere the caller
//                            was never bound to. Pinning it here closes that
//                            and makes the binding visible in what the handler
//                            receives instead of implicit in a re-read.
//   foreign workspaceId   -> READ: substituted with the binding.
//                            WRITE: refused.
//   unbound host (`null`) -> refused, both classes. The plugin host dispatched
//                            this and had no workspace to bind to; falling
//                            through would leave the caller free to name its
//                            own, making an unbound plugin strictly LESS
//                            confined than a bound one (PR1's fail-open).
//
// The read/write seam is the owner's ruling on #922, and it is read off the
// capability each method already declares (`CAPABILITY_EFFECT`), not off a
// verdict table written here. Reads substitute because the plugin still gets a
// truthful answer — about itself — which is what #959 chose for private events
// and what keeps an approved plugin working instead of erroring mid-poll.
// Writes refuse because silently redirecting an action does not fail safe: it
// would create a pane, or open a surface, in a workspace nobody asked for.
//
// ── Scope, stated so the gaps are not read as oversights ─────────────────
//
// WIRE callers are untouched. Every decision here is keyed on
// `isHostedCaller`, which is true only for the in-process plugin host, so the
// `declared` and `legacy` lanes behave exactly as before — they still need the
// peer-credential primitive #922 tracks, and this does not supply it.
//
// The mode switch (`mcp.mode`) is deliberately NOT consulted. It is the
// rollback lever for the #810 browser scope TABLE, which changed how existing
// wire callers resolve; the hosted binding is a different caller class that
// nothing was relying on, and the two other places that already scope on it
// (`events.rpc.ts`, `a2a.channel.rpc.ts`, both #959) do not consult it either.
// Gating here would also make dev builds (where shadow is the default) behave
// differently from the packaged builds plugin authors ship against.
//
// Ceiling, unchanged from PR1 and #959: this confines an APPROVED plugin to
// the scope its approval implied. It is not a defence against hostile code
// already running as the user.

import type { RpcContext, RpcMethod } from '../../shared/rpc';
import { isHostedCaller, hostedBindingOf } from '../../shared/rpc';
import { CAPABILITY_EFFECT, METHOD_CAPABILITY, resolveRequiredCapability } from '../mcp/methodCapabilityMap';

/**
 * Methods that resolve a workspace out of the request body with no ownership
 * check of their own. Two bypass patterns feed this set, and the second was
 * missed on the first pass because the survey only looked for the first:
 *
 *   1. the renderer fallback — `params.workspaceId ?? store.activeWorkspaceId`
 *      in `useRpcBridge.ts`, which resolves inside whatever workspace the
 *      caller named;
 *   2. the SKIPPED ownership check — `assertWorkspaceOwnsPty` (`ptyOwnership.ts`)
 *      and `resolveTarget` (`pane.rpc.ts`) both early-return when
 *      `workspaceId` is absent, so a caller that names a foreign `ptyId` or
 *      `paneId` and NO workspace is not checked at all. Omitting the field was
 *      the bypass; that is why every method here has `workspaceId` pinned on
 *      omission rather than only on mismatch.
 *
 * `hostedWorkspaceBinding.drift.test.ts` scans the tree for both patterns and
 * fails when a plugin-reachable method carries one without appearing here.
 *
 * Deliberately out, having been checked:
 *
 *   `surface.list` / `surface.new`  — `wmux.internal`; no plugin can declare
 *                                     the reserved prefix, so unreachable.
 *   `pane.resolveActiveLeaf`        — a main->renderer channel with no router
 *                                     entry; not in the `RpcMethod` union.
 *   `pane.focus` / `pane.close` /   — no `workspaceId` param at all; they take
 *   `pane.stash` / `pane.unstash`     a globally-unique `paneId`. They are
 *                                     confined through `hostedConfinement`
 *                                     below instead, reusing the renderer's
 *                                     commander-confinement path.
 *
 * Everything ELSE stays out on purpose. `browser.*` beyond the two below
 * resolves its scope in `callerScope` (#941) and must keep doing so — a second
 * binding applied here would double-scope it under a different mode policy.
 * `events.poll` and `a2a.channel.*` resolve theirs in-handler (#959) with
 * per-event-class semantics that a blanket `workspaceId` injection would
 * quietly narrow: their LIFECYCLE half is an all-workspace firehose for every
 * subscriber by design, and pinning the param would turn that into a filter.
 *
 * Being a set rather than "every method" is also the conservative half of the
 * open question in the #922 design pass: `workspaceId` reads as caller scope
 * at every site surveyed, but that was not proven for the whole method space,
 * and a security boundary is the wrong place to assume it.
 */
const BODY_SCOPED_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  // Renderer-fallback family.
  'pane.list',
  'pane.search',
  'pane.split',
  'browser.open',
  'browser.close',
  // Terminal IO — `assertWorkspaceOwnsPty` skips itself when `workspaceId` is
  // absent, so these were reachable with a foreign `ptyId` and no workspace.
  // The pty ids are discoverable: lifecycle events are an all-workspace
  // firehose for every `events.subscribe` holder by design.
  'input.readScreen',
  'input.send',
  'input.sendKey',
  'terminal.readEvents',
  // Pane metadata — `resolveTarget` validates a `paneId` against "any
  // workspace" when `workspaceId` is omitted.
  'pane.getMetadata',
  'pane.setMetadata',
  'pane.clearMetadata',
  // Workspace-level metadata, with no fallback to hide behind: it REQUIRES a
  // caller-named workspace and then writes agent skills into it with no owner
  // check — the `declared` lane in renderer form. Surfaced by the drift scan
  // rather than by either survey. `meta.setStatus` / `meta.setProgress` are
  // the safe members of the same family: they ignore the body and write to
  // the active workspace, which for a hosted caller IS its binding.
  'meta.setSkills',
]);

export type HostedBindingRefusal =
  | 'hosted-workspace-unbound'
  | 'hosted-workspace-mismatch';

/**
 * What dispatch should do with this request. `params` on a `bound` decision is
 * a COPY — the plugin host's object is never mutated, so a caller that reuses
 * its params cannot observe the substitution and no handler can write back
 * through it.
 */
export type HostedBindingDecision =
  | { kind: 'untouched' }
  | {
      kind: 'bound';
      params: Record<string, unknown>;
      hostedWorkspaceId: string;
      /** Set only when a caller-named workspace was overridden (a READ). */
      substitutedFrom?: string;
    }
  | {
      kind: 'refused';
      reason: HostedBindingRefusal;
      requestedWorkspaceId?: string;
      hostedWorkspaceId?: string;
    };

/**
 * Whether this method's declared capability OBSERVES or CHANGES state.
 *
 * An unclassified capability is treated as a write, so a capability added
 * without a `CAPABILITY_EFFECT` row refuses a foreign workspace rather than
 * silently acquiring the substitute treatment. The same fail-closed default
 * covers the `wmux.internal` and bootstrap-exempt (`null`) sentinels, though
 * neither is reachable for a method in `BODY_SCOPED_METHODS`.
 */
function effectOf(method: RpcMethod, params: Record<string, unknown>): 'read' | 'write' {
  const entry = METHOD_CAPABILITY[method];
  if (!entry) return 'write';
  const capability = resolveRequiredCapability(entry, params);
  if (typeof capability !== 'string') return 'write';
  return CAPABILITY_EFFECT[capability] ?? 'write';
}

/**
 * Apply the hosted workspace binding to one dispatch.
 *
 * Returns `untouched` for every caller that is not the plugin host and for
 * every method outside `BODY_SCOPED_METHODS` — the overwhelming majority of
 * dispatches, and the reason this is a cheap set membership test before
 * anything else.
 */
export function hostedWorkspaceBinding(
  method: RpcMethod,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
): HostedBindingDecision {
  if (!isHostedCaller(ctx) || !BODY_SCOPED_METHODS.has(method)) {
    return { kind: 'untouched' };
  }

  const requested =
    typeof params.workspaceId === 'string' && params.workspaceId.length > 0
      ? params.workspaceId
      : undefined;

  // `hostedBindingOf` accepts any non-empty string; `RpcRouter` already trims
  // the dispatch option and normalises a whitespace-only value to `null`, so
  // the extra trim here is a backstop for a hand-built context (tests, a future
  // context constructor) rather than a production path. Same reasoning as the
  // hosted lane's source check in `browser.rpc.ts`: the rule must hold for
  // contexts the router did not build.
  const rawBound = hostedBindingOf(ctx);
  const bound = rawBound?.trim() ? rawBound.trim() : undefined;
  if (!bound) {
    return {
      kind: 'refused',
      reason: 'hosted-workspace-unbound',
      ...(requested && { requestedWorkspaceId: requested }),
    };
  }

  if (requested && requested !== bound) {
    if (effectOf(method, params) === 'write') {
      return {
        kind: 'refused',
        reason: 'hosted-workspace-mismatch',
        requestedWorkspaceId: requested,
        hostedWorkspaceId: bound,
      };
    }
    return {
      kind: 'bound',
      params: { ...params, workspaceId: bound },
      hostedWorkspaceId: bound,
      substitutedFrom: requested,
    };
  }

  return {
    kind: 'bound',
    params: { ...params, workspaceId: bound },
    hostedWorkspaceId: bound,
  };
}

/**
 * Caller-facing text for a refused hosted dispatch.
 *
 * Same disclosure rule as `scopeRefusalError` in `browser.rpc.ts`: name the
 * refusal, say it is terminal, say what the caller can do instead — and never
 * name a workspace. A refusal must not become the enumeration primitive it
 * exists to prevent, and that holds even for the caller's OWN binding so every
 * branch has one rule instead of two.
 */
const HOSTED_REFUSAL_REMEDY: Record<HostedBindingRefusal, string> = {
  'hosted-workspace-unbound':
    'the plugin host has no active workspace to resolve this call against',
  'hosted-workspace-mismatch':
    'omit workspaceId and this resolves to the workspace you are hosted in',
};

export function hostedRefusalMessage(
  method: RpcMethod,
  reason: HostedBindingRefusal,
): string {
  return (
    `${method}: HOSTED_SCOPE_REFUSED: ${HOSTED_REFUSAL_REMEDY[reason]}. ` +
    `Do not retry unchanged.`
  );
}

/**
 * The hosted binding for a caller on a method that takes NO `workspaceId` —
 * `pane.focus` / `pane.close` / `pane.stash` / `pane.unstash`, which address a
 * globally-unique `paneId` that the renderer resolves across ALL workspaces.
 *
 * There is no request field to pin, so these reuse the confinement channel a
 * validated commander already rides: main stamps `confineWorkspaceId` onto the
 * renderer request, and the renderer refuses when the pane's true owner
 * differs. Same mechanism, second writer.
 *
 * Three outcomes, and the middle one is the whole point:
 *   `none`     not a hosted caller — the handler behaves exactly as before.
 *   `confine`  stamp this id; the renderer enforces it against the real owner.
 *   `refuse`   a hosted caller with NO binding. It must not fall through to
 *              `none`, which is unconfined: that is the fail-open PR1 closed,
 *              and here it would mean closing another workspace's pane (a PTY
 *              dispose — a running session destroyed) rather than being told no.
 */
export type HostedConfinement =
  | { kind: 'none' }
  | { kind: 'confine'; workspaceId: string }
  | { kind: 'refuse' };

export function hostedConfinement(ctx: RpcContext | undefined): HostedConfinement {
  if (!isHostedCaller(ctx)) return { kind: 'none' };
  const bound = hostedBindingOf(ctx)?.trim();
  if (!bound) return { kind: 'refuse' };
  return { kind: 'confine', workspaceId: bound };
}

/**
 * Refusal text for a hosted caller with no binding on a pane-addressed method.
 * Names no workspace, for the same reason as `hostedRefusalMessage`.
 */
export function hostedUnboundPaneMessage(method: RpcMethod): string {
  return (
    `${method}: HOSTED_SCOPE_REFUSED: ` +
    `${HOSTED_REFUSAL_REMEDY['hosted-workspace-unbound']}. Do not retry unchanged.`
  );
}

/** Test-only view of the covered set, so a test can pin it without re-listing. */
export const HOSTED_BOUND_METHODS = BODY_SCOPED_METHODS;

/**
 * Test-only: the methods confined through `hostedConfinement` rather than by
 * pinning `workspaceId`. Kept beside the set above so the drift test can treat
 * the two together as "the covered surface".
 */
export const HOSTED_CONFINED_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'pane.focus',
  'pane.close',
  'pane.stash',
  'pane.unstash',
]);
