// Pure pane-address resolution for A2A delivery (Part A). Extracted from
// useRpcBridge so it can be unit-tested directly (useRpcBridge itself pulls in
// the store/window and can't be imported under vitest). No React/window deps —
// operates only on the pane-leaf list the caller passes in.

import type { PaneLeaf } from '../../shared/types';
import { getLeafPanes } from '../../shared/paneUtils';
import { isBrainPtyId } from '../../shared/constants';
import type { AgentSlug } from '../../shared/agentIdentity';
import { resolveAgentSlug, submitProfileForAgent, type SubmitAssurance } from '../../shared/ptyMessageDelivery';

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
  | 'target_is_brain'     // the pinned target IS an orchestrator brain — it has no pane to paste into
  | 'same_ws_no_anchor'   // same-ws task side has no pane anchor → active-pane fallback would risk the #239 self-paste loop
  | 'self_loop'           // pinned target resolves to the caller's own pty
  | 'unverified_sender';  // same-ws + no verified senderPtyId → cannot prove the route is not self

/**
 * What the SERVER knows about the caller, beyond its pane identity.
 *
 * `commanderWorkspaceId` is the workspace MAIN stamped onto the request from a
 * VALIDATED commander per-spawn token (`confineWorkspaceId` in useRpcBridge) —
 * never caller-supplied, so it cannot be forged into existence. Empty/absent
 * for every ordinary caller, which is why every check below is `commander && …`.
 */
export interface ReplyCallerIdentity {
  commanderWorkspaceId?: string;
  /** The workspace the request itself is acting as. A commander binding only
   *  relaxes guards for ITS OWN workspace — see `decideReplyDelivery`. */
  callerWorkspaceId?: string;
}

/**
 * Is this caller a commander acting inside the workspace its token is bound to?
 *
 * The equality is the whole check. A token bound to workspace A says nothing
 * about workspace B, so treating "a commander token exists" as "this caller is
 * privileged here" would let one brain relax another workspace's guards. Main
 * pins both fields from the validated binding, so they agree exactly when the
 * commander is operating at home.
 */
export function isCommanderForWorkspace(caller: ReplyCallerIdentity): boolean {
  return (
    !!caller.commanderWorkspaceId && caller.commanderWorkspaceId === caller.callerWorkspaceId
  );
}

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
 *
 * The BRAIN exception (orchestrator track, 2026-09-04). `unverified_sender`
 * exists so a same-workspace route that cannot be proven non-self is never
 * pasted into the caller's own prompt, and it identifies "provable" with "the
 * caller owns a pane". An orchestrator brain owns none —
 * `isTerminalPtyInLeaves` rejects its pty, so `callerPtyId` arrives empty —
 * which meant every brain→worker reply inside its own workspace was suppressed
 * as unverified, and the brain was told its message was stored while the worker
 * sat waiting. A caller with no pane is precisely a caller a delivery cannot
 * loop back into, and MAIN has already validated the commander binding it
 * carries, so that ONE guard is satisfied rather than tripped.
 *
 * Exactly one guard, and only for the commander's OWN workspace:
 *
 *   - `same_ws_no_anchor` still suppresses, brain or not. With no pane anchor
 *     the delivery helpers fall back to the target workspace's ACTIVE pane —
 *     the #239 path — so relaxing it would hand an anchorless reply to
 *     whichever pane happens to be focused. A brain that wants a worker nudged
 *     addresses it (pane_id / surface_id), and then this guard never applies.
 *   - `self_loop` compares concrete pty ids, so it still protects every pane
 *     caller; a brain (empty callerPtyId) could never trip it anyway.
 *   - the binding must name the CALLER'S OWN workspace (see
 *     `isCommanderForWorkspace`) — a token bound to A must not relax B.
 */
export function decideReplyDelivery(
  sameWsTask: boolean,
  hasAnchor: boolean,
  pinnedAddressLost: boolean,
  explicitPtyId: string | undefined,
  callerPtyId: string,
  caller: ReplyCallerIdentity = {},
): ReplyDeliveryDecision {
  const commanderVerified = isCommanderForWorkspace(caller);
  if (pinnedAddressLost) return { kind: 'suppress', reason: 'pin_lost' };
  // Belt and braces. A brain pty cannot normally reach here — brains are not in
  // the workspace pane tree, so `resolvePaneAddress` reports a lost pin long
  // before this — but an anchor that ever did resolve to one would name a pane
  // that does not exist, and that is not something to discover by writing to it.
  if (isBrainPtyId(explicitPtyId)) return { kind: 'suppress', reason: 'target_is_brain' };
  if (sameWsTask && !hasAnchor) return { kind: 'suppress', reason: 'same_ws_no_anchor' };
  if (!!explicitPtyId && !!callerPtyId && explicitPtyId === callerPtyId) {
    return { kind: 'suppress', reason: 'self_loop' };
  }
  if (sameWsTask && !callerPtyId && !commanderVerified) {
    return { kind: 'suppress', reason: 'unverified_sender' };
  }
  return { kind: 'deliver', sameWs: sameWsTask, ...(explicitPtyId ? { explicitPtyId } : {}) };
}

