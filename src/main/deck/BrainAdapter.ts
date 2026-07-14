// ─── Command Deck — Brain adapter interface (Command Deck Phase 2, P2a) ──────
//
// The Commander tab's "other side" is an orchestrator brain. This module is the
// SWAPPABLE seam between the deck and whatever LLM drives the fleet.
//
// Design rationale (substrate neutrality):
//   - wmux holds NO orchestration policy of its own. The brain decides how to
//     split work across panes; the deck only ships the human's intent in and
//     streams the brain's turn back out. Everything the brain can DO is a wmux
//     MCP tool call (pane_split, terminal_send/read, channel/A2A …) — the same
//     tools any external agent gets — so the "policy" lives in the model + its
//     system prompt, never in wmux code.
//   - The brain is a replaceable layer:
//       * Claude family  → ClaudeSdkAdapter (the one Phase 2 ships).
//       * GLM / Z.ai     → the SAME ClaudeSdkAdapter + an env profile
//                          (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN), exactly
//                          the review-team pattern.
//       * Codex / OpenCode → FUTURE adapters implementing this same interface.
//     Keeping the contract this thin (5 normalized event kinds) is what makes a
//     future Codex adapter a drop-in rather than a deck rewrite.
//
// The interface is deliberately transport-agnostic: `send()` returns an
// AsyncIterable of normalized events so the caller (CommanderSessionManager)
// can forward them over IPC without knowing the SDK's raw message zoo. The
// concrete adapter is constructor-injected with its SDK `query` function, so
// the normalization can be unit-tested against a fake AsyncIterable with no
// live model and no SDK subprocess.

/** Token / cost accounting for a completed turn (best-effort — a fake or an
 *  older CLI may omit fields). Surfaced for a future usage meter; the deck does
 *  not depend on any field being present. */
export interface BrainUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  numTurns?: number;
}

/**
 * The normalized event union every adapter emits — the ONLY vocabulary the deck
 * understands. Mapped from the underlying SDK's message stream by the adapter:
 *   - `text-delta`  incremental assistant prose (accumulate into a bubble).
 *   - `tool-start`  the brain invoked a fleet tool (render a chip; `inputSummary`
 *                   is a short human string, e.g. the target pane / command).
 *   - `tool-end`    that tool returned; `ok=false` on an error result (or a
 *                   permission denial — a tool the deck did not allow).
 *   - `turn-end`    the turn finished; carries the session id (for resume) and
 *                   optional usage. Exactly one per completed turn.
 *   - `error`       a turn-fatal problem (auth failure, spawn error). Terminal
 *                   for the turn — no `turn-end` follows an `error`.
 *   - `limit`       the SUBSCRIPTION hit (or is approaching) a plan rate limit.
 *                   Sourced from the SDK's first-class `rate_limit_event` frame
 *                   (NOT a `result` error), so it carries a typed window kind and
 *                   a reset time. Informational within the turn — it does not by
 *                   itself end the turn (the SDK still emits its own result/error
 *                   frame); it is the signal the multi-account M3 switch hangs off.
 */
export type BrainEvent =
  // Emitted ONLY for turns the MAIN process originates (P3d scheduled runs):
  // the renderer opens a turn (user bubble + streaming assistant) exactly as
  // its own composer send would, so a scheduled run is as visible as a typed
  // one. Adapters never emit this — deck.handler's scheduler does, right
  // before manager.send.
  | { type: 'turn-start'; prompt: string }
  | { type: 'text-delta'; text: string }
  | {
      type: 'tool-start';
      name: string;
      inputSummary: string;
      toolId?: string;
      /** Parsed from the tool input when present, so the chat chip can offer a
       *  one-click pane jump (the litmus test: every action → its evidence). */
      paneId?: string;
      workspaceId?: string;
    }
  | { type: 'tool-end'; name: string; ok: boolean; toolId?: string }
  | { type: 'turn-end'; sessionId: string | null; usage?: BrainUsage }
  | { type: 'error'; message: string }
  | {
      type: 'limit';
      /** 'rejected' = the window is exhausted (hard limit hit); 'allowed_warning'
       *  = approaching the limit (pre-exhaustion nudge). We do NOT surface plain
       *  'allowed' as a limit event — that's the normal case. */
      status: 'rejected' | 'allowed_warning';
      /** Which plan window the limit belongs to, verbatim from the SDK's
       *  `SDKRateLimitInfo.rateLimitType`. Known values: `five_hour`,
       *  `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
       *  `seven_day_overage_included`, `overage`. Kept as a plain string (not a
       *  closed union) so a future SDK window passes through instead of breaking
       *  normalization. Undefined when the SDK omitted it. */
      window?: string;
      /** Epoch ms when the window resets, when the SDK provided it. Optional
       *  because a hook-sourced limit (M3 additive path) can't supply one. */
      resetsAtMs?: number;
      /** 0–100 window utilization when reported. */
      utilization?: number;
    };

