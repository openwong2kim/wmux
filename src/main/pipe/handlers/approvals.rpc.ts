// ─── approval.press — the brain's way to answer a worker's prompt ───────────
//
// Before this, a brain that saw a worker waiting on an approval had exactly one
// move: `terminal_send` the literal text `1`. That is not an approval — it is a
// keystroke aimed at whatever happens to be on that screen. Nothing checked that
// a prompt was still there, nothing recorded a decision, nothing consulted the
// press scope (#1199/#1201's `decideApprovalPress` governed only
// `daemon.approvals.resolve` callers, which a brain was not), and the same three
// bytes typed a second later land in the composer of an agent that has already
// moved on.
//
// So the press goes through the machinery that already exists for the phone:
// the daemon's ApprovalRegistry. It does the CAS, re-reads the pane to confirm
// the prompt is still on screen, sends the keystroke the RECORD specifies (never
// caller-supplied text), and writes the decision into history.
//
// WHAT THIS HANDLER ADDS, and it is deliberately little:
//   - target resolution: a brain knows a pane (`ptyId`), not an approval id;
//   - the AUTOMATED declaration. Main is a first-party pipe client, so the
//     daemon would otherwise classify this press as 'human' and skip the press
//     scope entirely — the scope would then govern nothing, because no other
//     caller class reaches that RPC. See approvals/resolveRequest.ts.
//
// AUTHORIZATION IS THE PRESS SCOPE, NOT PANE OWNERSHIP. A brain pressing its
// worker is BY DEFINITION reaching into another workspace, so an ownership
// assert would refuse the only call this exists for. What decides is the
// daemon's `decideApprovalPress`: a delegated task workspace, its effective
// `approvalPress` capability on, a hook-sourced record, and the prompt still on
// screen. A refusal comes back with its reason so the caller can act on it
// rather than guess (see the deadlock note in input.rpc.ts).

import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { DaemonClient } from '../../DaemonClient';

/** The daemon's approval list, narrowed to what target resolution needs. */
export interface PendingApproval {
  id: string;
  sessionId: string;
  kind?: string;
  createdAt?: number;
  question?: string;
  toolName?: string;
}

/**
 * Pick the approval a `ptyId` press means: the NEWEST pending record on that
 * pane. A pane can hold one screen-backed prompt and several permission gates
 * at once (gates never supersede each other), and the newest is the one whose
 * prompt is actually rendered.
 */
export function pickPendingForPty(
  pending: readonly PendingApproval[],
  ptyId: string,
): PendingApproval | null {
  const mine = pending.filter((r) => r.sessionId === ptyId);
  if (mine.length === 0) return null;
  return mine.reduce((newest, r) => ((r.createdAt ?? 0) >= (newest.createdAt ?? 0) ? r : newest));
}

/** Params a press accepts, after validation. */
export interface PressTarget {
  approvalId?: string;
  ptyId?: string;
  decision: 'approve' | 'deny';
  choiceKey?: string;
}

/**
 * Validate the wire params. A press that cannot name its target, or that names
 * a decision this surface does not have, is refused rather than defaulted —
 * guessing between approve and deny is not a recoverable mistake.
 */
export function parsePressParams(params: Record<string, unknown>): PressTarget | { error: string } {
  const approvalId = typeof params['approvalId'] === 'string' ? params['approvalId'].trim() : '';
  const ptyId = typeof params['ptyId'] === 'string' ? params['ptyId'].trim() : '';
  if (!approvalId && !ptyId) {
    return { error: 'approval.press requires an approvalId or a ptyId' };
  }
  const rawDecision = params['decision'];
  if (rawDecision !== undefined && rawDecision !== 'approve' && rawDecision !== 'deny') {
    return { error: 'approval.press: decision must be "approve" or "deny"' };
  }
  const decision: 'approve' | 'deny' = rawDecision === 'deny' ? 'deny' : 'approve';
  const rawChoice = params['choiceKey'];
  if (rawChoice !== undefined) {
    if (decision !== 'approve' || typeof rawChoice !== 'string' || !/^\d{1,2}$/.test(rawChoice)) {
      return { error: 'approval.press: choiceKey must be a 1-2 digit option key on an approve' };
    }
  }
  return {
    ...(approvalId ? { approvalId } : {}),
    ...(ptyId ? { ptyId } : {}),
    decision,
    ...(typeof rawChoice === 'string' ? { choiceKey: rawChoice } : {}),
  };
}