/** Per-reason guidance for the SENDING agent, shipped as `delivery.hint`.
 *  Every branch names a concrete next action — an honest failure that offers
 *  no recovery path is just a better-documented dead end. */
export const REPLY_SUPPRESS_HINTS: Record<ReplySuppressReason, string> = {
  pin_lost:
    'The pinned target pane is gone. The reply is stored; the receiver can still poll ' +
    'a2a_task_query. To nudge a live pane, start a new task addressed with pane_id.',
  target_is_brain:
    'The pinned target is an orchestrator brain, which has no pane to write into. The reply ' +
    'is stored; address a worker pane (pane_id / surface_id) if you meant to nudge one.',
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

// ---------------------------------------------------------------------------
// Delivery receipt honesty (#1337)
// ---------------------------------------------------------------------------
//
// `notified: true` has only ever meant "a pane with a live pty was resolved and
// written to". It has never meant "the receiving agent started a turn": the
// paste write's result is discarded, the Enter that submits it goes out on a
// timer AFTER the RPC has already answered, and no signal comes back from the
// composer either way.
//
// For a Claude Code pane that gap is small enough to ignore: a CR into its
// composer submits. For a Codex CLI pane it is the whole bug in #1337 — the
// nudge landed in the composer, the agent never woke, and the sender got the
// same receipt a woken agent produces, so it waited on a turn that was never
// going to start.
//
// So the receipt now carries what wmux actually proved. `notified` keeps its
// meaning (a push signal WAS written — no existing consumer breaks) and
// `submit` says whether the Enter can be claimed as a real submit.
//
//   submit: 'assured'      a Claude Code pane that is not sitting on a dialog.
//   submit: 'unverified'   everyone else: Codex, any other agent, a pane whose
//                          agent could not be named, and a Claude pane at
//                          `awaiting_input` (there the CR answers the dialog
//                          rather than starting a turn). The bytes went out;
//                          what the composer did with them is not observable.

/** Guidance shipped alongside `submit: 'unverified'`. Names the concrete next
 *  action, like every other `delivery.hint` on this path. */
export const UNVERIFIED_SUBMIT_HINT =
  'The nudge was written into the target pane, but wmux cannot confirm that agent submitted ' +
  'it (only an idle Claude Code pane reports turn start). Do not block on a turn starting: the ' +
  'task is stored, the receiver can poll a2a_task_query, and a human may need to press Enter in ' +
  'that pane.';

/**
 * The `submit` / `hint` half of a successful `delivery` record, for a write
 * that actually reached a pty. Takes the agent of THAT pty (see `ptyAgent` in
 * useRpcBridge) rather than the caller's liveness metadata, which can name a
 * workspace-level agent that does not own the pane the bytes went to.
 *
 * Split out of useRpcBridge so it is unit testable and so both send branches
 * cannot drift apart.
 */
export function submitReceiptFields(
  pane: { name?: string; status?: string },
): { submit: SubmitAssurance; hint?: string } {
  const { assurance } = submitProfileForAgent(pane.name, pane.status);
  return assurance === 'assured'
    ? { submit: assurance }
    : { submit: assurance, hint: UNVERIFIED_SUBMIT_HINT };
}

// ---------------------------------------------------------------------------
// Unaddressed delivery target (#1336)
// ---------------------------------------------------------------------------
//
// A send with no pane_id/surface_id used to fall straight through to
// `activePaneTerminalPty` — "whatever pane is active". In a workspace running
// an agent next to a plain shell that is not merely the wrong tab: the body is
// bracket-pasted AND submitted, so a natural-language task is handed to a shell
// prompt, which runs it line by line as commands. The reporter's PowerShell
// only threw a parser error, but the mechanism is "arbitrary text executed as
// shell input in the wrong place".
//
// So an unaddressed send resolves against the DETECTED AGENTS instead:
//   - exactly one agent pane  → deliver there, wherever focus happens to be
//   - more than one           → refuse, and name the candidates (the caller
//                               picks one; a2a_discover carries the same list)
//   - none                    → 'no_agent'; the caller writes NOTHING to that
//                               workspace (see the no-paste rule below)
// An explicit pane_id/surface_id is unaffected — it never reaches this.
//
// Why 'no_agent' means "write nothing" rather than "paste without Enter":
// a body left sitting in a shell's input buffer is the same hazard deferred,
// not removed — the next Enter a human presses in that pane (or the one after
// several parked messages have piled up) runs exactly the natural-language
// text this change exists to keep out of a shell. And "no Enter" is not even
// a guarantee: a shell that does not enable bracketed-paste mode executes
// embedded newlines as they arrive. The task is still stored and teed onto the
// EventBus, so nothing is lost — only the blind write is.

/** Candidate scan input. `agentAlive`/`commandRunning` are the process-truth
 *  maps (#1210): `false` means the TUI is known GONE, and the detected-agent
 *  entry that has not been cleared yet is stale. Without this a pane whose
 *  agent exited seconds ago is picked as "the one agent pane" and handed a
 *  submitted body — #1336 again, now with the focus safety net removed. */
export type PaneLivenessMaps = {
  agentAlive?: Record<string, boolean>;
  commandRunning?: Record<string, boolean>;
};

/**
 * The canonical agent slug of the TUI running in `ptyId`, or undefined when
 * the pane is not a detected, still-live agent. Decides whether an A2A
 * envelope may keep its body's real newlines (see `A2aFormatOptions`).
 *
 * Only a known slug counts: DECSET 2004 (bracketed paste) is NOT a signal,
 * because shells turn it on too, and a shell runs each pasted line as its own
 * command once the paste is submitted. A brain pty is not a TUI at all.
 *
 * Liveness must be POSITIVELY confirmed. A surfaceAgent entry outlives its
 * agent until a liveness snapshot clears it (#1210), and both maps are often
 * empty (no process attribution, no shell integration), so "not known gone"
 * would hand a multi-line body to a shell that just got its prompt back. The
 * entry's status is not used either: it is as stale as the entry. Unknown
 * means fold.
 */
export function detectedAgentTuiSlug(
  ptyId: string,
  surfaceAgent: Record<string, { name: string; slug?: string } | undefined>,
  liveness: PaneLivenessMaps = {},
): AgentSlug | undefined {
  if (!ptyId || isBrainPtyId(ptyId)) return undefined;
  const alive = liveness.agentAlive?.[ptyId];
  const running = liveness.commandRunning?.[ptyId];
  if (alive === false || running === false) return undefined;
  if (alive !== true && running !== true) return undefined;
  const agent = surfaceAgent[ptyId];
  if (!agent) return undefined;
  return resolveAgentSlug(agent.slug) ?? resolveAgentSlug(agent.name);
}

export type AgentPaneCandidate = {
  paneId: string;
  surfaceId: string;
  ptyId: string;
  agentName: string;
  paneTitle: string | null;
};

export type UnaddressedDelivery =
  /** Exactly one detected agent pane — deliver (and submit) there. */
  | { kind: 'agent'; address: PaneAddress }
  /** Several agent panes and no address: the caller must choose. */
  | { kind: 'ambiguous'; candidates: AgentPaneCandidate[] }
  /** No detected agent: nothing may be written to this workspace's panes. */
  | { kind: 'no_agent' };

/**
 * @param visibleLeaves the target's VISIBLE pane tree (getLeafPanes(rootPane)),
 * never the workspace-wide list. A stashed pane is off-screen: counting it
 * would turn a workspace with one visible agent into an ambiguous refusal, and
 * picking it would deliver where nobody is looking.
 */
export function resolveUnaddressedDelivery(
  visibleLeaves: PaneLeaf[],
  surfaceAgent: Record<string, { name: string; status: string } | undefined>,
  liveness: PaneLivenessMaps = {},
): UnaddressedDelivery {
  const candidates: AgentPaneCandidate[] = [];
  for (const leaf of visibleLeaves) {
    for (const s of leaf.surfaces) {
      if (s.surfaceType === 'browser' || !s.ptyId) continue;
      // A brain pty is not a pane a human or agent can be addressed at; see the
      // same guard in decideReplyDelivery.
      if (isBrainPtyId(s.ptyId)) continue;
      const agentName = surfaceAgent[s.ptyId]?.name;
      if (!agentName) continue;
      if (liveness.agentAlive?.[s.ptyId] === false) continue;
      if (liveness.commandRunning?.[s.ptyId] === false) continue;
      candidates.push({
        paneId: leaf.id,
        surfaceId: s.id,
        ptyId: s.ptyId,
        agentName,
        // Same source as a2a_discover's `paneTitle` (#1018) — untrusted
        // pane-chosen text; sanitized at render time, see describeAmbiguousDelivery.
        paneTitle: s.title?.trim() || null,
      });
    }
  }
  if (candidates.length === 1) {
    const c = candidates[0];
    return { kind: 'agent', address: { ptyId: c.ptyId, paneId: c.paneId, surfaceId: c.surfaceId } };
  }
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return { kind: 'no_agent' };
}

/** Candidates named in a refusal before it is summarized. A workspace can hold
 *  far more agent panes than a caller can act on, and every name in the list is
 *  pane-chosen text arriving in the CALLER's context. */
const AMBIGUOUS_LIST_CAP = 8;
const PANE_TITLE_CAP = 40;

/** Pane-chosen text, made safe to hand back to the calling agent: control
 *  characters (newlines included, which could forge a new instruction line) are
 *  dropped and the rest is truncated. Same defensive posture as the nudge's
 *  sanitizeA2aName — the title is DATA, and a long one must not be able to
 *  inflate an error payload either. */
function sanitizePaneTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > PANE_TITLE_CAP ? `${flat.slice(0, PANE_TITLE_CAP - 1)}…` : flat;
}

