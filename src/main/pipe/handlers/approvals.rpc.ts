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
// AUTHORIZATION IS TWO CHECKS, and neither is pane ownership in the ordinary
// sense — a brain pressing its worker is BY DEFINITION reaching into another
// workspace, so the usual `assertWorkspaceOwnsPty` would refuse the only call
// this exists for. Instead:
//
//   1. DELEGATION, checked here. The caller must hold a validated commander
//      token (`ctx.commanderWorkspace`), and the pane's workspace must be a
//      task workspace the TASK LEDGER says that caller owns. Without this, one
//      brain could press another brain's workers: the daemon's scope only asks
//      "is this pane SOMEBODY's delegated task workspace", never whose.
//   2. POLICY, checked by the daemon's `decideApprovalPress`: autonomy on, the
//      effective `approvalPress` capability on, a hook-sourced record, and the
//      prompt still on screen.
//
// A refusal comes back with its reason so the caller can act on it rather than
// guess (see the deadlock note below).

import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { DaemonClient } from '../../DaemonClient';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';

/** The daemon's approval list, narrowed to what target resolution needs. */
export interface PendingApproval {
  id: string;
  sessionId: string;
  /** The pane's workspace, from the hook envelope. Absent = unclassifiable. */
  workspaceId?: string;
  kind?: string;
  createdAt?: number;
  question?: string;
  toolName?: string;
}

/**
 * The newest pending record on a pane, or null.
 *
 * Used by the `terminal_send` BLOCK, where "newest" is good enough on purpose:
 * the block's question is "is this pane waiting on anything at all", and the
 * record it picks only supplies the wording of the refusal.
 *
 * The PRESS does not use this — see `pickPressTarget`, which refuses to guess.
 */
export function pickPendingForPty(
  pending: readonly PendingApproval[],
  ptyId: string,
): PendingApproval | null {
  const mine = pending.filter((r) => r.sessionId === ptyId);
  if (mine.length === 0) return null;
  return mine.reduce((newest, r) => ((r.createdAt ?? 0) >= (newest.createdAt ?? 0) ? r : newest));
}

/** What a `ptyId` press resolved to, or why it could not. */
export type PressTargetPick =
  | { record: PendingApproval }
  | { error: 'not-found' }
  | { error: 'ambiguous'; approvalIds: string[] };

/**
 * The approval a `ptyId` press means — and a refusal when the pane holds more
 * than one.
 *
 * A pane really can hold several pending records at once: one screen-backed
 * prompt plus a permission gate per gated tool the turn called, and gates never
 * supersede each other. Picking the newest looked harmless and is not — the
 * newest record is not reliably the prompt on screen (a gate is created when
 * the tool is CALLED, and the agent may have several in flight), so a press
 * aimed at one of them silently answers another. Approving the wrong tool call
 * is not a recoverable mistake, so the caller is made to name the `approvalId`
 * it means. The ids come back in the refusal so it can.
 */
