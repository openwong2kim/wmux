// ─── moa_ask — the wire contract (steps 2-5 of "Moa as the owner's delegate") ─
//
// An agent pane asks Moa instead of the owner. The call is ASYNC so the MCP
// client's 10 s RPC timeout (src/mcp/wmux-client.ts) can never re-fire the
// judge:
//
//   moa_ask {question|action, askId?}  → at once: { ticketId, status }
//   moa_ask_status {ticketId}          → the ticket as it is now
//
// Status, as the caller sees it:
//   pending    the judge is still deciding; poll again after `pollAfterMs`.
//   answered   final. `answer` holds the choice (or the action verdict), the
//              rule it rests on, and who settled it.
//   escalated  Moa will not settle it: ask the owner yourself, as you do today.
//              The ticket stays open in Moa's panel; if the owner answers it
//              there, a later poll returns `answered` (resolvedBy 'owner').
//   refused    final. A deterministic check refused it (for a merge: a lane
//              predicate, see moaMergeLane.ts) or the request itself was
//              rejected (`id-reused`). Do not proceed.
//
// Identity. The asker (pane, workspace, agent) is stamped by main from the
// verified pipe identity of the calling pane; nothing in the input names an
// asker. A ticket is visible only to the asker that created it; anyone else
// polling its id gets `unknown-ticket`.
//
// Idempotency mirrors AnswerReceiptStore (src/daemon/approvals):
//   key      = (stamped asker, askId)        — or (asker, "q:"+questionHash)
//                                              when no askId is given
//   bodyHash = questionHash                  — main's normalization, the same
//                                              as shadowPacketHash
//   same key, same body, still running → the same ticket, `pending`, replayed
//   same key, same body, finished      → the same ticket and its result, again
//   same key, another body             → `id-reused` (only possible with askId)
//   running when main stopped          → `escalated`, reasonCode
//                                         'restart-uncertain' (never re-judged)
//
// Actions. A typed action carries its target in typed fields only. Today the
// one action is `merge {prNumber, expectHead}`; the repo is the one the
// asker's own cwd belongs to (resolved by main), never named by the caller,
// and no number is ever parsed out of free text for an action.
//
// Surface decision (switches off ⇒ byte-identical): moa_ask and
// moa_ask_status are ABSENT from tools/list unless the owner turned the ask
// mode on (`moa-ask.json`, see moaAskSwitch.ts), and then only in the `full`
// profile, appended after every other tool — the computer-use pattern. They
// are not registered at all yet; the zod shapes live in src/mcp/moaAsk.ts.
// Main re-checks its own config on every call: a stale MCP server that still
// lists the tool gets `{ ok: false, code: 'off' }`, no record, no judge call.
//
// Everything a caller sends is untrusted text. Main validates it with
// parseMoaAskInput below (never with the MCP layer's schema alone).

/** MCP tool names. */
export const MOA_ASK_TOOL = 'moa_ask';
export const MOA_ASK_STATUS_TOOL = 'moa_ask_status';

/** Pipe RPC methods behind the tools (added to RpcMethod with their handler). */
export const MOA_ASK_RPC = 'moa.ask';
export const MOA_ASK_STATUS_RPC = 'moa.askStatus';

/** How long a caller should wait before polling a pending ticket again. */
export const MOA_ASK_POLL_MS = 3_000;

export const MOA_ASK_LIMITS = {
  QUESTION_MAX: 1_000,
  OPTIONS_MIN: 2,
  OPTIONS_MAX: 6,
  OPTION_LABEL_MAX: 200,
  OPTION_DESCRIPTION_MAX: 300,
  CONTEXT_MAX: 800,
} as const;

export const MOA_ASK_OPTION_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** The question's category (`kind` on the wire): a display and stats tag only. */
export const MOA_ASK_TOPIC_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const MOA_ASK_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
export const MOA_TICKET_ID_RE = /^moa-t-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A full commit SHA (same shape as prReview.isCommitSha). */
const COMMIT_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const PR_NUMBER_MAX = 99_999_999;

export type MoaTicketStatus = 'pending' | 'answered' | 'escalated' | 'refused';
export const MOA_TICKET_STATUSES: readonly MoaTicketStatus[] = ['pending', 'answered', 'escalated', 'refused'];

/** The ask switch: off (default), records only, suggests in the panel, or may
 *  answer by itself where a rule is auto-eligible (moaAutoEligibility). */
