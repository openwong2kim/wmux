// M2 — the approval-request wire/dep types.
//
// Kept in its own module so the web server (Worker B) can import the NARROW
// interface it consumes without pulling in the registry implementation, its
// persistence, or the headless-snapshot dependency chain. `WebTerminalServer`
// takes an `ApprovalRegistryApi` in its deps and its unit tests inject a fake
// that satisfies exactly this — the same shape the daemon injects the real
// registry through.

// Type-only, and the one import this module has: `approvalKeystrokes` is
// itself dependency-free, so the narrow-interface property above survives.
import type { ApprovalPressRefusal } from './approvalKeystrokes';
import type { QuestionShape } from './askUserQuestion';
import type { AgentSlug } from '../../shared/agentIdentity';

/** What the resolver asked for. Approve = affirmative, deny = reject. */
export type ApprovalDecision = 'approve' | 'deny';

/**
 * A structured approval choice. Each carries a `key` the resolver sends back
 * and a human-readable `label`. The key is the 1-based index string ('1', '2',
 * …) that identifies the original option in Claude Code's AskUserQuestion TUI —
 * preserving the digit even when unlabeled entries are dropped from `options`.
 *
 * Additive alongside the legacy `options` array: old clients that only know
 * `options` continue to render label-only rows, and new clients that understand
 * `choices` get the key they need to resolve a specific option.
 */
export interface ApprovalChoice {
  /** The keystroke digit ('1', '2', …) that selects this option in the TUI. */
  key: string;
  /** Sanitized display label — same content as the corresponding `options` entry. */
  label: string;
}

/**
 * Lifecycle of one request. Only `pending` is actionable; the other three are
 * terminal.
 *   - resolved   a human answered it and the keystroke reached the PTY
 *   - expired    the turn ended, the pane went away, the daemon restarted, or
 *                the pre-write screen re-verify refused (see 'prompt-gone')
 *   - superseded the same session raised a NEW awaiting_input over this one
 */
export type ApprovalState = 'pending' | 'resolved' | 'expired' | 'superseded';