/** Refusal text for an unaddressed send into a multi-agent workspace. Names
 *  the candidates so the caller can re-send addressed without a round trip
 *  through a2a_discover. When one pane holds two agent surfaces, pane_id alone
 *  cannot separate them, so those candidates are named by surface_id too. */
export function describeAmbiguousDelivery(
  targetName: string,
  candidates: ReadonlyArray<AgentPaneCandidate>,
): string {
  // The workspace name is user-set and neither normalized nor capped at its
  // source, so it gets the same treatment as the pane-chosen text below.
  const target = sanitizePaneTitle(targetName);
  const paneCounts = new Map<string, number>();
  for (const c of candidates) paneCounts.set(c.paneId, (paneCounts.get(c.paneId) ?? 0) + 1);
  const shown = candidates.slice(0, AMBIGUOUS_LIST_CAP);
  const list = shown
    .map((c) => {
      const title = c.paneTitle ? ` — "${sanitizePaneTitle(c.paneTitle)}"` : '';
      // Two agent surfaces in one pane: pane_id would resolve to whichever is
      // that pane's active surface, i.e. a coin flip between two agents.
      const addr = (paneCounts.get(c.paneId) ?? 0) > 1
        ? `pane_id=${c.paneId} surface_id=${c.surfaceId}`
        : `pane_id=${c.paneId}`;
      return `${addr} (${sanitizePaneTitle(c.agentName)}${title})`;
    })
    .join(', ');
  const more = candidates.length > shown.length
    ? ` (+${candidates.length - shown.length} more — call a2a_discover for the full list)`
    : '';
  return (
    `target "${target}" runs ${candidates.length} agent panes and no pane_id/surface_id was given. ` +
    `Re-send addressing one of: ${list}${more}. (Delivering to whichever pane is focused could paste the ` +
    'message into the wrong agent — or into a plain shell, which would run it as commands.)'
  );
}