/** One-time startup context for the brain. The fleet snapshot is injected ONCE
 *  (token-budgeted) at the first turn — see ClaudeSdkAdapter. */
export interface BrainStartOptions {
  /** Full system prompt (identity + policy). Applied to every turn. */
  systemPrompt?: string;
  /** A compact fleet snapshot (pane list / channel catalog summary). Injected
   *  once, ahead of the first user message, capped to a small token budget. */
  fleetContext?: string;
  /** A persisted session id from a previous app run (P3a). When set, the first
   *  turn resumes that conversation instead of starting fresh. Adapters must
   *  treat a dead/unknown id as soft: fall back to a fresh session rather than
   *  failing the turn. */
  resumeSessionId?: string;
}

/**
 * The swappable brain. One instance owns one logical conversation (its
 * `sessionId` threads turns together / survives a process for resume). The deck
 * drives exactly one turn at a time: it fully drains one `send()` iterable
 * before starting the next (turn concurrency is enforced by the session
 * manager, not here).
 */
export interface BrainAdapter {
  /** Prime the adapter with its system prompt + one-shot fleet context. Cheap /
   *  synchronous — no model round-trip; the first `send()` does the real work. */
  start(opts: BrainStartOptions): void;

  /** Run one turn. Yields normalized events in order and completes when the turn
   *  ends. Implementations must be safe to iterate exactly once per call. */
  send(text: string): AsyncIterable<BrainEvent>;

  /** Abort the in-flight turn (best-effort). Safe to call when idle. */
  interrupt(): void;

  /** Release all resources (kill any live subprocess). The adapter is unusable
   *  afterward. Idempotent. */
  dispose(): void;

  /** The current conversation id, or null before the first turn produced one.
   *  Persisted by the session manager for resume (P3). */
  readonly sessionId: string | null;
}

// ─── SDK → normalized-event mapping (pure, testable) ─────────────────────────
//
// Structural shapes of the SDK messages we consume — a minimal subset of
// `@anthropic-ai/claude-agent-sdk`'s `SDKMessage` union, redeclared here so the
// normalization (and its unit test) do not need the SDK package present. The
// real adapter passes the SDK's messages straight in; they are structurally
// assignable to these.

interface RawTextBlock { type: 'text'; text: string }
interface RawToolUseBlock { type: 'tool_use'; id?: string; name: string; input?: unknown }
interface RawToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  is_error?: boolean;
}
type RawContentBlock = RawTextBlock | RawToolUseBlock | RawToolResultBlock | { type: string };

/** Shape of the SDK's `rate_limit_event` payload we consume — a subset of the
 *  SDK's `SDKRateLimitInfo`. `resetsAt` is EPOCH SECONDS in the SDK; we convert
 *  to ms at normalization. All fields optional: the SDK omits them per plan/state. */
interface RawRateLimitInfo {
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}

/** The subset of SDK message frames the deck reacts to. Unknown frame types are
 *  ignored (the SDK stream carries dozens of ancillary event kinds). */