export interface ApprovalRequest {
  /** crypto.randomUUID. */
  id: string;
  /** Daemon session (pane) id — the PTY the keystroke would reach. */
  sessionId: string;
  /**
   * Read from the RESOLVED session's env, never from the hook envelope: the
   * bridge payload is authenticated but not trusted, and the cwd resolution
   * tier never validates a claimed workspaceId.
   */
  workspaceId?: string;
  /** Agent SLUG ('claude'), not the display name — the keystroke map keys on it. */
  agent: string;
  /**
   * `awaiting_input` — an AskUserQuestion prompt (keystroke resolution).
   * `awaiting_permission` — a PreToolUse gate on a high-risk tool (RPC-waiter
   *   resolution, no keystroke). #783
   * `terminal_prompt` — the agent's OWN terminal dialog (Claude Code's "Do you
   *   want to proceed?" permission prompt), as opposed to an AskUserQuestion
   *   select. Created from the PermissionRequest hook or from confirmed
   *   detector attention, and parsed off the screen at creation. ANSWERABLE
   *   ONLY when the parse was whole and offers a plain Yes, only by a web
   *   caller that declared the `terminal-prompt-answer` capability, only with
   *   a plain Yes/No `choiceKey`, and only while the live screen still shows
   *   the same dialog (`promptFingerprint`) — see ApprovalRegistry.resolve.
   *   Otherwise informational: `question`, `reason`, `choices` and
   *   `promptFingerprint` are absent and `resolve` refuses with
   *   `answer-in-terminal`. Never carries `options` or `screenTail`.
   */
  kind: 'awaiting_input' | 'awaiting_permission' | 'terminal_prompt';
  /**
   * A4 — WHAT is being asked, extracted from the hook envelope's `tool_input`
   * at creation time (see askUserQuestion.ts).
   *
   * Load-bearing, not decoration: `approve` is encoded as "press the first
   * option", which is a safe word for a consent-shaped question and a dangerous
   * one for "which file should I delete?". A surface that renders an approve
   * button without these fields is asking someone to answer a question they
   * cannot read.
   *
   * Both are AGENT-AUTHORED text — sanitized (control chars stripped) and
   * truncated before they get here, but still untrusted content: render them as
   * text, never as markup, and never as instructions.
   *
   * Absent whenever the payload had no usable shape. Extraction never blocks a
   * request: a request with no question text still beats no request at all.
   */
  question?: string;
  /**
   * Option LABELS only, in payload order, capped. Not a press index — entries
   * that carried no usable label are dropped, so position here does not promise
   * the digit that selects them.
   */
  options?: string[];
  /**
   * Structured choices with key+label, additive alongside `options`. Each
   * `key` is the 1-based digit that selects the option in Claude Code's TUI,
   * preserving the original index even when unlabeled entries are dropped from
   * `options`. New clients use this to send `choiceKey` on resolve; old clients
   * fall back to `options` for display-only rendering.
   *
   * Present only when the payload carried at least one usable option with a
   * deterministic key. Absent (not empty) when no choices could be extracted.
   */
  choices?: ApprovalChoice[];
  /**
   * `awaiting_input` only: present when the AskUserQuestion is NOT one
   * single-select question (see askUserQuestion.ts `QuestionShape`). One
   * keystroke cannot answer such a prompt, so an approve refuses with
   * `needs-v2` instead of pressing a digit that only toggles a checkbox or
   * advances a tab. Daemon-internal: not on the web wire (`approvalWire`).
   */
  questionShape?: QuestionShape;
  /**
   * A HINT that the question names a destructive action — set at creation when
   * `question`/`options` match the daemon's existing critical-action patterns
   * (shared/criticalPatterns.ts, the same list the PTY scanner uses).
   *
   * IT IS NOT A GATE. A surface may use it to step up its own confirmation
   * (Face ID, a second tap, a louder colour); it must NEVER use it to withhold,
   * delay or refuse an answer. The patterns are regexes over agent-authored
   * prose: they miss (an `rm -rf` described in words) and they over-fire (a
   * question ABOUT deleting a table). Both directions are expected, and neither
   * may cost a human the ability to answer the prompt in front of them.
   *
   * Absent means "no match", never "safe". Only 'critical' exists today; the
   * softer `review` tier is deliberately not carried — see hasCriticalRisk.
   *
   * The one place it does gate: an AUTOMATED approve (a brain or the HQ lane)
   * is refused as `critical-risk` (decideApprovalPress). That withholds
   * nothing from a human — the record stays pending in front of them — it
   * only stops a machine from saying yes on their behalf.
   */
  risk?: 'critical';
  /**
   * How the hook that created this record was tied to its pane. `exact`: the
   * hook named this pane's id (a wmux-launched agent). `inexact`: the pane was
   * guessed from the workspace or the cwd — e.g. a Claude started outside wmux
   * that cd'd into a task worktree. Only an `exact` record can be approved by
   * an automated caller; absent reads as not exact. Daemon-internal.
   */
  attribution?: 'exact' | 'inexact';
  /** Epoch ms. */
  createdAt: number;
  /**
   * Epoch ms this request stops being answerable on its own.
   *
   * Present on `awaiting_permission` records only: a gate holds a real timer
   * (the GateBroker self-defers and the tool falls back to the agent's own
   * local prompt), so there is a genuine deadline to render. An
   * `awaiting_input` record has no timer — it lives until the turn ends — and
   * must not grow a fake countdown.
   *
   * REPORTED BY THE BROKER, never computed here. The broker's timer is armed
   * after the record is created and for `min(the bridge's own remaining budget,
   * the cap)`, so `createdAt + cap` is a different number from the moment the
   * tool actually gives up. It calls back through `noteGateDeadline` when the
   * timer is armed, which is why this is absent for the first instant of a
   * record's life and stays absent on a gate that was deferred immediately.
   *
   * Additive and advisory: a surface without it renders no countdown, and no
   * decision anywhere is made from it. The daemon's own expiry is driven by the
   * broker's timer, not by this number.
   */
  deadlineAt?: number;
  state: ApprovalState;
  /**
   * #783 — the tool that triggered the gate. Present only on
   * `kind:'awaiting_permission'` records. The phone shows this so the operator
   * knows WHAT the gate is asking about (e.g. "Bash" → a shell command).
   */
  toolName?: string;
  /**
   * #783 — a short summary of the tool's input (sanitised + truncated). Present
   * only on `kind:'awaiting_permission'` records. Lets the phone render "what
   * command" / "what file" without a second round trip.
   */
  toolInputSummary?: string;
  /**
   * What the dialog is about, sanitized and capped at 200 characters. Present
   * only on `kind:'terminal_prompt'` records, and only when known (the command
   * rows of the parsed dialog, else a permission hook's tool input). Display
   * only: nothing is decided from it.
   * Agent-authored text: render it as text, never as markup.
   */
  summary?: string;
  /**
   * The permission-rule line of a `terminal_prompt` dialog ("Permission rule
   * Bash(rm -rf *) requires confirmation for this command."), capped. Present
   * only on an answerable record. Agent-authored text.
   */
  reason?: string;
  /**
   * Hash of the whole `terminal_prompt` dialog as parsed at creation (see
   * terminalPromptParse.ts). Present only on an answerable record. An answer
   * must echo it, and the live screen must still hash to it, before a key is
   * written.
   */
  promptFingerprint?: string;
  /**
   * When the one remote answer to a `terminal_prompt` was written into the
   * pane. The record stays `pending` until the dialog is seen gone (the screen
   * verifier, or the bridge's answered path), then resolves; another answer is
   * refused as `already-answered` meanwhile.
   */
  pressedAt?: number;
  /**
   * DAEMON-INTERNAL `terminal_prompt` fields — never on the web wire
   * (`approvalWire` is an allowlist), not persisted meaningfully.
   *   - `toolUseId`: the transcript `tool_use` this dialog is bound to.
   *   - `dialogKey`: which dialog this is (screen hash + tool_use id), for the
   *     per-dialog creation cooldown.
   *   - `keyRevisionAtCreate`: the pane's fence input revision when the dialog
   *     was read; any key or click since means a human is at the terminal.
   */
  toolUseId?: string;
  dialogKey?: string;
  keyRevisionAtCreate?: number;
  /**
   * How an answer reaches the agent (see DecisionChannel). Absent means the
   * channel follows from `kind`, which is every record that predates it.
   * Daemon-internal: `approvalWire` is an allowlist and never copies it.
   */
  channel?: DecisionChannel;
  /**
   * `channel: 'native-rpc'` only: the agent's own request this record mirrors.
   * An answer goes back to the agent's server under `requestId`, never into
   * the pane as keys. Daemon-internal.
   */
  native?: NativeDecisionRef;
  /**
   * The structured decision a `decision-v2` client renders and answers through
   * `POST /api/approvals/:id/answer`. Agent-authored text inside: render it as
   * text, never as markup.
   */
  form?: DecisionForm;
  /** 32 hex. An answer must echo it (see DecisionForm). */
  formFingerprint?: string;
  /**
   * A multi-key answer's progress (stepwise driver). Separate from `pressedAt`:
   * a stepwise answer never sets it. Daemon-internal apart from the
   * `{index,total,status}` projection a `decision-v2` client gets.
   */
  step?: DecisionStep;
  /**
   * OpenCode's request id behind an informational `awaiting_input` card (the
   * hook's `permId`), so the agent's own answer settles exactly that card.
   * Daemon-internal.
   */
  hookRequestId?: string;
  /** Size and hash of a phone-typed answer text; the text itself is never stored. */
  answerDigest?: { textBytes: number; textHash: string };
  /** Who answered — free-form caller-supplied label ('web', an operator name). */
  resolvedBy?: string;
  resolvedAt?: number;
  decision?: ApprovalDecision;
  /**
   * When resolved with a specific `choiceKey`, the key that was selected. Lets
   * the history UI show WHICH option was chosen, not just approve/deny.
   */
  selectedChoiceKey?: string;
  /**
   * `awaiting_input` expired as answered at the terminal: the option label
   * Claude reported for this question (PostToolUse `tool_response.answers`),
   * sanitized and capped. Lets main's Moa shadow judge compare its answer with
   * the owner's (moaShadowFeed.ts). Display-only, never a key to press.
   * Daemon-internal: `approvalWire` is an allowlist and never copies it.
   */
  localAnswer?: string;
  /**
   * The pane tail the registry actually looked at when it made the resolve
   * decision — the verified screen on a success, the REJECTED screen on a
   * 'prompt-gone' refusal (which is the forensically useful one: it is the
   * only record of why an approval was refused).
   *
   * Captured at RESOLVE time, not create time. At create time the prompt is
   * not on screen yet — the hook that creates the request is Claude Code's
   * PreToolUse, which fires BEFORE the tool renders anything — so a create-time
   * capture would store pre-prompt content and would put a multi-second
   * headless-terminal parse on the hook bridge's 2 s budget.
   */
  screenTail?: string;
}

