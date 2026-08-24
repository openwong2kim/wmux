// Pure pane-address resolution for A2A delivery (Part A). Extracted from
// useRpcBridge so it can be unit-tested directly (useRpcBridge itself pulls in
// the store/window and can't be imported under vitest). No React/window deps —
// operates only on the pane-leaf list the caller passes in.

import type { PaneLeaf } from '../../shared/types';
import { getLeafPanes } from '../../shared/paneUtils';

export type PaneAddress = { ptyId: string; paneId: string; surfaceId: string };

/**
 * Flatten a pane tree (root → leaves). Alias for the canonical
 * `getLeafPanes` in shared/paneUtils — kept under this name because the A2A
 * addressing paths, the channel mention composer (cross-ws live agent
 * candidates) and the mention inbox router (self-ws pane resolution) all import
 * it from here. One implementation, so a new pane location can never be visible
 * to one flatten and invisible to another.
 */
export const findLeafPanes = getLeafPanes;

/**
 * The historical active-pane delivery target: the active leaf's first terminal
 * surface with a pty, falling back to the first leaf that has one. Used when no
 * explicit pane address is supplied.
 */
export function activePaneTerminalPty(leaves: PaneLeaf[], activePaneId: string): string | null {
  // Fallback (active pane not found) must land on a leaf that actually has a
  // deliverable terminal — require `s.ptyId` in the predicate, else a leaf whose
  // only non-browser surface lacks a pty would be picked and yield null even
  // when a later leaf has a live terminal.
  const activeLeaf = leaves.find((l) => l.id === activePaneId)
    ?? leaves.find((l) => l.surfaces.some((s) => s.surfaceType !== 'browser' && s.ptyId));
  const termSurface = activeLeaf?.surfaces.find((s) => s.surfaceType !== 'browser' && s.ptyId);
  return termSurface?.ptyId ?? null;
}

/**
 * Resolve an optional pane-level address (paneId/surfaceId) to a concrete ptyId
 * WITHIN the given leaves (which must be the target workspace's own tree).
 * Cross-ws safety is structural: only the target's leaves are searched, so a
 * foreign id is simply "not found" (fail-closed). Returns an error string when
 * the address is missing or inconsistent — the caller must NOT fall back to the
 * active pane (that would deliver to the wrong agent on a typo).
 *
 *   - surfaceId given → that surface (must be a terminal with a pty); if paneId
 *     is also given it MUST be that surface's leaf, else reject.
 *   - paneId only → that leaf's active terminal surface, else its first one.
 */
export function resolvePaneAddress(
  leaves: PaneLeaf[],
  paneId: string,
  surfaceId: string,
): PaneAddress | { error: string } {
  if (surfaceId) {
    for (const leaf of leaves) {
      const s = leaf.surfaces.find((su) => su.id === surfaceId);
      if (!s) continue;
      if (paneId && leaf.id !== paneId) {
        return { error: `surface_id "${surfaceId}" does not belong to pane_id "${paneId}"` };
      }
      if (s.surfaceType === 'browser' || !s.ptyId) {
        return { error: `surface_id "${surfaceId}" is not a terminal surface` };
      }
      return { ptyId: s.ptyId, paneId: leaf.id, surfaceId: s.id };
    }
    return { error: `surface_id "${surfaceId}" not found in target workspace` };
  }
  const leaf = leaves.find((l) => l.id === paneId);
  if (!leaf) return { error: `pane_id "${paneId}" not found in target workspace` };
  const active = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId && s.surfaceType !== 'browser' && s.ptyId);
  const term = active ?? leaf.surfaces.find((s) => s.surfaceType !== 'browser' && s.ptyId);
  if (!term) return { error: `pane_id "${paneId}" has no terminal surface` };
  return { ptyId: term.ptyId, paneId: leaf.id, surfaceId: term.id };
}

/**
 * True iff `ptyId` is a live TERMINAL surface's pty within `leaves`. Used to
 * validate a caller-supplied senderPtyId against the sender's own workspace tree
 * before trusting it (a bogus / foreign value is treated as absent → the safe
 * silent fallback). Empty ptyId is never a member.
 */
