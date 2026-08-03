/**
 * Normalized transcript event model shared by the daemon projector, main's
 * relay, the desktop renderer, and (later) the wmux web frontend.
 *
 * Frontends never see raw transcript JSONL — this model shields them from
 * upstream Claude Code format drift and is the adapter seam for other agents
 * once they publish structured transcripts.
 *
 * Lives in src/shared because tsconfig.daemon.json includes only
 * src/daemon/** + src/shared/**; the daemon parser and every consumer must
 * share one definition.
 */

export type TurnEventKind =
  | 'user_text'
  | 'assistant_text'
  | 'tool_use'
  | 'tool_result'
  | 'meta';

interface TurnEventBase {
  /**
   * Transcript entry uuid when present, else `${offset}:${index}`. Stable
   * across re-reads so the renderer can key rows and dedup a re-snapshot.
   */
  id: string;
  kind: TurnEventKind;
  /** Epoch ms from entry.timestamp; absent when the entry carried none. */
  ts?: number;
}

export interface UserTextEvent extends TurnEventBase {
  kind: 'user_text';
  text: string;
  hasImage?: boolean;
}

/**
 * Code block extracted from assistant prose. `body` is NEVER shipped over the
 * wire (eng-review A3: a 256KB tail re-encoded with bodies routinely exceeds
 * main's 1MB control-buffer cap, and an overflow drops unrelated daemon
 * events). The renderer shows `{lang, lines, path}` as a collapsed chip and
 * fetches the body on expand via the block handle `n`.
 */
export interface CodeBlockRef {
  /** Handle for on-expand body fetch; unique within its parent event. */
  n: number;
  lang?: string;
  lines: number;
  path?: string;
  /**
   * Byte offset of the transcript line this block was parsed from. The
   * on-expand body fetch (`daemon.transcript.codeBlock`) re-reads that single
   * line and re-extracts block `n`, so no body has to be cached anywhere.
   * Absent only when the producer could not attribute an offset.
   */
  srcOffset?: number;
  /**
   * The stored body was CUT at the daemon's per-block character cap, so what an
   * expand returns is a prefix of the block `lines` describes. Set only when it
   * happened; absent means the body is complete.
   *
   * Load-bearing rather than cosmetic: without it a user copies a shortened
   * body out of the chip with nothing saying so.
   */
  truncated?: boolean;
}

export interface AssistantTextEvent extends TurnEventBase {
  kind: 'assistant_text';
  /**
   * Prose with fenced blocks stripped and replaced by inline markers
   * `\u0000code:<n>\u0000`; the renderer expands them in place as chips.
   */
  text: string;
  codeBlocks?: CodeBlockRef[];
  /** True when this entry's content was a `thinking` block. Collapsed by default. */
  thinking?: boolean;
}

/**
 * What a tool was actually given, or actually returned.
 *
 * Chat View exists so a pane can be read as a conversation instead of a
 * terminal, and for an agent session most of what happens IS the tool calls —
 * the command that ran and what came back. Those used to be summarised away
 * (`argSummary` at 80 chars; a result reduced to `ok` + `bytes`), which left
 * the view able to say that something happened but never what.
 *
 * Small bodies ride inline so the common case reads without a click: the
 * measured median tool output is ~300 bytes and p90 is ~2.5 KB, so a 4 KB cap
 * covers about nine calls in ten. Anything larger is left to the same
 * on-expand fetch code blocks already use (`daemon.transcript.codeBlock`),
 * which re-reads the one transcript line rather than caching anything.
 *
 * The cap is not a display preference. main's control pipe drops its ENTIRE
 * buffer when a frame exceeds MAX_LINE_BUFFER (1 MB) — silently, taking
 * unrelated in-flight events with it — so an unbounded body here would be a
 * quiet event-loss bug, not a slow render.
 */
export interface ToolBody {
  /** Handle for the on-expand fetch, unique within its parent event. */
  n: number;
  /** Total size of the body on disk, before any inline truncation. */
  bytes: number;
  /**
   * The body itself, or its head. Absent means "fetch it with codeBlock(n)" —
   * NOT "there is nothing here".
   */
  inline?: string;
  /**
   * `inline` is only a HEAD; the rest is behind the fetch.
   *
   * Stated as a flag rather than left for the reader to derive by comparing
   * `inline`'s size against `bytes`: the renderer runs with
   * `nodeIntegration: false`, where `Buffer` does not exist, so a byte-length
   * comparison there is a ReferenceError rather than a wrong answer. The
   * producer already knows, so it says.
   */
  truncated?: boolean;
  /** Byte offset of the transcript line this came from, for the fetch. */
  srcOffset?: number;
}

export interface ToolUseEvent extends TurnEventBase {
  kind: 'tool_use';
  toolUseId: string;
  name: string;
  /** One line, <=120 chars, no newlines. */
  argSummary: string;
  /** What the tool was called WITH. Absent when the call carried no input. */
  input?: ToolBody;
}