/**
 * How a decision's answer is delivered.
 *   hook-verdict  a held PreToolUse gate, woken through the GateBroker
 *   native-rpc    the agent's own server (OpenCode TUI plugin, Codex relay)
 *                 answers its own request; nothing is typed into the pane
 *   fenced-keys   keys typed into the pane behind the screen/revision fences
 *   none          informational: answered at the terminal (decline aside)
 */
export type DecisionChannel = 'hook-verdict' | 'native-rpc' | 'fenced-keys' | 'none';

/** The agent-side identity of a `native-rpc` decision. */
export interface NativeDecisionRef {
  /** `claude`: a chat-v2 driver's request (src/daemon/chat/v2), answered through its stdio.
   *  TODO(#1904): each member is a native decision channel written in code; a
   *  registry slug subset, persisted on records, so it is not derived. */
  adapter: Extract<AgentSlug, 'opencode' | 'codex' | 'claude'>;
  /** OpenCode requestID / Codex JSON-RPC server request id / Claude `control_request.request_id`. */
  requestId: string;
  /** OpenCode sessionID. */
  nativeSessionId?: string;
  /** Codex thread id. */
  threadId?: string;
  /** Codex relay id. */
  relayId?: string;
  /** Codex ServerRequest method. */
  method?: string;
  /**
   * OpenCode: the plugin's hash of the whole request. Part of the record's
   * fingerprint (the same id asking something else is a new card) and echoed
   * with the answer, so a stale card is refused right before it is sent.
   */
  digest?: string;
}