/**
 * Hints for the refusals a caller can actually do something about. A brain that
 * is told `press-capability-off` and nothing else will retry the same call.
 */
export const PRESS_REFUSAL_HINTS: Readonly<Record<string, string>> = {
  'not-a-task-workspace':
    'this pane is not a delegated fan-out worker — a human owns it, so ask them with deck_ask_decision',
  'autonomy-off':
    "this worker's workspace has autonomy off; the operator has to turn it on before a press can land",
  'press-capability-off':
    'approval-press is off for this worker (its owner runs in assist, or a loop narrowed the capability) — raise it with deck_ask_decision',
  'detector-only':
    'this prompt was only guessed at from the screen, not reported by a hook, so it will not be pressed',
  'prompt-gone': 'the prompt is no longer on screen — read the pane again before deciding',
  'scope-unavailable':
    'the daemon has no workspace facts to judge this pane by; the desktop app may have just started',
};

// ─── The deadlock guard ─────────────────────────────────────────────────────
//
// `terminal_send` is blocked on a pane holding an approval record, because
// typing at an approval prompt is the thing this tool replaces. But a block
// plus a press that POLICY refuses is a brain with no move at all: it cannot
// press, it cannot type, and it will burn its turn retrying.
//
// So a press refused for a POLICY reason lifts the block on that pane. The
// brain gets the refusal reason back from `approval.press`, and its next
// `terminal_send` goes through to the old typed path — worse, but not stuck.
// The lift is logged, is per-pane, and expires, so the block is the default
// state and fail-open is the exception that had to be earned.
//
// TRANSIENT refusals do NOT lift: `prompt-gone` and `not-found` mean the press
// was right and the world moved, and typing into a pane whose prompt just
// vanished is exactly the misfire the block exists for.

/** Policy refusals — the operator has decided, and no retry changes it. */
export const PRESS_DEADLOCK_REASONS: ReadonlySet<string> = new Set([
  'not-a-task-workspace',
  'autonomy-off',
  'press-capability-off',
  'workspace-unknown',
  'scope-unavailable',
  'detector-only',
]);

/**
 * How long a lift lasts. Long enough to cover the brain's next turn (it may
 * have to read the screen and think), short enough that the pane is protected
 * again well before it is reused for another task.
 */
export const PRESS_BLOCK_LIFT_MS = 10 * 60_000;

const pressBlockLifts = new Map<string, { until: number; reason: string }>();

/** Record that this pane's press was refused by policy, so typing is allowed. */
export function liftPressBlock(ptyId: string, reason: string, now = Date.now()): void {
  if (!ptyId) return;
  pressBlockLifts.set(ptyId, { until: now + PRESS_BLOCK_LIFT_MS, reason });
  console.warn(
    `[approval.press] press refused (${reason}) on pane ${ptyId} — ` +
      'lifting the terminal_send approval block for it so the brain is not deadlocked',
  );
}

/** The live lift for a pane, or null. Expired entries are dropped on read. */
export function pressBlockLift(ptyId: string, now = Date.now()): { reason: string } | null {
  const entry = pressBlockLifts.get(ptyId);
  if (!entry) return null;
  if (entry.until <= now) {
    pressBlockLifts.delete(ptyId);
    return null;
  }
  return { reason: entry.reason };
}

/** Test-only: the lift map is module state shared by two handlers. */
export function clearPressBlockLifts(): void {
  pressBlockLifts.clear();
}

/**
 * The pending approval a `terminal_send` to this pane would be typing over, or
 * null.
 *
 * Every "cannot tell" answer is null — no daemon, a list that threw, no record.
 * wmux only holds a record for a prompt a HOOK reported, so a worker whose
 * hooks are not installed has none and must keep its typed path; and a guard
 * that refused writes because it could not reach the daemon would break every
 * ordinary send the moment the daemon hiccuped.
 */
export async function pendingApprovalOnPane(
  getDaemonClient: (() => DaemonClient | null) | undefined,
  ptyId: string,
): Promise<PendingApproval | null> {
  const dc = getDaemonClient?.();
  if (!dc?.isConnected) return null;
  try {
    const listed = (await dc.rpc('daemon.approvals.list', {})) as
      | { pending?: PendingApproval[] }
      | undefined;
    return pickPendingForPty(listed?.pending ?? [], ptyId);
  } catch {
    return null;
  }
}

