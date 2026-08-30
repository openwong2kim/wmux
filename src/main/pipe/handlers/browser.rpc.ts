import type { BrowserWindow } from 'electron';
import { shell, webContents } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import {
  ProfileManager,
  isSelectableBrowserProfile,
  validateBrowserProfileName,
} from '../../browser-session/ProfileManager';
import { PortAllocator } from '../../browser-session/PortAllocator';
import { HumanBehavior } from '../../browser-session/HumanBehavior';
import { WebviewCdpManager } from '../../browser-session/WebviewCdpManager';
import { BrowserCaptureManager } from '../../browser-session/BrowserCaptureManager';
import { validateResolvedNavigationUrl } from '../../security/navigationPolicy';
import { parseKeyPress } from './cdpKeys';
import {
  BROWSER_TABS_ACTIONS,
  browserTabsError,
  type BrowserTabsAction,
} from '../../../shared/browserTabs';
import {
  EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE,
  CHROME_BACKEND_RPC_UNSUPPORTED_MESSAGE,
  type ExternalOpenResult,
} from '../../../shared/browserBackend';
import type { RpcContext, RpcMethod } from '../../../shared/rpc';
import type {
  BrowserScopeShadowInput,
  BrowserScopeShadowReason,
} from '../../audit/shadowRejectionLog';
import type { BrowserBackendStore } from '../../browser-session/BrowserBackendStore';
import type { ChromeBackendClient, ChromeLauncherRegistry } from '../../browser-session/ChromeLauncher';
import { isLiveChromeReachable } from '../../browser-session/LiveChromeClient';
import type { EnforcementMode } from '../../mcp/enforcementMode';
import { isFirstPartyClient } from '../../mcp/firstParty';
import { isLocalExternalWireContext } from '../../mcp/rpcProvenance';

type GetWindow = () => BrowserWindow | null;

async function validateUrl(url: string, method: string): Promise<void> {
  const result = await validateResolvedNavigationUrl(url);
  if (!result.valid) {
    throw new Error(`${method}: ${result.reason}`);
  }
}

/**
 * Whether a caller may receive the raw CDP attach primitive and app-shell URL.
 *
 * A recognised client name is insufficient by itself: an approved iframe UI
 * plugin can use the same manifest name. The name lane therefore also requires
 * the positive external-wire marker supplied only by PipeServer (#810). The
 * renderer operator and locally source-qualified server-pinned callers are
 * trusted directly.
 */
export function canDiscloseBrowserAttachInfo(ctx: RpcContext | undefined): boolean {
  if (!ctx) return false;
  if (ctx.origin !== 'local') return false;
  if (ctx.operator === true) return true;
  if (typeof ctx.commanderWorkspace === 'string' && ctx.commanderWorkspace.length > 0) {
    // Commander browser methods are currently absent from COMMANDER_RPC_METHODS,
    // but keep the accepted pinned lane source-qualified if that surface grows.
    return isLocalExternalWireContext(ctx);
  }
  return isLocalExternalWireContext(ctx) && isFirstPartyClient(ctx.clientName);
}

export type BrowserCallerScopeDecision =
  | {
      kind: 'allowed';
      lane: 'operator' | 'legacy';
      workspaceId?: string;
    }
  | {
      kind: 'scoped';
      lane: 'pinned' | 'hosted' | 'verified' | 'declared';
      workspaceId: string;
    }
  | {
      kind: 'rejected';
      lane: 'context' | 'pinned' | 'hosted' | 'verified' | 'declared' | 'legacy';
      reason: BrowserScopeShadowReason;
      requestedWorkspaceId?: string;
      pinnedWorkspaceId?: string;
      hostedWorkspaceId?: string;
      verifiedWorkspaceId?: string;
    };

function requestedWorkspaceId(params: Record<string, unknown>): string | undefined {
  return typeof params['workspaceId'] === 'string' && params['workspaceId'].length > 0
    ? params['workspaceId']
    : undefined;
}

/**
 * Compute the caller-derived browser scope.
 *
 * #846 landed this table in shadow; it is now what target lookup actually uses
 * under `mcp.mode: enforce` (see `scopeFor` below).
 *
 * The table itself is unchanged by the enforcement step. Enforcing it did
 * surface one broken caller — `wmux browser navigate` outside a wmux pane omits
 * `workspaceId` on purpose while still sending its `clientName`, so it would
 * have been refused in every packaged build — but the fix belongs on the CLI,
 * which now asks `workspace.current` instead of leaving the server to guess.
 * A lane keyed on the CLI's `clientName` was tried and rejected: `clientName`
 * is self-asserted, so any wire caller could claim it and buy back exactly the
 * unscoped access this closes.
 *
 * Read that near-miss as the shadow evidence being weaker than it looked: #846's
 * window recorded no `browser.*` traffic at all, so it validated nothing about
 * these callers.
 *
 * What this closes and what it does NOT (#810, be precise — the tool layer has
 * been mistaken for a boundary before):
 *
 *   closes  an approved THIRD-party caller that OMITS `workspaceId` no longer
 *           falls through to the workspace-blind "first registered surface"
 *           lookup; it is refused. This is the caller #810 describes.
 *   closes  a pinned commander can no longer name a workspace other than the
 *           one its validated token is bound to.
 *   closes  (#922) an approved IFRAME PLUGIN can no longer point a browser
 *           target lookup — every `browser.*` method that resolves through
 *           `scopeFor` — at a workspace other than the one hosting it. It used
 *           to reach `declared` and receive whatever workspace it named, while
 *           #719 already held it to the active workspace for OBSERVATION:
 *           "may watch here, may act anywhere" was an asymmetry, not a
 *           decision. Confined to THIS table: the renderer's own fallbacks
 *           (`pane.list`, `browser.open` in `useRpcBridge.ts`) resolve a
 *           workspace without ever reaching here. #922 PR2 covers those at
 *           dispatch instead (`hostedWorkspaceBinding.ts`) — including
 *           `browser.open` / `browser.close`, the two `browser.*` methods
 *           that never reach this table. They are bound THERE rather than
 *           routed in here on purpose: this table's other lanes apply to wire
 *           callers too, and folding two previously unscoped methods into it
 *           would newly refuse an approved wire caller that omits
 *           `workspaceId` — a change #922 explicitly holds for the
 *           peer-credential track.
 *   closes  (#922 PR-B) a wire caller that CLAIMED a workspace is now scoped to
 *           the one it claimed. `mcp.claimWorkspace` mints a token bound to the
 *           workspace it creates for that caller (`workspaceClaimTrust.ts`), so
 *           the association is one main RECORDED rather than one the caller
 *           asserts — the `verified` lane below. A claim that has gone stale is
 *           refused rather than demoted into `declared`.
 *   narrows (#922, owner ruling (c)) the `legacy` lane no longer resolves an
 *           OMITTED workspaceId through the workspace-blind "first registered
 *           surface" lookup; that case is refused. The lane is NOT closed — a
 *           legacy caller that names a workspace is unchanged, byte for byte —
 *           because closing it belongs to the shared grandfather deprecation
 *           with `PermissionEnforcer` (#1111), not to this table. Narrowing the
 *           scope without touching the allow keeps one clock, not two.
 *   OPEN    the `declared` lane still checks that `workspaceId` is PRESENT, not
 *           that it is the caller's own, for a wire caller that never claimed.
 *           Nothing binds a bare clientName to a workspace, and the name is
 *           self-asserted, so binding to it would be no stronger than the
 *           capability check that already keys on it.
 *   OPEN    the `legacy` lane is still ALLOWED, and `PermissionEnforcer`
 *           grandfathers the same callers. Dropping the identity envelope
 *           still avoids per-plugin permission enforcement; it just no longer
 *           buys an unscoped browser target lookup. Tracked on #1111.
 *
 * The hosted lane closes one caller CLASS, not the general problem: it works
 * only because the plugin host derives both halves of the identity itself. The
 * verified lane closes a second class — wire callers that claimed — the same
 * way: on a binding main recorded, not one the caller named.
 *
 * Peer credentials (`GetNamedPipeClientProcessId`) were the shape #922 first
 * suggested and are NOT what landed. The OS handle behind a Node pipe socket
 * is unreachable from JS (measured: the accepted socket reports
 * `_handle.fd === -1`), so it needs a compiled native addon — and it would buy
 * nothing against the ceiling below, since same-user code defeats both.
 * `workspaceClaimTrust.ts` records the reasoning.
 *
 * Ceiling, stated so the lane is not read as more than it is: this confines an
 * APPROVED plugin to the scope its approval implied. It is not a defence
 * against hostile code already running as the user.
 */