export interface RawSdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  apiKeySource?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
  errors?: string[];
  message?: { content?: RawContentBlock[]; usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Present on `type:'rate_limit_event'` frames (SDKRateLimitEvent). */
  rate_limit_info?: RawRateLimitInfo;
}

/** Mutable per-turn state threaded across `normalizeSdkMessage` calls: maps a
 *  tool_use id → its tool name so a later tool_result (which only carries the
 *  id) can be reported as a `tool-end` for the right tool. */
export interface NormalizeState {
  toolNames: Map<string, string>;
  sessionId: string | null;
}

export function createNormalizeState(): NormalizeState {
  return { toolNames: new Map(), sessionId: null };
}

/**
 * Compress a tool call's input object into a short one-line summary for the chip
 * (litmus test: the human can see WHAT the brain did without opening the pane).
 * Picks the few wmux-relevant keys; falls back to a truncated JSON blob.
 * Exported for direct unit testing.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const pick = (k: string): string | undefined =>
    typeof o[k] === 'string' ? (o[k] as string) : typeof o[k] === 'number' ? String(o[k]) : undefined;
  // Ordered by how identifying the key is for a fleet action.
  const parts: string[] = [];
  const paneId = pick('paneId') ?? pick('pane_id');
  const workspaceId = pick('workspaceId') ?? pick('workspace_id');
  const channel = pick('channelId') ?? pick('channel') ?? pick('name');
  const text = pick('text') ?? pick('command') ?? pick('data') ?? pick('message');
  if (paneId) parts.push(paneId);
  else if (workspaceId) parts.push(workspaceId);
  if (channel && !paneId && !workspaceId) parts.push(channel);
  if (text) {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    parts.push(oneLine.length > 60 ? oneLine.slice(0, 57) + '…' : oneLine);
  }
  if (parts.length > 0) return parts.join(' · ');
  // Nothing recognized — a short JSON preview beats an empty chip.
  try {
    const j = JSON.stringify(o);
    return j.length > 60 ? j.slice(0, 57) + '…' : j;
  } catch {
    return '';
  }
}

/** Pull the pane / workspace coordinate out of a tool input (when the tool
 *  targets one), so the chip can jump to it. Accepts both camelCase and the
 *  snake_case some tool schemas use. Exported for unit testing. */