export type MoaAskMode = 'off' | 'shadow' | 'suggest' | 'auto';
export const MOA_ASK_MODES: readonly MoaAskMode[] = ['off', 'shadow', 'suggest', 'auto'];

export interface MoaAskOption {
  key: string;
  label: string;
  description?: string;
}

/** A validated request body. `type` is the decision's kind. */
export type MoaAskBody =
  | { type: 'question'; question: string; options: MoaAskOption[]; topic?: string; context?: string }
  | { type: 'merge'; prNumber: number; expectHead: string; context?: string };

export type MoaAskKind = MoaAskBody['type'];

export interface MoaAskRequest {
  askId?: string;
  body: MoaAskBody;
}

/** The asker, stamped by main from the verified pipe identity. */
export interface MoaAsker {
  ptyId: string;
  workspaceId: string;
  agent: string;
}

/** What `moa_ask` returns at once. */
export interface MoaAskTicket {
  ticketId: string;
  status: MoaTicketStatus;
  /** This ticket already existed for the same key and body. */
  replayed?: true;
  pollAfterMs?: number;
}

export type MoaAskRefusalCode =
  /** The input failed parseMoaAskInput (nothing was recorded). */
  | 'invalid'
  /** The ask mode is off in main (a stale server still listing the tool). */
  | 'off'
  /** The calling pane has no verified identity. */
  | 'not-attributed'
  /** The askId was already used for a different body. */
  | 'id-reused'
  /** The asker holds too many live tickets. */
  | 'full';

export type MoaAskResult =
  | { ok: true; ticket: MoaAskTicket }
  | { ok: false; code: MoaAskRefusalCode; message: string; ticketId?: string };

export type MoaResolvedBy = 'owner' | 'moa-auto' | 'expired' | 'refused';

/** A settled answer. Exactly one of choiceKey / actionVerdict is set. */
export interface MoaAskAnswer {
  choiceKey?: string;
  actionVerdict?: 'go' | 'no-go';
  /** The policy rule it rests on; null when the owner answered. */
  ruleId: string | null;
  reasonCode: string;
  why: string;
  resolvedBy: 'owner' | 'moa-auto';
}

export type MergeEffectStatus = 'pending' | 'inFlight' | 'done' | 'refused' | 'uncertain';

/** A merge action's execution, as the asker may see it. */
export interface MoaAskEffectView {
  status: MergeEffectStatus;
  reason?: string;
}

/** What `moa_ask_status` returns for the asker's own ticket. */
export interface MoaTicketView {
  ticketId: string;
  kind: MoaAskKind;
  status: MoaTicketStatus;
  /** Set when answered. */
  answer?: MoaAskAnswer;
  /** Why it is escalated or refused (or the answer's code). */
  reasonCode: string;
  why: string;
  /** A merge action's execution, once an effect exists. */
  effect?: MoaAskEffectView;
  pollAfterMs?: number;
  createdAt: number;
  resolvedAt: number | null;
}

export type MoaAskStatusResult =
  | { ok: true; ticket: MoaTicketView }
  | { ok: false; code: 'invalid' | 'off' | 'not-attributed' | 'unknown-ticket'; message: string };

// ── Validation (main's, authoritative) ───────────────────────────────────────

export type MoaParse<T> = { ok: true; value: T } | { ok: false; code: 'invalid'; field: string; message: string };

const bad = (field: string, message: string): { ok: false; code: 'invalid'; field: string; message: string } => ({
  ok: false, code: 'invalid', field, message,
});

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A trimmed non-empty string within `max` chars, or an error message. */
function text(v: unknown, max: number): string | { error: string } {
  if (typeof v !== 'string') return { error: 'must be a string' };
  const s = v.trim();
  if (!s) return { error: 'must not be empty' };
  if (s.length > max) return { error: `must be at most ${max} characters` };
  return s;
}

function optionalText(o: Record<string, unknown>, field: string, max: number): string | undefined | { error: string } {
  if (o[field] === undefined) return undefined;
  return text(o[field], max);
}

