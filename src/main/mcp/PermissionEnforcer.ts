// PermissionEnforcer — pure-function permission gate for the Phase 2.2
// enforcement layer. Given a method, params, request context, and the
// caller's trust record, returns one of:
//
//   - { kind: 'allow' }
//       Capability declared and (if applicable) every requested path is
//       covered by the declaration. Handler runs as normal.
//
//   - { kind: 'reject'; rejection: RpcRejection }
//       Either the capability wasn't declared, every requested path was
//       rejected, the trust state forbids it (denied / unconfirmed), or
//       a multi-path method in 'all-or-nothing' mode had any path fail.
//       Caller MUST NOT invoke the handler.
//
//   - { kind: 'partial'; allowedPaths: string[]; rejection: RpcRejection }
//       Multi-path method in 'partial' mode where some paths matched and
//       some didn't. Dispatcher passes `allowedPaths` to the handler
//       (rewriting params if needed) and attaches the `rejection` field
//       (the `paths-partially-allowed` variant) to the success response
//       so the client knows what was filtered. See plan D3 for the wire
//       contract — Pre-commit 2 wires `rejection` into the RpcResponse
//       `ok: true` arm to carry this case.
//
// Design notes (plan D1, D4):
//   - Pure function. No I/O, no time, no side effects. Trust state is read
//     once upstream and passed in. This makes the enforcer trivially
//     unit-testable and means the same function runs in both shadow mode
//     (log the rejection) and enforce mode (return the rejection).
//   - Identity-bootstrap RPCs (mcp.identify / mcp.declarePermissions) carry
//     `capability: null` in methodCapabilityMap; the enforcer recognises
//     this and allows unconditionally. NO hard-coded special-case here.
//   - `legacy` status (no clientName envelope upstream) is allowed and
//     recorded by the shadow log in Pre-commit 3+4. The enforcer treats it
//     as 'allow' so substrate ships without breaking v2.x callers.
//   - `denied` is rejected with no pendingApproval (spec §4.3: denied
//     never regresses). User must edit plugin-trust.json by hand.
//   - `unconfirmed` is rejected with `pendingApproval` so the client can
//     retry once the user approves. The `promptId` is filled in by the
//     ApprovalQueue at dispatch time (Pre-commit 5), not here — the
//     enforcer returns it as `undefined` and the dispatcher overwrites.

import type {
  PluginIdentityRecord,
  RpcContext,
  RpcMethod,
  RpcRejection,
} from '../../shared/rpc';
import {
  METHOD_CAPABILITY,
  resolveRequiredCapability,
  type PathExtractor,
  type RequiredCapability,
} from './methodCapabilityMap';
import {
  parsePermission,
  type ParsedPermission,
} from './permissionGrammar';
import { FIRST_PARTY_METHODS, isFirstPartyClient } from './firstParty';
import { WMUX_CLI_METHODS, isInternalCliClient } from './internalCli';

export type EnforcerOutcome =
  | { kind: 'allow' }
  | { kind: 'reject'; rejection: RpcRejection }
  | {
      kind: 'partial';
      allowedPaths: string[];
      rejection: Extract<RpcRejection, { reason: 'paths-partially-allowed' }>;
    };

export interface EnforcerInput {
  method: RpcMethod;
  params: Record<string, unknown>;
  ctx: RpcContext;
  /** Trust record for `ctx.clientName`, or `undefined` if none exists. */
  trust: PluginIdentityRecord | undefined;
  /**
   * True when the trust-store lookup *threw* (corrupt DB / I/O error) instead
   * of cleanly resolving to "no record". The two cases look identical at the
   * `trust === undefined` level but must NOT be treated the same: a clean miss
   * is a fresh first-party caller (grant the bypass), whereas a failed read
   * means an operator `denied` row might exist but couldn't be loaded — so the
   * first-party bypass declines on this unknown state and lets the caller fall
   * through to the normal (fail-closed) ladder. Non-first-party callers already
   * fail closed here regardless; this keeps first-party symmetric for the
   * security-relevant `denied` case. Defaults to `false` when omitted (the
   * common path and every unit test that doesn't exercise a lookup failure).
   */
  trustLookupFailed?: boolean;
}

/**
 * Result of looking up matching declared permissions for a (capability,
 * trust-record) pair. `unrestricted` means at least one declaration was for
 * the capability with no `:glob` (broadest grant). `scoped` carries each
 * declaration's pathRegex + glob string for path matching.
 */
interface CapabilityGrant {
  unrestricted: boolean;
  scoped: { pathGlob: string; pathRegex: RegExp }[];
}

function findCapabilityGrant(
  trust: PluginIdentityRecord | undefined,
  capability: string,
): CapabilityGrant {
  const grant: CapabilityGrant = { unrestricted: false, scoped: [] };
  if (!trust || !trust.declaredCapabilities) return grant;
  for (const raw of trust.declaredCapabilities) {
    const parsed = parsePermission(raw);
    if (!parsed.ok) continue; // malformed declarations can't grant anything
    const p: ParsedPermission = parsed.permission;
    if (p.capability !== capability) continue;
    if (!p.pathGlob || !p.pathRegex) {
      grant.unrestricted = true;
    } else {
      grant.scoped.push({ pathGlob: p.pathGlob, pathRegex: p.pathRegex });
    }
  }
  return grant;
}

