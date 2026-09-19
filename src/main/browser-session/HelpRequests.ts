// ---------------------------------------------------------------------------
// HelpRequests — the agent hands one browser step back to the human.
//
// Login walls, CAPTCHAs, OTP fields, payment confirmations and consent screens
// end every browser flow the same way: the agent cannot proceed and has no way
// to ask. This store owns the "ask" — one open request per browser surface,
// a main-enforced deadline, and an optional page condition that finishes the
// request without anyone pressing a button.
//
// Deliberately Electron-free so it can be unit-tested directly: the two things
// it cannot do itself — showing the row and reading the page — arrive as
// injected callbacks (`open`/`close` and `probe`). browser.rpc.ts wires them.
//
// Mechanism credit: handing a blocked browser step to the operator and resuming
// on a page condition is the pattern in Tencent's BrowserSkill (MIT), referenced
// as prior art. No code copied.
// ---------------------------------------------------------------------------

import {
  BROWSER_HELP_HOLD_MS,
  BROWSER_HELP_POLL_MS,
  clampHelpTimeoutMs,
  sanitizeHelpPrompt,
  type BrowserHelpCompletion,
  type BrowserHelpOutcome,
  type BrowserHelpProbe,
  type BrowserHelpRequestInfo,
  type BrowserHelpState,
} from '../../shared/browserHelp';

/** Prefix every caller-visible "already open" refusal starts with. */
export const HELP_ALREADY_PENDING_PREFIX = 'help_already_pending:';

/**
 * A second request for a surface that already has one open.
 *
 * Its own class so the RPC layer can answer with the exact machine-readable
 * prefix the tool contract promises, without string-matching a generic Error.
 */
export class HelpAlreadyPendingError extends Error {
  constructor(readonly requestId: string) {
    super(
      `${HELP_ALREADY_PENDING_PREFIX} this browser surface already has an open help ` +
        `request (${requestId}). Answer it in the wmux window, or call ` +
        `browser_request_help again once it is resolved.`,
    );
    this.name = 'HelpAlreadyPendingError';
  }
}

interface HelpRecord {
  requestId: string;
  workspaceId: string;
  surfaceId: string | undefined;
  prompt: string;
  ref: string | undefined;
  completion: BrowserHelpCompletion | undefined;
  createdAt: number;
  deadlineAt: number;
  state: BrowserHelpState;
  /** Last URL the probe reported, if it ever answered. */
  url: string | undefined;
  /** When the completion condition first held in the current unbroken run. */
  matchedSince: number | undefined;
  /**
   * A probe is out. The poller SKIPS while this is set.
   *
   * Not an optimisation: a `Runtime.evaluate` against a guest mid-navigation
   * routinely takes longer than the 500ms cadence — which is exactly when a
   * login flow is redirecting — and two overlapping probes resolve out of
   * order. A late `matched: false` would then reset a `matchedSince` a newer
   * probe had already set, restarting the hold window and delaying (or
   * preventing) the auto-complete the agent asked for. It also bounds the
   * outstanding CDP commands against a wedged page to one.
   */
  probing: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  poller: ReturnType<typeof setInterval> | undefined;
}

export interface HelpRequestsOptions {
  /** Push the row to the renderer (BROWSER_HELP_OPEN). */
  open: (info: BrowserHelpRequestInfo) => void;
  /** Tell the renderer the row is gone (BROWSER_HELP_CLOSED). */
  close: (requestId: string) => void;
  /**
   * Read the page: its URL, and whether the request's completion condition
   * holds. Resolves to null when the surface cannot be read at all — a chrome
   * or external backend (no guest webview), a departed WebContents. A null
   * answer is not a failure of the request: the human's Done still works, the
   * deadline still fires, and `url` is simply omitted from the result.
   */
  probe?: (record: HelpProbeTarget) => Promise<BrowserHelpProbe | null>;
  /** Drop the outline this request put on the ref'd element. Best-effort. */
  clearHighlight?: (record: HelpProbeTarget) => Promise<void>;
  /** Injectable clock — every time read in this class goes through it. */
  now?: () => number;
  mintId?: () => string;
}