export function callerScope(
  ctx: RpcContext | undefined,
  params: Record<string, unknown>,
): BrowserCallerScopeDecision {
  const requested = requestedWorkspaceId(params);
  if (!ctx) {
    return {
      kind: 'rejected',
      lane: 'context',
      reason: 'caller-context-unavailable',
      ...(requested && { requestedWorkspaceId: requested }),
    };
  }
  if (ctx.origin !== 'local') {
    return {
      kind: 'rejected',
      lane: 'context',
      reason: 'caller-origin-unsupported',
      ...(requested && { requestedWorkspaceId: requested }),
    };
  }
  if (ctx.operator === true) {
    return {
      kind: 'allowed',
      lane: 'operator',
      ...(requested && { workspaceId: requested }),
    };
  }

  const pinnedWorkspaceId =
    typeof ctx.commanderWorkspace === 'string' && ctx.commanderWorkspace.length > 0
      ? ctx.commanderWorkspace
      : undefined;
  if (pinnedWorkspaceId) {
    if (!isLocalExternalWireContext(ctx)) {
      return {
        kind: 'rejected',
        lane: 'pinned',
        reason: 'pinned-source-unqualified',
        ...(requested && { requestedWorkspaceId: requested }),
        pinnedWorkspaceId,
      };
    }
    if (requested && requested !== pinnedWorkspaceId) {
      return {
        kind: 'rejected',
        lane: 'pinned',
        reason: 'pinned-workspace-mismatch',
        requestedWorkspaceId: requested,
        pinnedWorkspaceId,
      };
    }
    return { kind: 'scoped', lane: 'pinned', workspaceId: pinnedWorkspaceId };
  }

  // #922 — the hosted lane. The plugin host derives BOTH halves of this
  // caller's identity: `clientName` is stamped from the manifest and
  // `hostedWorkspace` is the workspace the host is showing. Neither is
  // readable from the bridge envelope, so unlike `declared` this is an
  // ownership fact rather than a claim, and it is applied with the pinned
  // lane's exact rules: omitted resolves to it, a mismatch is refused.
  //
  // The lane is keyed on the PRESENCE of the field, not on it holding a
  // workspace. A hosted caller with `null` — the host had no active workspace
  // to bind to — is refused here. Falling through on the empty case would send
  // exactly the caller this lane exists for into `declared`, where its own
  // `workspaceId` is accepted: an unbound plugin would be strictly less
  // confined than a bound one.
  if (ctx.hostedWorkspace !== undefined) {
    const hostedWorkspaceId =
      typeof ctx.hostedWorkspace === 'string' && ctx.hostedWorkspace.length > 0
        ? ctx.hostedWorkspace
        : undefined;
    // Mirror of the pinned lane's source check, pointed the other way: pinned
    // must arrive on the local wire, hosted must arrive in-process. This is an
    // invariant backstop, not production telemetry — RpcRouter rejects the
    // option off the firstParty lane before a context is ever built, so the
    // only way here is a hand-built context (tests, a future context
    // constructor). It stays because the lane must fail closed for those too.
    // The operator is not tested: it returns above, may act across workspaces
    // by design, and dispatch refuses operator + hostedWorkspace outright.
    if (ctx.firstParty !== true || ctx.externalWire === true) {
      return {
        kind: 'rejected',
        lane: 'hosted',
        reason: 'hosted-source-unqualified',
        ...(requested && { requestedWorkspaceId: requested }),
        ...(hostedWorkspaceId && { hostedWorkspaceId }),
      };
    }
    if (!hostedWorkspaceId) {
      return {
        kind: 'rejected',
        lane: 'hosted',
        reason: 'hosted-workspace-unbound',
        ...(requested && { requestedWorkspaceId: requested }),
      };
    }
    if (requested && requested !== hostedWorkspaceId) {
      return {
        kind: 'rejected',
        lane: 'hosted',
        reason: 'hosted-workspace-mismatch',
        requestedWorkspaceId: requested,
        hostedWorkspaceId,
      };
    }
    return { kind: 'scoped', lane: 'hosted', workspaceId: hostedWorkspaceId };
  }

  // #922 PR-B — the verified lane. The caller presented a token main itself
  // minted when `mcp.claimWorkspace` created a workspace FOR it
  // (`workspaceClaimTrust.ts`), so unlike `declared` the workspace is not a
  // claim the caller makes — it is one main recorded. Same two rules as pinned
  // and hosted: omitted resolves to it, a mismatch is refused.
  //
  // A STALE claim is refused rather than demoted. The caller presented a
  // credential that no longer resolves — its workspace closed, or the token was
  // revoked — and letting it fall through to `declared` would leave it free to
  // name any workspace, i.e. strictly less confined than before it claimed.
  // That is the same fail-open the hosted lane closes for an unbound plugin.
  if (ctx.workspaceClaim !== undefined) {
    if (ctx.workspaceClaim.kind === 'stale') {
      return {
        kind: 'rejected',
        lane: 'verified',
        reason: 'verified-claim-stale',
        ...(requested && { requestedWorkspaceId: requested }),
      };
    }
    const verifiedWorkspaceId = ctx.workspaceClaim.workspaceId;
    if (requested && requested !== verifiedWorkspaceId) {
      return {
        kind: 'rejected',
        lane: 'verified',
        reason: 'verified-workspace-mismatch',
        requestedWorkspaceId: requested,
        verifiedWorkspaceId,
      };
    }
    return { kind: 'scoped', lane: 'verified', workspaceId: verifiedWorkspaceId };
  }

  // #922 (c) — the legacy lane keeps its GRANDFATHER: a caller with no identity
  // envelope is still allowed here, and closing that belongs to the shared
  // deprecation clock with `PermissionEnforcer`, not to this table (#1111).
  // What changes is only the OMITTED case. A legacy caller that names a
  // workspace is unchanged, byte for byte — it was already scoped to what it
  // named. One that names nothing used to reach the workspace-blind "first
  // registered surface" lookup and get whichever surface happened to register
  // first; that is what is refused now, with the one refusal message an
  // unidentified caller can act on.
  if (!ctx.clientName) {
    if (requested) {
      return { kind: 'allowed', lane: 'legacy', workspaceId: requested };
    }
    return {
      kind: 'rejected',
      lane: 'legacy',
      reason: 'legacy-workspace-unresolved',
    };
  }
  if (requested) {
    return { kind: 'scoped', lane: 'declared', workspaceId: requested };
  }

  return {
    kind: 'rejected',
    lane: 'declared',
    reason: 'workspace-unresolved',
  };
}

/**
 * Registers browser.* RPC handlers.
 *
 * All commands are delegated to the renderer process via IPC where the active
 * browser Surface's <webview> element executes the requested operation.
 */
// Singleton instances for session management within the main process
const profileManager = new ProfileManager();
const portAllocator = new PortAllocator();
const humanBehavior = new HumanBehavior();
// CDP event capture for browser_console / browser_network / browser_response_body
// in packaged builds (#106). Lazy: enables domains on first drain call.
const captureManager = new BrowserCaptureManager();

// #529: how long browser.screenshot waits on CDP Page.captureScreenshot before
// falling back to webContents.capturePage(). Generous against slow-but-alive
// captures (a healthy one returns in <100ms) while keeping the worst case far
// under callers' RPC timeouts.
const CDP_SCREENSHOT_TIMEOUT_MS = 2_500;
// Bound for the capturePage fallback — it can hang on exactly the same guests.
const CAPTURE_PAGE_TIMEOUT_MS = 1_500;

/**
 * Caller-facing text for a refused scope decision.
 *
 * Same contract as `noTargetError`: name the refusal, say it is terminal, and
 * say what the caller can do instead. Never name another workspace or its URL —
 * a refusal must not become the enumeration primitive it exists to prevent.
 * `pinnedWorkspaceId` is the caller's own binding, but it is still left out so
 * every branch has one disclosure rule instead of two.
 */
const SCOPE_REFUSAL_REMEDY: Record<BrowserScopeShadowReason, string> = {
  'caller-context-unavailable':
    'this call arrived without a caller context, so no workspace can be resolved for it',
  'caller-origin-unsupported':
    'browser surfaces are reachable only from this machine',
  'pinned-source-unqualified':
    'a workspace-pinned caller must arrive on the local wmux wire',
  'pinned-workspace-mismatch':
    'address a surface in the workspace your token is bound to',
  'hosted-source-unqualified':
    'a host-bound caller must arrive through the in-process plugin host',
  'hosted-workspace-unbound':
    'the plugin host has no active workspace to resolve this call against',
  'hosted-workspace-mismatch':
    'omit workspaceId and this resolves to the workspace you are hosted in',
  'verified-workspace-mismatch':
    'omit workspaceId and this resolves to the workspace you claimed',
  'verified-claim-stale':
    'the workspace you claimed is gone; call mcp.claimWorkspace again to get a new one',
  // The one refusal an UNIDENTIFIED caller can receive, so it is the one that
  // has to teach rather than just refuse: whoever reads it built against the
  // documented envelope-less path and has no plugin identity to look up.
  'legacy-workspace-unresolved':
    'name the workspace this call belongs to — send workspaceId in the params. ' +
    'workspace.current returns the one you are in; workspace.list returns every id',
  'workspace-unresolved':
    'send the workspaceId of the workspace you are calling from',
};

export function scopeRefusalError(
  method: string,
  reason: BrowserScopeShadowReason,
): Error {
  return new Error(
    `${method}: BROWSER_SCOPE_REFUSED: ${SCOPE_REFUSAL_REMEDY[reason]}. ` +
      `Do not retry unchanged.`,
  );
}