export function extractToolTarget(input: unknown): { paneId?: string; workspaceId?: string } {
  if (!input || typeof input !== 'object') return {};
  const o = input as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const paneId = str('paneId') ?? str('pane_id');
  const workspaceId = str('workspaceId') ?? str('workspace_id');
  return {
    ...(paneId ? { paneId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/**
 * Coerce the SDK's `resetsAt` (a bare number with no documented unit) to epoch
 * MILLISECONDS. The SDK type annotates only `number`, and a live limit wasn't
 * available to confirm sec vs ms at authoring time, so we disambiguate by
 * magnitude: an epoch in SECONDS is ~1.7e9 while epoch MS is ~1.7e12, three
 * orders of magnitude apart with no overlap for any realistic date — a value
 * below this threshold is treated as seconds and scaled up. Returns null for
 * missing / non-finite / non-positive input (caller then omits resetsAtMs).
 * Exported for unit testing.
 */
const RESET_SECONDS_MAX = 1e11; // ~year 5138 in seconds; anything below = seconds
export function normalizeResetToMs(resetsAt: number | undefined): number | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  return resetsAt < RESET_SECONDS_MAX ? Math.round(resetsAt * 1000) : Math.round(resetsAt);
}

/**
 * Map one raw SDK message to zero or more normalized brain events, mutating
 * `state` (tool-name table + latest session id). Pure aside from that state:
 * same input → same output. This is the whole SDK-coupling surface of the deck,
 * kept isolated so it can be exhaustively unit-tested with hand-built frames.
 *
 * Emission rules:
 *   - system/init            → captures session_id; emits nothing (the turn has
 *                              not produced content yet).
 *   - assistant              → a `text-delta` per text block + a `tool-start`
 *                              per tool_use block (recording id→name).
 *   - user (tool_result)     → a `tool-end` per tool_result block, ok = !is_error.
 *   - result                 → a `turn-end` (success) or an `error` then no
 *                              turn-end (error_* subtypes / is_error).
 *   - rate_limit_event       → a `limit` for status 'rejected' / 'allowed_warning'
 *                              (nothing for plain 'allowed'). NOT terminal — the
 *                              turn still ends via its own result/error frame.
 */
export function normalizeSdkMessage(msg: RawSdkMessage, state: NormalizeState): BrainEvent[] {
  const out: BrainEvent[] = [];
  if (msg.session_id) state.sessionId = msg.session_id;

  switch (msg.type) {
    case 'system':
      // init carries session_id (captured above) + apiKeySource; nothing to render.
      return out;

    case 'assistant': {
      const blocks = msg.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'text') {
          const text = (b as RawTextBlock).text;
          if (text) out.push({ type: 'text-delta', text });
        } else if (b.type === 'tool_use') {
          const tb = b as RawToolUseBlock;
          if (tb.id) state.toolNames.set(tb.id, tb.name);
          const target = extractToolTarget(tb.input);
          out.push({
            type: 'tool-start',
            name: tb.name,
            inputSummary: summarizeToolInput(tb.name, tb.input),
            ...(tb.id ? { toolId: tb.id } : {}),
            ...(target.paneId ? { paneId: target.paneId } : {}),
            ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
          });
        }
      }
      return out;
    }

    case 'user': {
      // Tool results are delivered as `user` frames (the tool output is fed back
      // to the model as a user turn). Each result closes a prior tool-start.
      const blocks = msg.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const rb = b as RawToolResultBlock;
          const name = (rb.tool_use_id && state.toolNames.get(rb.tool_use_id)) || 'tool';
          out.push({
            type: 'tool-end',
            name,
            ok: rb.is_error !== true,
            ...(rb.tool_use_id ? { toolId: rb.tool_use_id } : {}),
          });
        }
      }
      return out;
    }

    case 'rate_limit_event': {
      // First-class subscription rate-limit signal (SDKRateLimitEvent). The
      // whole reason this case exists: a plan limit is NOT delivered as a
      // `result` error (its subtype union has no rate-limit member), so without
      // this branch the event is silently dropped and M3 can never react.
      const info = msg.rate_limit_info;
      if (!info) return out;
      // Only 'rejected' (hard hit) and 'allowed_warning' (approaching) are
      // actionable; 'allowed'/absent is the normal case and emits nothing.
      if (info.status !== 'rejected' && info.status !== 'allowed_warning') return out;
      const ev: Extract<BrainEvent, { type: 'limit' }> = {
        type: 'limit',
        status: info.status,
      };
      if (typeof info.rateLimitType === 'string' && info.rateLimitType) ev.window = info.rateLimitType;
      if (typeof info.utilization === 'number' && Number.isFinite(info.utilization)) {
        ev.utilization = info.utilization;
      }
      const resetMs = normalizeResetToMs(info.resetsAt);
      if (resetMs != null) ev.resetsAtMs = resetMs;
      out.push(ev);
      return out;
    }

    case 'result': {
      const isError = msg.is_error === true || (msg.subtype ? msg.subtype !== 'success' : false);
      if (isError) {
        const detail =
          (msg.errors && msg.errors.length > 0 && msg.errors.join('; ')) ||
          msg.subtype ||
          'the brain turn failed';
        out.push({ type: 'error', message: detail });
        return out;
      }
      const usage: BrainUsage = {};
      const u = msg.usage;
      if (u?.input_tokens != null) usage.inputTokens = u.input_tokens;
      if (u?.output_tokens != null) usage.outputTokens = u.output_tokens;
      if (msg.total_cost_usd != null) usage.costUsd = msg.total_cost_usd;
      if (msg.num_turns != null) usage.numTurns = msg.num_turns;
      out.push({
        type: 'turn-end',
        sessionId: state.sessionId,
        ...(Object.keys(usage).length > 0 ? { usage } : {}),
      });
      return out;
    }

    default:
      return out;
  }
}