/** The form kinds a daemon can produce; `/api/config` `decisionForms` lists them. */
export type DecisionFormKind = 'permission' | 'plan' | 'questions';

/**
 * A structured decision (`decision-v2`). Options that would widen what the
 * agent may do without asking again (a lasting rule, auto/bypass modes,
 * OpenCode `always`, Codex accept-for-session) are never listed in `actions`.
 */
export interface DecisionForm {
  v: 1;
  kind: DecisionFormKind;
  questions?: Array<{
    /** 'q0', 'q1', … */
    id: string;
    header?: string;
    text: string;
    multiSelect: boolean;
    allowOther: boolean;
    /**
     * `description`: Claude AskUserQuestion only — the option's description,
     * drawn under its label.
     */
    options: Array<{ key: string; label: string; description?: string }>;
  }>;
  actions: Array<{ id: string; label: string; needsText?: true }>;
}

/** A stepwise (multi-key) answer's progress on a record. */
export interface DecisionStep {
  answerId: string;
  index: number;
  total: number;
  expectedRevision: number;
  incarnation: string;
  status: 'running' | 'partial' | 'done';
  startedAt: number;
  /**
   * AskUserQuestion driver: a key that may submit the whole answer has been
   * typed. From then on only the screen can say where the answer is, and the
   * record is no longer held against a supersede. Daemon-internal.
   */
  mayBeSubmitted?: true;
  /**
   * AskUserQuestion driver: the answer stopped 409 `answer-uncertain` — every
   * key that could submit it was typed and the screen never confirmed it. Who
   * answered. Only Claude's own "answered" report resolves such a record (as
   * this answer); any other end expires it. Daemon-internal.
   */
  uncertainBy?: string;
}

/** A validated `POST /api/approvals/:id/answer` body (see web/decisionAnswer.ts). */
export interface DecisionAnswer {
  formFingerprint: string;
  clientAnswerId: string;
  action?: string;
  answers?: Array<{ questionId: string; keys: string[]; other?: string }>;
  text?: string;
}

/**
 * What the daemon asks a native adapter to do with one request. `formKind`
 * picks the agent's call (OpenCode: `permission.reply` vs `question.reply` /
 * `question.reject`); `choiceKey` is the option a single-select question was
 * answered with (approve only).
 */
export interface NativeDecisionReply {
  decision: ApprovalDecision;
  formKind: DecisionFormKind;
  choiceKey?: string;
  /**
   * `questions` approve only: one entry per question, in form order — the
   * chosen options' form keys and any typed answer. The adapter maps keys to
   * what its agent takes (OpenCode: option indexes, then its own labels).
   */
  answers?: Array<{ keys: string[]; other?: string }>;
}

/**
 * A native adapter's answer. `not-found`: the agent no longer has the
 * request (answered locally, or gone). `unavailable`: the agent's server could
 * not be reached — nothing was delivered. `uncertain`: the answer left and
 * its outcome was lost; it may have landed. `refused`: the agent turned this
 * answer down for good. `changed`: the request no longer asks what the card
 * showed.
 */
export type NativeDecisionOutcome = 'ok' | 'not-found' | 'unavailable' | 'uncertain' | 'refused' | 'changed';

/** Longest the registry waits on a native adapter before calling the answer uncertain. */
export const NATIVE_ANSWER_TIMEOUT_MS = 10_000;

/**
 * Who must hold the device's input grant to act on this record. True for a
 * permission gate or a terminal dialog (either one lets a tool run), for any
 * native decision (the agent's server acts on it), and for every v2 answer
 * (stepwise keys or phone-typed text). The one read-only exception left is
 * the single-key approve of a screen-backed, non-native `awaiting_input`.
 */
export function needsInputGrant(
  record: Pick<ApprovalRequest, 'kind' | 'channel' | 'native'>,
  via: 'resolve' | 'decline' | 'answer' = 'resolve',
): boolean {
  if (via !== 'resolve') return true;
  return record.kind === 'awaiting_permission'
    || record.kind === 'terminal_prompt'
    || isNativeDecision(record);
}

/**
 * A record the agent's own server holds — on the `native-rpc` channel, or on
 * `none` because the kill switch was off when it was made. Either way no
 * screen or key rule applies to it: it is not a dialog wmux can read or type.
 */
export function isNativeDecision(record: Pick<ApprovalRequest, 'channel' | 'native'>): boolean {
  return record.channel === 'native-rpc' || record.native !== undefined;
}

