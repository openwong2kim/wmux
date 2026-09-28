// M2 — ApprovalRegistry: the daemon is the process of record for approvals.
//
// M1 made the daemon the hook authority: with the GUI closed a Claude Code
// `AskUserQuestion` PreToolUse still lands here as an `agent.awaiting_input`
// with the full envelope. This module turns that signal into a REQUEST a human
// can answer from somewhere that is not the desktop, and owns the one dangerous
// step that follows — putting a keystroke into somebody's terminal.
//
// ASCII flow:
//
//   Claude Code AskUserQuestion (PreToolUse)
//      │  wmux-bridge.mjs → daemon.hooks.signal
//      ▼
//   HookIngest.handle → decision 'emit', source 'hook'
//      │  noteHookAwaitingInput(...)          [dedup'd signals never get here]
//      ▼
//   ApprovalRegistry   ── create ──▶ approvals.json + 'create' event
//      ▲                                          │
//      │ resolve({id, decision, resolvedBy})      ▼
//   daemon.approvals.resolve / POST /api/approvals/:id     SSE 'approval'
//      │
//      ├─ CAS on (id, state==='pending')  ──▶ 'already-resolved' for the loser
//      ├─ keystroke map (claude only)     ──▶ 'unsupported-agent'
//      ├─ re-read the pane's screen       ──▶ 'prompt-gone' (and EXPIRE it)
//      └─ ONE keystroke into the PTY      ──▶ state 'resolved'
//
// Three rules carry all the safety:
//
//  1. HOOK-ONLY CREATION. A request exists only for `source:'hook'` +
//     `agent.awaiting_input` + `decision:'emit'`. Detector (regex) awaiting_input
//     creates nothing — that is the CommanderEventCoalescer bar (a regex match
//     is a suspicion, and this surface writes bytes), enforced here rather than
//     described in a prompt.
//
//     ONE EXCEPTION: `kind:'terminal_prompt'`, the agent's own terminal dialog
//     (Claude Code's "Do you want to proceed?"). It is created from the
//     PermissionRequest hook AND from a confirmed detector attention, and it
//     does not need the hook bar, because its ANSWER never trusts its origin:
//     a remote answer is honoured only from a capable web client, only as a
//     plain Yes/No option, and only after the live screen is re-read, re-parsed
//     and found to be the same active dialog (fingerprint), with the pane
//     unchanged between that read and the one-byte write (see
//     resolveTerminalPrompt). A record whose parse was not whole carries no
//     choices and can never be answered; `resolve` refuses it with
//     `answer-in-terminal` and writes nothing.
//  2. ONE MUTATION CHAIN. Every state change funnels through `this.chain`, so a
//     read-modify-write can never interleave with another one across the awaits
//     in resolve() (the screen re-read is seconds long). This is the
//     deckDecisionStore lesson: two concurrent resolvers both reading 'pending'
//     is how a human's answer gets lost, and it is a race you cannot test your
//     way out of after the fact.
//  3. NEVER BLIND BYTES. The state says 'pending', but the state is a memory of
//     something that was true when the hook fired. Before writing we re-read the
//     actual screen and refuse unless the thing the keystroke acts on is still
//     visible (see looksLikeApprovalPrompt — biased to refuse).

import crypto from 'node:crypto';
import { hasCriticalRisk } from '../../shared/criticalPatterns';
import {
  boundRecordText,
  isClaudeFamilyAgent,
  TERMINAL_PROMPT_COOLDOWN_MS,
  TERMINAL_PROMPT_SUMMARY_MAX,
  TERMINAL_PROMPT_TOOL_NAME_MAX,
} from './terminalPrompt';
import {
  decisionForChoiceLabel,
  dialogMatchesToolCall,
  normalizePromptText,
  parsePlanPrompt,
  parseTerminalPrompt,
  terminalPromptAnswerability,
  toolFromDialogTitle,
  type ParsedTerminalPrompt,
} from './terminalPromptParse';
import { commandOfToolInput, type PendingToolUse } from '../transcript/pendingToolUse';
import { terminalPromptTextRisk } from '../push/approvalRisk';
import {
  decideApprovalPress,
  keystrokesForAgent,
  looksLikeApprovalPrompt,
  questionOnScreen,
  type ApprovalPressFacts,
} from './approvalKeystrokes';
import {
  formatScreenTail,
  loadApprovalState,
  saveApprovalState,
  sanitizeResolvedBy,
  trimHistory,
  type ApprovalPersistedState,
} from './approvalStore';
import type {
  ApprovalDecision,
  ApprovalEvent,
  ApprovalEventType,
  ApprovalExpiryReason,
  ApprovalHookSink,
  ApprovalListResult,
  ApprovalRegistryApi,
  ApprovalRequest,
  ApprovalResolveFailure,
  ApprovalResolveParams,
  ApprovalResolveResult,
  AnswerRefusalReason,
  DecisionForm,
  NativeDecisionOutcome,
  NativeDecisionRef,
  NativeDecisionReply,
  TerminalPromptDetail,
  TerminalPromptNote,
} from './types';
import {
  DECISION_V2_WEB_ANSWER,
  NATIVE_ANSWER_TIMEOUT_MS,
  isNativeDecision,
  TERMINAL_PROMPT_DETAIL_MAX_BYTES,
  TERMINAL_PROMPT_WEB_ANSWER,
  TERMINAL_PROMPT_WEB_DECLINE,
} from './types';
import type { QuestionShape } from './askUserQuestion';
import type { PhoneDecisionsConfig } from './decisionConfig';
import { boundDecisionForm, nativeV2Answer } from './decisionForm';

/** The pane's state at one instant: output bytes, key-carrying input, the PTY incarnation. */
export interface PromptScreenMark {
  bytes: number;
  keyInputRevision: number;
  incarnation: string | null;
}

/** No remote answer to a `terminal_prompt` this soon after it appeared (reflex / script guard). */
export const TERMINAL_PROMPT_MIN_ANSWER_AGE_MS = 1_500;
/** Renders an answer may take when the pane keeps moving under it. */
export const TERMINAL_PROMPT_ANSWER_ATTEMPTS = 2;
/** Creation-time screen reads (the hook can land before the dialog is drawn), and the gap between them. */
export const TERMINAL_PROMPT_CREATE_READS = 3;
export const TERMINAL_PROMPT_CREATE_READ_GAP_MS = 400;
/**
 * A record created without a whole parse gets this many later looks, this far
 * apart: the PermissionRequest hook can land well before the dialog is drawn,
 * and a first read that missed it must not leave the whole episode
 * unanswerable.
 */
export const TERMINAL_PROMPT_UPGRADE_READS = 2;
export const TERMINAL_PROMPT_UPGRADE_GAP_MS = 1_500;
/** Most pending native decisions one pane may hold at once. */
export const NATIVE_DECISIONS_PER_SESSION_MAX = 16;
/**
 * Expiry reasons inferred from the pane's SCREEN or keys. A `native-rpc`
 * record is settled by the agent's own server, so none of these may touch it:
 * a key in an OpenCode pane or a cleared Claude-style dialog says nothing
 * about a request the agent is still holding.
 */
const SCREEN_INFERRED_EXPIRY: ReadonlySet<ApprovalExpiryReason> = new Set<ApprovalExpiryReason>([
  'answered-locally',
  'screen-cleared',
  'prompt-submitted',
  'prompt-gone',
]);
const isNative = (r: ApprovalRequest): boolean => isNativeDecision(r);
/** How long a settled native request is remembered, so a late re-notify cannot resurrect its card. */
const NATIVE_SETTLED_MEMORY_MS = 10 * 60_000;
const NATIVE_SETTLED_MEMORY_MAX = 1024;
/**
 * One agent request's identity. Codex request ids are small integers that
 * every pane on an account server shares and that restart at 0 with it, so a
 * Codex key also names the relay (its incarnation) and the thread. An OpenCode
 * ref carries neither and keeps its `adapter|requestId` key.
 */
const nativeKey = (native: NativeDecisionRef): string => `${native.adapter}|${native.requestId}`
  + (native.relayId !== undefined ? `|r:${native.relayId}` : '')
  + (native.threadId !== undefined ? `|t:${native.threadId}` : '');
/**
 * The stepwise driver (feedback on the plan dialog): the longest one step
 * waits for the screen to show what its key should have drawn, how often it
 * looks, and the bounds on one whole answer.
 */
export const STEP_RENDER_WAIT_MS = 1_500;
export const STEP_POLL_MS = 100;
export const STEP_TOTAL_MS = 20_000;
export const STEP_MAX_KEYS = 40;
/** Extra render wait per 100 columns of pasted text. */
export const STEP_RENDER_WAIT_PER_100_MS = 200;
/** The feedback width allowed when the pane's width is unknown (measured to fit at 100x40). */
export const PLAN_FEEDBACK_FALLBACK_WIDTH = 300;

/**
 * Columns a text takes on screen: 2 for a wide (East Asian / emoji) code
 * point, 1 otherwise. An approximation that errs wide.
 */
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
  return width;
}

/**
 * The widest feedback the plan dialog's field can show whole on a
 * `cols`x`rows` pane, so the driver can read it back before Enter: the
 * field's rows (the grid less the question, options, hint and footer) times
 * its width (the grid less the option indent). Capped by the answer limit.
 */
export function planFeedbackMaxWidth(cols: number | undefined, rows: number | undefined): number {
  if (!cols || !rows) return PLAN_FEEDBACK_FALLBACK_WIDTH;
  return Math.min(2000, Math.max(0, cols - 12) * Math.max(0, rows - 14));
}

/**
 * Text that can go inside one bracketed paste and stay text: no C0 control
 * (ESC, CR and LF included), no DEL, no C1 control, no Unicode line or
 * paragraph separator.
 */
export function isPasteSafeText(text: string): boolean {
  // eslint-disable-next-line no-control-regex -- refusing them is the point
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text);
}
/** The ExitPlanMode dialog's form actions. */
export const PLAN_ACTION_APPROVE = 'approve-manual';
export const PLAN_ACTION_FEEDBACK = 'feedback';
/** Quiet time after a key/click before an overtaken record is refreshed. */
export const TERMINAL_PROMPT_REFRESH_SETTLE_MS = 600;
/** At most one refresh per record this often: key auto-repeat must not flood SSE. */
export const TERMINAL_PROMPT_REFRESH_MIN_GAP_MS = 2_000;

/** A screen read, parsed: the active dialog and the pane's state at the read. */
interface DialogRead {
  parsed: ParsedTerminalPrompt;
  mark: PromptScreenMark;
  /** The grid's width and height at the read, when known. */
  cols?: number;
  height?: number;
}

/** The tool call a dialog is bound to (transcript, or the PermissionRequest hook). */
interface ToolCallBinding {
  /** The transcript `tool_use` id; absent for a hook binding. */
  id?: string;
  name: string;
  input: Record<string, unknown>;
  /** Transcript bindings: unanswered `tool_use` blocks in the window (see PendingToolUse). */
  unanswered?: number;
  /** Hook bindings: the hook's `prompt_id`, an extra discriminator. */
  promptId?: string;
  /** A note's own input with no evidence behind it: summary and label only. */
  unbindable?: boolean;
}