export function registerBrowserRpc(
  router: RpcRouter,
  getWindow: GetWindow,
  webviewCdpManager: WebviewCdpManager,
  backendStore?: BrowserBackendStore,
  browserScopeShadowSink?: (input: BrowserScopeShadowInput) => void,
  // `mcp.mode` is resolved above this registration in main/index.ts; the getter
  // reads it lazily per call so the two never have to stay adjacent. Defaults
  // to shadow, so a caller that forgets to wire it keeps observing rather than
  // silently starting to refuse traffic.
  getEnforcementMode: () => EnforcementMode = () => 'shadow',
  // 'chrome' backend (Phase 2/2.5): per-profile real-Chrome instances behind
  // a workspace-binding registry. Optional so older wirings/tests keep
  // working; chrome-mode calls without it fail with a clear message.
  chromeRegistry?: ChromeLauncherRegistry,
): void {
  const getActivePartition = (): string => profileManager.getActiveProfile().partition;

  // ── #517 backend fork ────────────────────────────────────────────────────
  //
  //   browser.open (RPC, main)
  //     │
  //     ├─ backend()                     ── main-owned, read sync at boot; no gate
  //     │
  //     ├─ 'builtin' ──► existing path, untouched: sendToRenderer
  //     │                → openUrlInBrowserPaneImpl → <webview>
  //     │
  //     └─ 'external' ─► validateResolvedNavigationUrl(url)
  //                      └─ ok → shell.openExternal(url)
  //                              → { backend:'external', opened:true, url }
  //
  // External mode is fire-and-forget: no surface, no pane, no tracking. Tools
  // that need a live page fail closed with the shared contract error — never a
  // generic target-miss, never a silent fallback onto another builtin surface.
  const backend = () => backendStore?.get() ?? 'builtin';

  // Resolves the CALLING workspace's launcher (binding ?? 'default') — the
  // binding is user-set from the workspace card, never agent-selectable, so
  // workspace 1 drives its own signed-in Chrome and workspace 2 its own.
  const requireChrome = (method: string, workspaceId: string | undefined): ChromeBackendClient => {
    if (!chromeRegistry) {
      throw new Error(`${method}: browser backend is 'chrome' but no Chrome launcher is wired in this build.`);
    }
    return chromeRegistry.forWorkspace(workspaceId);
  };

  /** BrowserTabDescriptor for a chrome tab — paneId is synthetic (no pane).
   *  surfaceId is the launcher's STABLE id, never the CDP targetId (which
   *  Chrome may swap under the tab at any time). */
  const chromeTabDescriptor = (t: { surfaceId: string; url: string; title?: string }) => ({
    surfaceId: t.surfaceId,
    paneId: `chrome:${t.surfaceId}`,
    url: t.url,
    title: t.title ?? '',
    selected: false,
  });

  const delegateExternal = async (url: string, method: string): Promise<ExternalOpenResult> => {
    await validateUrl(url, method);
    await shell.openExternal(url);
    return { backend: 'external', opened: true, url };
  };

  // External mode must never resolve the workspace-blind DEFAULT target:
  // getTarget(undefined)/ensureAwake(undefined) fall back to "any surface",
  // which in external mode can be another workspace's manually-opened pane —
  // a call without a surfaceId would then automate a pane its caller does not
  // own instead of delegating/failing closed (codex P1). With an explicit
  // surfaceId both lookups are exact-match, so mixed mode still works.
  const resolveTargetSurface = async (
    surfaceId: string | undefined,
    workspaceId: string | undefined,
  ): Promise<string | undefined> => {
    // Non-builtin backends never own builtin surfaces: without an explicit
    // surfaceId the default-target lookup must not grab another workspace's
    // pane ('external' fire-and-forget; 'chrome' tabs live outside webviews).
    if (backend() !== 'builtin' && !surfaceId) return undefined;
    let resolved = webviewCdpManager.getTarget(surfaceId, workspaceId)?.surfaceId;
    if (!resolved) {
      resolved = (await webviewCdpManager.ensureAwake(surfaceId, workspaceId))?.surfaceId;
    }
    return resolved;
  };

  /**
   * The single place a target-resolving browser handler learns which workspace
   * to look a surface up in.
   *
   * Both modes audit the same decision. They differ in what the caller gets:
   *
   *        callerScope(ctx, params)
   *                 │
   *      ┌──────────┴────────────┐
   *   rejected                 allowed / scoped
   *      │                        │
   *   audit-log                   │
   *      │                        │
   *      ├─ enforce ─► throw      ├─ enforce ─► decision.workspaceId
   *      │   (terminal: no        │              (the pinned lane returns the
   *      │    lookup, wake,       │               TOKEN binding, which is the
   *      │    lease, or URL       │               point — it may differ from
   *      │    validation runs)    │               what the caller asked for)
   *      │                        │
   *      └─ shadow ──────────────►┴─ shadow ──► requestedWorkspaceId(params)
   *
   * Shadow returns the request-derived workspace on EVERY lane, refused or not.
   * That is deliberate and load-bearing: shadow is the rollback, so it has to
   * be pre-#810 behavior exactly, not "pre-#810 except where the new decision
   * happens to be better". Returning `decision.workspaceId` here would already
   * re-scope a pinned caller — changing which targets `browser.cdp.info` lists
   * and whether it sets `targetsScoped` — in the mode whose whole promise is
   * that it changes nothing.
   *
   * The mode is `mcp.mode`, shared with the permission enforcer rather than a
   * second knob — both answer "is substrate enforcement live on this install?",
   * and one switch means one rollback.
   *
   * The audit write is best-effort for the same reason as the permission shadow
   * logger: telemetry must never break a browser call. Note the ordering — the
   * log happens BEFORE the throw, so an enforced refusal is still evidence.
   */
  const scopeFor = (
    method: RpcMethod,
    params: Record<string, unknown>,
    ctx: RpcContext | undefined,
  ): string | undefined => {
    const decision = callerScope(ctx, params);
    const enforcing = getEnforcementMode() === 'enforce';

    if (decision.kind === 'rejected') {
      if (browserScopeShadowSink) {
        try {
          browserScopeShadowSink({
            clientName: ctx?.clientName,
            method,
            reason: decision.reason,
            ...(decision.requestedWorkspaceId && {
              requestedWorkspaceId: decision.requestedWorkspaceId,
            }),
            ...(decision.pinnedWorkspaceId && {
              pinnedWorkspaceId: decision.pinnedWorkspaceId,
            }),
            ...(decision.hostedWorkspaceId && {
              hostedWorkspaceId: decision.hostedWorkspaceId,
            }),
            ...(decision.verifiedWorkspaceId && {
              verifiedWorkspaceId: decision.verifiedWorkspaceId,
            }),
          });
        } catch {
          /* browser scope audit logging must never affect dispatch */
        }
      }
      if (enforcing) throw scopeRefusalError(method, decision.reason);
      return requestedWorkspaceId(params);
    }

    return enforcing ? decision.workspaceId : requestedWorkspaceId(params);
  };

  // Resolve the guest webview's WebContents for a CDP-backed handler, throwing a
  // method-tagged error if no target is registered or the WebContents is gone.
  // Shared by the #111 state handlers (cookies / resize / emulate) which all
  // drive the page over `wc.debugger.sendCommand`.
  // Single choke point for the external-backend contract error: a miss while the
  // backend is 'external' means the caller is asking for deep automation that
  // external mode cannot provide — say so explicitly instead of "no target".
  /**
   * "No target" has two causes with opposite right answers, and they used to
   * share one sentence (#756): a caller could not tell a permanent refusal
   * (the surface belongs to another workspace — #695) from a transient,
   * actionable absence (this workspace has no browser open yet).
   *
   * The scoped lookup returns null for both, so re-run it unscoped: if that
   * finds a target, ownership is what failed. Neither message names the other
   * workspace or its URL — only that the caller does not own it, which is the
   * minimum needed to stop the caller from retrying forever.
   */
  const noTargetError = (
    method: string,
    surfaceId: string | undefined,
    workspaceId: string | undefined,
  ): Error => {
    if (workspaceId && webviewCdpManager.getTarget(surfaceId, undefined)) {
      return new Error(
        `${method}: BROWSER_NOT_OWNED: the requested browser surface is not owned by ` +
          `the calling workspace. Do not retry — address a surface from this workspace instead.`,
      );
    }
    return new Error(
      `${method}: BROWSER_NO_TARGET: no browser surface is open in this workspace. ` +
        `Open one with browser_open first.`,
    );
  };

  const resolveWc = (
    surfaceId: string | undefined,
    method: string,
    workspaceId?: string,
  ): Electron.WebContents => {
    // Same default-target rule as resolveTargetSurface: external + no
    // surfaceId must not grab another workspace's pane via the default lookup.
    const target = backend() !== 'builtin' && !surfaceId
      ? null
      : webviewCdpManager.getTarget(surfaceId, workspaceId);
    if (!target) {
      if (backend() === 'external') throw new Error(EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE);
      if (backend() === 'chrome') throw new Error(CHROME_BACKEND_RPC_UNSUPPORTED_MESSAGE);
      throw noTargetError(method, surfaceId, workspaceId);
    }
    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error(`${method}: WebContents unavailable`);
    return wc;
  };

  // Tear down capture listeners whenever a surface's CDP session is unregistered.
  // unregister() fires only on real guest departure (destroyed / different-guest
  // replacement — same-guest re-register skips it), so record it as a close for
  // the lifecycle drain.
  webviewCdpManager.setCaptureCleanup((webContentsId) =>
    captureManager.drop(webContentsId, { closed: true }),
  );

  // Start capture as soon as a guest registers (#1081) — did-attach, before the
  // page has loaded — so the load-time error an agent goes looking for is
  // already in the buffer by the time it asks. ensure() is idempotent, so the
  // dom-ready re-registration is a no-op. Fire-and-forget: registration must
  // not wait on (or fail with) the CDP domain enable.
  webviewCdpManager.setCaptureAttach((webContentsId) => {
    void captureManager.ensure(webContentsId).catch(() => {
      // A guest that cannot be captured still automates fine; the drain
      // handlers report the miss when someone actually reads.
    });
  });

  // browser.lifecycle.get target-tolerance: remember the last webContentsId a
  // scope drained from, so a close can still be reported after the target is
  // gone (getTarget() then returns null and pendingClosures is keyed by the
  // departed webContentsId).
  const lastLifecycleTarget = new Map<string, number>();
  const MAX_LIFECYCLE_TARGETS = 64; // scope keys are per caller×surface — bound the map (review)

  // #517 lightweight mode: every automation op that drives the guest must hold
  // an AutomationLease for its duration so a hidden, throttled guest runs
  // full-speed while being automated (#353 — otherwise background screenshots
  // come back stale/blank with no error). registerLeased wraps a handler with
  // a per-op lease on the RESOLVED target surface. When no target is
  // registered yet, the handler runs unleased and fails with its own
  // "no webview target" error as before.
  // The leased handlers take the resolved workspace as an argument rather than
  // re-deriving it: `scopeFor` is the enforcement point, so a handler that
  // forgot to call it used to silently keep the old workspace-blind lookup
  // (#810). Threading it in makes that a type error instead of a quiet hole,
  // and guarantees one decision — and at most one audit entry — per RPC.
  const registerLeased = (
    method: Parameters<RpcRouter['register']>[0],
    handler: (
      params: Record<string, unknown>,
      scope: string | undefined,
      ctx?: RpcContext,
    ) => Promise<unknown>,
    // #517 backend fork: what to do when no builtin target resolves while the
    // backend is 'external'. Default is the fail-closed contract error; the
    // open-shaped handlers (navigate) pass a delegate instead.
    externalFallback?: (params: Record<string, unknown>) => Promise<unknown>,
    // 'chrome' analog: what to do when no builtin target resolves under the
    // chrome backend. Default is the chrome contract error — tools ride the
    // Playwright path there, so an RPC-fallback hit means resolution failed.
    chromeFallback?: (params: Record<string, unknown>, scope: string | undefined) => Promise<unknown>,
  ): void => {
    router.register(method, async (params, ctx) => {
      // Before any work: a refused caller must not reach URL validation, the
      // external-backend delegate, or a wake. Throwing here is the whole point.
      const scope = scopeFor(method, params, ctx);
      const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
      // Memory relief (#517 slice C): automation targeting a discarded guest
      // wakes it (renderer remounts + page reloads) before taking the lease,
      // so hidden-guest automation keeps working instead of "no target".
      // With NO surfaceId in builtin mode: ensureAwake falls back to any
      // discarded surface, matching getTarget()'s default-target contract
      // (codex P1 — otherwise the default MCP path fails once the only pane is
      // discarded). In EXTERNAL mode the default lookup is blocked entirely —
      // see resolveTargetSurface.
      const resolved = await resolveTargetSurface(surfaceId, scope);
      if (!resolved) {
        if (backend() === 'external') {
          if (externalFallback) return externalFallback(params);
          throw new Error(EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE);
        }
        if (backend() === 'chrome') {
          if (chromeFallback) return chromeFallback(params, scope);
          throw new Error(CHROME_BACKEND_RPC_UNSUPPORTED_MESSAGE);
        }
        return handler(params, scope, ctx);
      }
      return webviewCdpManager.withAutomationLease(resolved, () => handler(params, scope, ctx));
    });
  };

  // ── Automation lease RPC (#517) ─────────────────────────────────────────
  // Out-of-process automation (Playwright in the MCP process) drives the guest
  // directly over CDP, bypassing the browser.* handlers above — it takes a
  // TTL-bounded lease around each tool invocation instead, renewing during
  // long waits.
  router.register('browser.lease.acquire', async (params, ctx) => {
    const scope = scopeFor('browser.lease.acquire', params, ctx);
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    // Wake a discarded guest so out-of-process (Playwright) automation gets a
    // live target under its lease (#517 slice C). Without surfaceId this
    // defaults to any discarded surface in builtin mode; external mode blocks
    // the default lookup (see resolveTargetSurface).
    const resolved = await resolveTargetSurface(surfaceId, scope);
    if (!resolved) return { token: null };
    return { token: webviewCdpManager.acquireRpcLease(resolved) };
  });
  router.register('browser.lease.renew', async (params) => {
    const token = typeof params['token'] === 'string' ? params['token'] : '';
    return { ok: webviewCdpManager.renewRpcLease(token) };
  });
  router.register('browser.lease.release', async (params) => {
    const token = typeof params['token'] === 'string' ? params['token'] : '';
    return { ok: webviewCdpManager.releaseRpcLease(token) };
  });

  /**
   * browser.tabs
   * Workspace-exact control-plane operations for the browser_tabs MCP tool.
   * params: { action, workspaceId, surfaceId?, url? }
   *
   * This is deliberately a wmux.internal RPC: workspaceId is resolved by the
   * bundled MCP server, not trusted from an arbitrary capability-bearing
   * plugin. The renderer re-checks ownership at the mutation boundary.
   */
  router.register('browser.tabs', async (params) => {
    const actionValue = typeof params['action'] === 'string' ? params['action'] : 'list';
    if (!(BROWSER_TABS_ACTIONS as readonly string[]).includes(actionValue)) {
      return browserTabsError(
        'BROWSER_TABS_INVALID_ARGUMENT',
        `Unknown browser_tabs action "${actionValue}".`,
      );
    }
    const action = actionValue as BrowserTabsAction;
    const workspaceId =
      typeof params['workspaceId'] === 'string' && params['workspaceId'].length > 0
        ? params['workspaceId']
        : '';
    if (!workspaceId) {
      return browserTabsError(
        'BROWSER_TABS_WORKSPACE_UNRESOLVED',
        'The calling workspace is unavailable.',
      );
    }

    const surfaceId =
      typeof params['surfaceId'] === 'string' && params['surfaceId'].length > 0
        ? params['surfaceId']
        : undefined;
    const url = typeof params['url'] === 'string' ? params['url'] : undefined;
    if ((action === 'select' || action === 'close') && !surfaceId) {
      return browserTabsError(
        'BROWSER_TABS_INVALID_ARGUMENT',
        `browser_tabs ${action} requires a surfaceId returned by browser_tabs list.`,
      );
    }
    if ((action === 'list' || action === 'new') && surfaceId) {
      return browserTabsError(
        'BROWSER_TABS_INVALID_ARGUMENT',
        `browser_tabs ${action} does not accept surfaceId.`,
      );
    }
    if (action !== 'new' && url !== undefined) {
      return browserTabsError(
        'BROWSER_TABS_INVALID_ARGUMENT',
        `browser_tabs ${action} does not accept url.`,
      );
    }

    // Phase 2 'chrome' backend: all four actions operate on the dedicated
    // Chrome instance's wmux-opened tabs (registry-scoped by workspace).
    if (backend() === 'chrome') {
      const launcher = requireChrome('browser.tabs', workspaceId);
      if (action === 'new') {
        if (url) {
          try {
            await validateUrl(url, 'browser.tabs');
          } catch (error) {
            return browserTabsError(
              'BROWSER_TAB_URL_BLOCKED',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        try {
          const opened = await launcher.openTab(url ?? 'about:blank', workspaceId);
          return { ok: true, action: 'new', tab: chromeTabDescriptor(opened) };
        } catch (error) {
          return browserTabsError(
            'BROWSER_TAB_CREATE_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const targets = await launcher.listTargets(workspaceId);
      if (action === 'list') {
        return { ok: true, action: 'list', tabs: targets.map(chromeTabDescriptor) };
      }
      const match =
        targets.find((t) => t.surfaceId === surfaceId) ??
        // transitional: accept a raw CDP targetId as a surfaceId (pre-stable-id
        // handles agents may still be holding); remove next release.
        targets.find((t) => t.targetId === surfaceId);
      if (!match) {
        return browserTabsError(
          'BROWSER_TAB_NOT_FOUND',
          `browser_tabs ${action}: no wmux-opened Chrome tab with surfaceId "${surfaceId}" in this workspace — ` +
            'the Chrome tab that held this surface may have been replaced or closed by Chrome; open a new one.',
        );
      }
      if (action === 'select') {
        // Live attach supports real tab focus; dedicated instances leave
        // focus to the automation itself (Playwright bringToFront) and echo.
        if (launcher.selectSurface) await launcher.selectSurface(match.surfaceId);
        return { ok: true, action: 'select', tab: chromeTabDescriptor(match) };
      }
      // action === 'close'
      const closed = await launcher.closeSurface(match.surfaceId);
      if (!closed) {
        return browserTabsError('BROWSER_TABS_UNAVAILABLE', 'browser_tabs close: Chrome did not close the tab.');
      }
      return { ok: true, action: 'close', closed: chromeTabDescriptor(match) };
    }

    // #517 backend fork: 'new' is an open-shaped action, so external mode
    // delegates it like browser.open. list/select/close keep operating on
    // builtin surfaces only (external opens are fire-and-forget, untracked).
    if (action === 'new' && backend() === 'external') {
      if (!url) {
        return browserTabsError(
          'BROWSER_TABS_INVALID_ARGUMENT',
          `browser_tabs new requires a url when the browser backend is 'external'.`,
        );
      }
      // URL validation failure is a URL_BLOCKED error; a failed OS launch is a
      // CREATE_FAILED — the two must not share a code (agents branch on it).
      try {
        await validateUrl(url, 'browser.tabs');
      } catch (error) {
        return browserTabsError(
          'BROWSER_TAB_URL_BLOCKED',
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        const opened = await delegateExternal(url, 'browser.tabs');
        // BrowserTabsResult external variant — the MCP consumer validates the
        // response shape (isBrowserTabsResult), so a raw ExternalOpenResult
        // would be rejected after the tab already opened, and retries would
        // spawn duplicate tabs (codex P1).
        return { ok: true, action: 'new', backend: 'external', opened: true, url: opened.url };
      } catch (error) {
        return browserTabsError(
          'BROWSER_TAB_CREATE_FAILED',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (action === 'new' && url !== undefined) {
      try {
        await validateUrl(url, 'browser.tabs');
      } catch (error) {
        return browserTabsError(
          'BROWSER_TAB_URL_BLOCKED',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return sendToRenderer(getWindow, 'browser.tabs', {
      action,
      workspaceId,
      ...(surfaceId && { surfaceId }),
      ...(url !== undefined && { url }),
      ...(action === 'new' && { partition: getActivePartition() }),
    });
  });

  /**
   * browser.open
   * Opens a new browser surface in the active pane.
   * params: { url?: string }
   */
  router.register('browser.open', async (params) => {
    const url = typeof params['url'] === 'string' ? params['url'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    if (backend() === 'chrome') {
      // Dedicated-Chrome open: a tracked tab with a real handle — unlike
      // 'external', about:blank is a valid open here (auto-open path).
      const launcher = requireChrome('browser.open', workspaceId);
      if (url) await validateUrl(url, 'browser.open');
      const opened = await launcher.openTab(url ?? 'about:blank', workspaceId);
      // The launcher's stable surfaceId keeps the engine's auto-open→pin
      // contract AND survives Chrome swapping the target behind the tab.
      return { ok: true, backend: 'chrome', surfaceId: opened.surfaceId, url: opened.url };
    }
    if (backend() === 'external') {
      // Missing url is an argument error, not the backend contract error —
      // conflating them makes agents "work around" a tool that would succeed
      // with a url (GLM P3). There is no about:blank to open externally.
      if (!url) {
        throw new Error(
          `browser.open: a url is required when the browser backend is 'external' (nothing to open in the OS browser without one).`,
        );
      }
      return delegateExternal(url, 'browser.open');
    }
    if (url) await validateUrl(url, 'browser.open');
    return sendToRenderer(getWindow, 'browser.open', {
      partition: getActivePartition(),
      ...(url && { url }),
      // workspaceId is dropped when absent; the renderer (useRpcBridge.ts) then
      // falls back to the UI-active workspace. The MCP path guarantees a non-empty
      // id via requireWorkspaceId (src/mcp/index.ts -> browser_open), so it never
      // hits that fallback. Any future NON-MCP caller of browser.open must likewise
      // pass an explicit workspaceId to avoid active-workspace misrouting.
      ...(workspaceId && { workspaceId }),
    });
  });

  /**
   * browser.close
   * Closes the browser panel.
   * params: { surfaceId?: string, workspaceId?: string }
   */
  router.register('browser.close', async (params, ctx) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    // Chrome tabs live outside the renderer entirely, so the bridge send below
    // was a silent no-op for them — browser_close simply never worked on the
    // chrome backend. Close them here instead. `scopeFor` is applied ONLY on
    // this branch: the builtin branch keeps its pre-#810 shadow/enforce
    // semantics, which this change must not quietly alter.
    if (backend() === 'chrome') {
      const scope = scopeFor('browser.close', params, ctx);
      const launcher = requireChrome('browser.close', scope);
      if (surfaceId) {
        // Ownership first, exactly like browser.tabs close: a launcher is
        // shared by every workspace bound to its profile, so closeSurface()
        // alone would let workspace A tear down workspace B's tab. Scoping
        // through listTargets is the same check browser_tabs already makes
        // (an undefined scope stays unfiltered, preserving shadow-mode
        // semantics). The transitional raw-targetId handle folds in here.
        const own = await launcher.listTargets(scope);
        const match =
          own.find((t) => t.surfaceId === surfaceId) ??
          // transitional: the caller may still hold a raw CDP targetId from
          // before stable surface ids; map it once. Remove next release.
          own.find((t) => t.targetId === surfaceId);
        if (match && (await launcher.closeSurface(match.surfaceId))) {
          return { ok: true, backend: 'chrome', closed: true, surfaceId: match.surfaceId };
        }
        // Second chance: the surface may belong to another PROFILE's launcher
        // (the caller's workspace binding changed since the tab was opened).
        // Only the owning workspace may close it — a cross-workspace close is
        // exactly the tear-down-someone-else's-browser hazard #810 exists for.
        const owner = chromeRegistry?.ownerOfSurface(surfaceId);
        // An undefined scope (shadow mode, caller sent no workspaceId) closes
        // unfiltered — the same meaning the primary path's listTargets(scope)
        // gives it — so an unbound/stale handle stays retirable there too.
        if (owner && (scope === undefined || (owner.workspaceId !== undefined && owner.workspaceId === scope))) {
          if (await owner.client.closeSurface(surfaceId)) {
            return { ok: true, backend: 'chrome', closed: true, surfaceId };
          }
        }
        throw new Error(
          `browser.close: no wmux-opened Chrome tab with surfaceId "${surfaceId}" in this workspace ` +
            '(it may already be closed, or belong to another workspace).',
        );
      }
      // No surfaceId: close this workspace's most recently opened tab. There
      // is no "active" chrome tab to fall back on, so closing all of them (or
      // an arbitrary one) would both be worse than one explicit pick.
      const own = await launcher.listTargets(scope);
      const newest = own[own.length - 1];
      if (!newest) {
        throw new Error('browser.close: this workspace has no open wmux Chrome tab to close.');
      }
      await launcher.closeSurface(newest.surfaceId);
      return { ok: true, backend: 'chrome', closed: true, surfaceId: newest.surfaceId };
    }
    return sendToRenderer(getWindow, 'browser.close', {
      ...(surfaceId && { surfaceId }),
      // Same caller-workspace routing contract as browser.open above: absent
      // workspaceId falls back to the UI-active workspace in the renderer.
      // MCP/CLI callers pass an explicit id so a close issued from workspace A
      // can never tear down the browser the user is viewing in workspace B.
      ...(workspaceId && { workspaceId }),
    });
  });

  /**
   * browser.navigate
   * Navigates the active browser Surface to the given URL.
   * Tries CDP direct navigation first, falls back to renderer bridge.
   * params: { url: string, surfaceId?: string }
   */
  /**
   * Navigate and resolve once the guest has COMMITTED to the destination,
   * rather than once every subresource has finished loading (#756).
   *
   * `webContents.loadURL()` settles on full load, which has no upper bound: a
   * slow page kept the RPC open past the caller's deadline and the tool
   * reported a transport timeout for a navigation that was in fact fine. Commit
   * is the point at which the answer ("we went there") is actually known, and
   * it also releases the automation lease while the page finishes on its own.
   *
   *   loadURL() ─────────────────────────────────► full load  (unbounded)
   *        │
   *        ├── did-navigate (main frame committed) ──► resolve   ← we return here
   *        └── did-fail-load (main frame)          ──► reject
   */
  /**
   * The page itself refused to load, as opposed to the CDP plumbing failing.
   * The distinction decides whether the renderer-bridge fallback is allowed to
   * run: it is a second way to reach the SAME guest, so retrying a doomed
   * navigation there just fails again — and, because the bridge answers
   * `{ok:true}` once it has handed the URL over, it would report success for a
   * navigation that demonstrably failed.
   */
  class NavigationFailedError extends Error {}

  const navigateAwaitingCommit = (wc: Electron.WebContents, url: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        wc.off('did-navigate', onCommit);
        wc.off('did-fail-load', onFail);
      };
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err); else resolve();
      };
      function onCommit(): void { finish(); }
      function onFail(
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean,
      ): void {
        // Subframe failures are not this navigation's verdict.
        if (!isMainFrame) return;
        // ERR_ABORTED (-3) is what a superseding navigation looks like; the
        // caller's request was still issued, so do not call it a failure.
        if (errorCode === -3) return;
        finish(new NavigationFailedError(
          `browser.navigate: ${errorDescription} (${errorCode})`,
        ));
      }
      wc.on('did-navigate', onCommit);
      wc.on('did-fail-load', onFail);
      // Full load still resolves us if it beats the commit event (about:blank,
      // cached documents); a rejection here is a real navigation error.
      wc.loadURL(url).then(() => finish(), (err: unknown) => finish(
        err instanceof Error ? err : new Error(String(err)),
      ));
    });

  const requireNavigateUrl = (params: Record<string, unknown>): string => {
    if (typeof params['url'] !== 'string' || params['url'].length === 0) {
      throw new Error('browser.navigate: missing required param "url"');
    }
    return params['url'];
  };
  registerLeased('browser.navigate', async (params, scope) => {
    const navUrl = requireNavigateUrl(params);
    await validateUrl(navUrl, 'browser.navigate');
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    // Try CDP direct navigation first
    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (target) {
      try {
        const wc = webContents.fromId(target.webContentsId);
        if (wc && !wc.isDestroyed()) {
          await navigateAwaitingCommit(wc, navUrl);
          return { ok: true, url: navUrl };
        }
      } catch (err) {
        // A page that would not load is the answer, not a reason to try the
        // other transport to the same guest — see NavigationFailedError.
        if (err instanceof NavigationFailedError) throw err;
        console.warn('[browser.navigate] CDP fallback to renderer:', err);
      }
    }

    // Fallback to the renderer bridge, which resolves a surface with no
    // workspace check of its own — it picks the caller-supplied id, or its own
    // default when there is none. Neither choice is safe to hand a scoped
    // caller unless this side has already proven ownership (#695).
    if (scope) {
      // No target means the scoped lookup refused one, or there is none to
      // own. Routing that to the bridge would reinstate exactly the
      // workspace-blind selection this change removes, so refuse instead.
      if (!target) throw noTargetError('browser.navigate', surfaceId, scope);
      // A target did resolve and CDP merely failed on it. Ownership is already
      // established, so the bridge is fine — but pin it to that exact surface.
      // Leaving the id absent would let the bridge choose its own default,
      // which is the workspace-blind pick all over again.
      return sendToRenderer(getWindow, 'browser.navigate', {
        url: params['url'],
        surfaceId: target.surfaceId,
      });
    }
    return sendToRenderer(getWindow, 'browser.navigate', {
      url: params['url'],
      ...(surfaceId && { surfaceId }),
    });
  },
  // External backend + no builtin surface: navigate behaves exactly like open
  // (fire-and-forget delegate) instead of failing on a surface that was never
  // going to exist. A live builtin surface (manual pane) still wins above.
  (params) => delegateExternal(requireNavigateUrl(params), 'browser.navigate'),
  // Chrome backend + no builtin surface: pinned-tab navigation rides the
  // engine's Playwright path and never lands here; a bare navigate opens a
  // tracked tab like browser.open does.
  async (params, scope) => {
    // A pinned surfaceId reaching this fallback means the caller wanted to
    // navigate an EXISTING chrome tab through the RPC lane — opening a new
    // tab here would report success while the agent keeps reading the old
    // page (dogfood P1). Refuse loudly; the tool's Playwright lane is the
    // supported path for pinned chrome navigation.
    if (typeof params['surfaceId'] === 'string' && params['surfaceId'].length > 0) {
      throw new Error(
        'browser.navigate: cannot navigate an existing chrome tab over the RPC lane — ' +
          'page resolution failed upstream; retry (the tool navigates chrome tabs via CDP).',
      );
    }
    const navUrl = requireNavigateUrl(params);
    await validateUrl(navUrl, 'browser.navigate');
    // Owner = the caller-verified scope, never a body-supplied workspaceId
    // (#810 scope-coverage guard).
    const opened = await requireChrome('browser.navigate', scope).openTab(navUrl, scope);
    return { ok: true, backend: 'chrome', surfaceId: opened.surfaceId, url: opened.url };
  });

  /**
   * browser.goBack
   * Navigate the active browser Surface back by one history entry.
   * params: { surfaceId?: string }
   */
  registerLeased('browser.goBack', async (params, scope) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (!target) throw noTargetError('browser.goBack', surfaceId, scope);

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.goBack: WebContents unavailable');

    const navigationHistory = (wc as Electron.WebContents & {
      navigationHistory?: {
        canGoBack?: () => boolean;
        goBack?: () => void;
      };
      canGoBack?: () => boolean;
      goBack?: () => void;
    }).navigationHistory;

    const canGoBack = navigationHistory?.canGoBack?.() ?? wc.canGoBack?.() ?? false;
    if (!canGoBack) {
      return { ok: false, reason: 'no history entry' };
    }

    if (navigationHistory?.goBack) {
      navigationHistory.goBack();
    } else {
      wc.goBack();
    }

    return { ok: true };
  });

  // ── Session handlers ────────────────────────────────────────────────────

  /**
   * browser.session.start
   * Start a browser session with an optional profile.
   * params: { profile?: string }
   */
  router.register('browser.session.start', async (params) => {
    // Only the builtin backend runs an RPC-started Electron session (the
    // partition dance below). chrome/external never touch that partition, so
    // running it there and returning a port MISLED the agent into "a session
    // started" when nothing had (dogfood: a live-bound workspace got a
    // successful builtin session it could not use). Answer honestly instead —
    // no profileManager / portAllocator / renderer mutation — describing how
    // the real backend actually attaches.
    const kind = backend();
    if (kind !== 'builtin') {
      if (kind === 'external') {
        return {
          backend: kind,
          started: false,
          reason: 'URLs are handed to the OS browser; there is no session to start.',
        };
      }
      // chrome backend. session.start is GLOBAL — it has neither a workspace
      // nor an honored profile arg, so it CANNOT know whether the caller is
      // bound to dedicated Chrome or Live Chrome. A reason that assumed one
      // binding would be false for the other (and could contradict a
      // workspace-scoped session.status). So the reason addresses BOTH
      // audiences and states the fact it does know: whether the live
      // remote-debugging endpoint is reachable (a bounded TCP connect behind
      // isLiveChromeReachable; a stale DevToolsActivePort left by a dead Chrome
      // does NOT count). NEVER launch the dedicated Chrome here: global start
      // would spawn the DEFAULT profile, not the caller's bound one.
      const remoteDebugging = await isLiveChromeReachable();
      return {
        backend: kind,
        started: false,
        remoteDebugging,
        reason:
          'This backend starts no RPC session (any profile argument is ignored). ' +
          'If this workspace is bound to Live Chrome: remote debugging is ' +
          (remoteDebugging
            ? 'reachable, so the browser attaches when you first drive it. '
            : 'not reachable — enable it once at chrome://inspect/#remote-debugging (Chrome 144+), then drive the browser. ') +
          'Otherwise the dedicated Chrome launches on demand on the first browser tool call.',
      };
    }
    const profileName = typeof params['profile'] === 'string'
      ? validateBrowserProfileName(params['profile'])
      : 'default';
    if (!isSelectableBrowserProfile(profileName)) {
      throw new Error(
        `browser.session.start: profile "${profileName}" is not available for RPC browser sessions`,
      );
    }
    const profile = profileManager.getProfile(profileName);
    if (!profile) {
      throw new Error(`browser.session.start: profile "${profileName}" does not exist`);
    }
    profileManager.setActiveProfile(profileName);
    await sendToRenderer(getWindow, 'browser.session.applyProfile', {
      partition: profile.partition,
    });
    const port = await portAllocator.allocate();
    return {
      profile: profile.name,
      partition: profile.partition,
      persistent: profile.persistent,
      port,
    };
  });

  /**
   * browser.session.stop
   * Stop the active browser session and release resources.
   */
  router.register('browser.session.stop', async () => {
    // Symmetric with session.start: only the builtin backend has an RPC session
    // to stop. On chrome/external the mutations below (active-profile reset +
    // renderer applyProfile) would "tear down" a session that never existed —
    // the very partition the start-side gate refuses to touch — so gate them
    // out and answer honestly. builtin path stays byte-identical.
    const kind = backend();
    if (kind !== 'builtin') {
      return { backend: kind, stopped: false, reason: 'This backend has no RPC session to stop.' };
    }
    const port = portAllocator.getPort();
    if (port !== null) {
      portAllocator.release(port);
    }
    profileManager.setActiveProfile('default');
    await sendToRenderer(getWindow, 'browser.session.applyProfile', {
      partition: getActivePartition(),
    });
    return { stopped: true };
  });

  /**
   * browser.session.status
   * Return the active profile and CDP port information.
   */
  router.register('browser.session.status', async (params, ctx) => {
    const kind = backend();
    // Chrome backend: the Electron-session fields below describe a session the
    // chrome backend does not use, so reporting them alone made the status
    // useless for diagnosis (dogfood P2: "partition persist:wmux-default,
    // port null" while a real Chrome was up on its CDP port). Report the
    // chrome facts instead — via a pure read that never launches Chrome.
    if (kind === 'chrome' && chromeRegistry) {
      const ws = scopeFor('browser.session.status', params, ctx);
      const status = await chromeRegistry.statusForWorkspace(ws || undefined);
      return {
        backend: kind,
        profile: status.profile,
        partition: null,
        persistent: null,
        port: status.cdpPort,
        running: status.running,
        // Only the live profile sets liveAttach (running there = remote-debugging
        // reachable), so the agent reads running:false as "enable it at
        // chrome://inspect", not "call session.start". Additive: absent elsewhere.
        ...(status.liveAttach !== undefined && { liveAttach: status.liveAttach }),
      };
    }
    const active = profileManager.getActiveProfile();
    const port = portAllocator.getPort();
    return {
      backend: kind,
      profile: active.name,
      partition: active.partition,
      persistent: active.persistent,
      port,
    };
  });

  /**
   * browser.session.list
   * Return all available profiles.
   */
  router.register('browser.session.list', async () => {
    const profiles = profileManager.listProfiles().map((p) => ({
      name: p.name,
      partition: p.partition,
      persistent: p.persistent,
    }));
    return { profiles };
  });

  // ── Human-like typing handler ─────────────────────────────────────────

  /**
   * browser.type.humanlike
   * Generate a human-like typing schedule for the given text.
   * The schedule (array of per-keystroke delays) is returned so that the
   * caller (e.g. Playwright MCP) can execute the actual key presses.
   * params: { text: string, selector?: string }
   */
  router.register('browser.type.humanlike', async (params) => {
    if (typeof params['text'] !== 'string' || params['text'].length === 0) {
      throw new Error('browser.type.humanlike: missing required param "text"');
    }
    const text: string = params['text'];
    const selector = typeof params['selector'] === 'string' ? params['selector'] : undefined;

    const delays = humanBehavior.generateTypingSchedule(text);
    const config = humanBehavior.getConfig();

    return {
      text,
      ...(selector && { selector }),
      delays,
      totalDuration: delays.reduce((sum, d) => sum + d, 0),
      config: {
        typingDelay: config.typingDelay,
      },
    };
  });

  /**
   * browser.cdp.info
   * Returns the CDP port and minimal target metadata required for Playwright attachment.
   * params: { workspaceId?: string }
   *
   * When a caller passes its resolved `workspaceId`, `targets` is filtered to
   * that workspace server-side and `targetsScoped: true` is set (#580, Option
   * 1). `cdpPort` and `shellUrl` are more powerful: together they expose the raw
   * browser attach path, so #810 returns them only to the renderer operator,
   * server-pinned callers, and source-qualified first-party wire clients.
   * Approved third-party and legacy callers still receive target metadata, but
   * not the primitive that bypasses the tool-layer capability and lease checks.
   */
  router.register('browser.cdp.info', async (params, ctx) => {
    // Refuse before disclosing anything, including whether CDP is enabled.
    const callerWorkspaceId = scopeFor('browser.cdp.info', params, ctx);

    // Phase 2 'chrome' backend: report the dedicated Chrome's CDP endpoint.
    // Deliberately BEFORE the Electron-CDP gate below — chrome mode works even
    // when Electron's own remote debugging is disabled. No shellUrl: there is
    // no app shell in that instance, and the engine's localhost heuristics
    // must not hide the user's dev-server tabs.
    if (backend() === 'chrome') {
      const launcher = requireChrome('browser.cdp.info', callerWorkspaceId || undefined);
      const ep = await launcher.endpoint();
      // Both client kinds seed only wmux-opened tabs (live additionally
      // reaches pre-existing tabs via browser_tabs + engine-side direct
      // match; a random user tab still never becomes the default pin).
      const chromeTargets = await launcher.cdpInfoTargets(callerWorkspaceId || undefined);
      const disclose = canDiscloseBrowserAttachInfo(ctx);
      return {
        ...(disclose && ep.cdpPort !== undefined && { cdpPort: ep.cdpPort }),
        ...(disclose && ep.wsEndpoint && { wsEndpoint: ep.wsEndpoint }),
        ...(callerWorkspaceId && { targetsScoped: true }),
        workspaceBackend: 'chrome' as const,
        // The two ids differ for dedicated instances: the engine matches the
        // registry on surfaceId and then dials CDP with targetId, so shipping
        // the CURRENT targetId here is what keeps a stable handle drivable
        // after Chrome swaps the target (PlaywrightEngine needs no change).
        targets: chromeTargets.map((t) => ({
          surfaceId: t.surfaceId,
          targetId: t.targetId,
          ...(t.workspaceId && { workspaceId: t.workspaceId }),
        })),
      };
    }

    const cdpPort = webviewCdpManager.getCdpPort();
    if (cdpPort <= 0) {
      throw new Error(
        'CDP remote debugging is disabled — browser automation is unavailable. ' +
          'Enable it via ~/.wmux/config.json (browser.cdp.enabled = true) and restart wmux, ' +
          'or unset the WMUX_DISABLE_CDP environment variable.',
      );
    }
    const discloseAttachInfo = canDiscloseBrowserAttachInfo(ctx);

    const listRelevantTargets = () => {
      const targets = webviewCdpManager.listTargets();
      // Server-side workspace scoping. An untagged target (older registration
      // path) is dropped from a scoped response rather than leaked, since it
      // cannot be proven to belong to the caller.
      return callerWorkspaceId
        ? targets.filter((t) => t.workspaceId === callerWorkspaceId)
        : targets;
    };
    let scopedTargets = listRelevantTargets();

    // If the caller has no relevant builtin target yet, wait briefly for an
    // in-flight registration. A foreign workspace target must not suppress
    // this grace period. Only 'external' skips the wait — it is the one backend
    // that never registers a builtin target, so waiting could add latency to a
    // guaranteed miss. Any other value waits, which costs at most the grace
    // period; skipping costs a duplicate surface.
    if (backend() !== 'external' && scopedTargets.length === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      scopedTargets = listRelevantTargets();
    }

    // Read after the wait, not before: the Settings UI can flip the backend
    // over IPC while the grace period is pending, and a stale 'builtin' here
    // would send the caller into target-miss retries when the honest answer is
    // the external-backend contract error. The wait decision is the entry
    // value's to make; the reported value is the current one.
    const workspaceBackend = backend();

    // Expose the actual runtime URL of the main-window webContents (the app
    // shell) so the Playwright engine can recognize the shell by exact-match
    // instead of guessing from build-path shape. dev → http://localhost:..,
    // packaged → file:///.../.vite/renderer/main_window/index.html. The guest
    // <webview> is a separate webContents and never appears here. Suppress an
    // empty URL (window still mid-load) so the engine keeps any prior value.
    let shellUrl: string | undefined;
    if (discloseAttachInfo) {
      try {
        const url = getWindow()?.webContents.getURL();
        if (url && url.length > 0) shellUrl = url;
      } catch { /* window destroyed — omit shellUrl */ }
    }

    return {
      ...(discloseAttachInfo && { cdpPort }),
      ...(discloseAttachInfo && shellUrl && { shellUrl }),
      // Lets a scoped caller tell "I own no live targets" (empty + scoped) from
      // "legacy main that can't scope" (empty + unscoped). The engine gates its
      // leniency fallback on this.
      ...(callerWorkspaceId && { targetsScoped: true }),
      // #517 backend fork: with zero targets + 'external' the engine returns
      // the shared contract error instead of the generic target-miss (which
      // would send agents into pointless retry loops).
      workspaceBackend,
      targets: scopedTargets.map((t) => ({
        surfaceId: t.surfaceId,
        targetId: t.targetId,
        // Owning workspace (#554) — lets the read path scope page selection to
        // the calling session's workspace instead of the first surface globally.
        ...(t.workspaceId && { workspaceId: t.workspaceId }),
      })),
    };
  });

  /**
   * browser.screenshot
   * Capture a screenshot of the webview.
   * params: { surfaceId?: string, fullPage?: boolean }
   */
  registerLeased('browser.screenshot', async (params, scope) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const fullPage = params['fullPage'] === true;

    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (!target) throw noTargetError('browser.screenshot', surfaceId, scope);

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.screenshot: WebContents unavailable');

    // CDP first — it is the only path that supports captureBeyondViewport.
    // But its compositor-path capture is unreliable for <webview> guests
    // (#529): the command can wait forever on a frame that never comes, and
    // WHICH visibility state hangs varies by machine/GPU session (measured
    // both "hidden hangs" and "visible hangs" on the same box). So the call
    // is bounded, with Electron's capturePage() — a different, synchronous
    // readback path — as the fallback.
    const cdpCapture = wc.debugger
      .sendCommand('Page.captureScreenshot', {
        format: 'png',
        ...(fullPage && { captureBeyondViewport: true }),
      })
      // The abandoned promise may settle (or reject on detach) long after the
      // timeout below — never let it surface as an unhandled rejection.
      .catch(() => null);
    const timeoutMarker = Symbol('cdp-screenshot-timeout');
    const raced = await Promise.race([
      cdpCapture,
      new Promise<typeof timeoutMarker>((resolve) => {
        const t = setTimeout(() => resolve(timeoutMarker), CDP_SCREENSHOT_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    if (raced !== timeoutMarker && raced && typeof (raced as { data?: unknown }).data === 'string') {
      return { data: (raced as { data: string }).data };
    }

    // Fallback: viewport-only, so a fullPage request degrades to the viewport
    // — still strictly better than hanging for the caller. capturePage rides
    // the same surface-copy machinery and hangs for the same guests (measured
    // live), so it gets its own bound.
    const fallback = await Promise.race([
      wc.capturePage().catch(() => null),
      new Promise<typeof timeoutMarker>((resolve) => {
        const t = setTimeout(() => resolve(timeoutMarker), CAPTURE_PAGE_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    if (fallback !== timeoutMarker && fallback && !fallback.isEmpty()) {
      return { data: fallback.toPNG().toString('base64') };
    }
    // No capture path can produce pixels for this guest right now. Typical
    // cause: the pane's workspace is hidden and the compositor has stopped
    // producing frames for the guest (#529 — no CDP-side lever unblocks this;
    // reveal tricks, bringToFront and lifecycle overrides were all measured
    // ineffective). Fail fast with the workarounds instead of hanging.
    throw new Error(
      'browser.screenshot: the guest is not producing frames (its pane is likely in a hidden workspace — #529). ' +
      'Bring the workspace to front (workspace.focus / pane_focus) and retry, or use browser_snapshot / browser_extract_text for content without pixels.',
    );
  });

  /**
   * browser.evaluate
   * Execute JavaScript in the webview and return the result.
   * params: { expression: string, surfaceId?: string }
   */
  registerLeased('browser.evaluate', async (params, scope) => {
    const expression = typeof params['expression'] === 'string' ? params['expression'] : '';
    if (!expression) throw new Error('browser.evaluate: missing "expression"');
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (!target) throw noTargetError('browser.evaluate', surfaceId, scope);

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.evaluate: WebContents unavailable');

    // Use CDP Runtime.evaluate for reliable execution (executeJavaScript can fail silently)
    try {
      const cdpResult = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }) as { result: { value?: unknown; description?: string; type: string }; exceptionDetails?: { text: string; exception?: { description?: string } } };

      if (cdpResult.exceptionDetails) {
        const errMsg = cdpResult.exceptionDetails.exception?.description
          || cdpResult.exceptionDetails.text
          || 'Unknown script error';
        throw new Error(errMsg);
      }

      return { value: cdpResult.result?.value ?? null };
    } catch (err) {
      // Fallback to executeJavaScript
      try {
        const result = await wc.executeJavaScript(expression);
        return { value: result };
      } catch (fallbackErr) {
        throw new Error(`evaluate failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
      }
    }
  });

  /**
   * browser.console.get
   * Drain captured console messages for the webview (packaged-build fallback for
   * the MCP browser_console tool, #106). Capture is enabled when the guest
   * registers (#1081); ensure() here only covers a guest that registered before
   * the hook existed, or one whose debugger was stolen and dropped.
   * Also returns the collection window (since / missedBefore) so an empty
   * result can say which kind of empty it is.
   * params: { surfaceId?: string, clear?: boolean }
   */
  registerLeased('browser.console.get', async (params, scope) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const clear = params['clear'] === true;

    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (!target) throw noTargetError('browser.console.get', surfaceId, scope);

    const state = await captureManager.ensure(target.webContentsId);
    if (!state) throw new Error('browser.console.get: capture unavailable (webContents gone)');

    const entries = captureManager.getConsole(target.webContentsId);
    // Read the window BEFORE the clear: it describes the entries being
    // returned, not the empty buffer the clear leaves behind.
    const window = captureManager.getConsoleWindow(target.webContentsId);
    if (clear) captureManager.clearConsole(target.webContentsId);
    return { entries, ...window };
  });

  /**
   * browser.lifecycle.get
   * Destructively drain browser lifecycle events (navigated/loaded/closed) for
   * inline injection into MCP tool results. Target-tolerant: a gone target is
   * answered from the pending-closure records of the scope's last-known guest
   * instead of erroring — a closed tab is exactly the case this must report.
   * params: { surfaceId?: string }
   */
  registerLeased('browser.lifecycle.get', async (params, scope) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const scopeKey = `${scope ?? ''}|${surfaceId ?? ''}`;

    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (!target) {
      const lastId = lastLifecycleTarget.get(scopeKey);
      if (lastId === undefined) return { entries: [] };
      lastLifecycleTarget.delete(scopeKey);
      return { entries: captureManager.drainLifecycle(lastId) };
    }

    lastLifecycleTarget.delete(scopeKey);
    lastLifecycleTarget.set(scopeKey, target.webContentsId);
    while (lastLifecycleTarget.size > MAX_LIFECYCLE_TARGETS) {
      const oldest = lastLifecycleTarget.keys().next().value;
      if (oldest === undefined) break;
      lastLifecycleTarget.delete(oldest);
    }
    const state = await captureManager.ensure(target.webContentsId);
    if (!state) return { entries: [] };
    return { entries: captureManager.drainLifecycle(target.webContentsId) };
  },
  undefined,
  // Chrome backend: no webContents-side capture exists; the snapshot URL
  // guard covers baseline invalidation, so an empty drain is honest.
  async () => ({ entries: [] }));

  /**
   * browser.network.get
   * Drain captured network request summaries for the webview (#106). Bodies are
   * fetched separately via browser.responseBody.get to keep this payload small.
   * params: { surfaceId?: string, clear?: boolean }
   */
  registerLeased('browser.network.get', async (params, scope) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const clear = params['clear'] === true;

    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (!target) throw noTargetError('browser.network.get', surfaceId, scope);

    const state = await captureManager.ensure(target.webContentsId);
    if (!state) throw new Error('browser.network.get: capture unavailable (webContents gone)');

    const entries = captureManager.getNetwork(target.webContentsId);
    const window = captureManager.getNetworkWindow(target.webContentsId);
    if (clear) captureManager.clearNetwork(target.webContentsId);
    return { entries, ...window };
  });

  /**
   * browser.responseBody.get
   * Return the last captured response body whose URL matches the glob (#106).
   * params: { surfaceId?: string, urlPattern: string }
   */
  registerLeased('browser.responseBody.get', async (params, scope) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const urlPattern = typeof params['urlPattern'] === 'string' ? params['urlPattern'] : '';
    if (!urlPattern) throw new Error('browser.responseBody.get: missing "urlPattern"');

    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (!target) throw noTargetError('browser.responseBody.get', surfaceId, scope);

    const state = await captureManager.ensure(target.webContentsId);
    if (!state) throw new Error('browser.responseBody.get: capture unavailable (webContents gone)');

    const body = captureManager.getResponseBody(target.webContentsId, urlPattern);
    return { body };
  });

  /**
   * browser.type.cdp
   * Type text into the currently focused element via CDP Input events.
   * This simulates real keyboard input, which works with React/controlled inputs.
   * params: { text: string, surfaceId?: string }
   */
  registerLeased('browser.type.cdp', async (params, scope) => {
    const text = typeof params['text'] === 'string' ? params['text'] : '';
    if (!text) throw new Error('browser.type.cdp: missing "text"');
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (!target) throw noTargetError('browser.type.cdp', surfaceId, scope);

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.type.cdp: WebContents unavailable');

    // Use Input.insertText for reliable text input (handles CJK, React inputs, etc.)
    await wc.debugger.sendCommand('Input.insertText', { text });
    return { ok: true, text };
  });

  /**
   * browser.click.cdp
   * Click at coordinates or on the focused element via CDP Input events.
   * params: { x?: number, y?: number, selector?: string, surfaceId?: string }
   */
  registerLeased('browser.click.cdp', async (params, scope) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const selector = typeof params['selector'] === 'string' ? params['selector'] : undefined;

    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (!target) throw noTargetError('browser.click.cdp', surfaceId, scope);

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.click.cdp: WebContents unavailable');

    let x = typeof params['x'] === 'number' ? params['x'] : 0;
    let y = typeof params['y'] === 'number' ? params['y'] : 0;

    if (selector) {
      // Scroll element into view and get its viewport coordinates.
      // Without scrollIntoView, off-screen elements return coordinates outside
      // the viewport bounds, causing CDP mouse events to miss the target.
      const coordResult = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`,
        returnByValue: true,
      }) as { result: { value: { x: number; y: number } | null } };

      const coords = coordResult.result?.value;
      if (!coords) throw new Error(`Element not found: ${selector}`);
      x = coords.x;
      y = coords.y;
    }

    // Simulate mouse click via CDP.
    // Dispatch mouseMoved first — some frameworks (React, Vue) require hover
    // state before a click registers (e.g. onClick handlers on hover-revealed elements).
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });

    return { ok: true, x, y };
  });

  /**
   * browser.press.cdp
   * Press a keyboard key via CDP Input events.
   * params: { key: string, surfaceId?: string }
   */
  registerLeased('browser.press.cdp', async (params, scope) => {
    const key = typeof params['key'] === 'string' ? params['key'] : '';
    if (!key) throw new Error('browser.press.cdp: missing "key"');
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    const target = webviewCdpManager.getTarget(surfaceId, scope);
    if (!target) throw noTargetError('browser.press.cdp', surfaceId, scope);

    const wc = webContents.fromId(target.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('browser.press.cdp: WebContents unavailable');

    // Build real keyDown/keyUp descriptors (printable chars, named keys, and
    // modifier combos). Unlike the old `char`-only path this synthesizes DOM
    // keydown, and rejects multi-char text with a pointer to browser.type.cdp
    // (issue #353). parseKeyPress throwing surfaces as the RPC error.
    const { keyDown, keyUp } = parseKeyPress(key);
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', keyDown);
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', keyUp);

    return { ok: true, key };
  });

  /**
   * browser.cdp.target
   * Returns the CDP WebSocket URL for the active browser webview.
   * params: { surfaceId?: string }
   */
  router.register('browser.cdp.target', async (params, ctx) => {
    const scope = scopeFor('browser.cdp.target', params, ctx);
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;

    if (surfaceId) {
      try {
        // The wait itself carries the scope, so a live-but-foreign surface is
        // indistinguishable from one that never existed — same message, same
        // latency. Post-checking an unscoped wait would not achieve that: the
        // foreign case answers instantly and the missing case costs the full
        // timeout, and that difference is itself the disclosure.
        const target = await webviewCdpManager.waitForTarget(surfaceId, 5000, scope);
        return {
          targetId: target.targetId,
          surfaceId: target.surfaceId,
        };
      } catch {
        return { error: 'timeout waiting for webview CDP target' };
      }
    }

    const target = webviewCdpManager.getTarget(undefined, scope);
    if (!target) return { error: 'no active browser webview' };

    return {
      targetId: target.targetId,
      surfaceId: target.surfaceId,
    };
  });

  // ── State handlers (packaged RPC fallback for browser_cookies / _resize /
  //    _emulate, #111). On packaged builds playwright-core cannot hand the guest
  //    <webview> back as a Playwright Page, so these tools fall through to CDP
  //    over the page debugger — the same route browser.evaluate already uses.
  //    browser_storage needs no handler here: it routes through browser.evaluate.

  /**
   * browser.cookies
   * Get, set, or clear cookies via CDP Network domain.
   *   - get:   { action:'get', urls?: string[] }   -> { cookies: Network.Cookie[] }
   *   - set:   { action:'set', cookies: CookieParam[] } (url defaulted to page URL
   *            for entries lacking both url and domain) -> { ok: true }
   *   - clear: { action:'clear' } -> { ok: true }
   * params: { action, urls?, cookies?, surfaceId? }
   * Sensitive-domain redaction stays in the MCP tool (state.ts), not here.
   */
  registerLeased('browser.cookies', async (params, scope) => {
    const action = params['action'];
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const wc = resolveWc(surfaceId, 'browser.cookies', scope);

    if (action === 'get') {
      const urls = Array.isArray(params['urls'])
        ? (params['urls'] as unknown[]).filter((u): u is string => typeof u === 'string')
        : [];
      let result: { cookies: unknown[] };
      if (urls.length > 0) {
        result = await wc.debugger.sendCommand('Network.getCookies', { urls }) as { cookies: unknown[] };
      } else {
        // Whole-context read. Network.getAllCookies is deprecated in newer CDP
        // but still present in Electron's Chromium; fall back to a urls-less
        // getCookies (current-page frames) if it has been removed.
        try {
          result = await wc.debugger.sendCommand('Network.getAllCookies') as { cookies: unknown[] };
        } catch {
          result = await wc.debugger.sendCommand('Network.getCookies', {}) as { cookies: unknown[] };
        }
      }
      return { cookies: result.cookies };
    }

    if (action === 'set') {
      const raw = Array.isArray(params['cookies']) ? params['cookies'] as Record<string, unknown>[] : [];
      if (raw.length === 0) throw new Error('browser.cookies set: no cookies provided');
      const pageUrl = (() => { try { return wc.getURL(); } catch { return undefined; } })();
      const cookies = raw.map((c) => {
        const hasDomain = typeof c['domain'] === 'string' && (c['domain'] as string).length > 0;
        const hasUrl = typeof c['url'] === 'string' && (c['url'] as string).length > 0;
        // CDP Network.setCookies requires url OR domain. Default missing ones to
        // the live page URL so a bare { name, value } still lands.
        return (!hasDomain && !hasUrl && pageUrl) ? { ...c, url: pageUrl } : c;
      });
      await wc.debugger.sendCommand('Network.setCookies', { cookies });
      return { ok: true };
    }

    if (action === 'clear') {
      await wc.debugger.sendCommand('Network.clearBrowserCookies');
      return { ok: true };
    }

    throw new Error(`browser.cookies: unknown action "${String(action)}"`);
  });

  /**
   * browser.resize
   * Override the viewport size via CDP Emulation.setDeviceMetricsOverride.
   * params: { width: number, height: number, surfaceId? }
   */
  registerLeased('browser.resize', async (params, scope) => {
    const width = typeof params['width'] === 'number' ? params['width'] : NaN;
    const height = typeof params['height'] === 'number' ? params['height'] : NaN;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('browser.resize: width and height must be numbers');
    }
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const wc = resolveWc(surfaceId, 'browser.resize', scope);
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 0, mobile: false,
    });
    return { ok: true, width, height };
  });

  /**
   * browser.emulate
   * Apply emulation settings via CDP. The MCP tool (state.ts) resolves any
   * device preset to deviceMetrics + userAgent before calling, so this handler
   * never needs playwright-core's device table. Returns the list of applied
   * settings (including the "credentials unsupported over CDP" note) so the tool
   * can render an identical summary in both transports.
   * params: {
   *   offline?, headers?, credentialsRequested?, geo?(|null), media?(|null),
   *   timezone?(|null), locale?(|null), deviceMetrics?, userAgent?, deviceReset?,
   *   surfaceId?
   * }
   */
  registerLeased('browser.emulate', async (params, scope) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    const wc = resolveWc(surfaceId, 'browser.emulate', scope);
    const send = (method: string, p?: Record<string, unknown>): Promise<unknown> =>
      wc.debugger.sendCommand(method, p);
    const applied: string[] = [];

    if (typeof params['offline'] === 'boolean') {
      await send('Network.enable');
      await send('Network.emulateNetworkConditions', {
        offline: params['offline'], latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      applied.push(`offline=${params['offline']}`);
    }

    if (params['headers'] && typeof params['headers'] === 'object' && !Array.isArray(params['headers'])) {
      const headers = params['headers'] as Record<string, string>;
      await send('Network.enable');
      await send('Network.setExtraHTTPHeaders', { headers });
      applied.push(`headers=${Object.keys(headers).length} header(s)`);
    }

    if (params['credentialsRequested'] === true) {
      applied.push(
        'credentials=failed (HTTP credentials require a Playwright context and are not available over the CDP fallback. Use browser_emulate headers with a Base64-encoded Authorization header instead.)',
      );
    }

    if ('geo' in params) {
      const geo = params['geo'] as { latitude: number; longitude: number; accuracy?: number } | null;
      if (geo) {
        await send('Emulation.setGeolocationOverride', {
          latitude: geo.latitude, longitude: geo.longitude, accuracy: geo.accuracy ?? 100,
        });
        // Overriding the coordinates is not enough on its own: navigator.geolocation
        // stays blocked unless the page also holds the geolocation permission. The
        // Playwright path grants it explicitly (context.grantPermissions); mirror
        // that so the packaged fallback actually emulates location for the common
        // permission-gated flow. Browser.grantPermissions is a browser-target
        // command and may be unavailable on Electron's page-level debugger, so this
        // is best-effort — the coordinate override still applies if it throws.
        try {
          const origin = (() => {
            try { return new URL(wc.getURL()).origin; } catch { return undefined; }
          })();
          await send('Browser.grantPermissions', {
            ...(origin && origin !== 'null' ? { origin } : {}),
            permissions: ['geolocation'],
          });
        } catch {
          /* page-target debugger can't grant browser-level permissions; coords still set */
        }
        applied.push(`geo=${geo.latitude},${geo.longitude}`);
      } else {
        // Only clear the geolocation override, mirroring the Playwright path,
        // which leaves permissions untouched here. Browser.resetPermissions would
        // wipe every permission override for the whole browser context (all
        // origins), revoking grants this tool never made, so it is deliberately
        // not called — clearing the coordinate override is what actually stops
        // location emulation.
        await send('Emulation.clearGeolocationOverride');
        applied.push('geo=cleared');
      }
    }

    if ('media' in params) {
      const media = params['media'] as string | null;
      await send('Emulation.setEmulatedMedia',
        media ? { features: [{ name: 'prefers-color-scheme', value: media }] } : { features: [] });
      applied.push(media ? `colorScheme=${media}` : 'colorScheme=reset');
    }

    if ('timezone' in params) {
      const timezone = params['timezone'] as string | null;
      await send('Emulation.setTimezoneOverride', { timezoneId: timezone || '' });
      applied.push(timezone ? `timezone=${timezone}` : 'timezone=reset');
    }

    if ('locale' in params) {
      const locale = params['locale'] as string | null;
      await send('Emulation.setLocaleOverride', locale ? { locale } : {});
      applied.push(locale ? `locale=${locale}` : 'locale=reset');
    }

    if (params['deviceMetrics'] && typeof params['deviceMetrics'] === 'object') {
      const dm = params['deviceMetrics'] as { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean };
      await send('Emulation.setDeviceMetricsOverride', {
        width: dm.width, height: dm.height,
        deviceScaleFactor: dm.deviceScaleFactor ?? 0, mobile: dm.mobile ?? false,
      });
      if (typeof params['userAgent'] === 'string') {
        await send('Emulation.setUserAgentOverride', { userAgent: params['userAgent'] });
      }
      const label = typeof params['deviceLabel'] === 'string' ? params['deviceLabel'] : `${dm.width}x${dm.height}`;
      applied.push(`device=${label}`);
    } else if (params['deviceReset'] === true) {
      // Actually undo the preset over CDP: drop the device metrics override and
      // restore the real user agent. Without this, a packaged caller who switches
      // to a phone preset and then resets stays on the mobile UA/metrics for every
      // subsequent page. CDP has no "clear UA override" command, so re-apply the
      // WebContents' own UA to shed the mobile one set by the preset above.
      await send('Emulation.clearDeviceMetricsOverride');
      try {
        const ua = typeof wc.getUserAgent === 'function' ? wc.getUserAgent() : undefined;
        if (ua) await send('Emulation.setUserAgentOverride', { userAgent: ua });
      } catch {
        /* getUserAgent / UA override unavailable on this transport; metrics still cleared */
      }
      applied.push('device=reset (use browser_resize to set viewport)');
    }

    return { applied };
  });
}