/**
 * May workspace-level agent metadata stand in for a failed per-pane resolution?
 *
 * Only when there is exactly ONE terminal pane to write to. That is the case
 * the ws-metadata fallback exists for — detection has not landed per pane (or
 * the pane is remote), and "the active pane" and "the pane the metadata
 * describes" are necessarily the same pane. With two or more panes they are
 * not, and "workspace metadata says an agent lives here somewhere" is no
 * evidence at all about the pane that happens to be focused: that is how a
 * plain shell gets written to, which is the whole of #1336.
 */
export function wsMetadataMayStandIn(visibleLeaves: PaneLeaf[]): boolean {
  let terminals = 0;
  for (const leaf of visibleLeaves) {
    for (const s of leaf.surfaces) {
      if (s.surfaceType === 'browser' || !s.ptyId) continue;
      if (isBrainPtyId(s.ptyId)) continue;
      terminals++;
      if (terminals > 1) return false;
    }
  }
  return terminals === 1;
}

/** `delivery.hint` for a target whose visible panes carry no detected agent. */
export const NO_AGENT_PANE_HINT =
  'Nothing was written to the target: none of its visible panes is running a detected agent, and pasting a ' +
  'message body into a plain shell prompt is how it ends up executed as commands. The task is stored and on ' +
  'the event bus — the receiver can still find it with a2a_task_query. If an agent IS running there, ' +
  'detection may not have landed yet (or the pane is stashed): address it explicitly with pane_id/surface_id ' +
  'from a2a_discover, or re-send once it is detected.';
