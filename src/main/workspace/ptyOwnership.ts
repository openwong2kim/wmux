// ptyOwnership — mirror-first resolution of "which workspace owns this PTY"
// (and its D2 role binding) for main-process RPC handlers.
//
// WHY: every external MCP call used to pay a main→renderer round-trip
// (`input.findOwnerWorkspace`) per ownership check / identity resolution /
// role-binding lookup — 1-3 round-trips per call, and the renderer answers
// late exactly when the app is busy (flush storm), which is the moment the
// latency hurts. Main already holds a renderer-pushed WorkspaceMirror
// (structural changes push immediately, status churn debounced 300ms, 30s
// periodic — see useWorkspaceMirrorPush.ts), so a fresh mirror can answer
// locally and the round-trip becomes the fallback, not the hot path.
//
// TRUST MODEL (documented for PR review):
//   - The mirror and the round-trip have the SAME source of truth (the
//     renderer store); the mirror is just earlier. The exposure is bounded to
//     pushes lost/delayed within STALE_TRUST_MS (10s) after a pane moved
//     workspaces — structural changes push immediately, so the realistic
//     window is IPC delivery latency (ms).
//   - assert-style checks (expected workspace known): the mirror can only
//     SHORT-CIRCUIT AN ALLOW when it AGREES with the expectation. Any miss /
//     stale / disagreement falls back to the round-trip, which remains the
//     sole DENY authority — a stale mirror can never produce a false reject.
//   - resolve-style checks (caller identity from a verified senderPtyId): the
//     senderPtyId anchor is ADVISORY attribution under the #113 same-user
//     ceiling by design (see events.rpc.ts resolveCallerWorkspace — the true
//     unforgeable fix is peer-PID, deferred). A ≤10s-stale answer does not
//     change that threat model. Misses still round-trip, and the fail-closed
//     '' contract at the call sites is preserved.

import type { BrowserWindow } from 'electron';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { findWorkspaceIdForPty, STALE_TRUST_MS } from '../pipe/handlers/hooks.rpc';
import { normalizeRoleBinding, type RoleBinding } from '../../shared/orchestratorRole';
import { getWorkspaceMirror } from './WorkspaceMirror';

type GetWindow = () => BrowserWindow | null;

/** Parse the renderer's `input.findOwnerWorkspace` reply into an owner id. */
function parseOwner(result: unknown): string | null {
  const owner =
    result && typeof result === 'object' && 'workspaceId' in result
      ? ((result as Record<string, unknown>)['workspaceId'] as string | null)
      : null;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

/**
 * Resolve the workspace that owns `ptyId`. Mirror-first, renderer round-trip
 * fallback. Throws only when the round-trip itself throws (renderer gone) —
 * callers with a fail-closed contract keep their own try/catch.
 *
 * `opts.expected` selects the assert posture: the mirror may only answer when
 * it AGREES with the expectation (allow short-circuit); any other mirror
 * verdict falls through to the round-trip so DENY decisions always come from
 * the freshest source. Without `expected` (resolve posture), any fresh mirror
 * HIT answers; a fresh MISS still round-trips (a just-spawned pty may race
 * the push).
 */
export async function resolvePtyOwnerWorkspace(
  getWindow: GetWindow,
  ptyId: string,
  opts: { expected?: string } = {},
): Promise<string | null> {
  const peeked = getWorkspaceMirror().peek();
  if (peeked && peeked.ageMs < STALE_TRUST_MS) {
    const owner = findWorkspaceIdForPty(ptyId, peeked.entries);
    if (opts.expected !== undefined ? owner === opts.expected : owner !== null) {
      return owner;
    }
  }
  const result = await sendToRenderer(getWindow, 'input.findOwnerWorkspace', { ptyId });
  return parseOwner(result);
}

/**
 * Verify that `ptyId` belongs to a surface inside `expectedWorkspaceId`.
 * Throws when the PTY is owned by a different workspace (or no workspace at
 * all). Returns silently when `expectedWorkspaceId` is undefined — internal
 * callers (CLI, UI) skip this check.
 *
 * Closes the cross-workspace bypass where the metadata layer enforced
 * isolation but the PTY-id-keyed terminal IO layer didn't (see the original
 * input.rpc.ts rationale). The mirror fast path only ever short-circuits the
 * ALLOW; every deny is confirmed by the renderer round-trip.
 */
export async function assertWorkspaceOwnsPty(
  getWindow: GetWindow,
  ptyId: string,
  expectedWorkspaceId: string | undefined,
  rpcName: string,
): Promise<void> {
  if (!expectedWorkspaceId) return;
  const owner = await resolvePtyOwnerWorkspace(getWindow, ptyId, {
    expected: expectedWorkspaceId,
  });
  if (owner !== expectedWorkspaceId) {
    throw new Error(
      `${rpcName}: PTY "${ptyId}" is not owned by workspace "${expectedWorkspaceId}" ` +
        `(actual owner: ${owner ?? 'none'}). Cross-workspace terminal access is not allowed.`,
    );
  }
}

/**
 * Resolve a pane's enforced role→model binding for a ptyId. Mirror-first: the
 * push payload carries a COMPLETE ptyId→binding map (workspaceMirrorSnapshot
 * buildRoleBindings — same resolution the round-trip performs), so a fresh
 * mirror answers both "bound to X" and "unbound" locally. An old renderer that
 * pushes no roleBindings field yields peekRoleBindings() === null — unknown,
 * so we round-trip exactly as before.
 *
 * Returns undefined on any miss (no owner, unbound role, malformed reply) —
 * the caller fails OPEN, never blocking a legitimate send because a lookup
 * raced (unchanged contract from input.rpc.ts).
 */
export async function resolveRoleBindingForPty(
  getWindow: GetWindow,
  ptyId: string,
): Promise<RoleBinding | undefined> {
  const peeked = getWorkspaceMirror().peekRoleBinding(ptyId);
  if (peeked && peeked.ageMs < STALE_TRUST_MS) {
    // Re-normalize at the read boundary — the renderer store is hand-editable
    // via session.json, so treat the mirrored binding as untrusted even here.
    return normalizeRoleBinding(peeked.binding);
  }
  const result = await sendToRenderer(getWindow, 'input.findOwnerWorkspace', { ptyId });
  if (!result || typeof result !== 'object' || !('roleBinding' in result)) return undefined;
  return normalizeRoleBinding((result as Record<string, unknown>)['roleBinding']);
}