/**
 * Why a resolve did not happen. Closed set — the web layer maps these to
 * status codes (409 already-resolved, 410 expired, 501 unsupported-agent,
 * 404 not-found), so a new reason is an API change, not an implementation
 * detail.
 *
 * `expired` covers BOTH the 'expired' and 'superseded' states: they are the
 * same answer to the caller ("this request is dead, re-read the list"), and
 * the precise state is on `request.state` for a caller that wants to say which.
 * A refused pre-write re-verify reports `prompt-gone` and expires the request.
 *
 * `invalid-choice-key` is returned when a `choiceKey` was provided but it does
 * not belong to this request's `choices` set, or when the screen re-verify
 * cannot confirm the selected option row is visible. Fails closed — never
 * types a digit for a choice it cannot verify.
 */
export type ApprovalResolveFailure =
  | 'not-found'
  | 'already-resolved'
  | 'expired'
  | 'unsupported-agent'
  | 'prompt-gone'
  | 'invalid-choice-key'
  // The pane is outside the press scope (`decideApprovalPress`): not a
  // delegated task workspace, autonomy off, or a fact the daemon could not
  // establish — unknown is a refusal. NOT an expiry: the request stays live and
  // a human at the desktop can still answer it themselves.
  | 'out-of-scope'
  // The caller's `authorize` check no longer holds: the credential is gone
  // ('unauthorized') or no longer carries the input grant this record needs
  // ('input-revoked'). NOT an expiry: the request stays pending, untouched.
  | 'unauthorized'
  | 'input-revoked'
  // The caller's `authorize` did not settle in time. Fail closed, but this is
  // not a verdict on the credential: the caller may retry.
  | 'authorization-unconfirmed'
  // A `terminal_prompt` this caller may not answer: the record is not
  // answerable, the caller is not a capable web client, or the resolver is
  // automated. NOT an expiry: the record stays pending until the dialog closes.
  // The web layer maps it to 501.
  | 'answer-in-terminal'
  // The one remote answer to this `terminal_prompt` was already written.
  | 'already-answered'
  // The dialog on screen is not the one the answer was for: it changed, is no
  // longer the active dialog at the bottom, or the pane moved under the answer.
  // Nothing was written.
  | 'prompt-changed'
  // A `terminal_prompt` answer too soon after the record appeared.
  | 'answer-too-soon'
  // A `terminal_prompt` decline (or answer) for a record the daemon cannot tie
  // to one tool call on screen: it was never matched to its transcript call.
  // Nothing is written; the record stays pending.
  | 'prompt-unverified'
  // A `terminal_prompt` answer whose `decision` does not match the option its
  // `choiceKey` names (approve ↔ plain Yes, deny ↔ plain No), or whose
  // `choiceKey` / `promptFingerprint` is missing.
  | 'invalid-choice'
  // An approve on an `awaiting_input` record whose `questionShape` one key
  // cannot answer (multi-select, or several questions). NOT an expiry: the
  // record stays pending, deny (Esc) still works, and a human answers the rest
  // in the pane. The web layer maps it to 501 with `reason: 'needs-v2'`.
  | 'needs-v2'
  // A native decision whose agent server could not be reached: nothing was
  // delivered, the record stays pending, the caller may retry (503).
  | 'agent-unavailable'
  // A native decision whose agent server did not answer in time: the answer
  // may or may not have landed. Never retried by the daemon (409).
  | 'answer-uncertain'
  // A phone-typed answer text the dialog cannot take as it is: a control
  // character, or longer than the pane can show. Nothing was written (400).
  | 'invalid-text';

/**
 * Why a phone-typed text was refused (`invalid-text`), sent as the 400's
 * `reason`: wider than the field the pane can show, read as the free-text
 * row's placeholder, or not typeable as it is (a control character,
 * whitespace only, or a start that reads as a checkbox).
 */
export type DecisionTextRefusal = 'too-wide' | 'matches-placeholder' | 'unsafe-text';

/**
 * The one-line `reason` a 501 carries on the web wire, next to its unchanged
 * `error`: WHY the phone cannot answer, so a client can say more than "open
 * the computer". Closed set, documented in docs/phone-client-contract.md.
 *   no-capability      the caller cannot answer this kind remotely (no
 *                      capability header, or an automated resolver)
 *   unsupported-shape  the dialog was not bound and parsed whole, or a
 *                      question record has nothing to identify it by
 *   screen-unreadable  the pane cannot be read together with its state
 *   secret-input       reserved — no 501 path emits it yet
 *   needs-v2           answerable only by the stepwise v2 answer path
 *   unsupported-agent  no keystroke map for this agent
 */
export type AnswerRefusalReason =
  | 'no-capability'
  | 'unsupported-shape'
  | 'screen-unreadable'
  | 'secret-input'
  | 'needs-v2'
  | 'unsupported-agent';