function declaredGlobsFromGrant(grant: CapabilityGrant): string[] {
  // For surfacing "what you declared" in rejections. Unrestricted is
  // represented by the capability name alone (no glob suffix).
  const out: string[] = [];
  if (grant.unrestricted) out.push('(no glob — unrestricted)');
  for (const s of grant.scoped) out.push(s.pathGlob);
  return out;
}

function hasAnyDeclarationFor(grant: CapabilityGrant): boolean {
  return grant.unrestricted || grant.scoped.length > 0;
}

function pathAllowed(grant: CapabilityGrant, path: string): boolean {
  if (grant.unrestricted) return true;
  for (const s of grant.scoped) {
    if (s.pathRegex.test(path)) return true;
  }
  return false;
}

function extractPaths(
  extractor: PathExtractor,
  params: Record<string, unknown>,
): string | string[] | undefined | 'handler-resolves' {
  if (extractor === 'handler-resolves') return 'handler-resolves';
  return extractor(params);
}

/**
 * Main entry. Returns the outcome the dispatcher should act on.
 */
export function check(input: EnforcerInput): EnforcerOutcome {
  const entry: RequiredCapability | undefined = METHOD_CAPABILITY[input.method];

  // Totality safety net: `Record<RpcMethod, ...>` makes this branch
  // statically unreachable, but a future map edit could leave a hole and
  // we'd rather close-fail than open-fail. Surface the gap to shadow logs.
  if (!entry) {
    return {
      kind: 'reject',
      rejection: {
        reason: 'capability-not-declared',
        method: input.method,
        capability: '(unmapped — methodCapabilityMap missing entry)',
      },
    };
  }

  const capability = resolveRequiredCapability(entry, input.params);

  // Identity bootstrap (mcp.identify / mcp.declarePermissions / system.*) —
  // no capability needed regardless of trust state.
  if (capability === null) {
    return { kind: 'allow' };
  }

  // Legacy: caller didn't send a clientName envelope, RpcRouter is already
  // grandfathering them via the legacy recorder. Allow at this layer.
  if (!input.ctx.clientName) {
    return { kind: 'allow' };
  }

  // First-party bundled wmux MCP server (recognised by the host clientName it
  // reports). It ships inside wmux and never goes through the external-plugin
  // declare/approve flow — and it couldn't if it tried, because several tools
  // it exposes map to `wmux.internal` methods (surface.list, company.a2a.*)
  // that the permission grammar forbids from any declaration. Grant exactly
  // the method set it calls (firstParty.ts), nothing more, regardless of the
  // trust-DB `unconfirmed` status that the bundled server is otherwise stuck
  // in. Three guards keep this from becoming a blanket bypass:
  //   - An explicit user `denied` still wins (operator escape hatch): fall
  //     through to the `denied` branch below.
  //   - A failed trust lookup (corrupt DB / I/O error, signalled by
  //     `trustLookupFailed`) is an UNKNOWN state, not a clean miss: a `denied`
  //     row may exist but be unreadable, so we decline the bypass and fall
  //     through to fail-closed enforcement rather than honoring the bundled
  //     server while an operator's `denied` couldn't be loaded.
  //   - A method outside the curated allowlist also falls through to normal
  //     enforcement, so a coverage gap surfaces as a rejection instead of
  //     silently widening first-party scope.
  // See plans/first-party-mcp-trust.md and docs/api/mcp-plugin-spec.md.
  if (
    isFirstPartyClient(input.ctx.clientName) &&
    !input.trustLookupFailed &&
    input.trust?.status !== 'denied' &&
    FIRST_PARTY_METHODS.has(input.method)
  ) {
    return { kind: 'allow' };
  }

  // Internal first-party CLI (`wmux <command>`, clientName 'wmux-cli'). The CLI
  // ships inside wmux and is the one steady-state envelope-less mutating caller;
  // Stage 2 of the grandfather deprecation gives it a stable clientName so the
  // legacy grandfather can later be closed without breaking it. Grant exactly
  // its curated method set (internalCli.ts), nothing more — a separate, narrower
  // allowlist than FIRST_PARTY_METHODS. Same three guards as the first-party
  // tier above: an explicit user `denied` wins, a failed trust lookup declines
  // (fall through to fail-closed), and a method outside the curated set falls
  // through to normal enforcement rather than silently widening CLI scope.
  if (
    isInternalCliClient(input.ctx.clientName) &&
    !input.trustLookupFailed &&
    input.trust?.status !== 'denied' &&
    WMUX_CLI_METHODS.has(input.method)
  ) {
    return { kind: 'allow' };
  }

  // Plugin self-named but isn't in the trust DB yet. Treat as unconfirmed —
  // they need to call mcp.identify + mcp.declarePermissions first. The
  // ApprovalQueue can't generate a prompt because there's nothing declared,
  // so `pendingApproval` is omitted and the human-readable error tells
  // the plugin author what to do.
  if (!input.trust) {
    return {
      kind: 'reject',
      rejection: {
        reason: 'identity-status',
        method: input.method,
        capability,
        status: 'unconfirmed',
        // No pendingApproval — the plugin hasn't declared yet.
      },
    };
  }

  // Trust-state ladder (plan D4).
  if (input.trust.status === 'denied') {
    return {
      kind: 'reject',
      rejection: {
        reason: 'identity-status',
        method: input.method,
        capability,
        status: 'denied',
        // spec §4.3: denied never regresses, no pendingApproval offered
      },
    };
  }
  if (input.trust.status === 'unconfirmed') {
    return {
      kind: 'reject',
      rejection: {
        reason: 'identity-status',
        method: input.method,
        capability,
        status: 'unconfirmed',
        // ApprovalQueue (Pre-commit 5) overwrites this with a real promptId
        // at dispatch time. Enforcer is pure — it doesn't mint IDs.
      },
    };
  }
  if (input.trust.status === 'legacy') {
    // Grandfathered. Shadow log records it (Pre-commit 4).
    return { kind: 'allow' };
  }

  // status === 'trusted'. Capability declaration must include this entry's
  // capability. Reserved 'wmux.internal' can never appear in a declaration
  // (RESERVED_PREFIXES in permissionGrammar rejects it at declaration time)
  // so internal methods always fall through to capability-not-declared here.
  const grant = findCapabilityGrant(input.trust, capability);
  if (!hasAnyDeclarationFor(grant)) {
    return {
      kind: 'reject',
      rejection: {
        reason: 'capability-not-declared',
        method: input.method,
        capability,
      },
    };
  }

  // Capability matched. Now check the path (if applicable).
  if (!entry.pathFromParams) {
    return { kind: 'allow' };
  }

  const extracted = extractPaths(entry.pathFromParams, input.params);
  if (extracted === 'handler-resolves') {
    // Handler will call PermissionEnforcer.checkPath itself. The capability
    // check has passed; allow at this layer.
    return { kind: 'allow' };
  }
  if (extracted === undefined) {
    // No path payload to check (e.g. setMetadata with no fields populated —
    // a no-op that the handler still validates against schema). Allow.
    return { kind: 'allow' };
  }

  // Normalise to array for unified loop. Track single-vs-multi for the
  // rejection variant choice.
  const isSingle = typeof extracted === 'string';
  const paths: string[] = isSingle ? [extracted] : extracted;

  const allowed: string[] = [];
  const rejected: { path: string; declared: string[] }[] = [];
  const declaredGlobs = declaredGlobsFromGrant(grant);
  for (const p of paths) {
    if (pathAllowed(grant, p)) allowed.push(p);
    else rejected.push({ path: p, declared: declaredGlobs });
  }

  if (rejected.length === 0) return { kind: 'allow' };

  // Single-path method: wholesale reject with the simpler variant.
  if (isSingle) {
    const r = rejected[0];
    return {
      kind: 'reject',
      rejection: {
        reason: 'path-not-allowed',
        method: input.method,
        capability,
        path: r.path,
        declared: r.declared,
      },
    };
  }

  // Multi-path method. Behavior depends on the method's mode (plan D2).
  const mode = entry.multiPathMode ?? 'all-or-nothing';
  if (mode === 'all-or-nothing' || allowed.length === 0) {
    // For 'all-or-nothing' OR when nothing was allowed (no partial benefit
    // anyway), reject wholesale with the partial-rejection shape so the
    // client still sees per-path detail.
    return {
      kind: 'reject',
      rejection: {
        reason: 'paths-partially-allowed',
        method: input.method,
        capability,
        allowed,
        rejected,
      },
    };
  }

  // mode === 'partial' and at least one path was allowed: caller proceeds
  // with the allowed subset, response carries the rejection detail.
  return {
    kind: 'partial',
    allowedPaths: allowed,
    rejection: {
      reason: 'paths-partially-allowed',
      method: input.method,
      capability,
      allowed,
      rejected,
    },
  };
}

/**
 * Handler-side path check, for methods declared `pathFromParams:
 * 'handler-resolves'`. Pure function; the handler resolves whatever state
 * it needs (paneId → workspaceId → owning plugin) and calls this with the
 * final path string. Returns the same outcome shape as `check` for a
 * single-path case (never returns 'partial').
 */
export function checkPath(
  trust: PluginIdentityRecord,
  method: RpcMethod,
  capability: string,
  path: string,
): EnforcerOutcome {
  const grant = findCapabilityGrant(trust, capability);
  if (!hasAnyDeclarationFor(grant)) {
    return {
      kind: 'reject',
      rejection: {
        reason: 'capability-not-declared',
        method,
        capability,
      },
    };
  }
  if (pathAllowed(grant, path)) return { kind: 'allow' };
  return {
    kind: 'reject',
    rejection: {
      reason: 'path-not-allowed',
      method,
      capability,
      path,
      declared: declaredGlobsFromGrant(grant),
    },
  };
}