export interface ToolResultEvent extends TurnEventBase {
  kind: 'tool_result';
  toolUseId: string;
  ok: boolean;
  bytes: number;
  /** What the tool returned. Absent when the result carried no text. */
  output?: ToolBody;
  /**
   * Heuristic: content opens with `diff --git` / unified-hunk headers.
   * Renders as the workspace-diff chip, never inline.
   */
  diffLike?: boolean;
}

export interface MetaEvent extends TurnEventBase {
  kind: 'meta';
  /**
   * Extend ADDITIVELY only — several clients switch on this value.
   *
   * `command_output` and `system_reminder` name the Claude Code machinery that
   * is injected into `role:'user'` entries; without them those payloads render
   * as if the operator had typed them.
   */
  subtype:
    | 'session_start'
    | 'slash_command'
    | 'caveat'
    | 'subagent'
    | 'command_output'
    | 'system_reminder'
    | 'unknown';
  label: string;
}

export type TurnEvent =
  | UserTextEvent
  | AssistantTextEvent
  | ToolUseEvent
  | ToolResultEvent
  | MetaEvent;

/** Byte-offset cursor into a transcript file (see daemon readTail). */
export interface TranscriptCursor {
  /** Byte offset of the first COMPLETE line in the returned page. */
  headOffset: number;
  /** Byte offset just past the last complete line consumed (the tail mark). */
  tailOffset: number;
  fileSize: number;
  mtimeMs: number;
}

export interface TranscriptPage {
  events: TurnEvent[];
  cursor: TranscriptCursor;
  /** headOffset > 0 → "Load earlier" is meaningful. */
  hasMore: boolean;
  /** A partial leading line was discarded (expected on any mid-file seek). */
  truncatedHead: boolean;
}

export interface TranscriptStatus {
  available: boolean;
  /**
   * Closed set matching what the projector's `resolvePath` actually returns:
   * `no-hook` | `stale-session` | `no-transcript-path` | `not-claude` |
   * `unsafe-transcript-path` | `unreadable` | `ok`.
   *
   * `no-binding` was split into `no-hook` / `stale-session`; `unsafe-transcript-path`
   * was missing from an earlier draft of this comment, and `local-mode` never had
   * a producer. Kept as a free `string` (not a union) so additive reasons do not
   * churn the wire type — a client must treat an unknown reason as "unavailable".
   */
  reason: string;
  transcriptBasename?: string;
  agentSessionId?: string;
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface TranscriptAppendData {
  seq: number;
  /** File shrank/rotated or a new session started — consumer must re-snapshot. */
  reset?: boolean;
  events: TurnEvent[];
  cursor: TranscriptCursor;
}

/**
 * The `window.electronAPI.chat` contract (plan PR-4).
 *
 * Declared HERE rather than in the preload so main, preload, renderer and
 * `src/shared/electron.d.ts` all name one shape — the preload object is checked
 * against it with `satisfies`, so the global augmentation cannot drift from what
 * is actually exposed.
 *
 * Every method resolves rather than rejecting on an unavailable projector: a
 * pane whose agent publishes no transcript is a normal state that disables a
 * toggle, not an error the renderer has to catch.
 */
export interface ChatBridgeApi {
  status: (ptyId: string) => Promise<TranscriptStatus>;
  /** `before` pages BACKWARD from a prior cursor.headOffset; omit for the tail. */
  snapshot: (ptyId: string, before?: number) => Promise<TranscriptPage | null>;
  subscribe: (ptyId: string) => Promise<{ ok: boolean; status: TranscriptStatus }>;
  unsubscribe: (ptyId: string) => Promise<{ ok: boolean }>;
  /**
   * One code-block body, fetched on expand. `srcOffset` + `n` come off the
   * CodeBlockRef the append event carried; `eventId` guards against a rotated
   * file answering with a different conversation's code.
   */
  codeBlock: (args: {
    ptyId: string;
    srcOffset: number;
    n: number;
    eventId?: string;
  }) => Promise<{ body: string } | null>;
  /** Live projector deltas for every subscribed pane. Returns an unsubscribe fn. */
  onAppend: (callback: (ptyId: string, data: TranscriptAppendData) => void) => () => void;
  /**
   * Composer-gate transitions from the daemon ApprovalRegistry (plan PR-6).
   *
   * App-lifetime, NOT scoped to an open Chat surface: the lock has to already be
   * armed the moment a user toggles into Chat on a pane that has been parked on
   * a permission menu for ten minutes.
   */
  onGate: (callback: (ptyId: string, gate: { kind: 'open' | 'closed' }) => void) => () => void;
  /**
   * The ptyIds that hold an OPEN approval right now.
   *
   * `onGate` is transition-only, so on mount and on every daemon reconnect the
   * gate has to be SEEDED from this before the composer may be enabled —
   * otherwise a reload during an open permission menu renders an unlocked
   * composer over it. Returns an empty list in local mode (no registry, no
   * approvals) — never throws, because the caller's fallback for a throw would
   * be to guess.
   */
  openGates: () => Promise<string[]>;
}