export type ApprovalResolveResult =
  | {
      ok: true;
      request: ApprovalRequest;
      /**
       * Whether the resolved record reached DISK.
       *
       * `ok` and `durable` answer different questions and must not be collapsed.
       * `ok` means the keystroke was written into the PTY — that already
       * happened and cannot be undone, which is why a failed disk write does
       * not fail the call. `durable` false means the record of it did not
       * survive: the agent got its answer, but a daemon restart reloads the
       * request as pending, invalidates it, and the decision and who made it
       * are gone from the history.
       *
       * Surfaced rather than only logged so a caller can tell the operator the
       * answer landed but will not be remembered, instead of the daemon knowing
       * that privately.
       */
      durable: boolean;
    }
  | {
      ok: false;
      reason: Exclude<ApprovalResolveFailure, 'answer-in-terminal'>;
      /**
       * Present ONLY with `reason: 'out-of-scope'` — the concrete condition
       * `decideApprovalPress` refused on (`press-capability-off`,
       * `autonomy-off`, `not-a-task-workspace`, …).
       *
       * `reason` is the closed wire vocabulary the web layer maps to status
       * codes, and 'out-of-scope' is deliberately one bucket there. But a
       * caller that has to DO something about the refusal — the orchestrator's
       * `approval.press` relay, which turns it into a hint and decides whether
       * to re-open the typed path — cannot act on a bucket. Additive: a caller
       * that ignores this field behaves exactly as before.
       */
      pressRefusal?: ApprovalPressRefusal;
      /**
       * `partial`: a stepwise answer stopped after typing some of its keys
       * (`request.step` says how far), whatever `reason` stopped it.
       * `uncertain`: with `answer-uncertain` — every key was typed and the
       * answer was not confirmed.
       */
      effect?: 'partial' | 'uncertain';
      /** With `invalid-text`: why. */
      textRefusal?: DecisionTextRefusal;
      /** Present on 'already-resolved' — the 409 UX names who got there first. */
      resolvedBy?: string;
      /** Absent only for 'not-found'. */
      request?: ApprovalRequest;
    }
  | {
      ok: false;
      reason: 'answer-in-terminal';
      /**
       * REQUIRED: why the phone cannot answer. The web layer sends it as the
       * 501's `reason`; a refusal that cannot name its cause does not compile.
       */
      answerRefusal: AnswerRefusalReason;
      request?: ApprovalRequest;
      /** Never set on this variant; declared so callers can read it off any refusal. */
      pressRefusal?: undefined;
      effect?: undefined;
      textRefusal?: undefined;
      resolvedBy?: undefined;
    };

/** `press`: a remote answer to a `terminal_prompt` was written; still pending. */
export type ApprovalEventType = 'create' | 'resolve' | 'expire' | 'supersede' | 'press';

/** One lifecycle transition. The record carries its post-transition state. */
export interface ApprovalEvent {
  type: ApprovalEventType;
  request: ApprovalRequest;
  /**
   * On a `create`: the id of the record this one replaces within the SAME
   * awaiting episode (a `terminal_prompt` re-parsed after its dialog changed).
   * Push does not fire again for it — one push per episode.
   */
  replaces?: string;
}

/** Why a pending request was expired. Log/diagnostic only, never persisted. */
export type ApprovalExpiryReason =
  | 'daemon-restart'
  | 'turn-ended'
  | 'session-start'
  | 'pane-gone'
  | 'prompt-gone'
  | 'answered-locally'
  // The user submitted a new prompt: the input box is back, so the question
  // it would answer is no longer on screen (Esc sends no hook of its own).
  | 'prompt-submitted'
  // #783 — the gate self-deferred before the harness deadline (phone did not
  // answer in time). The record is expired so a late phone tap gets a 410.
  | 'gate-timed-out'
  // The awaiting-state verifier found the dialog gone from the pane's screen.
  // Also starts the `terminal_prompt` creation cooldown for that pane.
  | 'screen-cleared';

/** What HookIngest knows when it asks for a `terminal_prompt` record. */
export interface TerminalPromptNote {
  sessionId: string;
  agent: string;
  workspaceId?: string;
  toolName?: string;
  summary?: string;
  /** The PermissionRequest hook's `tool_input` — a binding when the transcript has none. */
  toolInput?: Record<string, unknown>;
  /** The hook's `tool_use_id`, when it carried one. */
  toolUseId?: string;
  /** The hook's Claude `session_id`: must be the pane's own agent session. */
  hookSessionId?: string;
  /** The hook's `prompt_id` (the user turn): an extra discriminator, never proof alone. */
  promptId?: string;
  /** `hook` (PermissionRequest) or `detector` (confirmed screen attention). */
  source: 'hook' | 'detector';
}

/**
 * The half of the registry HookIngest drives. Separate from the read/resolve
 * API on purpose: the ingest path may only CREATE and EXPIRE, and both calls
 * are fire-and-forget because the hook bridge runs inside the agent's process
 * on a hard 2 s budget and cannot wait for our disk write.
 */