/** The refusal a blocked `terminal_send` gets. Names the tool that replaces it. */
export function approvalBlockMessage(op: string, ptyId: string, record: PendingApproval): string {
  const what = record.toolName
    ? `a ${record.toolName} permission gate`
    : record.question
      ? `a question ("${record.question.slice(0, 80)}")`
      : 'an approval prompt';
  return (
    `${op}: pane "${ptyId}" is waiting on ${what} — refusing to type at an approval prompt. ` +
    `Answer it with approval_press({ ptyId: "${ptyId}", decision: "approve" | "deny" }), which ` +
    'resolves the approval record and presses the option that record specifies. ' +
    'If the press comes back refused, this block lifts and you may type again.'
  );
}

export function registerApprovalsRpc(
  router: RpcRouter,
  getDaemonClient: () => DaemonClient | null,
): void {
  router.register('approval.press', async (params, ctx?: RpcContext) => {
    const parsed = parsePressParams(params);
    if ('error' in parsed) throw new Error(parsed.error);

    const dc = getDaemonClient();
    if (!dc?.isConnected) {
      throw new Error('approval.press: daemon not connected — no approval records exist to press');
    }

    // Resolve the target FIRST, so a caller that named a pane learns "nothing is
    // pending there" instead of a generic not-found from the registry.
    let approvalId = parsed.approvalId;
    // The pane the press lands on — known up front when the caller named one,
    // otherwise learned from the record. Needed for the deadlock lift below.
    let targetPtyId = parsed.ptyId ?? '';
    if (!approvalId) {
      const listed = (await dc.rpc('daemon.approvals.list', {})) as
        | { pending?: PendingApproval[] }
        | undefined;
      const record = pickPendingForPty(listed?.pending ?? [], targetPtyId);
      if (!record) {
        return {
          ok: false,
          reason: 'not-found',
          ptyId: parsed.ptyId,
          note:
            'no approval is pending on that pane. wmux only records prompts a hook reported, ' +
            'so a pane that is merely waiting on something is not pressable — read its screen.',
        };
      }
      approvalId = record.id;
    }

    // The commander token's bound workspace is the authoritative caller id; the
    // `workspaceId` param is only what the caller typed.
    const callerWs =
      ctx?.commanderWorkspace ??
      (typeof params['workspaceId'] === 'string' ? params['workspaceId'] : '');
    const result = (await dc.rpc('daemon.approvals.resolve', {
      id: approvalId,
      decision: parsed.decision,
      resolvedBy: callerWs ? `brain:${callerWs}` : 'brain',
      // The whole point of this handler — see the header.
      resolver: 'automated',
      ...(parsed.choiceKey ? { choiceKey: parsed.choiceKey } : {}),
    })) as { ok?: boolean; reason?: string; durable?: boolean } | undefined;

    if (result?.ok) {
      return {
        ok: true,
        approvalId,
        decision: parsed.decision,
        ...(parsed.ptyId ? { ptyId: parsed.ptyId } : {}),
        ...(parsed.choiceKey ? { choiceKey: parsed.choiceKey } : {}),
        // false = the keystroke landed but the record of it did not reach disk.
        durable: result.durable !== false,
      };
    }
    const reason = result?.reason ?? 'not-found';

    // The deadlock guard. A press the OPERATOR'S POLICY refused leaves the brain
    // with no move while terminal_send is blocked on the same pane, so the block
    // is lifted for it. Transient refusals do not lift — see the header above.
    if (PRESS_DEADLOCK_REASONS.has(reason)) {
      if (!targetPtyId) {
        // Pressed by approvalId, so we never learned the pane. One extra list on
        // the refusal path only, so the lift is not silently skipped.
        const listed = (await dc
          .rpc('daemon.approvals.list', {})
          .catch(() => undefined)) as { pending?: PendingApproval[] } | undefined;
        targetPtyId = listed?.pending?.find((r) => r.id === approvalId)?.sessionId ?? '';
      }
      liftPressBlock(targetPtyId, reason);
    }

    return {
      ok: false,
      reason,
      approvalId,
      ...(targetPtyId ? { ptyId: targetPtyId } : {}),
      ...(PRESS_REFUSAL_HINTS[reason] ? { note: PRESS_REFUSAL_HINTS[reason] } : {}),
      ...(PRESS_DEADLOCK_REASONS.has(reason)
        ? {
            typedFallback:
              'the approval block on this pane is lifted — you may terminal_send at it, ' +
              'or raise the decision with deck_ask_decision instead',
          }
        : {}),
    };
  });
}