export function isTerminalPtyInLeaves(leaves: PaneLeaf[], ptyId: string): boolean {
  if (!ptyId) return false;
  return leaves.some((l) => l.surfaces.some((s) => s.surfaceType !== 'browser' && s.ptyId === ptyId));
}

export type SameWsSendDecision =
  | { kind: 'reject'; error: string }
  | { kind: 'deliver'; suppressPaste: boolean };

/**
 * Decide whether an A2A NEW-TASK send is allowed and whether its PTY paste must
 * be suppressed, once same-workspace pane-to-pane sends are permitted. Pure so
 * it is unit-testable (useRpcBridge can't be imported under vitest).
 *
 * The historical guard rejected ANY same-workspace send ("cannot send to
 * yourself"), which also blocked legitimate sibling-pane delivery. Now the rule
 * is per-pane:
 *
 *  - Different workspace → always deliver (cross-ws path unchanged).
 *  - Same workspace, NO resolved pane address → REJECT: ambiguous; a bare
 *    same-ws send would fall back to the sender's own active pane and loop.
 *  - Same workspace, resolved address == sender's OWN pty (only knowable when
 *    senderPtyId is present) → REJECT: true self-send = bracket-paste + forced
 *    submit into your own prompt = loop.
 *  - Same workspace, resolved SIBLING address, senderPtyId VERIFIED (present and
 *    ≠ target) → deliver with a loud paste (we proved it isn't self).
 *  - Same workspace, resolved address but senderPtyId ABSENT → deliver but
 *    SUPPRESS the paste. Absent senderPtyId is the common case (PID-map miss →
 *    env-hint identity), so we cannot prove the target isn't the sender's own
 *    pane; fail closed on the PASTE only. The task is still persisted + teed onto
 *    the EventBus, so a sibling still receives it (pollable via a2a_task_query)
 *    and a self-addressed send is at worst a no-op pointer — never a loop.
 */
export function decideSameWsSend(
  targetIsSelfWorkspace: boolean,
  resolvedPtyId: string | undefined,
  senderPtyId: string,
): SameWsSendDecision {
  if (!targetIsSelfWorkspace) return { kind: 'deliver', suppressPaste: false };
  if (!resolvedPtyId) {
    return {
      kind: 'reject',
      error:
        'cannot send to your own workspace without addressing a specific pane ' +
        '(pass pane_id or surface_id of a sibling pane)',
    };
  }
  if (senderPtyId && resolvedPtyId === senderPtyId) {
    return { kind: 'reject', error: 'cannot send to your own pane' };
  }
  // Verified sibling (senderPtyId present and ≠ target) → loud paste; otherwise
  // (senderPtyId absent) deliver silently so an unprovable self-send can't loop.
  return { kind: 'deliver', suppressPaste: !senderPtyId };
}

export type SelfPaneIdentity = {
  ptyId: string;
  paneId: string;
  surfaceId: string;
  agentName: string | null;
  agentStatus: string | null;
};

/**
 * Resolve the CALLER's own pane ADDRESS from a verified senderPtyId — the
 * reverse of resolvePaneAddress (ptyId → {paneId, surfaceId}). The search is
 * scoped to `leaves` (the caller's own workspace tree), so an absent, forged, or
 * foreign senderPtyId yields null: it never trusts a value outside the given
 * tree. Pure + store-free so the whoami pane-identity path AND the A2A
 * from-pane/role paths (S-C2) share one tested unit. Browser surfaces (no pty)
 * are never a match.
 */
export function resolveSenderPaneAddress(leaves: PaneLeaf[], senderPtyId: string): PaneAddress | null {
  if (!senderPtyId) return null;
  for (const leaf of leaves) {
    const s = leaf.surfaces.find((su) => su.surfaceType !== 'browser' && su.ptyId === senderPtyId);
    if (s) return { ptyId: s.ptyId, paneId: leaf.id, surfaceId: s.id };
  }
  return null;
}

