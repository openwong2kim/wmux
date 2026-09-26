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
// guess (see the policy-refusal note below).

import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { DaemonClient } from '../../DaemonClient';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { looksLikeApprovalPrompt } from '../../../daemon/approvals/approvalKeystrokes';
import { parseTerminalPrompt } from '../../../daemon/approvals/terminalPromptParse';

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
    "this worker's workspace has autonomy off — do not type or send keys at the prompt; raise it with deck_ask_decision",
  'press-capability-off':
    'approval-press is off for this worker (its owner runs in assist, or a loop narrowed the capability) — raise it with deck_ask_decision',
  'detector-only':
    'this prompt was only guessed at from the screen, not reported by a hook, so it will not be pressed',
  'prompt-gone': 'the prompt is no longer on screen — read the pane again before deciding',
  'scope-unavailable':
    'the daemon has no workspace facts to judge this pane by; the desktop app may have just started',
  'answer-in-terminal':
    "this is the agent's own terminal dialog: a human answers it, in the pane or from a paired phone. " +
    'No automated press reaches it — raise it with deck_ask_decision if the operator is needed',
};

// ─── Policy refusals escalate; raw input follows live state ────────────────
//
// `terminal_send` / `terminal_send_key` are blocked on a pane holding an
// approval record, because typing at an approval prompt is the thing
// `approval_press` replaces. When the OPERATOR'S POLICY refuses the press
// (autonomy off, approval pressing off), the answer is the operator's to give:
// the caller escalates with `deck_ask_decision`. A refusal unlocks nothing.
//
// A record is not the only sign of an approval. A gate record expires when the
// gate defers to the agent's own dialog, and that dialog can be on screen with
// no record at all. So the raw-input guard also asks, at the moment of the
// write, whether the pane's workspace policy lets an automated caller answer
// approvals, and — only when it does not — whether an approval dialog is on
// the pane's screen right now. That is live state, not an event: when the
// human answers the dialog it leaves the screen and typing works again at once.

/** Policy refusals — the operator has decided, and only the operator can change it. */
export const PRESS_POLICY_REFUSALS: ReadonlySet<string> = new Set([
  'autonomy-off',
  'press-capability-off',
]);

/** Whether a workspace's live policy lets an automated caller answer approvals. */
export type AnswerPolicy =
  | { allowed: true }
  | { allowed: false; reason: 'autonomy-off' | 'press-capability-off' | 'workspace-unknown' };

/**
 * The policy for a pane's workspace, from its stored (effective) autonomy
 * entry. No workspace, or no entry, reads as not allowed: the product default
 * is autonomy off, and a missing fact must never read as permission.
 */
export function answerPolicyFor(
  workspaceId: string | null,
  entry: { mode?: string; approvalPress?: boolean } | undefined,
): AnswerPolicy {
  if (!workspaceId) return { allowed: false, reason: 'workspace-unknown' };
  if (!entry?.mode || entry.mode === 'off') return { allowed: false, reason: 'autonomy-off' };
  if (entry.approvalPress !== true) return { allowed: false, reason: 'press-capability-off' };
  return { allowed: true };
}

/**
 * Is an approval dialog on this screen right now? Either shape counts: an
 * option row under a selection cursor (a select, or the permission dialog's
 * "❯ 1. Yes"), or a whole permission dialog the parser recognises. Only the
 * tail is looked at — the live dialog is at the bottom of the grid.
 */
export function approvalOnScreen(screenText: string): boolean {
  const rows = screenText.split('\n').slice(-60);
  if (rows.length === 0) return false;
  return looksLikeApprovalPrompt(rows) || parseTerminalPrompt(rows) !== null;
}

/** The refusal raw input gets when an approval is on screen and policy is off. */
export function approvalGateMessage(op: string, ptyId: string, reason: string): string {
  return (
    `${op}: pane "${ptyId}" is showing an approval prompt, and this workspace's policy ` +
    `(${reason}) does not let an automated caller answer it — refusing raw input. ` +
    'A human answers it in the pane; raise it with deck_ask_decision. ' +
    'ctrl+c and escape still stop the worker.'
  );
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
  // The agent's own terminal dialog is a human's to answer; approval_press is
  // refused on it too (`answer-in-terminal`), so do not point the caller there.
  if (record.kind === 'terminal_prompt') {
    const tool = safeRecordText(record.toolName ?? '', 40);
    return (
      `${op}: pane "${ptyId}" is showing the agent's own permission dialog` +
      `${tool ? ` for tool "${tool}"` : ''} — refusing to type at it. A human answers this ` +
      'in the pane (or from a paired phone); no tool presses it. Raise it with ' +
      'deck_ask_decision if you need the operator.'
    );
  }
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
    'If the press is refused because the operator has autonomy or approval-press off ' +
    'for this worker, the block stays — raise it with deck_ask_decision.'
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
    // knows it too.
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
    // the hints on the bucket meant they never fired in production.
    const reason = result?.pressRefusal ?? result?.reason ?? 'not-found';

    // A policy refusal is the operator's call: nothing is unlocked, and the
    // caller is pointed at the escalation path.
    return {
      ok: false,
      reason,
      approvalId,
      ptyId: targetPtyId,
      ...(PRESS_REFUSAL_HINTS[reason] ? { note: PRESS_REFUSAL_HINTS[reason] } : {}),
      ...(PRESS_POLICY_REFUSALS.has(reason) ? { escalate: 'deck_ask_decision' } : {}),
    };
  });
}