export function pickPressTarget(
  pending: readonly PendingApproval[],
  ptyId: string,
): PressTargetPick {
  const mine = pending.filter((r) => r.sessionId === ptyId);
  if (mine.length === 0) return { error: 'not-found' };
  if (mine.length > 1) return { error: 'ambiguous', approvalIds: mine.map((r) => r.id) };
  return { record: mine[0] as PendingApproval };
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
 *
 * `decision` is REQUIRED, and an omitted one is an error rather than an
 * approve. A default of 'approve' meant the least specified call this tool
 * accepts — a model that emitted `{ptyId}` and nothing else, or dropped the
 * field mid-generation — was the one that granted a permission, and it granted
 * it silently. Denying is the recoverable direction; approving is not. The
 * daemon's own `parseApprovalResolveRequest` has refused an unnamed decision
 * from the start, for the same reason.
 */
export function parsePressParams(params: Record<string, unknown>): PressTarget | { error: string } {
  const approvalId = typeof params['approvalId'] === 'string' ? params['approvalId'].trim() : '';
  const ptyId = typeof params['ptyId'] === 'string' ? params['ptyId'].trim() : '';
  if (!approvalId && !ptyId) {
    return { error: 'approval.press requires an approvalId or a ptyId' };
  }
  const rawDecision = params['decision'];
  if (rawDecision !== 'approve' && rawDecision !== 'deny') {
    return {
      error:
        'approval.press: decision is required and must be "approve" or "deny" — ' +
        'an unnamed decision is never taken as an approval',
    };
  }
  const decision: 'approve' | 'deny' = rawDecision;
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
//
// NEITHER DO REFUSALS THAT MEAN "THIS IS NOT YOUR WORKER" OR "WE DO NOT KNOW".
// The first draft lifted on `not-a-task-workspace`, `workspace-unknown`,
// `scope-unavailable` and `detector-only` too, which inverted the guard: those
// are exactly the panes a brain must not be typing digits into — a HUMAN's
// pane, a pane the daemon cannot classify, a daemon with no fact table yet, and
// a prompt nobody's hook ever reported. "The press was refused" would have been
// enough to open the typed path on any of them, and the easiest of the four to
// produce is a main process that has not published its table yet, i.e. the
// first seconds after a restart.
//
// So the lift needs BOTH halves and gets neither for free:
//   - the pane is a task workspace THIS caller owns (checked in the handler,
//     before the press is even attempted — an unowned pane is refused outright
//     and never reaches this set), and
//   - the refusal is one of the two the operator can actually resolve.

/** Policy refusals — the operator has decided, and no retry changes it. */
export const PRESS_DEADLOCK_REASONS: ReadonlySet<string> = new Set([
  'autonomy-off',
  'press-capability-off',
]);

/**
 * How long a lift lasts. Long enough to cover the brain's next turn (it may
 * have to read the screen and think), short enough that the pane is protected
 * again well before it is reused for another task.
 */
export const PRESS_BLOCK_LIFT_MS = 10 * 60_000;

const pressBlockLifts = new Map<string, { until: number; reason: string }>();

/**
 * Hard ceiling on the map. Reached only by something pathological (a brain
 * looping presses across thousands of dead panes); past it the oldest entries
 * go, because a lift is a temporary exception and losing one only restores the
 * default — the block.
 */
export const PRESS_BLOCK_LIFT_MAX = 256;

/** Record that this pane's press was refused by policy, so typing is allowed. */
export function liftPressBlock(ptyId: string, reason: string, now = Date.now()): void {
  if (!ptyId) return;
  // Sweep on write. `pressBlockLift` only ever drops the entry it was asked
  // about, so a pane that is pressed once and then closed left its lift in the
  // map for the life of the process — this map is module state in a desktop app
  // that runs for days. Insertion order is Map order, so the oldest-first slice
  // below is the eviction the ceiling wants.
  for (const [pty, entry] of pressBlockLifts) {
    if (entry.until <= now) pressBlockLifts.delete(pty);
  }
  pressBlockLifts.delete(ptyId);
  while (pressBlockLifts.size >= PRESS_BLOCK_LIFT_MAX) {
    const oldest = pressBlockLifts.keys().next();
    if (oldest.done) break;
    pressBlockLifts.delete(oldest.value);
  }
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

/** Test-only: how many lifts are held right now. */
export function pressBlockLiftCount(): number {
  return pressBlockLifts.size;
}

/**
 * Make a fragment of the RECORD safe to put inside an error string.
 *
 * `question` and `toolName` come from the worker's own screen and its hook
 * envelope — text an agent under test wrote — and this message is handed
 * straight to the BRAIN as a tool error, i.e. into its context. Unquoted and
 * unbounded, a question containing newlines and something shaped like an
 * instruction reads there as a line of its own rather than as data. So:
 * control characters (newlines included) collapse to spaces, the result is
 * length-capped, and the caller wraps it in quotes.
 */
export function safeRecordText(raw: string, max = 80): string {
  const flat = raw
    // eslint-disable-next-line no-control-regex -- matching them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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

/**
 * The refusal a blocked `terminal_send` gets. Names the tool that replaces it.
 *
 * Both record fields are UNTRUSTED — a tool name off the hook envelope and a
 * question the worker's agent printed — and this string lands in the CALLER's
 * context. They go through `safeRecordText` and are quoted, so the worst a
 * hostile question can do is occupy 80 characters inside a pair of quotes on
 * one line.
 */
export function approvalBlockMessage(op: string, ptyId: string, record: PendingApproval): string {
  const toolName = safeRecordText(record.toolName ?? '', 40);
  const question = safeRecordText(record.question ?? '');
  const what = toolName
    ? `a permission gate for tool "${toolName}"`
    : question
      ? `a question ("${question}")`
      : 'an approval prompt';
  return (
    `${op}: pane "${ptyId}" is waiting on ${what} — refusing to type at an approval prompt. ` +
    `Answer it with approval_press({ ptyId: "${ptyId}", decision: "approve" | "deny" }), which ` +
    'resolves the approval record and presses the option that record specifies. ' +
    'If the press comes back refused because the operator has autonomy or ' +
    'approval-press off for this worker, this block lifts and you may type again.'
  );
}

/** Injectable seams. Defaults are the hosted singletons. */
export interface ApprovalsRpcDeps {
  /** Injected in tests; defaults to the main-hosted task ledger. */
  getLedger?: () => TaskLedger;
}

function deny(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

export function registerApprovalsRpc(
  router: RpcRouter,
  getDaemonClient: () => DaemonClient | null,
  deps: ApprovalsRpcDeps = {},
): void {
  const ledgerOf = deps.getLedger ?? getTaskLedger;

  router.register('approval.press', async (params, ctx?: RpcContext) => {
    const parsed = parsePressParams(params);
    if ('error' in parsed) return deny('INVALID_ARGUMENT', parsed.error);

    // The caller id is the commander token's bound workspace and NOTHING else.
    // The `workspaceId` param used to stand in for it, which made the one input
    // that decides whose workers may be pressed a field the caller types.
    const callerWs = ctx?.commanderWorkspace ?? '';
    if (!callerWs) {
      return deny(
        'NOT_AUTHORIZED',
        'approval.press is for an orchestrator brain: it needs a validated commander token, ' +
          'because the press is authorized by which task workspaces that brain owns',
      );
    }

    const dc = getDaemonClient();
    if (!dc?.isConnected) {
      throw new Error('approval.press: daemon not connected — no approval records exist to press');
    }

    // Resolve the target FIRST, so a caller that named a pane learns "nothing is
    // pending there" instead of a generic not-found from the registry. The
    // record is also what carries the workspace the ownership check needs, so
    // this list happens even when the caller named an approvalId.
    const listed = (await dc.rpc('daemon.approvals.list', {})) as
      | { pending?: PendingApproval[] }
      | undefined;
    const pending = listed?.pending ?? [];

    let record: PendingApproval | undefined;
    if (parsed.approvalId) {
      record = pending.find((r) => r.id === parsed.approvalId);
      if (!record) {
        return {
          ok: false,
          reason: 'not-found',
          approvalId: parsed.approvalId,
          note: 'no pending approval has that id — it was answered, it expired, or it never existed.',
        };
      }
    } else {
      const pick = pickPressTarget(pending, parsed.ptyId ?? '');
      if ('error' in pick && pick.error === 'ambiguous') {
        return {
          ok: false,
          reason: 'ambiguous',
          ptyId: parsed.ptyId,
          approvalIds: pick.approvalIds,
          note:
            'this pane holds more than one pending approval (an agent can have several gated ' +
            'tool calls in flight at once), and guessing which one you meant could approve a ' +
            'different tool call than the one you read. Name the approvalId.',
        };
      }
      if ('error' in pick) {
        return {
          ok: false,
          reason: 'not-found',
          ptyId: parsed.ptyId,
          note:
            'no approval is pending on that pane. wmux only records prompts a hook reported, ' +
            'so a pane that is merely waiting on something is not pressable — read its screen.',
        };
      }
      record = pick.record;
    }

    const approvalId = record.id;
    // The pane the press lands on — from the RECORD, so a press by approvalId
    // knows it too (the deadlock lift below is per-pane).
    const targetPtyId = record.sessionId;

    // ── Delegation: is this MY worker? ──────────────────────────────────────
    // The daemon's press scope asks whether the pane is somebody's delegated
    // task workspace; it has no way to ask WHOSE, because it does not hold the
    // ledger. Without this, brain A could answer brain B's workers' permission
    // prompts. Fails closed: a record with no workspace, or a task the ledger
    // does not tie to this caller, is refused and never reaches the daemon.
    if (!record.workspaceId) {
      return {
        ok: false,
        reason: 'record-has-no-workspace',
        approvalId,
        ptyId: targetPtyId,
        note:
          'this approval record carries no workspace, so wmux cannot tell whether the pane is ' +
          'one of your delegated workers — refusing rather than pressing into an unknown pane.',
      };
    }
    const owned = ledgerOf()
      .list({ taskWorkspaceId: record.workspaceId })
      .some((e) => e.ownerWorkspaceId === callerWs);
    if (!owned) {
      return {
        ok: false,
        reason: 'not-your-task',
        approvalId,
        ptyId: targetPtyId,
        note:
          'that pane is not a task workspace you delegated (the task ledger has no entry naming ' +
          'you as its owner). Answering another orchestrator\'s worker, or a human\'s own pane, ' +
          'is not something this tool does — raise it with deck_ask_decision instead.',
      };
    }

    const result = (await dc.rpc('daemon.approvals.resolve', {
      id: approvalId,
      decision: parsed.decision,
      resolvedBy: callerWs ? `brain:${callerWs}` : 'brain',
      // The whole point of this handler — see the header.
      resolver: 'automated',
      ...(parsed.choiceKey ? { choiceKey: parsed.choiceKey } : {}),
    })) as
      | { ok?: boolean; reason?: string; pressRefusal?: string; durable?: boolean }
      | undefined;

    if (result?.ok) {
      return {
        ok: true,
        approvalId,
        decision: parsed.decision,
        ptyId: targetPtyId,
        ...(parsed.choiceKey ? { choiceKey: parsed.choiceKey } : {}),
        // false = the keystroke landed but the record of it did not reach disk.
        durable: result.durable !== false,
      };
    }
    // The CONCRETE condition, not the bucket. The daemon answers every press
    // -scope refusal with the wire reason 'out-of-scope' — one value for eight
    // conditions — and carries the condition itself in `pressRefusal`. Keying
    // the hints and the deadlock lift on the bucket meant neither ever fired in
    // production, however carefully both were written.
    const reason = result?.pressRefusal ?? result?.reason ?? 'not-found';

    // The deadlock guard. A press the OPERATOR'S POLICY refused leaves the brain
    // with no move while terminal_send is blocked on the same pane, so the block
    // is lifted for it. Transient refusals do not lift, and neither does a pane
    // this caller does not own — that one never reaches here. See the header.
    if (PRESS_DEADLOCK_REASONS.has(reason)) liftPressBlock(targetPtyId, reason);

    return {
      ok: false,
      reason,
      approvalId,
      ptyId: targetPtyId,
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