/**
 * Resolve the CALLER's own pane within its workspace tree from a verified
 * senderPtyId, for a2a_whoami's pane-level answer. Builds on
 * resolveSenderPaneAddress (same fail-closed scoping) and enriches it with the
 * per-pane agent label (the ws-level metadata.agentName collapses N agents into
 * one). An absent/forged/foreign senderPtyId yields null → the caller degrades
 * to the ws-level identity (never an error). Read-only: confers no capability.
 * `agentFor` maps a ptyId to its detected agent (a callback so this stays pure /
 * store-free / unit-testable).
 */
export function resolveSelfPaneIdentity(
  leaves: PaneLeaf[],
  agentFor: (ptyId: string) => { name?: string; status?: string } | undefined,
  senderPtyId: string,
): SelfPaneIdentity | null {
  const addr = resolveSenderPaneAddress(leaves, senderPtyId);
  if (!addr) return null;
  const a = agentFor(addr.ptyId);
  return {
    ptyId: addr.ptyId,
    paneId: addr.paneId,
    surfaceId: addr.surfaceId,
    agentName: a?.name ?? null,
    agentStatus: a?.status ?? null,
  };
}

/**
 * Compute the A2A history role of the CALLER from its verified pane address vs
 * the task's stored `from`/`to` pane anchors (S-C2). Comparison is at paneId
 * granularity — one pane = one agent identity — so a reply from a sibling
 * SURFACE of the same pane still resolves correctly; surfaceId is used only for
 * delivery pinning + the self-loop ptyId check, never for role. Returns null
 * when the caller's pane is unknown (callerAddr null — absent/forged senderPtyId
 * or a ws-only task side) or matches neither anchor → the caller falls back to
 * the ws-level role, preserving cross-ws behavior exactly.
 *   - caller pane === `from` pane → 'user'  (the original sender)
 *   - caller pane === `to` pane   → 'agent' (the receiver)
 */
export function resolvePaneRole(
  task: { from: { paneId?: string }; to: { paneId?: string } },
  callerAddr: PaneAddress | null,
): 'user' | 'agent' | null {
  if (!callerAddr) return null;
  if (task.from.paneId && task.from.paneId === callerAddr.paneId) return 'user';
  if (task.to.paneId && task.to.paneId === callerAddr.paneId) return 'agent';
  return null;
}

// ---------------------------------------------------------------------------
// Reply delivery decision (dogfood 2026-08-13 follow-up)
// ---------------------------------------------------------------------------

/** Why a reply's PTY nudge was withheld. Surfaced verbatim in the
 *  `delivery.reason` field of the a2a.task.send response so the SENDING agent
 *  can act on it instead of believing the send reached the other party. */
export type ReplySuppressReason =
  | 'pin_lost'            // pinned target pane no longer exists (fail closed, no active-pane fallback)
  | 'same_ws_no_anchor'   // same-ws task side has no pane anchor → active-pane fallback would risk the #239 self-paste loop
  | 'self_loop'           // pinned target resolves to the caller's own pty
  | 'unverified_sender';  // same-ws + no verified senderPtyId → cannot prove the route is not self

export type ReplyDeliveryDecision =
  | { kind: 'deliver'; sameWs: boolean; explicitPtyId?: string }
  | { kind: 'suppress'; reason: ReplySuppressReason };

/**
 * Decide whether a reply's nudge may be delivered, or why it must be withheld.
 * Extracted verbatim from the reply branch of useRpcBridge (same four guards,
 * same precedence) so the decision is unit-testable and the suppression reason
 * is a value, not a silent skip. The 2026-08-13 dogfood sessions hit these
 * guards blind: the send reported success, the receiver got nothing, and a
 * human ended up relaying every message by hand. The guards are CORRECT
 * (they exist so a same-ws route that can't be proven non-self never pastes
 * into the caller's own prompt) — what was broken was their silence.
 *
 * Precedence (first match wins) only affects the REPORTED reason; any single
 * true guard suppresses, exactly as the original conjunction did.
 */