/** The subset of a record the injected page hooks are allowed to see. */
export interface HelpProbeTarget {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly surfaceId: string | undefined;
  readonly ref: string | undefined;
  readonly completion: BrowserHelpCompletion | undefined;
}

export interface CreateHelpRequestArgs {
  workspaceId: string;
  surfaceId?: string;
  prompt: string;
  ref?: string;
  timeoutMs?: number;
  completion?: BrowserHelpCompletion;
}

export interface HelpStatus {
  state: BrowserHelpState;
  url?: string;
}

function defaultMintId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `help-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The one-open-request-per-surface key.
 *
 * A workspace with no resolvable browser surface still gets exactly one slot:
 * the alternative — an unbounded number of surface-less requests in one
 * workspace — is a queue of rows nobody can attribute to a pane.
 */
function surfaceKey(workspaceId: string, surfaceId: string | undefined): string {
  return `${workspaceId}::${surfaceId ?? '-'}`;
}

/**
 * Keep only the string halves a caller actually sent, so an empty `selector: ''`
 * cannot become a condition that matches nothing forever, and
 * `completion: {}` is indistinguishable from no completion at all.
 */
function normalizeCompletion(raw: BrowserHelpCompletion | undefined): BrowserHelpCompletion | undefined {
  if (!raw) return undefined;
  const urlIncludes = typeof raw.urlIncludes === 'string' && raw.urlIncludes.length > 0
    ? raw.urlIncludes
    : undefined;
  const selector = typeof raw.selector === 'string' && raw.selector.length > 0
    ? raw.selector
    : undefined;
  if (urlIncludes === undefined && selector === undefined) return undefined;
  return {
    ...(urlIncludes !== undefined && { urlIncludes }),
    ...(selector !== undefined && { selector }),
  };
}

/**
 * Settled records are kept so the polling agent can still read the outcome it
 * was waiting for; this bounds that keep. Well above any plausible number of
 * live flows, and pruned oldest-settled-first so a long-lived session cannot
 * grow the map without limit.
 */
const MAX_RETAINED_RECORDS = 64;

/**
 * Ceiling on PENDING requests per workspace. The one-open-per-surface rule is
 * keyed on a caller-supplied surfaceId, so without this an agent looping
 * browser.help.request with fresh ids would arm an unbounded number of deadline
 * timers, inbox rows and (on live) OS notifications. Well above what one agent
 * can legitimately be waiting on at once.
 */
const MAX_PENDING_PER_WORKSPACE = 8;

export class HelpRequests {
  private readonly records = new Map<string, HelpRecord>();
  /** surfaceKey → requestId of the PENDING request holding that slot. */
  private readonly bySurface = new Map<string, string>();
  private readonly opts: HelpRequestsOptions;
  private readonly now: () => number;
  private readonly mintId: () => string;

  constructor(opts: HelpRequestsOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.mintId = opts.mintId ?? defaultMintId;
  }

  /**
   * Open a request and push its row. Throws HelpAlreadyPendingError when this
   * surface already has one open — never queues, because a queue would let an
   * agent stack prompts the human has to answer in an order nobody chose.
   */
  create(args: CreateHelpRequestArgs): BrowserHelpRequestInfo {
    const prompt = sanitizeHelpPrompt(args.prompt);
    if (!prompt) {
      throw new Error('browser.help.request: "prompt" must be 1-500 printable characters.');
    }
    const key = surfaceKey(args.workspaceId, args.surfaceId);
    const holder = this.bySurface.get(key);
    if (holder) {
      // Free a lapsed holder first: a deadline that passed while nobody polled
      // must not block the surface forever. `settle` runs `markTerminal` — which
      // releases the slot — before its first await, so the check below sees the
      // release even though the async tail is still in flight.
      const held = this.records.get(holder);
      if (held && held.state === 'pending' && this.now() >= held.deadlineAt) {
        void this.settle(held, 'timed_out');
      }
      if (this.bySurface.get(key) === holder) throw new HelpAlreadyPendingError(holder);
    }
    let pendingHere = 0;
    for (const record of this.records.values()) {
      if (record.state === 'pending' && record.workspaceId === args.workspaceId) pendingHere += 1;
    }
    if (pendingHere >= MAX_PENDING_PER_WORKSPACE) {
      throw new Error(
        `browser.help.request: this workspace already has ${pendingHere} help requests open; ` +
          'cancel or wait for one before asking again.',
      );
    }
    this.prune();

    const createdAt = this.now();
    const record: HelpRecord = {
      requestId: this.mintId(),
      workspaceId: args.workspaceId,
      surfaceId: args.surfaceId,
      prompt,
      ref: args.ref,
      completion: normalizeCompletion(args.completion),
      createdAt,
      deadlineAt: createdAt + clampHelpTimeoutMs(args.timeoutMs),
      state: 'pending',
      url: undefined,
      matchedSince: undefined,
      probing: false,
      timer: undefined,
      poller: undefined,
    };
    this.records.set(record.requestId, record);
    this.bySurface.set(key, record.requestId);

    // The deadline is main's, not the renderer's: a renderer that reloads,
    // crashes or is never looked at must not be able to leave a request open
    // forever, and the agent's own timeout is a client-side guess.
    record.timer = setTimeout(() => {
      void this.settle(record, 'timed_out');
    }, Math.max(0, record.deadlineAt - createdAt));
    (record.timer as { unref?: () => void }).unref?.();

    if (record.completion && this.opts.probe) {
      record.poller = setInterval(() => {
        void this.tick(record);
      }, BROWSER_HELP_POLL_MS);
      (record.poller as { unref?: () => void }).unref?.();
    }

    const info = this.infoOf(record);
    try {
      this.opts.open(info);
    } catch {
      /* the row is presentation; a push failure must not fail the request */
    }
    return info;
  }

  /** The renderer-facing payload for one record. */
  private infoOf(record: HelpRecord): BrowserHelpRequestInfo {
    return {
      requestId: record.requestId,
      workspaceId: record.workspaceId,
      ...(record.surfaceId !== undefined && { surfaceId: record.surfaceId }),
      prompt: record.prompt,
      ...(record.ref !== undefined && { ref: record.ref }),
      deadlineAt: record.deadlineAt,
    };
  }

  /**
   * Read one request's state, scoped to the workspace that owns it.
   *
   * A mismatched workspace is answered as "not found" rather than "belongs to
   * someone else": the id is the only thing the caller supplied, and confirming
   * that it exists elsewhere would turn this into an id-probe for other
   * workspaces' requests.
   */
  async status(requestId: string, workspaceId: string): Promise<HelpStatus | null> {
    const record = this.ownedRecord(requestId, workspaceId);
    if (!record) return null;
    await this.settleIfExpired(requestId);
    return {
      state: record.state,
      ...(record.url !== undefined && { url: record.url }),
    };
  }

  /** Cancel from the agent side (same scoping rule as status). */
  async cancel(requestId: string, workspaceId: string): Promise<HelpStatus | null> {
    const record = this.ownedRecord(requestId, workspaceId);
    if (!record) return null;
    if (record.state === 'pending') await this.settle(record, 'cancelled');
    return {
      state: record.state,
      ...(record.url !== undefined && { url: record.url }),
    };
  }

  /**
   * The human answered in the wmux window. Idempotent: a duplicate resolve (a
   * click racing the deadline, the optimistic local removal racing the push)
   * keeps the first outcome rather than rewriting it.
   */
  async resolveFromRenderer(requestId: string, outcome: BrowserHelpOutcome): Promise<boolean> {
    const record = this.records.get(requestId);
    if (!record || record.state !== 'pending') return false;
    await this.settle(record, outcome);
    return true;
  }

  private ownedRecord(requestId: string, workspaceId: string): HelpRecord | null {
    const record = this.records.get(requestId);
    if (!record) return null;
    if (!workspaceId || record.workspaceId !== workspaceId) return null;
    return record;
  }

  /** Drop the oldest SETTLED records once the map outgrows its keep. */
  private prune(): void {
    if (this.records.size < MAX_RETAINED_RECORDS) return;
    // Map iteration is insertion order, so this walks oldest-first.
    for (const [id, record] of this.records) {
      if (this.records.size < MAX_RETAINED_RECORDS) return;
      if (record.state === 'pending') continue;
      this.records.delete(id);
    }
  }

  private async settleIfExpired(requestId: string): Promise<void> {
    const record = this.records.get(requestId);
    if (!record || record.state !== 'pending') return;
    if (this.now() < record.deadlineAt) return;
    // The lazy path exists because the timer above can be throttled or skipped
    // (a suspended machine, a background renderer process): the polling agent
    // must still learn the deadline passed on its very next status call.
    await this.settle(record, 'timed_out');
  }

  /** One completion poll: refresh the URL, then apply the continuous-hold rule. */
  private async tick(record: HelpRecord): Promise<void> {
    if (record.state !== 'pending' || record.probing) return;
    const probe = this.opts.probe;
    if (!probe) return;
    let result: BrowserHelpProbe | null = null;
    record.probing = true;
    try {
      result = await probe(record);
    } catch {
      // A read that failed says nothing about the condition — treat it as "not
      // matched yet" and keep polling rather than completing on a transport
      // hiccup mid-navigation, which is exactly when a login flow reloads.
      result = null;
    } finally {
      record.probing = false;
    }
    if (record.state !== 'pending') return;
    if (result?.url !== undefined) record.url = result.url;
    if (!result?.matched) {
      record.matchedSince = undefined;
      return;
    }
    const at = this.now();
    if (record.matchedSince === undefined) {
      record.matchedSince = at;
      return;
    }
    // Held continuously for the full window, so it is the flow's new steady
    // state rather than one frame of a redirect chain that happened to match.
    if (at - record.matchedSince >= BROWSER_HELP_HOLD_MS) {
      await this.settle(record, 'completed');
    }
  }

  private stopTimers(record: HelpRecord): void {
    if (record.timer) clearTimeout(record.timer);
    if (record.poller) clearInterval(record.poller);
    record.timer = undefined;
    record.poller = undefined;
  }

  /**
   * The half of settling that every SYNCHRONOUS caller must be able to observe:
   * the terminal state, the timers, and the surface slot. Split out of `settle`
   * so `create` can reclaim a lapsed slot without depending on how far an
   * un-awaited `settle` happens to run. Returns false when the record was
   * already terminal, which is what makes settling idempotent.
   */
  private markTerminal(record: HelpRecord, state: Exclude<BrowserHelpState, 'pending'>): boolean {
    if (record.state !== 'pending') return false;
    record.state = state;
    this.stopTimers(record);
    const key = surfaceKey(record.workspaceId, record.surfaceId);
    if (this.bySurface.get(key) === record.requestId) this.bySurface.delete(key);
    return true;
  }

  /**
   * Move a pending record to its terminal state exactly once: mark it, take a
   * final URL reading, drop the outline, and tell the renderer the row is gone.
   */
  private async settle(record: HelpRecord, state: Exclude<BrowserHelpState, 'pending'>): Promise<void> {
    if (!this.markTerminal(record, state)) return;

    // The final URL is what the agent needs to see: the whole point of the wait
    // is that the human moved the page somewhere the agent could not.
    if (this.opts.probe) {
      try {
        const result = await this.opts.probe(record);
        if (result?.url !== undefined) record.url = result.url;
      } catch {
        /* a missing final URL is reported as an absent field, never an error */
      }
    }
    // The row goes BEFORE the outline is taken back. Both touch the page, but
    // only one of them is on the operator's screen: a guest whose main thread is
    // wedged would otherwise keep the Done / Cancel bar up on a request that is
    // already over. A leftover outline on a page nobody is working in is
    // cosmetic; a bar for a settled request is a lie.
    try {
      this.opts.close(record.requestId);
    } catch {
      /* see create(): the row is presentation */
    }
    if (record.ref !== undefined && this.opts.clearHighlight) {
      try {
        await this.opts.clearHighlight(record);
      } catch {
        /* an outline left on a page the human is done with is cosmetic */
      }
    }
  }
}