/** JSON with object keys sorted, so the same input hashes the same from any source. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 (hex) of a tool call's WHOLE input — every field, untruncated. */
function toolInputHash(input: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/**
 * A dialog's fingerprint bound to one tool call instance — its `tool_use` id
 * AND a hash of its whole input, so a command longer than anything the
 * screen or the record shows is still covered in full — and to the pane's
 * input epoch (the fence revision it was read at). A key or click since the
 * phone's read therefore always shows up as a different fingerprint: the
 * refreshed record the phone must re-confirm.
 */
function bindFingerprint(
  screen: string,
  toolUseId: string | undefined,
  keyRevision: number | undefined,
  inputHash: string | undefined,
): string {
  return crypto
    .createHash('sha256')
    .update(`${screen}|${toolUseId ?? ''}|${keyRevision ?? ''}|${inputHash ?? ''}`)
    .digest('hex')
    .slice(0, screen.length);
}

/**
 * What a `terminal_prompt` record was minted from, kept on EVERY such record
 * (answerable or not) under a Symbol key: it lives exactly as long as the
 * record in daemon memory and never reaches JSON — approvals.json, the pipe
 * RPC, SSE and the push payload all serialize without it. A daemon restart
 * expires every pending record, so nothing is lost with it.
 */
const IDENTITY: unique symbol = Symbol('terminal-prompt-identity');
interface TerminalPromptIdentity {
  /** The screen hash of the dialog read at creation; absent when none was read. */
  screenFp?: string;
  /** The pane at the instant the record was minted (the read, else the mint). */
  mark?: { keyInputRevision: number; incarnation: string | null };
  /**
   * The tool call the record was bound to, with its whole input's hash: by
   * its transcript id, or (no id) by the PermissionRequest hook's evidence.
   */
  call?: { id?: string; name: string; command: string; description?: string; inputHash: string; promptId?: string };
  /** The dialog read at creation spelled exactly that call's command. */
  matched: boolean;
  /** Matched with its top scrolled off (see buildTerminalPrompt). */
  topCut: boolean;
}
type WithIdentity = ApprovalRequest & { [IDENTITY]?: TerminalPromptIdentity };
const identityOf = (r: ApprovalRequest): TerminalPromptIdentity | undefined => (r as WithIdentity)[IDENTITY];

/**
 * The PermissionRequest hook's word that a call is waiting on its dialog: the
 * call's tool and whole input (and its hash), the hook's `prompt_id`, and the
 * pane's key revision / PTY incarnation when it arrived. Kept per pane from
 * the hook until the pane's records are swept; two at once means two calls
 * waiting, and then none of them proves anything.
 */
interface PermissionEvidence {
  name: string;
  input: Record<string, unknown>;
  inputHash: string;
  promptId?: string;
  mark: { keyInputRevision: number; incarnation: string | null } | null;
  /** When the hook arrived (registry clock). */
  at: number;
}

/** One line of log-safe text: control characters gone, capped. */
function logText(raw: string | undefined, max = 160): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const flat = (raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Copy a record for handing OUT (list results, event payloads). A spread alone
 * is not enough now that `options` is an array: a shallow copy would share it,
 * and a consumer that sorted or pushed to the options it got from `list()`
 * would be editing registry state through the back door.
 */
function copyRequest(r: ApprovalRequest): ApprovalRequest {
  return {
    ...r,
    ...(r.options ? { options: [...r.options] } : {}),
    ...(r.choices ? { choices: r.choices.map((c) => ({ ...c })) } : {}),
    ...(r.native ? { native: { ...r.native } } : {}),
    ...(r.form ? { form: structuredClone(r.form) } : {}),
    ...(r.step ? { step: { ...r.step } } : {}),
    ...(r.answerDigest ? { answerDigest: { ...r.answerDigest } } : {}),
  };
}

export interface ApprovalRegistryDeps {
  /** Suffix-aware wmux data dir — where approvals.json lives. */
  wmuxDir: string;
  /**
   * Plain-text rows of a session's VISIBLE grid, newest last, or null when the
   * session is gone / could not be read. The daemon backs this with the same
   * headless-terminal parse `daemon.readSessionText` uses: the ring buffer is
   * raw PTY bytes and a TUI redraws in place, so stripping ANSI off the ring
   * would describe a screen that never existed. `null` is treated as "no
   * evidence" and refuses the resolve.
   */
  readScreenTail: (sessionId: string) => Promise<string[] | null>;
  /**
   * Write bytes to a live session's PTY. Returns false when the session is gone
   * or the write failed — the registry then refuses rather than claiming a
   * delivery it did not make.
   */
  writeToSession: (sessionId: string, data: string) => boolean;
  /**
   * The workspace-shaped half of the press scope (see `decideApprovalPress`):
   * is this workspace a WorkTask task workspace, and what is its deck autonomy
   * mode. Both facts live in the MAIN process, so the daemon can only be told
   * them (see approvals/workspaceFacts.ts).
   *
   * Three answers, and they are NOT the same refusal. `undefined` (the dep is
   * absent) and `null` (wired, but main has never published) both mean the
   * source of truth is unreachable — reported as `scope-unavailable`, which is
   * the one that says "the integration is missing", not "policy said no". An
   * OBJECT is an answer from main, and `{}` inside it is main declining to
   * classify this workspace, which refuses as `workspace-unknown`. Every branch
   * refuses; what differs is what an operator is told to go and fix.
   */
  pressScope?: (workspaceId: string) => Pick<ApprovalPressFacts, 'isTaskWorkspace' | 'autonomyMode'> | null;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for test determinism. */
  now?: () => number;
  /**
   * Upper bound on one `authorize` call (see ApprovalResolveParams). It runs
   * inside the single mutation link, so a check that never settles would stall
   * every resolve, hook and expiry behind it. Default 2000 ms.
   */
  authorizeTimeoutMs?: number;
  /** Injected for test determinism. */
  newId?: () => string;
  /**
   * #783 — wake the GateBroker waiter when a `kind:'awaiting_permission'`
   * record is resolved. The broker holds the bridge RPC response open; this
   * call is what closes it. Optional: tests that don't exercise the gate path
   * leave it absent, and a gate resolve without a broker is a no-op for the
   * waiter (the record still flips to 'resolved' for /api/approvals).
   */
  notifyGateResolved?: (gateId: string, decision: 'approve' | 'deny') => void;
  /**
   * #783 — cancel the GateBroker waiter when a gate record is expired or
   * superseded (turn ended, session died, newer gate superseded this one, etc).
   * The waiter would otherwise hang until its own deadline; this tells it to
   * defer immediately so the bridge falls back to the local permission flow.
   */
  notifyGateDropped?: (gateId: string) => void;
  /**
   * `terminal_prompt` — the pane's visible grid, with the pane's state
   * captured at the SAME instant the grid was read. Null when the pane is gone
   * or the grid cannot be read at its live geometry. Absent ⇒ records are
   * created without a parse and can never be answered.
   */
  readPromptScreen?: (
    sessionId: string,
  ) => Promise<{ rows: readonly string[]; mark: PromptScreenMark; cols?: number } | null>;
  /**
   * `terminal_prompt` — the latest `tool_use` in the pane's own transcript
   * that has no `tool_result` yet, or null. A record is answerable only when
   * its dialog binds to this call (or to the PermissionRequest hook's input).
   */
  pendingToolUse?: (sessionId: string) => PendingToolUse | null;
  /**
   * The pane's own Claude session id (its transcript's basename), or null when
   * unknown. A PermissionRequest hook counts as evidence for this pane only
   * when its `session_id` is this one.
   */
  agentSessionId?: (sessionId: string) => string | null;
  /** `terminal_prompt` — the pane's state right now, read synchronously just before the write. */
  promptScreenMark?: (sessionId: string) => PromptScreenMark | null;
  /**
   * The stepwise driver's own key: write `data` to the PTY and return the
   * pane's new key revision, synchronously, or null when nothing was written.
   * The pane does not count it as a human key (no fence refresh, no
   * "answered"), so the driver can tell its own keys from a human's by the
   * revision alone. Absent ⇒ no stepwise answer.
   */
  writeStepKey?: (sessionId: string, data: string) => number | null;
  /** After the stepwise driver's last key: the pane's turn resumes (once). */
  noteSubmitted?: (sessionId: string) => void;
  /** Injected for tests: the wait between creation-time screen reads. */
  promptReadDelay?: (ms: number) => Promise<void>;
  /**
   * `native-rpc` — hand one answer to the agent's own server (the OpenCode TUI
   * plugin, the Codex relay). Must return `unavailable` only when nothing was
   * delivered. Absent ⇒ a native record cannot be answered from here.
   */
  answerNative?: (native: NativeDecisionRef, reply: NativeDecisionReply, sessionId: string) => Promise<NativeDecisionOutcome>;
  /** The `phoneDecisions` kill switch, read on every use. Absent ⇒ both on. */
  phoneDecisions?: () => PhoneDecisionsConfig;
  /** Upper bound on one `answerNative` call. Default NATIVE_ANSWER_TIMEOUT_MS. */
  nativeAnswerTimeoutMs?: number;
  /**
   * Injected for tests: the timer behind the refresh after a key/click. `fn`
   * settles once that refresh has fully landed (read, persist, events), so a
   * fake timer can await it instead of guessing how long the disk write takes.
   */
  schedule?: (fn: () => Promise<void>, ms: number) => () => void;
}

export class ApprovalRegistry implements ApprovalRegistryApi, ApprovalHookSink {
  private readonly deps: ApprovalRegistryDeps;
  private readonly now: () => number;
  private readonly newId: () => string;
  private requests: ApprovalRequest[];
  private readonly listeners = new Set<(event: ApprovalEvent) => void>();
  /**
   * The single mutation chain. Every mutator appends to it, so mutations run
   * one at a time in call order even though each one awaits I/O. Kept alive
   * across a rejection so one failure can never wedge every later mutation.
   */
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * Per pane: the dialog the screen check just released, and until when a
   * detector-found `terminal_prompt` for that SAME dialog is not re-created. A
   * different dialog (another fingerprint or tool_use) is not affected, and the
   * PermissionRequest hook path is exempt. In memory only.
   */
  private readonly terminalPromptQuiet = new Map<string, { until: number; dialogKey: string }>();
  /** Panes with a `terminal_prompt` creation (screen read) in flight. */
  private readonly terminalPromptReads = new Set<string>();
  /**
   * Per pane, bumped by every `expireForSession` (pane-gone included — never
   * deleted, so a creation that straddled the pane's death can never match
   * again). A creation whose screen read straddled a sweep is dropped rather
   * than raising a card for a dialog that is already gone.
   */
  private readonly sweepSeq = new Map<string, number>();
  /** Per pane: the pending refresh after a key/click (see noteFenceInput). */
  private readonly refreshTimers = new Map<string, () => void>();
  /**
   * Per pane: the last PermissionRequest hook's call (see PermissionEvidence).
   * Set by a hook note, dropped by every sweep of the pane's records.
   */
  private readonly permissionEvidence = new Map<string, PermissionEvidence[]>();
  /**
   * Native requests (`adapter|requestId`) whose answer is on its way to the
   * agent's server. Keyed by the agent's request, not the record, so two
   * records for one request can never both reply. In memory only.
   */
  private readonly nativeClaims = new Set<string>();
  /**
   * A sweep that reached a record while its stepwise answer was running: held
   * (the driver's own keys make the screen look answered) and applied if the
   * answer stops partway. Record id → the sweep's reason. In memory only.
   */
  private readonly deferredExpiry = new Map<string, ApprovalExpiryReason>();
  /** Native requests that left `pending` recently (`adapter|requestId` → when). */
  private readonly nativeSettled = new Map<string, number>();

  constructor(deps: ApprovalRegistryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());

    // Load + INVALIDATE. Every pending request that survived to disk is stale
    // by definition: we only get here on a daemon start, the panes are being
    // recovered around us, and a recovered session is a brand-new PTY with a
    // brand-new agent process. Pressing a remembered approval into it would
    // deliver a keystroke to a program that never asked the question. So the
    // recovery rule is unconditional — expire them all, keep them as history.
    //
    // Keep it unconditional. A "the PTY survived, keep the pending" optimisation
    // would look harmless and would quietly remove the guarantee two other things
    // lean on: that a create lost to a crash before its write landed is harmless
    // (the survivor set is emptied anyway), and that no remembered keystroke can
    // ever reach a process that did not ask the question.
    const loaded = loadApprovalState(deps.wmuxDir);
    let invalidated = 0;
    this.requests = trimHistory(
      loaded.requests.map((r) => {
        if (r.state !== 'pending') return r;
        invalidated++;
        // A stepwise answer cut off by the restart: some of its keys may have
        // landed. Expired (no `pressedAt`), and said so.
        if (r.step) deps.log?.('info', `[approvals] expired ${r.id} with its answer at step ${r.step.index}/${r.step.total} (partial-at-restart)`);
        // A terminal_prompt whose answer was already written counts as
        // resolved: the key reached the old PTY.
        return {
          ...r,
          // A step the restart cut off mid-run: some keys may have landed.
          ...(r.step?.status === 'running' ? { step: { ...r.step, status: 'partial' as const } } : {}),
          state: r.pressedAt !== undefined ? 'resolved' as const : 'expired' as const,
          resolvedAt: this.now(),
        };
      }),
    );
    if (invalidated > 0) {
      this.deps.log?.(
        'info',
        `[approvals] invalidated ${invalidated} pending request(s) — a restarted daemon has new PTYs`,
      );
      // No 'expire' events: construction happens before anything can subscribe,
      // and a phone reconnecting fetches the list anyway. Pushed onto the chain
      // rather than fired directly so it cannot race the first real mutation's
      // write over the same file.
      this.chain = this.chain.then(() => this.persist()).catch(() => undefined);
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  list(): ApprovalListResult {
    const pending: ApprovalRequest[] = [];
    const terminal: ApprovalRequest[] = [];
    for (const r of this.requests) {
      (r.state === 'pending' ? pending : terminal).push(copyRequest(r));
    }
    pending.sort((a, b) => a.createdAt - b.createdAt);
    terminal.sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt));
    return { pending, recentlyResolved: terminal };
  }

  /**
   * The full command a PENDING bound `terminal_prompt` is about, for
   * `GET /api/approvals/:id/detail`. Null for anything else.
   */
  terminalPromptDetail(id: string): TerminalPromptDetail | null {
    const record = this.requests.find((r) => r.id === id);
    if (!record || record.kind !== 'terminal_prompt' || record.state !== 'pending' || isNative(record)) return null;
    const call = record.promptFingerprint ? identityOf(record)?.call : undefined;
    if (!call) return null;
    const full = Buffer.from(call.command, 'utf8');
    let command = call.command;
    const truncated = full.length > TERMINAL_PROMPT_DETAIL_MAX_BYTES;
    if (truncated) {
      // Cut on a character boundary: drop a partial trailing UTF-8 sequence.
      command = full.subarray(0, TERMINAL_PROMPT_DETAIL_MAX_BYTES).toString('utf8').replace(/\uFFFD+$/, '');
    }
    return {
      id: record.id,
      ...(record.toolName ? { toolName: record.toolName } : {}),
      command,
      commandHash: crypto.createHash('sha256').update(full).digest('hex'),
      commandBytes: full.length,
      truncated,
    };
  }

  /** Count only — skips the copy+sort `list()` does for callers that just need a number. */
  pendingCount(): number {
    let count = 0;
    for (const r of this.requests) if (r.state === 'pending') count++;
    return count;
  }

  onEvent(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Hook-sourced lifecycle (called by HookIngest) ─────────────────────────

  /**
   * A hook said this pane is waiting on a human. Fire-and-forget by contract:
   * the caller is on the hook bridge's 2 s budget and must not wait for our
   * disk write. Enqueued on the mutation chain, so it is still strictly
   * ordered against every resolve/expire.
   *
   * One pending request per session: an existing one is SUPERSEDED rather than
   * left beside the new one. A second question on the same pane means the first
   * is no longer what is on screen, and two pending records for one pane would
   * let a phone answer the wrong one.
   *
   * Returns the settled promise ONLY so tests and the dynamic harness can wait
   * for the disk write; `ApprovalHookSink` types it as `void` because no
   * production caller may depend on it (the hook path must not block).
   */
  noteHookAwaitingInput(input: {
    sessionId: string;
    agent: string;
    workspaceId?: string;
    question?: string;
    options?: string[];
    choices?: Array<{ key: string; label: string }>;
    questionShape?: QuestionShape;
    /** The agent's own request id behind this card (OpenCode `permId`). */
    requestId?: string;
  }): Promise<void> {
    // Snapshot BEFORE queuing. `mutate` runs the body after the chain drains,
    // which can be seconds later (a resolve ahead of it is holding the chain
    // through a screen re-read), and the body closed over the caller's object —
    // so a caller that reused or mutated it in the meantime could have this
    // record persisted against the wrong pane or question. Nothing does that
    // today; the contract should not depend on that staying true.
    const snapshot = {
      sessionId: input.sessionId,
      agent: input.agent,
      workspaceId: input.workspaceId,
      question: input.question,
      options: input.options ? [...input.options] : undefined,
      choices: input.choices ? input.choices.map((c) => ({ ...c })) : undefined,
      questionShape: input.questionShape,
      requestId: input.requestId,
    };
    return this.mutate(() => {
      // A Codex pane whose approval is already up as a native decision: the
      // hook's question-less card would be a second card for the same prompt.
      if (!snapshot.question && this.shadowsCodexDecision(snapshot.sessionId, snapshot.agent)) return [];
      // A native decision is the agent's own request, settled by its server:
      // a screen-backed question on the same pane never replaces it.
      const superseded = this.requests.find(
        (r) => r.state === 'pending' && r.sessionId === snapshot.sessionId && !isNative(r),
      );
      const events: ApprovalEvent[] = [];
      if (superseded) {
        superseded.state = 'superseded';
        superseded.resolvedAt = this.now();
        if (superseded.kind === 'awaiting_permission') {
          this.deps.notifyGateDropped?.(superseded.id);
        }
        events.push({ type: 'supersede', request: copyRequest(superseded) });
      }
      const created: ApprovalRequest = {
        id: this.newId(),
        sessionId: snapshot.sessionId,
        ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
        agent: snapshot.agent,
        kind: 'awaiting_input',
        // A4 — the question the operator is being asked to answer. Absent when
        // the envelope carried no usable shape; never a reason to skip the
        // request.
        ...(snapshot.question ? { question: snapshot.question } : {}),
        ...(snapshot.options && snapshot.options.length > 0 ? { options: [...snapshot.options] } : {}),
        ...(snapshot.choices && snapshot.choices.length > 0 ? { choices: snapshot.choices.map((c) => ({ ...c })) } : {}),
        ...(snapshot.questionShape ? { questionShape: snapshot.questionShape } : {}),
        ...(snapshot.requestId ? { hookRequestId: snapshot.requestId } : {}),
        // Danger HINT for UI step-up, computed once at creation from the same
        // pattern list the PTY critical-action scanner uses. A miss or a false
        // positive changes nothing about whether this request can be answered.
        ...(hasCriticalRisk(snapshot.question, ...(snapshot.options ?? []))
          ? { risk: 'critical' as const }
          : {}),
        createdAt: this.now(),
        state: 'pending',
      };
      this.requests.push(created);
      events.push({ type: 'create', request: copyRequest(created) });
      return events;
    });
  }

  /**
   * #783 — create a pending permission-gate record. Same supersede rule as
   * `noteHookAwaitingInput`: one pending record per session, so a new gate
   * supersedes an existing one (the old tool call is moot once a new one is
   * pending). Returns the id SYNCHRONOUSLY so the caller can register the
   * GateBroker waiter before the mutation even reaches disk.
   */
  noteGateAwaiting(input: {
    sessionId: string;
    agent: string;
    workspaceId?: string;
    toolName: string;
    toolInputSummary?: string;
  }): string {
    const id = this.newId();
    const snapshot = {
      id,
      sessionId: input.sessionId,
      agent: input.agent,
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      toolInputSummary: input.toolInputSummary,
    };
    this.mutate(() => {
      // One-pending-per-session holds for SCREEN-backed prompts: a pane shows
      // one question at a time, so a newer one replaced the older. Gates are
      // different — the agent can call several gated tools in one turn, and
      // each blocks its own bridge process. Superseding one would silently drop
      // that tool to the local prompt while the phone operator, watching only
      // the phone, sees nothing (review: Claude). So a gate never supersedes
      // another gate; it only replaces a screen-backed prompt.
      const superseded = this.requests.find(
        (r) => r.state === 'pending'
          && r.sessionId === snapshot.sessionId
          && r.kind !== 'awaiting_permission'
          && !isNative(r),
      );
      const events: ApprovalEvent[] = [];
      if (superseded) {
        superseded.state = 'superseded';
        superseded.resolvedAt = this.now();
        events.push({ type: 'supersede', request: copyRequest(superseded) });
      }
      const created: ApprovalRequest = {
        id: snapshot.id,
        sessionId: snapshot.sessionId,
        ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
        agent: snapshot.agent,
        kind: 'awaiting_permission',
        toolName: snapshot.toolName,
        ...(snapshot.toolInputSummary ? { toolInputSummary: snapshot.toolInputSummary } : {}),
        createdAt: this.now(),
        // No `deadlineAt` here on purpose. The record is created BEFORE the
        // broker arms its timer, and that timer runs for min(the bridge's own
        // remaining budget, the cap) — so a deadline invented here would be a
        // countdown to a moment nothing happens at. The broker reports the real
        // one through `noteGateDeadline`.
        state: 'pending',
      };
      this.requests.push(created);
      events.push({ type: 'create', request: copyRequest(created) });
      return events;
    });
    return id;
  }

  /**
   * Record a decision the agent's OWN server holds (an OpenCode permission or
   * question, a Codex approval) as a `native-rpc` record. Its answer goes back
   * to that server through `answerNative`, never into the pane.
   *
   * Idempotent per `(sessionId, adapter, requestId)`: the same request again
   * with the same form is a no-op, with a changed form it replaces the record
   * (`create` carries `replaces`). It never supersedes a screen-backed record
   * and is never superseded by one. At most NATIVE_DECISIONS_PER_SESSION_MAX
   * pending per pane. With the `native` kill switch off the record is created
   * on the `none` channel: an informational card, answered at the terminal.
   *
   * v1 projection (a client without `decision-v2`): a permission is a
   * `terminal_prompt` whose choices are exactly Yes/No and whose
   * `promptFingerprint` is the form's, so a shipped phone can answer it; a
   * question is an `awaiting_input` (one single-select question keeps its
   * choices, anything else carries `questionShape`). A `plan` form is never
   * native. Resolves to the record id, or null when nothing was recorded.
   *
   * The OpenCode reconcile (openCodeDecisions.ts) produces these; the Codex
   * relay does not yet.
   */
  noteNativeDecision(input: {
    sessionId: string;
    agent: string;
    workspaceId?: string;
    native: NativeDecisionRef;
    form: DecisionForm;
    /** The permission's own question line (a permission form needs one). */
    question?: string;
    toolName?: string;
    summary?: string;
  }): Promise<string | null> {
    const bounded = boundDecisionForm(input.form);
    const snapshot = {
      ...input,
      native: { ...input.native },
      question: boundRecordText(input.question, TERMINAL_PROMPT_SUMMARY_MAX),
      toolName: boundRecordText(input.toolName, TERMINAL_PROMPT_TOOL_NAME_MAX),
      summary: boundRecordText(input.summary, TERMINAL_PROMPT_SUMMARY_MAX),
    };
    return this.mutate<string | null>(() => {
      const { native } = snapshot;
      const form = bounded;
      if (!form) {
        this.deps.log?.('warn', `[approvals] native decision form out of bounds on ${snapshot.sessionId}`);
        return { result: null };
      }
      if (form.kind === 'plan') return { result: null };
      const question = form.kind === 'permission' ? snapshot.question : form.questions?.[0]?.text;
      if (!question) return { result: null };
      // Answered or gone a moment ago: a late re-notify (a reconcile racing
      // the answer) must not bring the card back.
      const settledAt = this.nativeSettled.get(nativeKey(native));
      if (settledAt !== undefined && this.now() - settledAt < NATIVE_SETTLED_MEMORY_MS) return { result: null };
      // Everything the card shows, and the agent's own hash of the whole
      // request: the same id asking something else is a different card.
      const formFingerprint = crypto.createHash('sha256')
        .update(`${nativeKey(native)}|${native.digest ?? ''}|${canonicalJson({
          form, question, toolName: snapshot.toolName ?? null, summary: snapshot.summary ?? null,
        })}`)
        .digest('hex')
        .slice(0, 32);
      const existing = this.requests.find((r) => r.state === 'pending' && r.sessionId === snapshot.sessionId
        && r.native !== undefined && nativeKey(r.native) === nativeKey(native));
      if (existing && existing.formFingerprint === formFingerprint) return { result: existing.id };
      const enabled = this.decisionChannels().native;
      if (!existing && this.requests.filter(
        (r) => r.state === 'pending' && r.sessionId === snapshot.sessionId && r.native !== undefined,
      ).length >= NATIVE_DECISIONS_PER_SESSION_MAX) {
        this.deps.log?.('warn', `[approvals] native decision cap reached on ${snapshot.sessionId}`);
        return { result: null };
      }
      const single = form.kind === 'questions' && form.questions?.length === 1 && !form.questions[0]!.multiSelect;
      // A shipped phone sends a 1–2 digit `choiceKey`; options keyed otherwise
      // are offered to a `decision-v2` client only.
      const digitKeys = single && form.questions![0]!.options.length > 0
        && form.questions![0]!.options.every((o) => /^\d{1,2}$/.test(o.key));
      const shape: QuestionShape | undefined = form.kind !== 'questions' || single
        ? undefined
        : (form.questions?.length ?? 0) > 1 ? 'multi-question' : 'multi-select';
      const created: ApprovalRequest = {
        id: this.newId(),
        sessionId: snapshot.sessionId,
        ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
        agent: snapshot.agent,
        kind: form.kind === 'permission' ? 'terminal_prompt' : 'awaiting_input',
        ...(snapshot.toolName ? { toolName: snapshot.toolName } : {}),
        ...(snapshot.summary ? { summary: snapshot.summary } : {}),
        ...(hasCriticalRisk(question, snapshot.summary) ? { risk: 'critical' as const } : {}),
        native,
        // Kept on every native record, switch on or off: it is what makes a
        // re-notify of the same request a no-op instead of a new card.
        formFingerprint,
        ...(enabled
          ? {
              channel: 'native-rpc' as const,
              form,
              question,
              ...(form.kind === 'permission'
                ? { choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], promptFingerprint: formFingerprint }
                : digitKeys
                  ? { choices: form.questions![0]!.options.map((o) => ({ ...o })) }
                  : { ...(shape ? { questionShape: shape } : {}) }),
            }
          : { channel: 'none' as const }),
        createdAt: this.now(),
        state: 'pending',
      };
      const events: ApprovalEvent[] = [];
      if (existing) {
        existing.state = 'superseded';
        existing.resolvedAt = this.now();
        events.push({ type: 'supersede', request: copyRequest(existing) });
      }
      // Codex's PermissionRequest hook runs before its server asks: the
      // question-less card it left for this same prompt is replaced.
      if (native.adapter === 'codex' && created.channel === 'native-rpc') {
        for (const r of this.requests) {
          if (r.state !== 'pending' || r.sessionId !== snapshot.sessionId || !this.isCodexHookCard(r)) continue;
          r.state = 'superseded';
          r.resolvedAt = this.now();
          events.push({ type: 'supersede', request: copyRequest(r) });
        }
      }
      this.requests.push(created);
      events.push({ type: 'create', request: copyRequest(created), ...(existing ? { replaces: existing.id } : {}) });
      return { events, result: created.id };
    });
  }

  /** A Codex hook's `awaiting_input` card: no question, nothing native. */
  private isCodexHookCard(r: ApprovalRequest): boolean {
    return r.kind === 'awaiting_input' && r.agent === 'codex' && !isNative(r) && !r.question;
  }

  /** A Codex hook card here would duplicate a pending native Codex decision. */
  private shadowsCodexDecision(sessionId: string, agent: string): boolean {
    return agent === 'codex' && this.requests.some((r) => r.state === 'pending' && r.sessionId === sessionId
      && r.native?.adapter === 'codex' && r.channel === 'native-rpc');
  }

  /**
   * The agent's own server says these requests are no longer open (answered
   * in its terminal, or gone): the reconcile's list form of `expireNative`,
   * keyed by request id within one adapter. Unlike the screen-inferred
   * reasons this is the agent's word about its own request, so it settles
   * native records — and only those. Resolves to how many were expired.
   */
  expireNativeRequests(sessionId: string, adapter: NativeDecisionRef['adapter'], requestIds: readonly string[]): Promise<number> {
    const ids = new Set(requestIds);
    return this.mutate<number>(() => {
      const events: ApprovalEvent[] = [];
      for (const r of this.requests) {
        if (r.state !== 'pending' || r.sessionId !== sessionId || r.native?.adapter !== adapter || !ids.has(r.native.requestId)) continue;
        r.state = 'expired';
        r.resolvedAt = this.now();
        events.push({ type: 'expire', request: copyRequest(r) });
      }
      if (events.length > 0) {
        this.deps.log?.('info', `[approvals] expired ${events.length} native request(s) the agent no longer holds on ${sessionId}`);
      }
      return { events, result: events.length };
    });
  }

  /**
   * Expire a pane's informational `awaiting_input` cards (never a native
   * record) for these agent request ids — the agent answered them, or a native
   * record now stands for them. `unkeyed` also takes cards that carry no id
   * (an older bridge sent none). Resolves to how many were expired.
   */
  expireHookAwaiting(sessionId: string, requestIds: readonly string[], unkeyed = false): Promise<number> {
    const ids = new Set(requestIds);
    return this.mutate<number>(() => {
      const events = this.expirePendingWhere(
        (r) => r.sessionId === sessionId && r.kind === 'awaiting_input' && !isNative(r)
          && (r.hookRequestId !== undefined ? ids.has(r.hookRequestId) : unkeyed),
        'answered-locally',
      );
      return { events, result: events.length };
    });
  }

  private decisionChannels(): PhoneDecisionsConfig {
    try {
      return this.deps.phoneDecisions?.() ?? { native: true, stepwise: true };
    } catch {
      // An unreadable config must not turn on a channel the operator turned off.
      return { native: false, stepwise: false };
    }
  }

  /**
   * The agent's own terminal dialog is on this pane (Claude Code's permission
   * prompt — a PermissionRequest hook, or detector attention that survived its
   * confirmation window). Reads the screen, parses the dialog, binds it to the
   * tool call it is for, and records it as `kind:'terminal_prompt'`.
   *
   * ANSWERABLE only when all of it lines up: a whole, active dialog with a
   * plain Yes, bound to the pane's pending tool call — the transcript's latest
   * unanswered `tool_use` (or the PermissionRequest hook's own input) with the
   * same tool and exactly the command the dialog shows. Then the record carries
   * `question`, `reason`, the plain Yes/No `choices` and a `promptFingerprint`
   * that includes the `tool_use` id. Anything else — detector-only with no
   * binding, a command that does not match — is informational for everyone.
   *
   * Created only when nothing is pending on the pane, with one exception (see
   * `staleQuestionFor`): a hook-reported dialog for another tool supersedes a
   * pending AskUserQuestion record, which it proves is no longer on screen. A
   * detector-found record is also refused for the same dialog the screen check
   * released within the cooldown. Never rejects: failures are logged.
   */
  async noteTerminalPrompt(input: TerminalPromptNote): Promise<void> {
    try {
      await this.noteTerminalPromptInner({ ...input });
    } catch (err) {
      this.deps.log?.('warn', `[approvals] terminal prompt record failed for ${input.sessionId}: ${String(err)}`);
    }
  }

  private async noteTerminalPromptInner(note: TerminalPromptNote): Promise<void> {
    const { sessionId } = note;
    if (!isClaudeFamilyAgent(note.agent)) return;
    if (note.source === 'hook' && this.notePermissionEvidence(note)) {
      // A record already up for this dialog (the detector saw it first, or the
      // transcript lagged) gets another look now that the hook's proof is in.
      const stale = this.requests.find((r) => r.state === 'pending' && r.sessionId === sessionId
        && r.kind === 'terminal_prompt' && !r.promptFingerprint && r.pressedAt === undefined && !isNative(r));
      if (stale && this.deps.readPromptScreen) {
        this.upgradeTerminalPromptLater(note, stale.id).catch((err: unknown) => {
          this.deps.log?.('warn', `[approvals] terminal prompt upgrade failed for ${sessionId}: ${String(err)}`);
        });
      }
    }
    if (this.terminalPromptReads.has(sessionId)) return;
    // Pinned BEFORE any await: only this record may be superseded below. A
    // question created while the screen is read is a new one, not stale.
    const staleId = this.staleQuestionFor(note)?.id;
    if (this.hasPending(sessionId) && !staleId) return;
    this.terminalPromptReads.add(sessionId);
    const seq = this.sweepSeq.get(sessionId) ?? 0;
    try {
      const read = await this.readDialogForCreation(sessionId);
      const binding = this.bindingFor(sessionId, note);
      // The question must be proven gone from the screen, not just outlived by
      // a hook: a subagent's permission request can arrive while the lead
      // turn's question is still up.
      const staleGone = staleId ? await this.questionGone(sessionId, staleId) : false;
      let created: ApprovalRequest | null = null;
      await this.mutate(() => {
        const candidate = this.staleQuestionFor(note);
        const stale = candidate && candidate.id === staleId && staleGone ? candidate : undefined;
        if (this.hasPending(sessionId) && !stale) return [];
        if ((this.sweepSeq.get(sessionId) ?? 0) !== seq) return [];
        // The pane must still be alive at the moment the record is minted.
        if (this.deps.promptScreenMark && this.deps.promptScreenMark(sessionId) === null) return [];
        const record = this.buildTerminalPrompt(note, read, binding);
        if (note.source !== 'hook' && this.inCooldown(sessionId, record.dialogKey)) return [];
        const events: ApprovalEvent[] = [];
        if (stale) {
          stale.state = 'superseded';
          stale.resolvedAt = this.now();
          events.push({ type: 'supersede', request: copyRequest(stale) });
          this.deps.log?.(
            'info',
            `[approvals] superseded stale question ${stale.id} on ${sessionId}: ` +
              `a ${logText(note.toolName ?? 'permission', 40)} dialog replaced it`,
          );
        }
        this.requests.push(record);
        created = record;
        events.push({ type: 'create', request: copyRequest(record) });
        return events;
      });
      const record: ApprovalRequest | null = created;
      if (record && !(record as ApprovalRequest).promptFingerprint && this.deps.readPromptScreen) {
        this.upgradeTerminalPromptLater(note, (record as ApprovalRequest).id).catch((err: unknown) => {
          this.deps.log?.('warn', `[approvals] terminal prompt upgrade failed for ${sessionId}: ${String(err)}`);
        });
      }
    } finally {
      this.terminalPromptReads.delete(sessionId);
    }
  }

  /**
   * Remember that the PermissionRequest hook fired for this call — only when
   * its Claude `session_id` is the pane's own agent session. Returns whether
   * it was kept.
   */
  private notePermissionEvidence(note: TerminalPromptNote): boolean {
    if (!note.toolInput || !note.toolName || !note.hookSessionId) return false;
    let own: string | null = null;
    try {
      own = this.deps.agentSessionId?.(note.sessionId) ?? null;
    } catch {
      own = null;
    }
    if (!own || own !== note.hookSessionId) return false;
    const mark = this.deps.promptScreenMark?.(note.sessionId) ?? null;
    const list = this.permissionEvidence.get(note.sessionId) ?? [];
    list.push({
      name: note.toolName,
      input: note.toolInput,
      inputHash: toolInputHash(note.toolInput),
      ...(note.promptId ? { promptId: note.promptId } : {}),
      mark: mark ? { keyInputRevision: mark.keyInputRevision, incarnation: mark.incarnation } : null,
      at: this.now(),
    });
    this.permissionEvidence.set(note.sessionId, list);
    return true;
  }

  /**
   * A `terminal_prompt` record settled: its PermissionRequest is no longer
   * pending. Drop every piece of evidence that is its (the same whole input)
   * or older than it; a hook that arrived after it was minted, for another
   * call, is the next dialog's and stays.
   */
  private pruneEvidence(record: ApprovalRequest): void {
    const list = this.permissionEvidence.get(record.sessionId);
    if (!list) return;
    const hash = identityOf(record)?.call?.inputHash;
    const kept = list.filter((e) => e.at > record.createdAt && e.inputHash !== hash);
    if (kept.length > 0) this.permissionEvidence.set(record.sessionId, kept);
    else this.permissionEvidence.delete(record.sessionId);
  }

  /** The ONE pending PermissionRequest on this pane, or null (none, or two at once). */
  private soleEvidence(sessionId: string): PermissionEvidence | null {
    const list = this.permissionEvidence.get(sessionId) ?? [];
    return list.length === 1 ? list[0]! : null;
  }

  /** Does the pane's one pending PermissionRequest name exactly this call? */
  private evidenceAgrees(sessionId: string, binding: { name: string; input: Record<string, unknown> }): boolean {
    const evidence = this.soleEvidence(sessionId);
    return !!evidence && evidence.name === binding.name && evidence.inputHash === toolInputHash(binding.input);
  }

  /**
   * Look again at a pane whose record was created without an answerable
   * parse: the PermissionRequest hook can land before the dialog is drawn.
   * When it is now answerable, the record is replaced — `create` with
   * `replaces`, so the push carries over rather than firing twice.
   */
  private async upgradeTerminalPromptLater(note: TerminalPromptNote, id: string): Promise<void> {
    const delay = this.deps.promptReadDelay
      ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    const stillStale = (): ApprovalRequest | undefined => this.requests.find(
      (r) => r.id === id && r.state === 'pending' && !r.promptFingerprint && r.pressedAt === undefined,
    );
    for (let attempt = 0; attempt < TERMINAL_PROMPT_UPGRADE_READS; attempt++) {
      await delay(TERMINAL_PROMPT_UPGRADE_GAP_MS);
      if (!stillStale()) return;
      const read = await this.readActiveDialog(note.sessionId);
      if (!read) continue;
      const fresh = this.buildTerminalPrompt(note, read, this.bindingFor(note.sessionId, note));
      if (!fresh.promptFingerprint) continue;
      await this.mutate(() => {
        const stale = stillStale();
        if (!stale) return [];
        stale.state = 'superseded';
        stale.resolvedAt = this.now();
        fresh.createdAt = this.now();
        this.requests.push(fresh);
        return [
          { type: 'supersede', request: copyRequest(stale) },
          { type: 'create', request: copyRequest(fresh), replaces: stale.id },
        ];
      });
      return;
    }
  }

  /**
   * A key, click, release or wheel reached this pane. A pending answerable
   * `terminal_prompt` it overtook is refreshed once the input settles, so the
   * phone's list is current BEFORE anyone taps: a new record (new id, new
   * fingerprint, the reflex guard restarted) replaces it, provided the same
   * dialog is still up. At most one refresh per record every
   * TERMINAL_PROMPT_REFRESH_MIN_GAP_MS, so key auto-repeat cannot flood SSE.
   * Cheap for every other pane: one scan of the pending records.
   */
  noteFenceInput(sessionId: string): void {
    if (!this.answerablePrompt(sessionId)) return;
    this.scheduleRefresh(sessionId, TERMINAL_PROMPT_REFRESH_SETTLE_MS);
  }

  private answerablePrompt(sessionId: string): ApprovalRequest | undefined {
    return this.requests.find((r) => r.state === 'pending' && r.sessionId === sessionId
      && r.kind === 'terminal_prompt' && !!r.promptFingerprint && r.pressedAt === undefined && !r.step && !isNative(r));
  }

  private scheduleRefresh(sessionId: string, delayMs: number): void {
    this.refreshTimers.get(sessionId)?.();
    const schedule = this.deps.schedule ?? ((fn: () => Promise<void>, ms: number) => {
      const t = setTimeout(() => { void fn(); }, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });
    this.refreshTimers.set(sessionId, schedule(() => {
      this.refreshTimers.delete(sessionId);
      return this.refreshTerminalPrompt(sessionId).catch((err: unknown) => {
        this.deps.log?.('warn', `[approvals] terminal prompt refresh failed for ${sessionId}: ${String(err)}`);
      });
    }, delayMs));
  }

  private async refreshTerminalPrompt(sessionId: string): Promise<void> {
    const record = this.answerablePrompt(sessionId);
    if (!record) return;
    const age = this.now() - record.createdAt;
    if (age < TERMINAL_PROMPT_REFRESH_MIN_GAP_MS) {
      this.scheduleRefresh(sessionId, TERMINAL_PROMPT_REFRESH_MIN_GAP_MS - age);
      return;
    }
    const current = this.deps.promptScreenMark?.(sessionId) ?? null;
    if (!current || current.keyInputRevision === record.keyRevisionAtCreate) return;
    // Only a dialog still up is refreshed; one the input dismissed is left to
    // the answered path and the screen check, as before.
    const live = await this.readActiveDialog(sessionId);
    if (!live) return;
    await this.supersedeWithFresh(record, live);
  }

  /**
   * The pane's lone pending AskUserQuestion record, as a CANDIDATE for being
   * retired by another dialog — never retired on this alone.
   *
   * Esc on an AskUserQuestion rejects the tool: Claude Code sends no
   * PostToolUse for it and no Stop for the interrupt, so its `awaiting_input`
   * record stayed pending for the rest of the session (measured on 2.1.283),
   * and the next permission dialog found the pane "pending" and got no record.
   * A candidate is superseded only when a screen read proves its question is
   * gone (`questionGone`), so a subagent's permission request that lands while
   * the question is still up changes nothing.
   *
   * Only a lone `awaiting_input` qualifies — a gate or another terminal prompt
   * keeps today's first-record-wins rule — and never for the question's own
   * PermissionRequest (Claude fires it ~50 ms after the question's PreToolUse).
   */
  private staleQuestionFor(note: TerminalPromptNote): ApprovalRequest | undefined {
    if (note.toolName === 'AskUserQuestion') return undefined;
    const pending = this.requests.filter((r) => r.state === 'pending' && r.sessionId === note.sessionId && !isNative(r));
    return pending.length === 1 && pending[0].kind === 'awaiting_input' ? pending[0] : undefined;
  }

  /**
   * True only when a fresh screen read shows the record's question is NOT on
   * screen (`questionOnScreen` → `absent`). Unreadable, unprovable, or still
   * there → false: a live question is never retired on a guess.
   */
  private async questionGone(sessionId: string, id: string): Promise<boolean> {
    const record = this.requests.find((r) => r.id === id);
    if (!record || record.state !== 'pending') return false;
    const rows = await this.safeReadScreen(sessionId);
    return !!rows && rows.length > 0 && questionOnScreen(rows, record) === 'absent';
  }

  /**
   * Retire the pane's pending AskUserQuestion record when its question has
   * left the screen. HookIngest calls this when the agent starts another tool
   * (the permission gate's PreToolUse): that tool may belong to a subagent
   * while the question is still up, so the screen decides. Never rejects.
   */
  async retireStaleQuestion(sessionId: string): Promise<void> {
    try {
      const candidate = this.staleQuestionFor({ sessionId, agent: '', source: 'hook' });
      if (!candidate) return;
      const id = candidate.id;
      if (!(await this.questionGone(sessionId, id))) return;
      await this.mutate(() => this.expirePendingWhere((r) => r.id === id, 'prompt-gone'));
    } catch (err) {
      this.deps.log?.('warn', `[approvals] stale question check failed for ${sessionId}: ${String(err)}`);
    }
  }

  /** Screen-backed records only: a native decision does not hold the pane's screen. */
  private hasPending(sessionId: string): boolean {
    return this.requests.some((r) => r.state === 'pending' && r.sessionId === sessionId && !isNative(r));
  }

  private inCooldown(sessionId: string, dialogKey: string | undefined): boolean {
    const quiet = this.terminalPromptQuiet.get(sessionId);
    return !!quiet && this.now() < quiet.until && quiet.dialogKey === (dialogKey ?? '');
  }

  /**
   * The tool call the dialog should be for: the transcript's pending
   * `tool_use` first (it is the agent's own record, and its id binds one
   * dialog instance), else the pane's ONE pending PermissionRequest (the
   * hook's `tool_input`; Claude Code 2.1.283 often writes the `tool_use` to
   * the transcript only after the dialog is answered). A note's own input
   * that is not such evidence (another session, two pending) is a label for
   * the card, never a binding.
   */
  private bindingFor(sessionId: string, note: TerminalPromptNote): ToolCallBinding | null {
    let pending: PendingToolUse | null = null;
    try {
      pending = this.deps.pendingToolUse?.(sessionId) ?? null;
    } catch (err) {
      this.deps.log?.('warn', `[approvals] transcript read failed for ${sessionId}: ${String(err)}`);
    }
    if (pending) {
      return {
        id: pending.id,
        name: pending.name,
        input: pending.input,
        ...(pending.unanswered !== undefined ? { unanswered: pending.unanswered } : {}),
      };
    }
    const evidence = this.soleEvidence(sessionId);
    if (evidence) {
      return { name: evidence.name, input: evidence.input, ...(evidence.promptId ? { promptId: evidence.promptId } : {}) };
    }
    if (note.toolInput && note.toolName) return { name: note.toolName, input: note.toolInput, unbindable: true };
    return null;
  }

  /**
   * The ACTIVE dialog on the pane's screen, or null. Read a few times: the
   * PermissionRequest hook can land before the dialog is drawn.
   */
  private async readDialogForCreation(sessionId: string): Promise<DialogRead | null> {
    if (!this.deps.readPromptScreen) return null;
    const delay = this.deps.promptReadDelay
      ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    for (let attempt = 1; attempt <= TERMINAL_PROMPT_CREATE_READS; attempt++) {
      const read = await this.readActiveDialog(sessionId);
      if (read) return read;
      if (attempt < TERMINAL_PROMPT_CREATE_READS) await delay(TERMINAL_PROMPT_CREATE_READ_GAP_MS);
    }
    return null;
  }

  /** One screen read, parsed. Outside the mutation chain: a render can take seconds. */
  private async readActiveDialog(sessionId: string): Promise<DialogRead | null> {
    let screen: { rows: readonly string[]; mark: PromptScreenMark; cols?: number } | null = null;
    try {
      screen = (await this.deps.readPromptScreen?.(sessionId)) ?? null;
    } catch (err) {
      this.deps.log?.('warn', `[approvals] prompt screen read failed for ${sessionId}: ${String(err)}`);
    }
    if (!screen) return null;
    const opts = screen.cols ? { cols: screen.cols } : {};
    const parsed = parseTerminalPrompt(screen.rows, opts);
    const geometry = { ...(screen.cols ? { cols: screen.cols } : {}), height: screen.rows.length };
    if (parsed && parsed.active) return { parsed, mark: screen.mark, ...geometry };
    // Claude's ExitPlanMode dialog has a shape of its own (see parsePlanPrompt).
    const plan = parsePlanPrompt(screen.rows, opts);
    return plan && plan.active ? { parsed: plan, mark: screen.mark, ...geometry } : null;
  }

  /** A fresh `terminal_prompt` record from what was read and what it binds to. */
  private buildTerminalPrompt(
    note: TerminalPromptNote,
    read: DialogRead | null,
    binding: ToolCallBinding | null,
  ): ApprovalRequest {
    if (read?.parsed.plan) return this.buildPlanPrompt(note, read, binding);
    const parsed = read?.parsed ?? null;
    const command = binding ? commandOfToolInput(binding.name, binding.input) : undefined;
    const description = typeof binding?.input['description'] === 'string' ? binding.input['description'] : undefined;
    const toolName = binding?.name ?? note.toolName ?? toolFromDialogTitle(parsed?.title);
    // The call's own input is the source of the summary; the screen only when
    // there is no call to read it from.
    const summary = boundRecordText(command, TERMINAL_PROMPT_SUMMARY_MAX)
      ?? (parsed ? boundRecordText(parsed.commandText, TERMINAL_PROMPT_SUMMARY_MAX) : undefined)
      ?? note.summary;
    // The summary is capped for display; the binding takes the WHOLE command.
    const call = binding && command && !binding.unbindable
      ? { name: binding.name, command, ...(description ? { description } : {}) }
      : null;
    const topCut = !!parsed && !parsed.topRuleFound;
    const mark = read?.mark ?? this.deps.promptScreenMark?.(note.sessionId) ?? null;
    const bound = !!parsed && !!binding && !!call && (binding.id
      // By the transcript's own call id. The hook's evidence, when there is
      // any, must name the same call. A dialog whose top scrolled off also
      // needs that evidence and the call to be provably the only one pending:
      // an unanswered tool_use is also what a RUNNING tool looks like, and its
      // output can print a question, options and a footer under its tail.
      ? ((this.permissionEvidence.get(note.sessionId) ?? []).length === 0 || this.evidenceAgrees(note.sessionId, binding))
        && (parsed.topRuleFound
          ? dialogMatchesToolCall(parsed, call)
          : binding.unanswered === 1
            && this.evidenceAgrees(note.sessionId, binding)
            && dialogMatchesToolCall(parsed, call, { topCut: true }))
      // By the pane's ONE pending PermissionRequest (bindingFor): the dialog's
      // title names its tool, no key reached the pane and the PTY is the same
      // since the hook arrived, and the rows spell the hook's whole command.
      : this.evidenceAgrees(note.sessionId, binding)
        && !!mark && !!this.soleEvidence(note.sessionId)?.mark
        && this.soleEvidence(note.sessionId)!.mark!.keyInputRevision === mark.keyInputRevision
        && this.soleEvidence(note.sessionId)!.mark!.incarnation === mark.incarnation
        && toolFromDialogTitle(parsed.title) === binding.name
        && dialogMatchesToolCall(parsed, call, { topCut })
    );
    const answer = bound ? terminalPromptAnswerability(parsed) : null;
    const answerable = !!answer?.answerable;
    const risky = terminalPromptTextRisk(command, summary, parsed?.reason);
    const inputHash = binding && !binding.unbindable ? toolInputHash(binding.input) : undefined;
    const record: WithIdentity = {
      id: this.newId(),
      sessionId: note.sessionId,
      ...(note.workspaceId ? { workspaceId: note.workspaceId } : {}),
      agent: note.agent,
      kind: 'terminal_prompt',
      ...(toolName ? { toolName } : {}),
      ...(summary ? { summary } : {}),
      ...(risky ? { risk: 'critical' as const } : {}),
      ...(answerable && parsed && read
        ? {
            question: parsed.question,
            ...(parsed.reason ? { reason: parsed.reason } : {}),
            choices: answer!.choices,
            promptFingerprint: bindFingerprint(parsed.fingerprint, binding?.id, read.mark.keyInputRevision, inputHash),
            ...(binding?.id ? { toolUseId: binding.id } : {}),
            keyRevisionAtCreate: read.mark.keyInputRevision,
          }
        : {}),
      dialogKey: `${parsed?.fingerprint ?? '-'}|${binding?.id ?? '-'}`,
      createdAt: this.now(),
      state: 'pending',
    };
    // Non-enumerable: a spread copy (list results, event payloads) never
    // carries it, so the full command stays inside the registry.
    const identity: TerminalPromptIdentity = {
      ...(parsed ? { screenFp: parsed.fingerprint } : {}),
      ...(mark ? { mark: { keyInputRevision: mark.keyInputRevision, incarnation: mark.incarnation } } : {}),
      ...(call && inputHash
        ? {
            call: {
              ...call,
              ...(binding?.id ? { id: binding.id } : {}),
              ...(binding?.promptId ? { promptId: binding.promptId } : {}),
              inputHash,
            },
          }
        : {}),
      matched: bound,
      topCut: bound && topCut,
    };
    Object.defineProperty(record, IDENTITY, { value: identity, enumerable: false });
    return record;
  }

  /**
   * A `terminal_prompt` for Claude's ExitPlanMode dialog. Bound like a
   * permission dialog — to the transcript's pending `ExitPlanMode` call (the
   * hook's evidence, when there is any, naming the same call), or to the
   * pane's one pending PermissionRequest for it with no key since it arrived
   * — but the screen is not asked to spell the plan: the dialog shows it
   * rendered, and the call's whole input is in the fingerprint instead.
   *
   * Answerable (a `plan` form for `decision-v2` clients) only when bound, the
   * dialog was read whole and active, both the manual-approve row and the
   * feedback row are on it, no row would switch the session to bypass
   * permissions, and the `stepwise` channel is on. Never any `choices`: a
   * shipped phone keeps the informational card (and its decline).
   */
  private buildPlanPrompt(note: TerminalPromptNote, read: DialogRead, binding: ToolCallBinding | null): ApprovalRequest {
    const { parsed, mark } = read;
    const plan = parsed.plan!;
    const planText = typeof binding?.input['plan'] === 'string' ? binding.input['plan'] : undefined;
    const summary = boundRecordText(planText?.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, ''), TERMINAL_PROMPT_SUMMARY_MAX)
      ?? note.summary;
    const planCall = !!binding && !binding.unbindable && binding.name === 'ExitPlanMode';
    const evidence = this.soleEvidence(note.sessionId);
    const bound = planCall && (binding.id
      ? (this.permissionEvidence.get(note.sessionId) ?? []).length === 0 || this.evidenceAgrees(note.sessionId, binding)
      : this.evidenceAgrees(note.sessionId, binding)
        && !!evidence?.mark
        && evidence.mark.keyInputRevision === mark.keyInputRevision
        && evidence.mark.incarnation === mark.incarnation);
    const inputHash = planCall ? toolInputHash(binding.input) : undefined;
    const answerable = bound && parsed.active && !parsed.cut && !!plan.approve && !!plan.feedback && !plan.bypass
      && this.decisionChannels().stepwise;
    const fingerprint = answerable ? bindFingerprint(parsed.fingerprint, binding?.id, mark.keyInputRevision, inputHash) : undefined;
    const record: WithIdentity = {
      id: this.newId(),
      sessionId: note.sessionId,
      ...(note.workspaceId ? { workspaceId: note.workspaceId } : {}),
      agent: note.agent,
      kind: 'terminal_prompt',
      // The screen is a plan dialog, whatever call it failed to bind to.
      toolName: 'ExitPlanMode',
      ...(summary ? { summary } : {}),
      ...(answerable && fingerprint
        ? {
            question: parsed.question,
            channel: 'fenced-keys' as const,
            form: {
              v: 1 as const,
              kind: 'plan' as const,
              actions: [
                { id: PLAN_ACTION_APPROVE, label: plan.approve!.label },
                { id: PLAN_ACTION_FEEDBACK, label: plan.feedback!.label, needsText: true as const },
              ],
            },
            formFingerprint: fingerprint,
            // The same hash, so the paths that key on `promptFingerprint`
            // (the refresh after a key, decline's echo) treat it as bound.
            promptFingerprint: fingerprint,
            ...(binding?.id ? { toolUseId: binding.id } : {}),
            keyRevisionAtCreate: mark.keyInputRevision,
          }
        : {}),
      dialogKey: `${parsed.fingerprint}|${binding?.id ?? '-'}`,
      createdAt: this.now(),
      state: 'pending',
    };
    const identity: TerminalPromptIdentity = {
      screenFp: parsed.fingerprint,
      mark: { keyInputRevision: mark.keyInputRevision, incarnation: mark.incarnation },
      ...(planCall && inputHash
        ? {
            call: {
              name: binding.name,
              // The whole plan: what `GET /api/approvals/:id/detail` serves.
              command: planText ?? '',
              ...(binding.id ? { id: binding.id } : {}),
              ...(binding.promptId ? { promptId: binding.promptId } : {}),
              inputHash,
            },
          }
        : {}),
      matched: bound,
      topCut: false,
    };
    Object.defineProperty(record, IDENTITY, { value: identity, enumerable: false });
    return record;
  }

  /**
   * The turn this pane was blocked on is over (hook `agent.stop`), the pane
   * started a fresh session (`agent.session_start`), or the pane is gone. Any
   * pending request on it is answered-or-abandoned either way — nobody is
   * waiting on that keystroke anymore.
   *
   * `agent.subagent_stop` deliberately does NOT expire: a subagent finishing
   * says nothing about the main agent's question still sitting on screen.
   *
   * `kind` narrows the sweep to one record kind. A locally answered
   * AskUserQuestion says nothing about a permission gate the same turn opened
   * in parallel, and expiring one drops its waiter (see expirePendingWhere) —
   * the tool falls back to the local prompt while the phone operator, watching
   * only the phone, sees the card vanish. That is the exact harm the supersede
   * rule in noteHookAwaitingInput already refuses to cause; the sweep has to
   * refuse it too. Omitted ⇒ every kind, which is what the turn/pane-lifecycle
   * callers want.
   *
   * Returns the settled promise for the same reason noteHookAwaitingInput does.
   */
  expireForSession(
    sessionId: string,
    reason: ApprovalExpiryReason,
    kind?: ApprovalRequest['kind'],
  ): Promise<void> {
    // Stamped at call time. The cooldown remembers WHICH dialog was released,
    // so only a repeat of that same dialog is held back.
    this.sweepSeq.set(sessionId, (this.sweepSeq.get(sessionId) ?? 0) + 1);
    // The turn, the session or the pane is over: no PermissionRequest from it
    // is pending any more. (A dialog leaving the screen settles its record,
    // which prunes that record's own evidence — see pruneEvidence.)
    if (reason !== 'screen-cleared' && reason !== 'answered-locally' && reason !== 'prompt-gone') {
      this.permissionEvidence.delete(sessionId);
    }
    if (reason === 'screen-cleared') {
      const released = this.requests.find(
        (r) => r.state === 'pending' && r.sessionId === sessionId && r.kind === 'terminal_prompt' && !isNative(r),
      );
      const previous = this.terminalPromptQuiet.get(sessionId);
      const stillQuiet = previous && this.now() < previous.until ? previous.dialogKey : undefined;
      this.terminalPromptQuiet.set(sessionId, {
        until: this.now() + TERMINAL_PROMPT_COOLDOWN_MS,
        // No record to name (its re-creation was the one held back): keep the
        // dialog the window is already about.
        dialogKey: released?.dialogKey ?? stillQuiet ?? '',
      });
    } else if (reason === 'pane-gone') {
      this.terminalPromptQuiet.delete(sessionId);
      this.refreshTimers.get(sessionId)?.();
      this.refreshTimers.delete(sessionId);
    }
    return this.mutate(() => this.expirePendingWhere(
      (r) => r.sessionId === sessionId && (kind === undefined || r.kind === kind),
      reason,
    ));
  }

  /**
   * Expire ONE record by id. The gate broker calls this when it defers a gate
   * (#783): the tool has already fallen through to the local prompt, so the
   * card must stop being answerable — otherwise a late tap gets a success
   * receipt for a decision that changed nothing. Runs through the same
   * serialized CAS, so a phone answer that already won finds nothing pending.
   */
  expireById(id: string, reason: ApprovalExpiryReason): Promise<void> {
    return this.mutate(() => this.expirePendingWhere((r) => r.id === id, reason));
  }

  /**
   * The agent's own server reports that one native request is settled — it
   * was answered somewhere other than through this registry, its turn ended,
   * or the channel to it is gone. The one path that expires a native record
   * for `answered-locally`: `expireForSession` never does, because there that
   * reason is inferred from the screen.
   */
  expireNative(sessionId: string, native: NativeDecisionRef, reason: ApprovalExpiryReason): Promise<void> {
    const key = nativeKey(native);
    return this.mutate(() => {
      const events: ApprovalEvent[] = [];
      for (const r of this.requests) {
        if (r.state !== 'pending' || r.sessionId !== sessionId || !r.native || nativeKey(r.native) !== key) continue;
        r.state = 'expired';
        r.resolvedAt = this.now();
        events.push({ type: 'expire', request: copyRequest(r) });
      }
      if (events.length > 0) this.deps.log?.('info', `[approvals] expired a native decision on ${sessionId} (${reason})`);
      return events;
    });
  }

  /**
   * Stamp the deadline the GateBroker ACTUALLY armed onto a gate record, so a
   * surface can count down to the moment the tool really gives up rather than
   * to an invented one (see `ApprovalRequest.deadlineAt`).
   *
   * Goes through `mutate` for ORDERING, not for durability: `noteGateAwaiting`
   * queues the record's creation on the same chain, so a deadline reported in
   * the very next statement would otherwise land before the record exists. It
   * returns no events on purpose — this is an advisory annotation on a record
   * whose creation was already persisted, and the broker's timer does not
   * survive a restart either, so a re-write to disk would buy nothing.
   *
   * A no-op for an unknown or already-settled id.
   */
  noteGateDeadline(id: string, deadlineAt: number): Promise<void> {
    return this.mutate(() => {
      const record = this.requests.find((r) => r.id === id && r.state === 'pending');
      if (record) record.deadlineAt = deadlineAt;
      return [];
    });
  }

  // ── Resolution ───────────────────────────────────────────────────────────

  async resolve(params: ApprovalResolveParams): Promise<ApprovalResolveResult> {
    // The agent's own terminal dialog: its screen read happens OUTSIDE the
    // mutation chain (a render can take seconds and would hold every other
    // resolve, hook and expiry); only the CAS, the fence and the write run in it.
    const peek = this.requests.find((r) => r.id === params.id);
    // A native decision is answered by the agent's own server — before the
    // kind is even looked at, so it can never reach a screen read, a fence or
    // a keystroke.
    if (peek && isNative(peek)) return this.resolveNative(params, peek);
    // A v2 answer: the plan dialog's form is answered by keys behind the
    // fences; every other record refuses it.
    if (params.decisionAnswer !== undefined || params.decisionV2Answer !== undefined) {
      if (peek?.kind === 'terminal_prompt' && peek.form?.kind === 'plan') return this.answerPlan(params, peek);
      return this.refuseDecisionAnswer(params, peek);
    }
    if (peek?.kind === 'terminal_prompt') return this.resolveTerminalPrompt(params, peek);
    // The WHOLE decision runs inside one link of the chain — CAS, screen
    // re-read, PTY write and the state flip. A concurrent resolver waits for
    // this to finish and then reads a state that is no longer 'pending', which
    // is exactly the 409 the second phone should get.
    return this.mutate(async () => {
      const record = this.requests.find((r) => r.id === params.id);
      if (!record) return { result: { ok: false, reason: 'not-found' } as ApprovalResolveResult };

      // CAS on (id, state === 'pending').
      if (record.state !== 'pending') {
        const reason = record.state === 'resolved' ? 'already-resolved' : 'expired';
        return {
          result: {
            ok: false,
            reason,
            ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
            request: copyRequest(record),
          } as ApprovalResolveResult,
        };
      }


      // The caller's authority, re-checked inside the chain before ANY
      // mutation — including the prompt-gone expiry below.
      const refusedEarly = await this.reauthorize(params, record);
      if (refusedEarly) return { result: refusedEarly };

      // #783 — gate records resolve through the GateBroker, not the PTY. There
      // is no screen to re-read (the gate blocks inside the bridge process, not
      // on the pane's TUI) and no keystroke to send. The CAS above already
      // guarantees first-write-wins; notifyGateResolved wakes the waiter and
      // the bridge returns the verdict to Claude Code.
      if (record.kind === 'awaiting_permission') {
        // choiceKey is meaningless for a gate — there are no on-screen options.
        if (params.choiceKey !== undefined) {
          return {
            result: {
              ok: false,
              reason: 'invalid-choice-key',
              request: copyRequest(record),
            } as ApprovalResolveResult,
          };
        }
        // Last check before the waiter wakes and the tool runs. Nothing awaits
        // between this and the entry check today; it stays so that a future
        // await added above cannot silently reopen the window.
        const refusedGate = await this.reauthorize(params, record);
        if (refusedGate) return { result: refusedGate };
        // A pending gate is held by the hook, not displayed on a terminal.
        // Read current autonomy AFTER the last awaited authority check so a
        // policy change during that check cannot release the blocked tool.
        const pressRefusal = this.refuseOutOfScopePress(params, record, true);
        if (pressRefusal) return { result: pressRefusal };
        record.state = 'resolved';
        record.decision = params.decision;
        record.resolvedBy = sanitizeResolvedBy(params.resolvedBy);
        record.resolvedAt = this.now();
        this.deps.notifyGateResolved?.(record.id, params.decision);
        this.deps.log?.(
          'info',
          `[approvals] gate ${params.decision} ${record.id} on ${record.sessionId} by ${record.resolvedBy || 'unknown'}`,
        );
        return {
          events: [{ type: 'resolve' as ApprovalEventType, request: copyRequest(record) }],
          result: { ok: true, request: copyRequest(record), durable: true } as ApprovalResolveResult,
        };
      }

      const keys = keystrokesForAgent(record.agent);
      if (!keys) {
        // NOT an expiry: the request is still live and a human at the desktop
        // can still answer it. We simply have no mapping we would trust.
        return {
          result: {
            ok: false,
            reason: 'unsupported-agent',
            request: copyRequest(record),
          } as ApprovalResolveResult,
        };
      }

      // ── choiceKey validation ──────────────────────────────────────────────
      // When present, the caller is selecting a specific option rather than the
      // default first-option mapping. Validate that the key belongs to this
      // request's stored choices — fail closed on any mismatch.
      let choiceDigit: string | null = null;
      if (params.choiceKey !== undefined) {
        // Only an affirmative can select an option. Empty is malformed rather
        // than "absent": silently defaulting it would press option 1.
        if (params.decision !== 'approve' || params.choiceKey === '') {
          return {
            result: {
              ok: false,
              reason: 'invalid-choice-key',
              request: copyRequest(record),
            } as ApprovalResolveResult,
          };
        }
        if (!record.choices || record.choices.length === 0) {
          // choiceKey sent for a request that has no choices — invalid.
          return {
            result: {
              ok: false,
              reason: 'invalid-choice-key',
              request: copyRequest(record),
            } as ApprovalResolveResult,
          };
        }
        const match = record.choices.find((c) => c.key === params.choiceKey);
        if (!match) {
          // choiceKey not in the stored set — fail closed.
          return {
            result: {
              ok: false,
              reason: 'invalid-choice-key',
              request: copyRequest(record),
            } as ApprovalResolveResult,
          };
        }
        choiceDigit = match.key;
      }

      // ── Prove the key lands on THIS question, or write nothing ────────────
      // A record can outlive its question (Esc sends no hook), and the next
      // dialog Claude draws starts with `❯ 1.` too. So every press — approve,
      // choiceKey, deny — first proves the record's own dialog is on screen
      // (question row and every option row, see questionOnScreen), then proves
      // the pane has not moved between that read and the write: same PTY, no
      // key or click, no output, checked synchronously after the last await.
      // Anything short of that proof refuses. Ambiguity never presses a key.
      if (!record.question || !record.choices?.length) {
        return { result: this.answerInTerminal(record, 'unsupported-shape') };
      }
      const readQuestion = this.deps.readPromptScreen;
      const markNow = this.deps.promptScreenMark;
      if (!readQuestion || !markNow) {
        return { result: this.answerInTerminal(record, 'screen-unreadable') };
      }
      let rows: readonly string[] = [];
      for (let attempt = 1; ; attempt++) {
        let read: Awaited<ReturnType<typeof readQuestion>> = null;
        try {
          read = await readQuestion(record.sessionId);
        } catch (err) {
          this.deps.log?.('warn', `[approvals] screen read failed for ${record.sessionId}: ${String(err)}`);
        }
        rows = read?.rows ?? [];

        const pressRefusal = this.refuseOutOfScopePress(params, record,
          rows.length > 0 && looksLikeApprovalPrompt(rows));
        if (pressRefusal) return { result: pressRefusal };

        const proof = read && rows.length > 0 ? questionOnScreen(rows, record) : 'absent';
        if (!read || proof !== 'match' && proof !== 'changed') {
          // Whatever the pane is showing now, it is not this question: expire,
          // so the card stops inviting the same refusal.
          return this.expireUnpressed(record, rows, 'prompt-gone', 'its question is not on screen');
        }
        if (proof === 'changed') {
          // The question is there but its options do not all read back (a
          // re-render, a wrap). Still live: keep it pending, press nothing.
          this.deps.log?.('info', `[approvals] refused ${record.id} on ${record.sessionId}: options changed on screen`);
          return { result: { ok: false, reason: 'prompt-changed', request: copyRequest(record) } };
        }

        // One key cannot answer a multi-select or multi-question AskUserQuestion
        // (measured: a digit toggles one checkbox, or answers the first question
        // and moves to the next tab). Refuse an approve — with or without a
        // choiceKey — without expiring: the question is live (proved above), a
        // human can answer it in the pane, and deny (Esc) still cancels it.
        if (params.decision === 'approve' && record.questionShape) {
          return { result: { ok: false, reason: 'needs-v2', request: copyRequest(record) } };
        }

        // Last check before the bytes: the screen read above can take seconds.
        const refusedWrite = await this.reauthorize(params, record);
        if (refusedWrite) return { result: refusedWrite };
        // Policy again, after the last await: the operator may have turned
        // autonomy or approval pressing off while reauthorize ran, and the scope
        // read above predates that. Same rule the gate branch follows.
        const lateRefusal = this.refuseOutOfScopePress(params, record, true);
        if (lateRefusal) return { result: lateRefusal };

        // The fence — synchronous from here to the write, nothing can interleave.
        const now = markNow(record.sessionId);
        if (!now) return this.expireUnpressed(record, rows, 'prompt-gone', 'the pane is gone');
        if (now.incarnation !== read.mark.incarnation || now.keyInputRevision !== read.mark.keyInputRevision) {
          // A key or click reached the pane (or it restarted) since the read: a
          // human may just have answered, and whatever is up now is unproven.
          this.deps.log?.('info', `[approvals] refused ${record.id} on ${record.sessionId}: the pane took input since the read`);
          return { result: { ok: false, reason: 'prompt-changed', request: copyRequest(record) } };
        }
        if (now.bytes !== read.mark.bytes) {
          if (attempt < TERMINAL_PROMPT_ANSWER_ATTEMPTS) continue;
          this.deps.log?.('info', `[approvals] refused ${record.id} on ${record.sessionId}: the pane kept drawing`);
          return { result: { ok: false, reason: 'prompt-changed', request: copyRequest(record) } };
        }
        break;
      }

      // Determine the data to send: choiceKey overrides the default mapping.
      // When choiceKey is set, we send exactly that digit — no CR.
      // When absent, existing behaviour: approve → '1', deny → ESC.
      const data = params.decision === 'deny'
        ? keys.deny
        : (choiceDigit ?? keys.approve);
      let delivered = false;
      try {
        delivered = this.deps.writeToSession(record.sessionId, data);
      } catch (err) {
        this.deps.log?.(
          'warn',
          `[approvals] write failed for ${record.sessionId}: ${String(err)}`,
        );
      }
      if (!delivered) {
        // The pane died between the fence and the write. Same answer as a
        // vanished prompt — there is nothing to press.
        return this.expireUnpressed(record, rows, 'prompt-gone', 'the write did not land');
      }

      // Bytes are out. The flip is last so a failed write never consumes the
      // request, and it is safe to be last because nothing else can run between
      // the two: we hold the chain.
      record.state = 'resolved';
      record.decision = params.decision;
      // Sanitized at the chokepoint, not at the caller — see sanitizeResolvedBy.
      record.resolvedBy = sanitizeResolvedBy(params.resolvedBy);
      record.resolvedAt = this.now();
      record.screenTail = formatScreenTail(rows);
      // Persist which specific choice was selected (if any).
      if (choiceDigit) record.selectedChoiceKey = choiceDigit;
      this.deps.log?.(
        'info',
        // The SANITIZED value, not the raw param. Sanitizing only what gets
        // stored left the log line taking a CR/LF straight from the caller,
        // which is the forged-log-line injection sanitizeResolvedBy exists to
        // prevent — the field was clean on disk and dirty in the log.
        `[approvals] ${params.decision} ${record.id} on ${record.sessionId} by ${record.resolvedBy || 'unknown'}${choiceDigit ? ` (choice ${choiceDigit})` : ''}`,
      );
      return {
        events: [{ type: 'resolve' as ApprovalEventType, request: copyRequest(record) }],
        // `durable` is stamped by the finalize below; the body cannot know it.
        result: { ok: true, request: copyRequest(record), durable: true } as ApprovalResolveResult,
      };
    },
    // The bytes are in the PTY either way, so a failed write does not fail the
    // call — it changes what we can honestly claim about it.
    (result, durable) => (result.ok ? { ...result, durable } : result));
  }

  /**
   * Answer the agent's own terminal dialog from a phone. Fails closed at every
   * step; the only success writes ONE byte — the chosen option's digit, never
   * Enter — and only once per record.
   *
   * Outside the mutation chain (reads only, nothing changes):
   *   1. one answer per record: `pressedAt` set → `already-answered`
   *   2. who: a human through the web route from a capable client (the route's
   *      Symbol marker — JSON callers such as the pipe RPC or MCP
   *      `approval_press` cannot carry it) → else `answer-in-terminal`; so is a
   *      record that was never bound and parsed whole (no choices/fingerprint)
   *   3. what: `choiceKey` one of the stored choices and `decision` matching
   *      its label, a fingerprint echoed → else `invalid-choice`; the echoed
   *      fingerprint equal to the record's → else `prompt-changed`
   *   4. when: not within TERMINAL_PROMPT_MIN_ANSWER_AGE_MS of creation
   *   5. the call: the transcript's pending `tool_use` is still the record's
   *   6. the screen: re-read and re-parsed with the pane's state captured at
   *      that instant; the dialog must be ACTIVE and hash (with the tool_use
   *      id) to the same fingerprint, and no key or click may have reached the
   *      pane since the record was created. Changed content supersedes the
   *      record with a fresh one (the phone re-reads it off SSE).
   * Inside the chain, synchronously up to the write: the CAS (still pending,
   * not pressed) and the fence — no key/click and no new PTY since the read
   * (refused at once: a human may just have answered), and no output (read
   * again, up to TERMINAL_PROMPT_ANSWER_ATTEMPTS).
   *
   * Every outcome is audited in one log line: who, which record and pane,
   * which tool and choice, the fingerprint's first 8 characters. Never the
   * command or the reason line.
   */
  /**
   * Can the daemon PROVE the dialog on screen now is the one this record was
   * minted for? The same call (transcript id and whole-input hash still the
   * pending call's), the same PTY incarnation and no key/click since the
   * record was created, the same dialog text, and its rows still spelling that
   * call's command. Any doubt is `false`: the caller writes nothing.
   */
  private provenDialog(record: ApprovalRequest, live: DialogRead): 'ok' | 'call' | 'input' | 'screen' {
    const identity = identityOf(record);
    const call = identity?.call;
    if (!identity?.matched || !call || !identity.mark || !identity.screenFp) return 'screen';
    let pending: PendingToolUse | null = null;
    try {
      pending = this.deps.pendingToolUse?.(record.sessionId) ?? null;
    } catch {
      pending = null;
    }
    const sameCall = (c: { name: string; input: Record<string, unknown> }): boolean =>
      c.name === call.name && toolInputHash(c.input) === call.inputHash;
    if (call.id) {
      if (!pending || pending.id !== call.id || !sameCall(pending)) return 'call';
    } else {
      // Bound by the hook: still the pane's ONE pending PermissionRequest, for
      // the same whole input (and the same turn, when the hook named one); a
      // transcript call that has appeared since must be that call too.
      const evidence = this.soleEvidence(record.sessionId);
      if (!evidence || !sameCall(evidence)) return 'call';
      if (call.promptId && evidence.promptId && evidence.promptId !== call.promptId) return 'call';
      if (pending && !sameCall(pending)) return 'call';
    }
    if (live.mark.incarnation !== identity.mark.incarnation || live.mark.keyInputRevision !== identity.mark.keyInputRevision) {
      return 'input';
    }
    if (live.parsed.fingerprint !== identity.screenFp) return 'screen';
    // A plan dialog shows the plan rendered, not spelled: the call's whole
    // input is bound through the fingerprint (bindFingerprint) instead.
    if (live.parsed.plan) return call.name === 'ExitPlanMode' ? 'ok' : 'screen';
    if (call.name === 'ExitPlanMode') return 'screen';
    const matches = live.parsed.topRuleFound
      ? dialogMatchesToolCall(live.parsed, call)
      : identity.topCut && dialogMatchesToolCall(live.parsed, call, { topCut: true });
    return matches ? 'ok' : 'screen';
  }

  private async resolveTerminalPrompt(
    params: ApprovalResolveParams,
    record: ApprovalRequest,
  ): Promise<ApprovalResolveResult> {
    // Defence in depth: `resolve` routes native records away before this.
    if (isNative(record)) return this.answerInTerminal(record, 'unsupported-shape');
    if (params.terminalPromptDecline !== undefined) return this.declineTerminalPrompt(params, record);
    const choice = record.choices?.find((c) => c.key === params.choiceKey);
    const audit = (outcome: string): void => {
      this.deps.log?.(
        'info',
        `[approvals] terminal-prompt answer outcome=${outcome} record=${record.id} session=${record.sessionId} ` +
          `by="${logText(sanitizeResolvedBy(params.resolvedBy))}" tool=${logText(record.toolName, 40) || '-'} ` +
          `choice=${params.choiceKey !== undefined ? logText(params.choiceKey, 4) : '-'}` +
          `${choice ? `:${logText(choice.label, 40)}` : ''} ` +
          `fp=${(record.promptFingerprint ?? '').slice(0, 8) || '-'}`,
      );
    };
    const refuse = (reason: Exclude<ApprovalResolveFailure, 'answer-in-terminal'>): ApprovalResolveResult => {
      audit(reason);
      return { ok: false, reason, request: copyRequest(record) };
    };
    const answerInTerminal = (answerRefusal: AnswerRefusalReason): ApprovalResolveResult => {
      audit('answer-in-terminal');
      return { ok: false, reason: 'answer-in-terminal', answerRefusal, request: copyRequest(record) };
    };

    if (record.state !== 'pending') {
      const reason = record.state === 'resolved' ? 'already-resolved' : 'expired';
      audit(reason);
      return {
        ok: false,
        reason,
        ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
        request: copyRequest(record),
      };
    }
    if (record.pressedAt !== undefined) return refuse('already-answered');
    if (
      (params.resolver ?? 'human') !== 'human'
      || params.terminalPromptAnswer !== TERMINAL_PROMPT_WEB_ANSWER
    ) {
      return answerInTerminal('no-capability');
    }
    if (!record.promptFingerprint || !record.choices?.length) {
      return answerInTerminal('unsupported-shape');
    }
    if (!choice || !params.promptFingerprint) return refuse('invalid-choice');
    const expected = decisionForChoiceLabel(choice.label);
    if (expected === null || params.decision !== expected) return refuse('invalid-choice');
    if (params.promptFingerprint !== record.promptFingerprint) return refuse('prompt-changed');
    if (this.now() - record.createdAt < TERMINAL_PROMPT_MIN_ANSWER_AGE_MS) return refuse('answer-too-soon');

    const refusedEarly = await this.reauthorize(params, record);
    if (refusedEarly) {
      audit(refusedEarly.ok ? 'ok' : refusedEarly.reason);
      return refusedEarly;
    }

    for (let attempt = 1; attempt <= TERMINAL_PROMPT_ANSWER_ATTEMPTS; attempt++) {
      const live = await this.readActiveDialog(record.sessionId);
      if (!live) return refuse('prompt-changed');
      // Everything the key rests on, re-proved from this read. A different
      // call, a key or click since the record appeared (a human is at the
      // terminal), or changed rows: never pressed through — the record is
      // refreshed from this read (a new id and fingerprint, the reflex guard
      // restarted), so the phone re-reads and can confirm what is up now.
      const proven = this.provenDialog(record, live);
      if (proven !== 'ok' || record.toolUseId !== identityOf(record)?.call?.id) {
        const superseded = await this.supersedeWithFresh(record, live);
        audit(`prompt-changed:${proven}`);
        return { ok: false, reason: 'prompt-changed', request: superseded ?? copyRequest(record) };
      }
      const inputHash = identityOf(record)?.call?.inputHash;
      if (bindFingerprint(live.parsed.fingerprint, record.toolUseId, record.keyRevisionAtCreate, inputHash) !== record.promptFingerprint) {
        const superseded = await this.supersedeWithFresh(record, live);
        audit('prompt-changed');
        return { ok: false, reason: 'prompt-changed', request: superseded ?? copyRequest(record) };
      }
      const stillAnswerable = terminalPromptAnswerability(live.parsed);
      if (!stillAnswerable.choices.some((c) => c.key === choice.key && c.label === choice.label)) {
        return refuse('prompt-changed');
      }

      const refusedWrite = await this.reauthorize(params, record);
      if (refusedWrite) {
        audit(refusedWrite.ok ? 'ok' : refusedWrite.reason);
        return refusedWrite;
      }

      let keyMoved = false;
      const outcome = await this.mutate<'retry' | ApprovalResolveResult>(() => {
        // ── Synchronous from here to the write: nothing can move in between. ──
        if (record.state !== 'pending') {
          return { result: { ok: false, reason: record.state === 'resolved' ? 'already-resolved' : 'expired', request: copyRequest(record) } };
        }
        if (record.pressedAt !== undefined) {
          return { result: { ok: false, reason: 'already-answered', request: copyRequest(record) } };
        }
        const now = this.deps.promptScreenMark?.(record.sessionId) ?? null;
        if (!now || now.incarnation !== live.mark.incarnation || now.keyInputRevision !== live.mark.keyInputRevision) {
          // Never retried: a human may just have answered in the pane.
          keyMoved = !!now && now.incarnation === live.mark.incarnation;
          return { result: { ok: false, reason: 'prompt-changed', request: copyRequest(record) } };
        }
        if (now.bytes !== live.mark.bytes) return { result: 'retry' };
        // The CAS: one write per record, ever.
        record.pressedAt = this.now();
        let delivered = false;
        try {
          delivered = this.deps.writeToSession(record.sessionId, choice.key);
        } catch (err) {
          this.deps.log?.('warn', `[approvals] write failed for ${record.sessionId}: ${String(err)}`);
        }
        if (!delivered) {
          delete record.pressedAt;
          record.state = 'expired';
          record.resolvedAt = this.now();
          return {
            events: [{ type: 'expire', request: copyRequest(record) }],
            result: { ok: false, reason: 'prompt-gone', request: copyRequest(record) },
          };
        }
        record.decision = expected;
        record.selectedChoiceKey = choice.key;
        record.resolvedBy = sanitizeResolvedBy(params.resolvedBy);
        return {
          events: [{ type: 'press', request: copyRequest(record) }],
          result: { ok: true, request: copyRequest(record), durable: true },
        };
      }, (result, durable) => (result !== 'retry' && result.ok ? { ...result, durable } : result));
      if (outcome === 'retry') continue;
      if (keyMoved) {
        // A key or click landed between the read and the write: refresh the
        // record from a fresh read, as above, so the phone can re-confirm.
        const again = await this.readActiveDialog(record.sessionId);
        const superseded = again ? await this.supersedeWithFresh(record, again) : null;
        audit('prompt-changed');
        return { ok: false, reason: 'prompt-changed', request: superseded ?? copyRequest(record) };
      }
      audit(outcome.ok ? 'pressed' : outcome.reason);
      return outcome;
    }
    return refuse('prompt-changed');
  }

  /**
   * Decline the agent's own terminal dialog from a phone: ONE Esc, the
   * dialog's cancel key. Allowed on a record without Yes/No choices too (a
   * row the TUI cut, no plain Yes) — but ONLY when the daemon can prove the
   * dialog on screen is the one the record was minted for. Never "some
   * dialog is active": an Esc into another call's dialog cancels that call.
   *
   * Outside the mutation chain (reads only):
   *   1. settled → `already-resolved` / `expired`; answered → `already-answered`
   *   2. who: a human through the web decline route (its Symbol marker) and
   *      `decision:'deny'` with no `choiceKey` → else `answer-in-terminal` /
   *      `invalid-choice`
   *   3. an echoed fingerprint must be the record's → else `prompt-changed`
   *   4. when: not within TERMINAL_PROMPT_MIN_ANSWER_AGE_MS of creation
   *   5. identity: the record was matched to a transcript call at creation
   *      (screen rows spelled its command) → else `prompt-unverified`
   *   6. proof (provenDialog): the same call id and whole input still
   *      pending, the same PTY incarnation and key revision as at creation,
   *      the same dialog text and rows → else `prompt-changed`
   * Inside the chain, synchronously up to the write: the CAS (still pending,
   * not answered) and the fence — the same PTY and no key/click since the
   * read (refused at once), no output since the read (read again, up to
   * TERMINAL_PROMPT_ANSWER_ATTEMPTS). The record then stays pending with
   * `pressedAt` until the dialog is seen gone, exactly like an answer.
   */
  private async declineTerminalPrompt(
    params: ApprovalResolveParams,
    record: ApprovalRequest,
  ): Promise<ApprovalResolveResult> {
    // Never an Esc for a native decision: the agent's server declines it.
    if (isNative(record)) return this.answerInTerminal(record, 'unsupported-shape');
    const audit = (outcome: string): void => {
      this.deps.log?.(
        'info',
        `[approvals] terminal-prompt decline outcome=${outcome} record=${record.id} session=${record.sessionId} ` +
          `by="${logText(sanitizeResolvedBy(params.resolvedBy))}" tool=${logText(record.toolName, 40) || '-'} ` +
          `via=escape fp=${(record.promptFingerprint ?? '').slice(0, 8) || '-'}`,
      );
    };
    const refuse = (reason: Exclude<ApprovalResolveFailure, 'answer-in-terminal'>): ApprovalResolveResult => {
      audit(reason);
      return { ok: false, reason, request: copyRequest(record) };
    };
    const settled = (): ApprovalResolveResult => {
      const reason = record.state === 'resolved' ? 'already-resolved' : 'expired';
      audit(reason);
      return {
        ok: false,
        reason,
        ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
        request: copyRequest(record),
      };
    };

    if (record.state !== 'pending') return settled();
    if (record.pressedAt !== undefined || record.step) return refuse('already-answered');
    if ((params.resolver ?? 'human') !== 'human' || params.terminalPromptDecline !== TERMINAL_PROMPT_WEB_DECLINE) {
      audit('answer-in-terminal');
      return { ok: false, reason: 'answer-in-terminal', answerRefusal: 'no-capability', request: copyRequest(record) };
    }
    if (params.decision !== 'deny' || params.choiceKey !== undefined) return refuse('invalid-choice');
    if (params.promptFingerprint !== undefined && params.promptFingerprint !== record.promptFingerprint) {
      return refuse('prompt-changed');
    }
    if (this.now() - record.createdAt < TERMINAL_PROMPT_MIN_ANSWER_AGE_MS) return refuse('answer-too-soon');
    const identity = identityOf(record);
    if (!identity?.matched || !identity.call) return refuse('prompt-unverified');

    const refusedEarly = await this.reauthorize(params, record);
    if (refusedEarly) {
      audit(refusedEarly.ok ? 'ok' : refusedEarly.reason);
      return refusedEarly;
    }

    for (let attempt = 1; attempt <= TERMINAL_PROMPT_ANSWER_ATTEMPTS; attempt++) {
      const live = await this.readActiveDialog(record.sessionId);
      if (!live) return refuse('prompt-changed');
      const proven = this.provenDialog(record, live);
      if (proven !== 'ok') {
        audit(`prompt-changed:${proven}`);
        return { ok: false, reason: 'prompt-changed', request: copyRequest(record) };
      }

      const refusedWrite = await this.reauthorize(params, record);
      if (refusedWrite) {
        audit(refusedWrite.ok ? 'ok' : refusedWrite.reason);
        return refusedWrite;
      }

      const outcome = await this.mutate<'retry' | ApprovalResolveResult>(() => {
        // ── Synchronous from here to the write: nothing can move in between. ──
        if (record.state !== 'pending') {
          return {
            result: {
              ok: false,
              reason: record.state === 'resolved' ? 'already-resolved' : 'expired',
              ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
              request: copyRequest(record),
            },
          };
        }
        if (record.pressedAt !== undefined || record.step) {
          return { result: { ok: false, reason: 'already-answered', request: copyRequest(record) } };
        }
        const now = this.deps.promptScreenMark?.(record.sessionId) ?? null;
        if (!now || now.incarnation !== live.mark.incarnation || now.keyInputRevision !== live.mark.keyInputRevision) {
          return { result: { ok: false, reason: 'prompt-changed', request: copyRequest(record) } };
        }
        if (now.bytes !== live.mark.bytes) return { result: 'retry' };
        record.pressedAt = this.now();
        let delivered = false;
        try {
          delivered = this.deps.writeToSession(record.sessionId, '\x1b');
        } catch (err) {
          this.deps.log?.('warn', `[approvals] write failed for ${record.sessionId}: ${String(err)}`);
        }
        if (!delivered) {
          delete record.pressedAt;
          record.state = 'expired';
          record.resolvedAt = this.now();
          return {
            events: [{ type: 'expire', request: copyRequest(record) }],
            result: { ok: false, reason: 'prompt-gone', request: copyRequest(record) },
          };
        }
        record.decision = 'deny';
        record.resolvedBy = sanitizeResolvedBy(params.resolvedBy);
        return {
          events: [{ type: 'press', request: copyRequest(record) }],
          result: { ok: true, request: copyRequest(record), durable: true },
        };
      }, (result, durable) => (result !== 'retry' && result.ok ? { ...result, durable } : result));
      if (outcome === 'retry') continue;
      audit(outcome.ok ? 'pressed' : outcome.reason);
      return outcome;
    }
    return refuse('prompt-changed');
  }

  /**
   * Answer a `native-rpc` record through the agent's own server. Nothing is
   * read off the screen, nothing is fenced and no key is typed: the agent's
   * server is the judge of whether its request is still open.
   *
   *   1. settled → `already-resolved` / `expired`; an answer in flight →
   *      `already-answered`
   *   2. who: a human through a web route carrying one of the three web
   *      markers (the pipe RPC and MCP `approval_press` cannot carry any) →
   *      else `answer-in-terminal` / `no-capability`; the `native` kill switch
   *      off or no adapter wired → `answer-in-terminal`
   *   3. what: a decline is a deny; a v1 answer names Yes or No of a
   *      permission and echoes the form's fingerprint; a v2 answer waits for
   *      the form producers (`unsupported-shape`)
   *   4. when: not within TERMINAL_PROMPT_MIN_ANSWER_AGE_MS of creation
   * Then the claim (one answer in flight per record), the re-check of the
   * caller, the adapter call OUTSIDE the chain (it is I/O), and the settle:
   * `ok` resolves, `not-found` expires (410), `unavailable` releases the claim.
   */
  private async resolveNative(params: ApprovalResolveParams, record: ApprovalRequest): Promise<ApprovalResolveResult> {
    const via = params.terminalPromptDecline !== undefined ? 'decline' : params.decisionV2Answer !== undefined ? 'v2' : 'v1';
    const audit = (outcome: string): void => {
      this.deps.log?.(
        'info',
        `[approvals] native answer outcome=${outcome} record=${record.id} session=${record.sessionId} ` +
          `adapter=${record.native?.adapter ?? '-'} via=${via} by="${logText(sanitizeResolvedBy(params.resolvedBy))}" ` +
          `fp=${(record.formFingerprint ?? '').slice(0, 8) || '-'}`,
      );
    };
    const refuse = (reason: Exclude<ApprovalResolveFailure, 'answer-in-terminal'>): ApprovalResolveResult => {
      audit(reason);
      return { ok: false, reason, request: copyRequest(record) };
    };
    const inTerminal = (why: AnswerRefusalReason): ApprovalResolveResult => {
      audit(`answer-in-terminal:${why}`);
      return { ok: false, reason: 'answer-in-terminal', answerRefusal: why, request: copyRequest(record) };
    };
    const settled = (): ApprovalResolveResult => {
      const reason = record.state === 'resolved' ? 'already-resolved' : 'expired';
      audit(reason);
      return {
        ok: false,
        reason,
        ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
        request: copyRequest(record),
      };
    };

    if (record.state !== 'pending') return settled();
    const claimKey = record.native ? nativeKey(record.native) : record.id;
    if (this.nativeClaims.has(claimKey)) return refuse('already-answered');
    const marked = params.decisionV2Answer === DECISION_V2_WEB_ANSWER
      || params.terminalPromptAnswer === TERMINAL_PROMPT_WEB_ANSWER
      || params.terminalPromptDecline === TERMINAL_PROMPT_WEB_DECLINE;
    if ((params.resolver ?? 'human') !== 'human' || !marked) return inTerminal('no-capability');
    const native = record.native;
    const answerNative = this.deps.answerNative;
    // `none`: made while the switch was off — informational for good.
    const form = record.form;
    if (!native || !form || record.channel !== 'native-rpc' || !this.decisionChannels().native) {
      return inTerminal('unsupported-shape');
    }
    if (!answerNative) return inTerminal('unsupported-agent');
    if (this.now() - record.createdAt < TERMINAL_PROMPT_MIN_ANSWER_AGE_MS) return refuse('answer-too-soon');

    let decision: ApprovalDecision;
    let choiceKey: string | undefined;
    let answers: Array<{ keys: string[]; other?: string }> | undefined;
    let answerDigest: ApprovalRequest['answerDigest'];
    if (via === 'v2') {
      const answer = params.decisionAnswer;
      if (!answer) return refuse('invalid-choice');
      if (answer.formFingerprint !== record.formFingerprint) return refuse('prompt-changed');
      const built = nativeV2Answer(form, answer);
      if (!built) return refuse('invalid-choice');
      ({ decision, answers } = built);
      const typed = (answer.answers ?? []).flatMap((a) => (a.other !== undefined ? [a.other] : []));
      if (answers && typed.length > 0) {
        const joined = typed.join('\u0000');
        answerDigest = {
          textBytes: Buffer.byteLength(joined, 'utf8'),
          textHash: crypto.createHash('sha256').update(joined).digest('hex'),
        };
      }
    } else if (via === 'decline') {
      if (params.decision !== 'deny' || params.choiceKey !== undefined) return refuse('invalid-choice');
      if (params.promptFingerprint !== undefined && params.promptFingerprint !== record.formFingerprint) {
        return refuse('prompt-changed');
      }
      decision = 'deny';
    } else if (form.kind === 'permission') {
      // The shipped phone's answer to a permission: its plain Yes or No.
      const choice = record.choices?.find((c) => c.key === params.choiceKey);
      if (!choice || !params.promptFingerprint) return refuse('invalid-choice');
      const expected = decisionForChoiceLabel(choice.label);
      if (expected === null || params.decision !== expected) return refuse('invalid-choice');
      if (params.promptFingerprint !== record.formFingerprint) return refuse('prompt-changed');
      decision = expected;
      choiceKey = choice.key;
    } else if (params.decision === 'deny') {
      // A question's v1 deny: reject it (no key names an option to deny).
      if (params.choiceKey !== undefined) return refuse('invalid-choice');
      decision = 'deny';
    } else {
      // A question's v1 approve: one single-select option by its key.
      if (record.questionShape) return refuse('needs-v2');
      const choice = record.choices?.find((c) => c.key === params.choiceKey);
      if (!record.choices?.length) return inTerminal('unsupported-shape');
      if (!choice) return refuse('invalid-choice');
      decision = 'approve';
      choiceKey = choice.key;
      answers = [{ keys: [choice.key] }];
    }

    const refusedEarly = await this.reauthorize(params, record);
    if (refusedEarly) {
      audit(refusedEarly.ok ? 'ok' : refusedEarly.reason);
      return refusedEarly;
    }
    // The CAS: at most one answer on its way to the agent per record.
    const lost = await this.mutate<ApprovalResolveResult | null>(() => {
      if (record.state !== 'pending') return { result: settled() };
      if (this.nativeClaims.has(claimKey)) return { result: refuse('already-answered') };
      this.nativeClaims.add(claimKey);
      return { result: null };
    });
    if (lost) return lost;
    try {
      const refusedLate = await this.reauthorize(params, record);
      if (refusedLate) {
        audit(refusedLate.ok ? 'ok' : refusedLate.reason);
        return refusedLate;
      }
      let outcome: NativeDecisionOutcome | 'timeout';
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        outcome = await Promise.race([
          answerNative({ ...native }, {
            decision,
            formKind: form.kind,
            // A permission's Yes/No is the decision itself; a question names its option.
            ...(choiceKey && form.kind === 'questions' ? { choiceKey } : {}),
            ...(answers && decision === 'approve' && form.kind === 'questions'
              ? { answers: answers.map((a) => ({ ...a, keys: [...a.keys] })) }
              : {}),
          }, record.sessionId),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.deps.nativeAnswerTimeoutMs ?? NATIVE_ANSWER_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } catch (err) {
        this.deps.log?.('warn', `[approvals] native answer failed for ${record.id}: ${String(err)}`);
        outcome = 'unavailable';
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      // Nothing delivered: the caller may retry.
      if (outcome === 'unavailable') return refuse('agent-unavailable');
      // Sent, never confirmed: it may have landed. The card stays up; the
      // agent's own event (or a later not-found) settles it.
      if (outcome === 'timeout' || outcome === 'uncertain') return refuse('answer-uncertain');
      // Nothing changed at the agent, and the same answer would fare no better.
      if (outcome === 'refused') return refuse('invalid-choice');
      // The request asks something else now; the next reconcile replaces the card.
      if (outcome === 'changed') return refuse('prompt-changed');
      const result = await this.mutate<ApprovalResolveResult>(() => {
        if (outcome === 'not-found') {
          // The agent no longer holds the request (answered at the terminal,
          // or gone): the card is dead.
          const events: ApprovalEvent[] = [];
          if (record.state === 'pending') {
            record.state = 'expired';
            record.resolvedAt = this.now();
            events.push({ type: 'expire', request: copyRequest(record) });
          }
          return { events, result: { ok: false, reason: 'prompt-gone', request: copyRequest(record) } };
        }
        // Delivered. A record a sweep settled meanwhile (the pane went away)
        // keeps its state; the answer still reached the agent.
        if (record.state !== 'pending') return { result: { ok: true, request: copyRequest(record), durable: true } };
        record.state = 'resolved';
        record.decision = decision;
        record.resolvedBy = sanitizeResolvedBy(params.resolvedBy);
        record.resolvedAt = this.now();
        if (choiceKey) record.selectedChoiceKey = choiceKey;
        if (answerDigest) record.answerDigest = answerDigest;
        return {
          events: [{ type: 'resolve', request: copyRequest(record) }],
          result: { ok: true, request: copyRequest(record), durable: true },
        };
      }, (r, durable) => (r.ok ? { ...r, durable } : r));
      audit(result.ok ? 'answered' : result.reason);
      return result;
    } finally {
      this.nativeClaims.delete(claimKey);
    }
  }

  /**
   * A `decision-v2` answer to Claude's ExitPlanMode dialog (`form.kind:
   * 'plan'`). Fails closed at every step, like `resolveTerminalPrompt`:
   *
   *   1. settled → `already-resolved` / `expired`; a key already written
   *      (`pressedAt`) or a stepwise answer started (`step`) → `already-answered`
   *   2. who: a human through the web answer route (its Symbol marker) →
   *      else `answer-in-terminal`; a record that is not bound, has no form or
   *      was made with the `stepwise` switch off (or it is off now) →
   *      `unsupported-shape`
   *   3. what: one of the form's actions, no `answers`, `text` only with
   *      `feedback` → else `invalid-choice`; the echoed `formFingerprint` must
   *      be the record's → else `prompt-changed`
   *   4. when: not within TERMINAL_PROMPT_MIN_ANSWER_AGE_MS of creation
   *   5. the screen: re-read and proven the same dialog for the same call
   *      with no key since the record was made (`provenDialog`); the action's
   *      row still there under the same label. A changed dialog supersedes
   *      the record, as a v1 answer does.
   *
   * `approve-manual` is then ONE key — the row's own number, read off the
   * screen — under the same fence and `pressedAt` CAS as a v1 answer.
   * `feedback` runs the stepwise driver (see driveFeedback).
   */
  private async answerPlan(params: ApprovalResolveParams, record: ApprovalRequest): Promise<ApprovalResolveResult> {
    const answer = params.decisionAnswer;
    const audit = (outcome: string): void => {
      this.deps.log?.(
        'info',
        `[approvals] plan answer outcome=${outcome} record=${record.id} session=${record.sessionId} ` +
          `by="${logText(sanitizeResolvedBy(params.resolvedBy))}" action=${logText(answer?.action, 20) || '-'} ` +
          `text=${answer?.text !== undefined ? Buffer.byteLength(answer.text, 'utf8') : 0}B ` +
          `step=${record.step ? `${record.step.index}/${record.step.total}:${record.step.status}` : '-'} ` +
          `fp=${(record.formFingerprint ?? '').slice(0, 8) || '-'}`,
      );
    };
    const refuse = (reason: Exclude<ApprovalResolveFailure, 'answer-in-terminal'>): ApprovalResolveResult => {
      audit(reason);
      return { ok: false, reason, request: copyRequest(record) };
    };
    const inTerminal = (why: AnswerRefusalReason): ApprovalResolveResult => {
      audit(`answer-in-terminal:${why}`);
      return { ok: false, reason: 'answer-in-terminal', answerRefusal: why, request: copyRequest(record) };
    };
    if (record.state !== 'pending') {
      const reason = record.state === 'resolved' ? 'already-resolved' : 'expired';
      audit(reason);
      return {
        ok: false,
        reason,
        ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
        request: copyRequest(record),
      };
    }
    if (record.pressedAt !== undefined || record.step) return refuse('already-answered');
    if ((params.resolver ?? 'human') !== 'human' || params.decisionV2Answer !== DECISION_V2_WEB_ANSWER || !answer) {
      return inTerminal('no-capability');
    }
    const identity = identityOf(record);
    const form = record.form;
    if (!form || record.channel !== 'fenced-keys' || !record.formFingerprint || !identity?.matched || !identity.call
      || !this.decisionChannels().stepwise) {
      return inTerminal('unsupported-shape');
    }
    const action = form.actions.find((a) => a.id === answer.action);
    if (!action || answer.answers !== undefined) return refuse('invalid-choice');
    const feedback = action.id === PLAN_ACTION_FEEDBACK;
    if (!feedback && answer.text !== undefined) return refuse('invalid-choice');
    if (feedback && !this.deps.writeStepKey) return inTerminal('unsupported-shape');
    if (answer.formFingerprint !== record.formFingerprint) return refuse('prompt-changed');
    if (this.now() - record.createdAt < TERMINAL_PROMPT_MIN_ANSWER_AGE_MS) return refuse('answer-too-soon');

    const refusedEarly = await this.reauthorize(params, record);
    if (refusedEarly) {
      audit(refusedEarly.ok ? 'ok' : refusedEarly.reason);
      return refusedEarly;
    }

    for (let attempt = 1; attempt <= TERMINAL_PROMPT_ANSWER_ATTEMPTS; attempt++) {
      const live = await this.readActiveDialog(record.sessionId);
      if (!live) return refuse('prompt-changed');
      const proven = this.provenDialog(record, live);
      if (proven !== 'ok'
        || bindFingerprint(live.parsed.fingerprint, record.toolUseId, record.keyRevisionAtCreate, identity.call.inputHash) !== record.formFingerprint) {
        const superseded = await this.supersedeWithFresh(record, live);
        audit(`prompt-changed:${proven}`);
        return { ok: false, reason: 'prompt-changed', request: superseded ?? copyRequest(record) };
      }
      const row = feedback ? live.parsed.plan?.feedback : live.parsed.plan?.approve;
      if (!row || row.label !== action.label) return refuse('prompt-changed');
      if (feedback) return this.driveFeedback(params, record, live, row.key, answer, audit);

      const refusedWrite = await this.reauthorize(params, record);
      if (refusedWrite) {
        audit(refusedWrite.ok ? 'ok' : refusedWrite.reason);
        return refusedWrite;
      }
      const outcome = await this.mutate<'retry' | ApprovalResolveResult>(() => {
        // ── Synchronous from here to the write: nothing can move in between. ──
        if (record.state !== 'pending') {
          return { result: { ok: false, reason: record.state === 'resolved' ? 'already-resolved' : 'expired', request: copyRequest(record) } };
        }
        if (record.pressedAt !== undefined || record.step) {
          return { result: { ok: false, reason: 'already-answered', request: copyRequest(record) } };
        }
        const now = this.deps.promptScreenMark?.(record.sessionId) ?? null;
        if (!now || now.incarnation !== live.mark.incarnation || now.keyInputRevision !== live.mark.keyInputRevision) {
          return { result: { ok: false, reason: 'prompt-changed', request: copyRequest(record) } };
        }
        if (now.bytes !== live.mark.bytes) return { result: 'retry' };
        record.pressedAt = this.now();
        let delivered = false;
        try {
          delivered = this.deps.writeToSession(record.sessionId, row.key);
        } catch (err) {
          this.deps.log?.('warn', `[approvals] write failed for ${record.sessionId}: ${String(err)}`);
        }
        if (!delivered) {
          delete record.pressedAt;
          record.state = 'expired';
          record.resolvedAt = this.now();
          return {
            events: [{ type: 'expire', request: copyRequest(record) }],
            result: { ok: false, reason: 'prompt-gone', request: copyRequest(record) },
          };
        }
        record.decision = 'approve';
        record.selectedChoiceKey = row.key;
        record.resolvedBy = sanitizeResolvedBy(params.resolvedBy);
        return {
          events: [{ type: 'press', request: copyRequest(record) }],
          result: { ok: true, request: copyRequest(record), durable: true },
        };
      }, (result, durable) => (result !== 'retry' && result.ok ? { ...result, durable } : result));
      if (outcome === 'retry') continue;
      audit(outcome.ok ? 'pressed' : outcome.reason);
      return outcome;
    }
    return refuse('prompt-changed');
  }

  /**
   * The stepwise driver, first applied to the plan dialog's feedback: the
   * feedback row's number (the cursor moves into its text field; nothing is
   * submitted), the text as ONE bracketed paste (none for empty feedback),
   * then Enter, which rejects the plan with that feedback.
   *
   * Every key is the driver's own (`writeStepKey`): the pane's key revision
   * moves by exactly one per key and the returned revision is recorded on
   * `record.step`, so a revision past it can only be someone else's key. The
   * fence is checked synchronously right before every write, and every read
   * between keys must show what the last key should have drawn — the cursor
   * in the empty field, then the pasted text echoed there — within
   * STEP_RENDER_WAIT_MS, the whole answer within STEP_TOTAL_MS.
   *
   * The record belongs to the answer from its first key (`step`): no refresh,
   * supersede or screen-inferred expiry touches it while it runs. The last
   * key resolves it. Anything else after the first key — a human key, a
   * screen that never shows the expected state, a lost grant — leaves it
   * `partial` and pending: 409 `prompt-changed` with `effect:'partial'` now,
   * `already-answered` to every later answer, and the pane's own sweep settles
   * it. No key is ever typed to undo what was typed.
   */
  private async driveFeedback(
    params: ApprovalResolveParams,
    record: ApprovalRequest,
    first: DialogRead,
    feedbackKey: string,
    answer: NonNullable<ApprovalResolveParams['decisionAnswer']>,
    audit: (outcome: string) => void,
  ): Promise<ApprovalResolveResult> {
    const writeStepKey = this.deps.writeStepKey!;
    const sessionId = record.sessionId;
    // Empty or whitespace-only feedback is no feedback: the row key and Enter.
    const text = answer.text !== undefined && answer.text.trim() !== '' ? answer.text : undefined;
    const changed = (): ApprovalResolveResult => ({ ok: false, reason: 'prompt-changed', request: copyRequest(record) });
    if (text !== undefined) {
      // Checked here as well as by the route's parser: the text goes into a
      // bracketed paste, and a control character (ESC ending the paste early,
      // CR/LF submitting it) would turn the rest of it into keys.
      if (!isPasteSafeText(text)) {
        audit('invalid-text:control');
        return { ok: false, reason: 'invalid-text', request: copyRequest(record) };
      }
      // The echo check reads the whole text back off the screen, so it must
      // fit in the field the pane can show.
      const max = planFeedbackMaxWidth(first.cols, first.height);
      if (textWidth(text) > max) {
        audit(`invalid-text:width>${max}`);
        return { ok: false, reason: 'invalid-text', request: copyRequest(record) };
      }
    }
    const keys = [feedbackKey, ...(text !== undefined ? [`\x1b[200~${text}\x1b[201~`] : []), '\r'];
    if (keys.length > STEP_MAX_KEYS) return this.answerInTerminal(record, 'unsupported-shape');
    const plan = first.parsed.plan!;
    const placeholder = plan.feedback!.label;
    const compact = (value: string): string => normalizePromptText(value).replace(/\s+/g, '');
    const onField = (p: ParsedTerminalPrompt): boolean =>
      p.plan?.feedback?.key === feedbackKey && p.options.find((o) => o.selected)?.key === feedbackKey;
    // What the screen must show before key `index` (the one before it drawn).
    const expected = (index: number) => (p: ParsedTerminalPrompt): boolean => {
      if (!onField(p)) return false;
      const label = p.plan!.feedback!.label;
      return index === 1 ? label === placeholder : compact(label) === compact(text ?? '');
    };
    // A longer paste takes the TUI longer to draw.
    const renderWait = (index: number): number => STEP_RENDER_WAIT_MS
      + (index === 2 && text !== undefined ? Math.ceil(textWidth(text) / 100) * STEP_RENDER_WAIT_PER_100_MS : 0);
    const delay = this.deps.promptReadDelay
      ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    const deadline = this.now() + STEP_TOTAL_MS;

    /**
     * Stop after the first key, whatever stopped it: the step is left
     * `partial` (never undone), the answer says so (`effect: 'partial'`), and a
     * sweep that arrived while the step was running is applied now.
     */
    const stop = async (result: ApprovalResolveResult, why: string): Promise<ApprovalResolveResult> => {
      const failure = result.ok ? changed() : result;
      const out = await this.mutate<ApprovalResolveResult>(() => {
        const step = record.step;
        if (!step || step.answerId !== answer.clientAnswerId) return { result: failure };
        if (step.status === 'running') step.status = 'partial';
        const events: ApprovalEvent[] = [];
        const held = this.deferredExpiry.get(record.id);
        this.deferredExpiry.delete(record.id);
        if (record.state === 'pending' && held) {
          record.state = 'expired';
          record.resolvedAt = this.now();
          events.push({ type: 'expire', request: copyRequest(record) });
          this.deps.log?.('info', `[approvals] expired ${record.id} on ${sessionId} (${held}, held while its answer ran)`);
        } else if (record.state === 'pending') {
          events.push({ type: 'press', request: copyRequest(record) });
        }
        return {
          events,
          persist: true,
          result: { ...failure, effect: 'partial' as const, request: copyRequest(record) } as ApprovalResolveResult,
        };
      });
      audit(`${out.ok ? 'ok' : out.reason}:partial:${why}`);
      return out;
    };
    const unwritten = (why: string): ApprovalResolveResult => {
      audit(`prompt-changed:${why}`);
      return changed();
    };

    /** Poll the screen until it shows what key `index` needs, or say why not. */
    const awaitScreen = async (index: number): Promise<DialogRead | 'moved' | 'timeout' | 'gone'> => {
      const until = Math.min(this.now() + renderWait(index), deadline);
      const want = expected(index);
      let lastLook = false;
      for (;;) {
        let screen: Awaited<ReturnType<NonNullable<ApprovalRegistryDeps['readPromptScreen']>>> = null;
        try {
          screen = (await this.deps.readPromptScreen?.(sessionId)) ?? null;
        } catch {
          screen = null;
        }
        if (!screen) return 'gone';
        const step = record.step;
        if (!step || screen.mark.incarnation !== step.incarnation || screen.mark.keyInputRevision !== step.expectedRevision) {
          return 'moved';
        }
        const parsed = parsePlanPrompt(screen.rows, screen.cols ? { cols: screen.cols } : {});
        if (parsed?.active && parsed.plan?.frameFingerprint === plan.frameFingerprint && want(parsed)) {
          return { parsed, mark: screen.mark };
        }
        if (lastLook) return 'timeout';
        // Out of time: one more look after a last pause, then give up.
        if (this.now() >= until) lastLook = true;
        await delay(STEP_POLL_MS);
      }
    };

    let read = first;
    for (let index = 0; index < keys.length;) {
      if (index > 0) {
        const seen = await awaitScreen(index);
        if (typeof seen === 'string') return stop(changed(), seen);
        read = seen;
      }
      const refused = await this.reauthorize(params, record);
      if (refused) {
        if (index > 0) return stop(refused, 'authorize');
        audit(refused.ok ? 'ok' : refused.reason);
        return refused;
      }
      if (this.now() > deadline) return index > 0 ? stop(changed(), 'deadline') : unwritten('deadline');
      const at = index;
      const outcome = await this.mutate<'retry' | 'written' | 'moved' | ApprovalResolveResult>(() => {
        // ── Synchronous from here to the write: nothing can move in between. ──
        if (record.state !== 'pending') {
          return { result: { ok: false, reason: record.state === 'resolved' ? 'already-resolved' : 'expired', request: copyRequest(record) } };
        }
        const step = record.step;
        // The CAS: a stepwise answer starts only on a record nothing answered.
        if (at === 0 ? step !== undefined || record.pressedAt !== undefined
          : step?.answerId !== answer.clientAnswerId || step.status !== 'running') {
          return { result: { ok: false, reason: 'already-answered', request: copyRequest(record) } };
        }
        const now = this.deps.promptScreenMark?.(sessionId) ?? null;
        const revision = at === 0 ? read.mark.keyInputRevision : step!.expectedRevision;
        const incarnation = at === 0 ? read.mark.incarnation : step!.incarnation;
        if (!now || (now.incarnation ?? '') !== (incarnation ?? '') || now.keyInputRevision !== revision) return { result: 'moved' };
        if (now.bytes !== read.mark.bytes) return { result: 'retry' };
        let written: number | null = null;
        try {
          written = writeStepKey(sessionId, keys[at]!);
        } catch (err) {
          this.deps.log?.('warn', `[approvals] step write failed for ${sessionId}: ${String(err)}`);
        }
        if (written === null) return { result: 'moved' };
        const events: ApprovalEvent[] = [];
        if (at === 0) {
          record.step = {
            answerId: answer.clientAnswerId,
            index: 1,
            total: keys.length,
            expectedRevision: written,
            incarnation: now.incarnation ?? '',
            status: 'running',
            startedAt: this.now(),
          };
          events.push({ type: 'press', request: copyRequest(record) });
        } else {
          step!.index = at + 1;
          step!.expectedRevision = written;
        }
        // Every delivered key is on disk before the next one.
        if (at < keys.length - 1) return { events, persist: true, result: 'written' };
        // The last key: the plan is rejected with the feedback. The record is
        // closed here, before the pane's turn resumes (noteSubmitted), so the
        // pane's "answered" finds nothing left to sweep.
        this.deferredExpiry.delete(record.id);
        record.step!.status = 'done';
        record.state = 'resolved';
        record.decision = 'deny';
        record.selectedChoiceKey = feedbackKey;
        record.resolvedBy = sanitizeResolvedBy(params.resolvedBy);
        record.resolvedAt = this.now();
        if (text !== undefined) {
          record.answerDigest = {
            textBytes: Buffer.byteLength(text, 'utf8'),
            textHash: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
          };
        }
        try {
          this.deps.noteSubmitted?.(sessionId);
        } catch (err) {
          this.deps.log?.('warn', `[approvals] noteSubmitted failed for ${sessionId}: ${String(err)}`);
        }
        return {
          events: [{ type: 'resolve', request: copyRequest(record) }],
          result: { ok: true, request: copyRequest(record), durable: true },
        };
      }, (result, durable) => (typeof result === 'object' && result.ok ? { ...result, durable } : result));
      if (outcome === 'written') {
        index++;
        continue;
      }
      if (outcome === 'retry') {
        // Output since the read: read again (and prove again, for the first key).
        if (at === 0) {
          const again = await this.readActiveDialog(sessionId);
          if (!again || this.provenDialog(record, again) !== 'ok') return unwritten('retry');
          read = again;
        }
        if (this.now() > deadline) return at > 0 ? stop(changed(), 'deadline') : unwritten('deadline');
        continue;
      }
      if (outcome === 'moved') return at === 0 ? unwritten('input') : stop(changed(), 'input');
      if (!outcome.ok && at > 0) return stop(outcome, 'settled');
      audit(outcome.ok ? 'answered' : outcome.reason);
      return outcome;
    }
    return changed();
  }

  /**
   * A `decision-v2` answer (`POST /api/approvals/:id/answer`) for a record
   * that is not native and not a plan dialog (see answerPlan): after the
   * lifecycle checks every such record refuses it as `unsupported-shape`.
   */
  private refuseDecisionAnswer(params: ApprovalResolveParams, record: ApprovalRequest | undefined): ApprovalResolveResult {
    if (!record) return { ok: false, reason: 'not-found' };
    if (record.state !== 'pending') {
      return {
        ok: false,
        reason: record.state === 'resolved' ? 'already-resolved' : 'expired',
        ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
        request: copyRequest(record),
      };
    }
    if ((params.resolver ?? 'human') !== 'human' || params.decisionV2Answer !== DECISION_V2_WEB_ANSWER) {
      return this.answerInTerminal(record, 'no-capability');
    }
    // The reflex guard every remote answer takes, in place before any form
    // producer can make this path answer something.
    if (this.now() - record.createdAt < TERMINAL_PROMPT_MIN_ANSWER_AGE_MS) {
      return { ok: false, reason: 'answer-too-soon', request: copyRequest(record) };
    }
    return this.answerInTerminal(record, 'unsupported-shape');
  }

  /**
   * The dialog on screen changed under an answer: replace the record with one
   * built from what is there now (a new id and fingerprint), so the phone
   * re-reads and can answer the dialog that is actually up. `create` carries
   * `replaces`, so the push carries over rather than firing again.
   */
  private async supersedeWithFresh(record: ApprovalRequest, live: DialogRead): Promise<ApprovalRequest | null> {
    const note: TerminalPromptNote = {
      sessionId: record.sessionId,
      agent: record.agent,
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      ...(record.toolName ? { toolName: record.toolName } : {}),
      source: 'detector',
    };
    const fresh = this.buildTerminalPrompt(note, live, this.bindingFor(record.sessionId, note));
    return this.mutate<ApprovalRequest | null>(() => {
      // A stepwise answer owns the record from its first key: never replaced.
      if (record.state !== 'pending' || record.pressedAt !== undefined || record.step) return { result: null };
      record.state = 'superseded';
      record.resolvedAt = this.now();
      fresh.createdAt = this.now();
      this.requests.push(fresh);
      return {
        events: [
          { type: 'supersede', request: copyRequest(record) },
          { type: 'create', request: copyRequest(fresh), replaces: record.id },
        ],
        result: copyRequest(record),
      };
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Run one mutation with exclusive access to `this.requests`, then persist and
   * fan out its events. Every mutator goes through here; nothing mutates
   * `this.requests` outside a `mutate` body.
   */
  private mutate<R = void>(
    body: () => ApprovalEvent[] | { events?: ApprovalEvent[]; result: R; persist?: boolean } | Promise<
      ApprovalEvent[] | { events?: ApprovalEvent[]; result: R; persist?: boolean }
    >,
    /**
     * Last look at the result, once the write outcome is known. The body cannot
     * know it — the persist happens after the body returns — so a caller that
     * needs to report durability folds it in here.
     */
    finalize?: (result: R, durable: boolean) => R,
  ): Promise<R> {
    const run = this.chain.then(async () => {
      const out = await body();
      const events = Array.isArray(out) ? out : (out.events ?? []);
      const result = Array.isArray(out) ? (undefined as unknown as R) : out.result;
      // No events means nothing changed, so nothing had to be written.
      let durable = true;
      // `persist`: a change no event announces (a stepwise answer's progress).
      if (events.length > 0 || (!Array.isArray(out) && out.persist === true)) {
        for (const event of events) {
          if (event.request.native && event.request.state !== 'pending' && event.type !== 'supersede') {
            this.rememberNativeSettled(event.request.native);
          }
          if (event.request.kind !== 'terminal_prompt') continue;
          if (event.request.state !== 'resolved' && event.request.state !== 'expired') continue;
          const settled = this.requests.find((r) => r.id === event.request.id);
          if (settled) this.pruneEvidence(settled);
        }
        this.requests = trimHistory(this.requests);
        durable = await this.persist();
        for (const event of events) this.emit(event);
      }
      return finalize ? finalize(result, durable) : result;
    });
    // Keep the chain alive across a rejection (deckDecisionStore does the same):
    // one throwing mutation must not wedge every later one.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private rememberNativeSettled(native: NativeDecisionRef): void {
    const now = this.now();
    this.nativeSettled.set(nativeKey(native), now);
    if (this.nativeSettled.size <= NATIVE_SETTLED_MEMORY_MAX) return;
    for (const [key, at] of this.nativeSettled) {
      if (now - at >= NATIVE_SETTLED_MEMORY_MS || this.nativeSettled.size > NATIVE_SETTLED_MEMORY_MAX) {
        this.nativeSettled.delete(key);
      }
    }
  }

  /** Flip every pending record matching `match`. Returns the events to fan out. */
  private expirePendingWhere(
    match: (r: ApprovalRequest) => boolean,
    reason: ApprovalExpiryReason,
  ): ApprovalEvent[] {
    const events: ApprovalEvent[] = [];
    for (const r of this.requests) {
      if (r.state !== 'pending' || !match(r)) continue;
      // Only the agent's own events, the pane's end, the turn's end and a
      // restart settle a native decision — never what the screen suggests.
      if (isNative(r) && SCREEN_INFERRED_EXPIRY.has(reason)) continue;
      // A stepwise answer in progress: its own keys move the screen (and the
      // pane's "answered"), so nothing the screen suggests settles it. The
      // driver closes it, or leaves it `partial` for the sweep to settle.
      if (r.step?.status === 'running' && SCREEN_INFERRED_EXPIRY.has(reason)) {
        if (!this.deferredExpiry.has(r.id)) this.deferredExpiry.set(r.id, reason);
        continue;
      }
      // A terminal_prompt whose remote answer was written RESOLVES when its
      // dialog is gone (the answered path, the screen check, the turn's end).
      if (r.pressedAt !== undefined) {
        r.state = 'resolved';
        r.resolvedAt = this.now();
        events.push({ type: 'resolve', request: copyRequest(r) });
        continue;
      }
      r.state = 'expired';
      r.resolvedAt = this.now();
      // #783 — cancel the broker waiter so the bridge defers immediately.
      if (r.kind === 'awaiting_permission') {
        this.deps.notifyGateDropped?.(r.id);
      }
      events.push({ type: 'expire', request: copyRequest(r) });
    }
    if (events.length > 0) {
      this.deps.log?.(
        'info',
        `[approvals] expired ${events.length} pending request(s) (${reason})`,
      );
    }
    return events;
  }

  /** Shared policy for both screen presses and permission-hook verdicts. */
  private refuseOutOfScopePress(
    params: ApprovalResolveParams,
    record: ApprovalRequest,
    stillOnScreen: boolean,
  ): ApprovalResolveResult | null {
    // ── Press scope ───────────────────────────────────────────────────────
    // "Can these bytes be pressed" and "may this pane be pressed at all" are
    // different questions. `decideApprovalPress` answers the second — for an
    // AUTOMATED approve only.
    //
    // A human answering from the phone or the web is looking at the prompt;
    // gating them behind a workspace classification would just be a broken
    // button, and a refused DENY (from anyone) would keep a pane blocked in
    // the name of safety. Both bypass, inside the decision, so the reasoning
    // lives in one place. `resolver` therefore defaults to 'human': every
    // caller that exists today is a person tapping, and an automated presser
    // has to say so — at which point it faces the full check.
    //
    // For that automated caller the check FAILS CLOSED: a pane whose
    // workspace we cannot classify, or whose autonomy setting we cannot read,
    // is refused rather than assumed delegated. Those facts live in main;
    // `pressScope` is the seam that supplies them, and its ABSENCE reports
    // `scope-unavailable` — distinct from a workspace that answered "no", so
    // the missing integration wiring is visible instead of looking like
    // policy.
    // Three distinct ways to have no scope, and an operator fixes each one
    // differently: no feed wired at all, a feed that has never published, and
    // a RECORD with no workspace to ask about (a hook envelope that carried
    // none). Collapsing them sent people to look at the integration wiring
    // for a problem in the hook payload.
    type NoScopeCause = 'unwired' | 'unpublished' | 'record-has-no-workspace';
    const noScopeCause: NoScopeCause | null = !this.deps.pressScope
      ? 'unwired'
      : !record.workspaceId
        ? 'record-has-no-workspace'
        : null;
    const published =
      noScopeCause === null && this.deps.pressScope
        ? this.deps.pressScope(record.workspaceId as string)
        : null;
    // Wired AND answering. A wired feed that has never been published is as
    // unavailable as no feed at all — see the ApprovalRegistryDeps note.
    const scopeAvailable = published !== null;
    const scope = published ?? {};
    const pressDecision = decideApprovalPress({
      resolver: params.resolver ?? 'human',
      decision: params.decision,
      scopeAvailable,
      ...scope,
      // Only hook-sourced requests are ever created (see the header), so the
      // record's own existence is the origin evidence.
      origin: 'hook',
      stillOnScreen,
    });
    if (!pressDecision.press && pressDecision.reason !== 'prompt-gone') {
      // NOT an expiry: the request is live and a human at the desktop can
      // still answer it. We simply may not press on their behalf.
      const SCOPE_CAUSE_DETAIL: Record<NoScopeCause, string> = {
        unwired: 'ApprovalRegistryDeps.pressScope is not wired',
        unpublished: 'the main process has not published its workspace fact table yet',
        'record-has-no-workspace': 'this request carries no workspaceId, so there is nothing to classify',
      };
      const cause = noScopeCause ?? (scopeAvailable ? null : 'unpublished');
      this.deps.log?.(
        pressDecision.reason === 'scope-unavailable' ? 'warn' : 'info',
        pressDecision.reason === 'scope-unavailable'
          ? `[approvals] refused ${record.id} on ${record.sessionId}: automated press has no ` +
            `workspace scope source (${SCOPE_CAUSE_DETAIL[cause ?? 'unwired']}) — ` +
            'a human can still answer this request'
          : `[approvals] refused ${record.id} on ${record.sessionId}: out of press scope (${pressDecision.reason})`,
      );
      return {
        ok: false,
        reason: 'out-of-scope',
        // The condition that actually refused. 'out-of-scope' is one
        // bucket in the closed wire vocabulary the web layer maps to
        // status codes; a relay that has to turn the refusal into a hint —
        // or decide whether the operator's policy said no, as opposed to
        // the daemon not knowing — cannot act on a bucket. See
        // ApprovalResolveResult.pressRefusal.
        pressRefusal: pressDecision.reason,
        request: copyRequest(record),
      } as ApprovalResolveResult;
    }

    return null;
  }

  /**
   * Run the caller's `authorize` (see ApprovalResolveParams). Returns the
   * refusal to answer with, or null when the caller may proceed. A throw, a
   * rejection or an unknown verdict fails closed as `unauthorized`; a check
   * that does not settle within `authorizeTimeoutMs` fails closed as
   * `authorization-unconfirmed` (retryable — the credential may be fine). The
   * record is left exactly as it was: no state change, no event, no persist.
   */
  private async reauthorize(
    params: ApprovalResolveParams,
    record: ApprovalRequest,
  ): Promise<ApprovalResolveResult | null> {
    const authorize = params.authorize;
    if (!authorize) return null;
    let verdict: 'ok' | 'expired' | 'read-only' | 'timeout';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      verdict = await Promise.race([
        authorize(copyRequest(record)),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.deps.authorizeTimeoutMs ?? 2000);
        }),
      ]);
    } catch (err) {
      this.deps.log?.('warn', `[approvals] authorize threw for ${record.id}: ${String(err)}`);
      verdict = 'expired';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (verdict === 'ok') return null;
    if (verdict === 'timeout') {
      this.deps.log?.('warn', `[approvals] authorize timed out for ${record.id}`);
    }
    return {
      ok: false,
      reason: verdict === 'read-only' ? 'input-revoked'
        : verdict === 'timeout' ? 'authorization-unconfirmed'
        : 'unauthorized',
      request: copyRequest(record),
    };
  }

  /** A 501 `answer-in-terminal` for a press the daemon cannot make, naming why. */
  private answerInTerminal(record: ApprovalRequest, why: AnswerRefusalReason): ApprovalResolveResult {
    this.deps.log?.('info', `[approvals] refused ${record.id} on ${record.sessionId}: answer in terminal (${why})`);
    return { ok: false, reason: 'answer-in-terminal', answerRefusal: why, request: copyRequest(record) };
  }

  /** Expire an `awaiting_input` record without writing to its pane (inside the mutation chain). */
  private expireUnpressed(
    record: ApprovalRequest,
    rows: readonly string[],
    reason: 'prompt-gone',
    why: string,
  ): { events: ApprovalEvent[]; result: ApprovalResolveResult } {
    record.state = 'expired';
    record.resolvedAt = this.now();
    if (rows.length > 0) record.screenTail = formatScreenTail(rows);
    this.deps.log?.('info', `[approvals] refused ${record.id} on ${record.sessionId}: ${why}`);
    return {
      events: [{ type: 'expire', request: copyRequest(record) }],
      result: { ok: false, reason, request: copyRequest(record) },
    };
  }

  private async safeReadScreen(sessionId: string): Promise<string[] | null> {
    try {
      return await this.deps.readScreenTail(sessionId);
    } catch (err) {
      // An unreadable screen is not evidence of a prompt — refuse.
      this.deps.log?.('warn', `[approvals] screen read failed for ${sessionId}: ${String(err)}`);
      return null;
    }
  }

  /** True when the write landed. Callers decide what a false means. */
  private async persist(): Promise<boolean> {
    const state: ApprovalPersistedState = { version: 1, requests: this.requests };
    const ok = await saveApprovalState(this.deps.wmuxDir, state);
    if (!ok) {
      this.deps.log?.('warn', '[approvals] could not persist approvals.json');
    }
    return ok;
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // A broken subscriber (a dead SSE response) must never take down the
        // mutation that produced the event.
        this.deps.log?.('warn', `[approvals] listener threw: ${String(err)}`);
      }
    }
  }
}

export { RESOLVED_BY_MAX, sanitizeResolvedBy } from './approvalStore';