export function decideReplyDelivery(
  sameWsTask: boolean,
  hasAnchor: boolean,
  pinnedAddressLost: boolean,
  explicitPtyId: string | undefined,
  callerPtyId: string,
): ReplyDeliveryDecision {
  if (pinnedAddressLost) return { kind: 'suppress', reason: 'pin_lost' };
  if (sameWsTask && !hasAnchor) return { kind: 'suppress', reason: 'same_ws_no_anchor' };
  if (!!explicitPtyId && !!callerPtyId && explicitPtyId === callerPtyId) {
    return { kind: 'suppress', reason: 'self_loop' };
  }
  if (sameWsTask && !callerPtyId) return { kind: 'suppress', reason: 'unverified_sender' };
  return { kind: 'deliver', sameWs: sameWsTask, ...(explicitPtyId ? { explicitPtyId } : {}) };
}

/** Per-reason guidance for the SENDING agent, shipped as `delivery.hint`.
 *  Every branch names a concrete next action — an honest failure that offers
 *  no recovery path is just a better-documented dead end. */
export const REPLY_SUPPRESS_HINTS: Record<ReplySuppressReason, string> = {
  pin_lost:
    'The pinned target pane is gone. The reply is stored; the receiver can still poll ' +
    'a2a_task_query. To nudge a live pane, start a new task addressed with pane_id.',
  same_ws_no_anchor:
    'This same-workspace task has no pane anchor on the target side, so a nudge cannot be ' +
    'routed safely. The reply is stored; the receiver must poll a2a_task_query.',
  self_loop:
    'The pinned target resolves to your own pane — no nudge was sent to avoid pasting into ' +
    'your own prompt. The reply is stored for the other party to poll via a2a_task_query.',
  unverified_sender:
    'Your pane identity could not be verified (no senderPtyId reached the server), so a ' +
    'same-workspace nudge cannot be proven non-self and was withheld. The reply is stored; ' +
    'the receiver must poll a2a_task_query.',
};

/**
 * Count completed round trips in a task thread. Definition (fixed here so the
 * cap fires identically everywhere): 1 round trip = one message from EACH side,
 * i.e. `min(#user-role messages, #agent-role messages)`. Consecutive messages
 * from the same side count once toward that side's total, so a double-post
 * cannot inflate the round count, and a thread where only one side has ever
 * spoken is 0 round trips regardless of length.
 */
export function countRoundTrips(history: ReadonlyArray<{ kind: string; role?: string }>): number {
  let user = 0;
  let agent = 0;
  for (const h of history) {
    if (h.kind !== 'message') continue;
    if (h.role === 'user') user++;
    else if (h.role === 'agent') agent++;
  }
  return Math.min(user, agent);
}

/**
 * The larger of the two per-side message counts. Companion ceiling to
 * `countRoundTrips`: min() alone never trips on a MONOLOGUE — an agent
 * re-replying to a thread the other side ignores stays at 0 round trips
 * forever while nudging the receiver on every message (review finding). The
 * reply path refuses once one side exceeds `REPLY_ROUND_CAP * 2` messages,
 * so a one-sided runaway is bounded even though it never completes a round.
 */
export function maxSideMessages(history: ReadonlyArray<{ kind: string; role?: string }>): number {
  let user = 0;
  let agent = 0;
  for (const h of history) {
    if (h.kind !== 'message') continue;
    if (h.role === 'user') user++;
    else if (h.role === 'agent') agent++;
  }
  return Math.max(user, agent);
}

/** Reply round-trip ceiling per thread. When `countRoundTrips` reaches this,
 *  further replies are REFUSED (a2a.task.send returns an error) instead of
 *  silently looping — two agents left alone will politely ping-pong without
 *  converging, and no state-machine transition can stop them (the reply path
 *  never consults task status). A refusal is visible to the sending agent AND
 *  costs nothing to honor: continue by having the human open a fresh task
 *  that references this one. */
export const REPLY_ROUND_CAP = 5;
