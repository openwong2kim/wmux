// M2 — the approval-request wire/dep types.
//
// Kept in its own module so the web server (Worker B) can import the NARROW
// interface it consumes without pulling in the registry implementation, its
// persistence, or the headless-snapshot dependency chain. `WebTerminalServer`
// takes an `ApprovalRegistryApi` in its deps and its unit tests inject a fake
// that satisfies exactly this — the same shape the daemon injects the real
// registry through.

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
   */
  kind: 'awaiting_input' | 'awaiting_permission';
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
   */
  risk?: 'critical';
  /** Epoch ms. */
  createdAt: number;
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
  | 'out-of-scope';

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
      reason: ApprovalResolveFailure;
      /** Present on 'already-resolved' — the 409 UX names who got there first. */
      resolvedBy?: string;
      /** Absent only for 'not-found'. */
      request?: ApprovalRequest;
    };

export type ApprovalEventType = 'create' | 'resolve' | 'expire' | 'supersede';

/** One lifecycle transition. The record carries its post-transition state. */
export interface ApprovalEvent {
  type: ApprovalEventType;
  request: ApprovalRequest;
}

/** Why a pending request was expired. Log/diagnostic only, never persisted. */
export type ApprovalExpiryReason =
  | 'daemon-restart'
  | 'turn-ended'
  | 'session-start'
  | 'pane-gone'
  | 'prompt-gone'
  | 'answered-locally'
  // #783 — the gate self-deferred before the harness deadline (phone did not
  // answer in time). The record is expired so a late phone tap gets a 410.
  | 'gate-timed-out';

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
  }): void;
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
  }): string;
  /** `kind` narrows the sweep to one record kind; omitted ⇒ every kind. */
  expireForSession(
    sessionId: string,
    reason: ApprovalExpiryReason,
    kind?: ApprovalRequest['kind'],
  ): void;
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
}

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
}