export interface ApprovalHookSink {
  noteHookAwaitingInput(input: {
    sessionId: string;
    agent: string;
    workspaceId?: string;
    /** A4 — already extracted and sanitized by the envelope-aware caller. */
    question?: string;
    options?: string[];
    /** Structured choices with key+label, extracted alongside options. */
    choices?: ApprovalChoice[];
    questionShape?: QuestionShape;
    /** The agent's own request id behind the card (OpenCode `permId`). */
    requestId?: string;
    /**
     * Claude-family AskUserQuestion only: the whole prompt as a `questions`
     * form (see claudeQuestionsForm), answered by the stepwise driver.
     */
    form?: DecisionForm;
    /** See ApprovalRequest.attribution. */
    attribution?: 'exact' | 'inexact';
  }): void;
  /**
   * Expire a pane's informational `awaiting_input` cards for these agent
   * request ids (`unkeyed`: also cards with none). Optional so a sink that
   * predates it still type-checks.
   */
  expireHookAwaiting?(sessionId: string, requestIds: readonly string[], unkeyed?: boolean): void | Promise<unknown>;
  /**
   * #783 — create a pending permission-gate record. Returns the new record's id
   * SYNCHRONOUSLY (generated before the mutation is queued) so the caller can
   * register the waiter with the GateBroker before the record is even on disk.
   * The record carries `kind:'awaiting_permission'` and resolves through the
   * same CAS as an `awaiting_input` record — `POST /api/approvals/:id` branches
   * on kind and wakes the waiter instead of pressing a key.
   */
  noteGateAwaiting(input: {
    sessionId: string;
    agent: string;
    workspaceId?: string;
    toolName: string;
    toolInputSummary?: string;
    /** Judged on the call's FULL input before the summary was cut. */
    risk?: 'critical';
    /** See ApprovalRequest.attribution. */
    attribution?: 'exact' | 'inexact';
  }): string;
  /**
   * Record the agent's own terminal dialog as a `kind:'terminal_prompt'`
   * record, parsed off the pane's screen. A no-op when the pane already has any
   * pending record, the agent is not Claude-family, or the pane is inside the
   * cooldown that follows a `screen-cleared` expiry. It never supersedes
   * anything. Optional so a sink that predates the kind still type-checks.
   */
  noteTerminalPrompt?(input: TerminalPromptNote): void | Promise<void>;
  /**
   * `kind` narrows the sweep to one record kind; omitted ⇒ every kind.
   * `answered`: with `answered-locally`, the answers Claude reported for its
   * AskUserQuestion (question text → answer), when the hook carried them.
   */
  expireForSession(
    sessionId: string,
    reason: ApprovalExpiryReason,
    kind?: ApprovalRequest['kind'],
    answered?: Readonly<Record<string, string>>,
  ): void;
  /**
   * The agent is starting another tool: retire the pane's pending
   * AskUserQuestion record if a screen read shows its question is gone.
   * Optional so a sink without a screen (tests) can omit it.
   */
  retireStaleQuestion?(sessionId: string): void;
}

export interface ApprovalListResult {
  pending: ApprovalRequest[];
  /** Newest first. Bounded — see RESOLVED_HISTORY_CAP. */
  recentlyResolved: ApprovalRequest[];
}