function parseOptions(raw: unknown): MoaParse<MoaAskOption[]> {
  if (!Array.isArray(raw)) return bad('options', 'must be an array');
  if (raw.length < MOA_ASK_LIMITS.OPTIONS_MIN || raw.length > MOA_ASK_LIMITS.OPTIONS_MAX) {
    return bad('options', `must hold ${MOA_ASK_LIMITS.OPTIONS_MIN} to ${MOA_ASK_LIMITS.OPTIONS_MAX} choices`);
  }
  const out: MoaAskOption[] = [];
  const keys = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i];
    if (!isRecord(o)) return bad(`options[${i}]`, 'must be an object');
    if (typeof o.key !== 'string' || !MOA_ASK_OPTION_KEY_RE.test(o.key)) return bad(`options[${i}].key`, 'must match [A-Za-z0-9_-]{1,32}');
    if (keys.has(o.key)) return bad(`options[${i}].key`, 'duplicate key');
    keys.add(o.key);
    const label = text(o.label, MOA_ASK_LIMITS.OPTION_LABEL_MAX);
    if (typeof label !== 'string') return bad(`options[${i}].label`, label.error);
    const description = optionalText(o, 'description', MOA_ASK_LIMITS.OPTION_DESCRIPTION_MAX);
    if (description !== undefined && typeof description !== 'string') return bad(`options[${i}].description`, description.error);
    out.push({ key: o.key, label, ...(description ? { description } : {}) });
  }
  return { ok: true, value: out };
}

/**
 * Validate a `moa_ask` input. Exactly one of `question` (with `options`) or
 * `action` is given; unknown keys are rejected. Pure; never throws.
 */
export function parseMoaAskInput(raw: unknown): MoaParse<MoaAskRequest> {
  if (!isRecord(raw)) return bad('', 'must be an object');
  const allowed = new Set(['question', 'options', 'kind', 'action', 'context', 'askId']);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) return bad(k, 'unknown field');
  let askId: string | undefined;
  if (raw.askId !== undefined) {
    if (typeof raw.askId !== 'string' || !MOA_ASK_ID_RE.test(raw.askId)) return bad('askId', 'must match [A-Za-z0-9._:-]{1,64}');
    askId = raw.askId;
  }
  const context = optionalText(raw, 'context', MOA_ASK_LIMITS.CONTEXT_MAX);
  if (context !== undefined && typeof context !== 'string') return bad('context', context.error);
  const withCtx = context ? { context } : {};
  const hasQuestion = raw.question !== undefined;
  const hasAction = raw.action !== undefined;
  if (hasQuestion === hasAction) return bad(hasQuestion ? 'action' : 'question', 'give exactly one of question or action');

  if (hasAction) {
    if (raw.options !== undefined || raw.kind !== undefined) return bad(raw.options !== undefined ? 'options' : 'kind', 'not allowed with action');
    const a = raw.action;
    if (!isRecord(a)) return bad('action', 'must be an object');
    for (const k of Object.keys(a)) if (!['type', 'prNumber', 'expectHead'].includes(k)) return bad(`action.${k}`, 'unknown field');
    if (a.type !== 'merge') return bad('action.type', 'the only action is "merge"');
    if (typeof a.prNumber !== 'number' || !Number.isSafeInteger(a.prNumber) || a.prNumber < 1 || a.prNumber > PR_NUMBER_MAX) {
      return bad('action.prNumber', 'must be a positive integer');
    }
    if (typeof a.expectHead !== 'string' || !COMMIT_SHA_RE.test(a.expectHead)) return bad('action.expectHead', 'must be a full lowercase commit SHA');
    return { ok: true, value: { ...(askId ? { askId } : {}), body: { type: 'merge', prNumber: a.prNumber, expectHead: a.expectHead, ...withCtx } } };
  }

  const question = text(raw.question, MOA_ASK_LIMITS.QUESTION_MAX);
  if (typeof question !== 'string') return bad('question', question.error);
  const options = parseOptions(raw.options);
  if (!options.ok) return options;
  let topic: string | undefined;
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== 'string' || !MOA_ASK_TOPIC_RE.test(raw.kind)) return bad('kind', 'must match [a-z][a-z0-9-]{0,31}');
    topic = raw.kind;
  }
  return {
    ok: true,
    value: { ...(askId ? { askId } : {}), body: { type: 'question', question, options: options.value, ...(topic ? { topic } : {}), ...withCtx } },
  };
}

/** Validate a `moa_ask_status` input. */
export function parseMoaAskStatusInput(raw: unknown): MoaParse<{ ticketId: string }> {
  if (!isRecord(raw)) return bad('', 'must be an object');
  for (const k of Object.keys(raw)) if (k !== 'ticketId') return bad(k, 'unknown field');
  if (typeof raw.ticketId !== 'string' || !MOA_TICKET_ID_RE.test(raw.ticketId)) return bad('ticketId', 'not a ticket id');
  return { ok: true, value: { ticketId: raw.ticketId } };
}