export interface ApprovalResolveParams {
  id: string;
  decision: ApprovalDecision;
  /** Free-form label for the 409 UX. Empty string is accepted, not rejected. */
  resolvedBy: string;
  /**
   * When present, selects a specific option by its `choices[].key` rather than
   * using the default mapping (approve → first option, deny → ESC). The daemon
   * validates the key belongs to the stored request, re-verifies the
   * corresponding option row is visible on screen, and sends exactly that one
   * digit. Invalid or absent keys fail closed.
   *
   * Omitting this field preserves existing behavior byte-for-byte: approve
   * sends '1', deny sends ESC.
   */
  choiceKey?: string;
  /**
   * Who is answering. Defaults to `'human'`, because every caller that exists
   * today is a person tapping Approve on the phone or the web UI, and they are
   * looking at the prompt they are answering. An AUTOMATED resolver must
   * declare itself — that is what subjects it to the press scope
   * (`decideApprovalPress`), which a human is deliberately not subject to.
   */
  resolver?: 'human' | 'automated';
  /**
   * The HQ approval lane's declaration (main, deck/hqApprovalLane.ts). Like
   * `resolver: 'automated'` it can only ADD a check: an automated approve that
   * declares the lane is refused as `hq-lane-closed` unless main's published
   * lane policy is open AND still the `laneGeneration` the caller checked —
   * re-read right before the record is released, inside the mutation chain.
   */
  lane?: 'hq';
  laneGeneration?: number;
  /**
   * Re-check the caller's authority from INSIDE the mutation link. A resolve
   * can queue behind other resolves and re-reads the screen before it writes,
   * so a credential checked by the caller beforehand can be revoked or narrowed
   * by the time the side effect happens. The registry calls this with its own
   * record right after the pending check (before any mutation) and again
   * immediately before the side effect (the gate wake-up or the PTY write).
   *
   * 'expired' refuses with `unauthorized`, 'read-only' with `input-revoked`;
   * the record stays pending with no event and no persist. A throw or a
   * rejection counts as 'expired'. Async because the web layer's device
   * resolver may be async; there is no timeout.
   *
   * Omitted ⇒ no re-check, byte-for-byte the previous behavior (the desktop
   * renderer and the operator's own pipe callers).
   */
  authorize?: (record: ApprovalRequest) => Promise<'ok' | 'expired' | 'read-only'>;
  /**
   * `terminal_prompt` only: the dialog hash the answering client was shown.
   * Must equal the record's, and the live screen's.
   */
  promptFingerprint?: string;
  /**
   * `terminal_prompt` only: set by the web route, and only for a caller that
   * declared the `terminal-prompt-answer` capability. A Symbol, so JSON params
   * (the pipe RPC, MCP `approval_press`) can never carry it.
   */
  terminalPromptAnswer?: typeof TERMINAL_PROMPT_WEB_ANSWER;
  /**
   * `terminal_prompt` only: set by the web decline route for a caller that
   * declared `terminal-prompt-decline`. The answer is then ONE Esc, written
   * only while the record is pending and its dialog is on screen; `decision`
   * must be 'deny' and `choiceKey` absent.
   */
  terminalPromptDecline?: typeof TERMINAL_PROMPT_WEB_DECLINE;
  /**
   * Set by the web answer route (`POST /api/approvals/:id/answer`) for a
   * caller that declared `decision-v2`. Same Symbol discipline as the markers
   * above: a JSON caller can never carry it.
   */
  decisionV2Answer?: typeof DECISION_V2_WEB_ANSWER;
  /** The validated v2 answer body; only honoured together with `decisionV2Answer`. */
  decisionAnswer?: DecisionAnswer;
}

/** The web route's marker for a capable `terminal_prompt` answer (see above). */
export const TERMINAL_PROMPT_WEB_ANSWER: unique symbol = Symbol('terminal-prompt-web-answer');

/**
 * The web decline route's marker (`POST /api/approvals/:id/decline`): cancel a
 * `terminal_prompt` dialog with ONE Esc. A Symbol for the same reason as the
 * answer marker — JSON callers can never carry it.
 */
export const TERMINAL_PROMPT_WEB_DECLINE: unique symbol = Symbol('terminal-prompt-web-decline');

/**
 * The web answer route's marker for a `decision-v2` answer. A native or
 * stepwise resolve requires one of the three web markers, so the pipe RPC
 * (`daemon.approvals.resolve`) and MCP `approval_press` can never answer one.
 */
export const DECISION_V2_WEB_ANSWER: unique symbol = Symbol('decision-v2-web-answer');

/**
 * `GET /api/approvals/:id/detail` — the full text a pending, bound
 * `terminal_prompt` is about. Kept in daemon memory only: never on the record,
 * so never in approvals.json, an SSE event or a push.
 */
export interface TerminalPromptDetail {
  id: string;
  toolName?: string;
  /** The call's full command (Bash) or path/url, up to TERMINAL_PROMPT_DETAIL_MAX_BYTES. */
  command: string;
  /** sha256 (hex) of the FULL command's UTF-8 bytes, even when `command` was capped. */
  commandHash: string;
  /** UTF-8 byte length of the full command. */
  commandBytes: number;
  /** `command` was capped at TERMINAL_PROMPT_DETAIL_MAX_BYTES. */
  truncated: boolean;
}

/** Most bytes of a command `/detail` returns. */
export const TERMINAL_PROMPT_DETAIL_MAX_BYTES = 64 * 1024;

/**
 * The whole surface a consumer (the web server, the daemon RPCs) needs. The
 * registry class implements it; nothing else about the registry is public.
 */
export interface ApprovalRegistryApi {
  /** Snapshot. Returns copies — a caller can never mutate registry state. */
  list(): ApprovalListResult;
  /** Count only, no copying/sorting — for callers that just need "is anything pending". */
  pendingCount(): number;
  /**
   * CAS + pre-write screen re-verify + one keystroke. Never throws: every
   * failure is a `{ok:false, reason}`, because the callers are an HTTP handler
   * and a pipe RPC that both have to answer with a status, not a stack trace.
   */
  resolve(params: ApprovalResolveParams): Promise<ApprovalResolveResult>;
  /** Subscribe to lifecycle transitions. Returns the unsubscribe function. */
  onEvent(listener: (event: ApprovalEvent) => void): () => void;
  /**
   * The full command of a PENDING `terminal_prompt` bound to its tool call,
   * or null (unknown id, settled, another kind, or never bound). Optional so
   * a registry that predates it still type-checks.
   */
  terminalPromptDetail?(id: string): TerminalPromptDetail | null;
}
