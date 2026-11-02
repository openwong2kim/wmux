// Terminal agent status detection — monitors PTY output for known AI agent
// prompt patterns and status indicators. This is status display only; the one
// piece of terminal content that leaves here is `CriticalEvent.matchedLine`
// (a single 80-char sanitized line, so a "spicy command" heads-up can say
// WHICH one) — nothing is stored, and no other output is transmitted.
//
// DESIGN: Only use patterns that are UNIQUE to each agent's output.
// Never use generic patterns like "Done", "Failed", "?" that match
// normal shell output. False positives are worse than missed detections.

import { CRITICAL_PATTERNS, matchesCriticalPattern } from '../../shared/criticalPatterns';
import { CodexUsageLimitLineScanner } from '../../shared/usageLimit';
import type { AgentStatus } from '../../shared/types';
import type { AgentSlug } from '../../shared/agentIdentity';
import type { ApprovalScreenSnapshot } from '../../shared/approvalScreen';
import { agyScreenApproval, claudeScreenApproval, codexScreenApproval, folderTrustScreenApproval, openCodeScreenApproval, piScreenApproval, qwenScreenApproval, type ScreenApproval } from './approvalScreen';
export type { AgentSlug };
export { agentDisplayToSlug } from '../../shared/agentIdentity';

// C0 controls, DEL and C1 controls. Built via RegExp(...) with hex escapes so
// the source stays pure-ASCII while still stripping the bytes at runtime —
// same construction as the shared activity-summary sanitizer.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = new RegExp('[\\x00-\\x1f\\x7f-\\x9f]', 'g');

/** Replace control bytes with spaces and collapse the result to one line. */
function stripControls(s: string): string {
  return s.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * How long one pane stays quiet about a critical line it already reported. A
 * TUI redraws the same rows over and over, and a last-line dedup re-fired every
 * time two or three such rows took turns on screen.
 */
export const CRITICAL_REPEAT_WINDOW_MS = 10 * 60_000;
/** Lines remembered per pane for that window; the oldest go first. */
export const CRITICAL_SEEN_MAX = 256;
/** How much of a line its dedup key keeps. */
const CRITICAL_KEY_MAX = 512;

/**
 * A line that IS a grep/rg/echo/printf command: the command is the first word,
 * after nothing but a `$`/`%` prompt sign or Claude's own `⏺ Bash(` row prefix.
 * A wrapper in front (`docker exec echo …`, `sudo`, `ssh`) is not this.
 */
const SEARCH_OR_PRINT_LINE_RE = /^(?:[$%]\s*|([⏺●])\s*Bash\()?(?:grep|egrep|fgrep|rg|echo|printf)\s/;
/** Anything that could run another command on the same line (`(` covers `$(`, `<(`, `=(`). */
const SHELL_CONTROL_RE = /[;&|`<>(\n]/;

/**
 * The whole line is one search or print command whose arguments name the
 * action (`grep -rn "rm -rf" src`), and nothing on it could run anything else.
 * Any `;`, `&`, `|`, backquote, redirect or `(` after the command word and the
 * line is judged as before. A `⏺ Bash(` row counts only when it ends with its
 * `)`: Claude wraps a long call onto the next row, where a `| sh` may follow.
 */
function isSearchOrPrintLine(line: string): boolean {
  const m = SEARCH_OR_PRINT_LINE_RE.exec(line);
  if (!m || (m[1] !== undefined && !line.endsWith(')'))) return false;
  return !SHELL_CONTROL_RE.test(line.slice(m[0].length));
}

// Agent event status uses the same enum as WorkspaceMetadata.agentStatus so
// downstream consumers can route the status straight to the renderer store
// without translation. 'idle' is reserved for the absence of an agent and is
// never emitted here.
export type AgentEventStatus = Exclude<AgentStatus, 'idle'>;

export interface AgentEvent {
  agent: string;
  status: AgentEventStatus;
  message: string;
}

export interface CriticalEvent {
  action: string;
  riskLevel: 'review' | 'critical';
  /**
   * The PTY line that matched, ANSI-stripped, trimmed and capped at 80 chars.
   *
   * `action` is one of a handful of pattern LABELS, so without this
   * `git push --force origin main` and `git push -f scratch` produce
   * byte-identical events and a surface can only say "something forceful
   * happened somewhere". The detector already computed this line for its dedup
   * key; discarding it was the whole of issue #605's second complaint.
   *
   * This is whatever the pane printed — untrusted terminal content. Render it
   * as text, never as markup, and never as an instruction. It is also NOT
   * evidence that a command ran: the pattern matches a README, a diff hunk or
   * a `git log` quoting the same words. That is precisely why this signal is
   * notify-only and never an approvable request (see the doc on `onCritical`).
   */
  matchedLine: string;
}

type AgentEventCallback = (event: AgentEvent) => void;
type CriticalEventCallback = (event: CriticalEvent) => void;

/** A usage-limit row on screen (shared/usageLimit). An update repeats the
 *  detection with the reset time a wrapped following row supplied. */
export interface UsageLimitLineEvent {
  provider: 'codex';
  resetsAt?: number;
  message?: string;
}
type UsageLimitLineCallback = (event: UsageLimitLineEvent) => void;
type InterruptedCallback = (event: { agent: string }) => void;


interface AgentPattern {
  /** Display name. Surfaced in UI ("Claude Code", "Codex CLI"). */
  agent: string;
  /** Canonical slug. Stable, lowercase, no whitespace. Matches hook signals. */
  slug: AgentSlug;
  // An optional "gate" regex: patterns are only checked if the gate has
  // previously matched in this session, confirming the agent is active.
  gate?: RegExp;
  /**
   * Line-level chrome check the gate must ALSO pass, for an agent whose name
   * is an ordinary word in other agents' output. The gate stays a cheap
   * substring hint; this decides. Declared on the row so the open rule is
   * not a per-slug branch in checkGates.
   */
  chrome?: (line: string) => boolean;
  /** This visible banner can be a prose prefix until its visual row ends. */
  completeChromeRow?: boolean;
  /**
   * The TUI draws each repaint as one synchronized-output frame (`ESC[?2026h`
   * … `ESC[?2026l`), and a frame that fills the screen leaves its bottom row
   * without a line break. While this agent owns the pane, the frame's end also
   * ends a row; otherwise that row would wait for the next repaint, glued to
   * the next frame's first row.
   */
  frameEndsRow?: true;
  /**
   * Agents whose gate this one's chrome may take a pane from mid-session: a
   * fork that draws the other agent's chrome, so the other gate can open
   * first on this agent's own screen.
   */
  takesOverFrom?: readonly AgentSlug[];
  /** Strict live-grid recovery, used only after a fresh external identity. */
  approvalScreen?: (rows: readonly string[]) => ScreenApproval | null;
  /**
   * A question the grid can read: its question row, and the row that
   * finishes it. The question row arms it and a later finishing row makes it
   * ready, however far apart the two are drawn. Ready after identity arrived,
   * it asks the host for that identity's one recheck
   * (takeApprovalRecheckRequest) unless a line pattern reported awaiting_input
   * in the same read, since the grid could then add nothing; no recheck is
   * spent before it is ready, because a read then would see half a question.
   *
   * `shared`: the screen reader also reads dialogs that line patterns or the
   * stream report (Claude, Codex). Their recheck is not held for this
   * question, and spending it does not spend the one this question asks for.
   */
  approvalReady?: {
    question: RegExp;
    end: RegExp;
    shared?: true;
    /** More questions, each with the row that finishes it: an end is matched
     *  only after its own question. */
    also?: readonly { question: RegExp; end: RegExp }[];
  };
  patterns: {
    regex: RegExp;
    status: AgentEvent['status'];
    message: string;
    /**
     * Counts only as the last row drawn in its frame (`frameEndsRow` agents):
     * held until the frame ends, dropped if another non-blank row follows.
     */
    frameTail?: true;
  }[];
}

/**
 * Map an `AgentEvent.status` to the canonical hook-signal kind that the
 * dedup ledger uses. Required because AgentDetector emits status names
 * ('waiting', 'complete', ...) whereas HookSignalRouter dedup keys are
 * built from hook kinds ('agent.stop', 'agent.activity', ...).
 *
 * 'waiting' AND 'complete' both map to 'agent.stop' because both
 * conceptually represent the same user-visible event ("task finished,
 * ready for next input"). The status is a finer-grained distinction
 * the renderer uses for icon variation; for dedup it collapses to one.
 *
 * Returns `null` for status values that have no corresponding hook
 * kind. Caller skips dedup wiring in that case.
 *
 * (claude review 2026-05-23 P1 #2 — required before PTYBridge wiring
 * lands in Phase 1.5.)
 */
export function agentStatusToSignalKind(
  status: AgentEventStatus,
): 'agent.stop' | 'agent.activity' | 'agent.awaiting_input' | null {
  switch (status) {
    case 'waiting':
    case 'complete':
      return 'agent.stop';
    case 'running':
      return 'agent.activity';
    case 'awaiting_input':
      return 'agent.awaiting_input';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Per-agent patterns — ONLY agent-specific, no generic patterns
// ---------------------------------------------------------------------------

// Kiro's TUI is identified by a compound signature. A product-name mention by
// itself is not enough: agents routinely print logs/docs about other agents.
// Require an anchored Kiro chrome line (the exact banner or trust-mode footer)
// AND the anchored composer placeholder from the same PTY session.
const KIRO_CHROME_LINE = /^(?:Kiro\s*CLI(?:\s+v?\d[\w.-]*)?|Trust\s*All\s*Tools\s*active,\s*confirmations\s*are\s*off(?:\s*·.*)?)$/i;
const KIRO_PROMPT_LINE = /^[▸>❯]?\s*ask\s*a\s*question\s*or\s*describe\s*a\s*task\s*↵?\s*$/i;

// #850: Claude compound gate — two independent signals, same model as Kiro.
// Signal A (banner): a TUI/OSC chrome LINE, not a substring anywhere in the
// 4 KB probe. Agents working this repo print `Claude Code` and
// `shift+tab to cycle` from source; treating the blob as one string opened
// the gate on a live Grok pane (2026-08-16).
// Signal B (prompt): the same fragments, but only as TUI footer chrome.
//
// \s* — same treatment CLAUDE_BANNER_RE already carries, and for the same
// reason. Claude Code (measured on v2.1.235) paints its footer by advancing
// the cursor instead of writing spaces: the wire carries
// `⏵⏵ESC[1Cbypass ESC[1Cpermissions ESC[1Con ESC[1C(shift+tab...`, which
// strips to `bypasspermissionson(shift+tabtocycle)`. The space-bearing form
// could never match a live pane, so the compound gate never closed its second
// half and the whole Claude pattern block — waiting AND the approval
// awaiting_input regexes — was dead code against the real product.
//
// `⏸ manual mode on`: the footer Claude Code 2.1.281 draws in the default
// permission mode (`⏸ manual mode on · ← for agents`). It carries neither
// fragment above, and a `claude "<prompt>"` launch — how a fan-out worker
// starts — draws no splash either, so such a pane's gate never opened and its
// first permission prompts were read by nobody. Gate evidence only: it is on
// screen mid-turn too, so it never stands in for a `waiting` status.
const CLAUDE_PROMPT_RE = /bypass\s*permissions\s*on|shift\+tab\s*to\s*cycle|⏸\s*manual\s*mode\s*on/;
// Cheap `ap.gate` hint only — checkGates does not use this on the 4 KB
// probe. Line-level `isClaudeBannerChrome` is the real banner signal.
const CLAUDE_BANNER_RE = /(?<!Open)(?<!Open\s)Claude\s*Code|claude-code/;
// Box / spinner / whitespace — stripped so a framed splash collapses to
// `Claude Code` while a btop row (`3304  Claude Code  43%`) does not.
const CHROME_NOISE_RE = /[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·✳*⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏▀▄█▌▐░▒▓]/g;
// JS/TS (and test-dump) syntax that means this line is source, not chrome.
const SOURCE_LINE_RE = /[=;{}]|const |let |var |function |det\.feed|\/(?:bypass|shift)\\?\+?tab|\/\/|\/\*/;
// The waiting patterns the ordinary pattern pass runs, in the SAME array order,
// so the gate's replay can store the text that pass will produce. Derived below
// from AGENT_PATTERNS rather than duplicated — a second hand-written copy is
// exactly how the two drift apart again.
let CLAUDE_WAITING_PATTERNS: RegExp[] = [];

const AGENT_PATTERNS: AgentPattern[] = [
  // ── Claude Code ────────────────────────────────────────────────────────────
  // Gate: compound — banner AND prompt (checkGates handles the two-signal
  // logic; ap.gate is still tested but the slug === 'claude' branch overrides
  // the result to require both signals).
  {
    agent: 'Claude Code',
    slug: 'claude',
    approvalScreen: claudeScreenApproval,
    // The folder-trust screen (2.1.310 live capture, __tests__/fixtures/
    // claude-code-2.1.310-trust-120x40.json) comes before any banner or
    // footer, so the gate is closed and no line pattern reads it; its choices
    // are unnumbered (`❯ No, exit`). Read from the grid once process identity
    // has seeded the profile: the question, then the key footer, its last row.
    approvalReady: { question: /Is\s*this\s*a\s*project\s*you\s*created\s*or\s*one\s*you\s*trust\?/, end: /Enter\s*to\s*confirm\s*·\s*Esc\s*to\s*cancel/, shared: true },
    // \s* — Claude Code TUI는 배너 "Claude Code"를 셀 단위 커서 이동으로 그려,
    // ANSI strip 후 "Claude"와 "Code" 사이 공백이 사라진 "ClaudeCode"가 된다.
    // 공백을 선택적으로 둬야 daemon mode에서도 gate가 매칭된다(핵심 race 원인).
    // (?<!Open)(?<!Open\s) keeps this gate from also opening on the
    // OpenClaude fork's banner ("╭ … OpenClaude" / "╭ … Open Claude"),
    // which would double-activate and misattribute events to Claude.
    gate: CLAUDE_BANNER_RE,
    patterns: [
      // Waiting — Claude Code's unique idle prompt fragments.
      //
      // NOTE: `esc to interrupt` was previously matched here but it actually
      // appears while a response is in flight (hint that the user can ESC to
      // cancel), not when the agent is idle. Including it produced
      // false-positive "waiting" notifications mid-turn. Removed.
      { regex: /bypass\s*permissions\s*on/,      status: 'waiting',          message: 'Ready for input' },
      // Not the mid-turn tip Claude Code 2.1.289 prints under a running tool
      // ("Tip: Hit shift+tab to cycle between manual mode, …"): read as idle,
      // it ended a turn that was still running, and woke Moa on a worker that
      // was about to ask for permission.
      { regex: /(?<![Hh]it\s*)shift\+tab\s*to\s*cycle/, status: 'waiting',          message: 'Ready for input' },
      // Approval prompts — Claude Code is paused mid-turn waiting for the user
      // to pick an option. Orchestrators can react to 'awaiting_input' to feed
      // pre-approved answers without waiting for the full turn to end.
      //
      // The patterns are anchored to the END of the line: a real approval
      // prompt occupies the whole line (possibly inside Claude's box-drawing
      // frame), whereas conversational mentions are followed by more sentence
      // text. Codex round-1/round-2 P2: an unanchored `Do you want to
      // proceed` matched `If the CLI asks "Do you want to proceed?", choose
      // no`, and unanchored `Allow tool use` matched `click Allow tool use
      // for Bash` in plain text. Because orchestrators may auto-feed
      // approval responses into the PTY, false positives here are
      // particularly costly.
      //
      // Trailing AND leading character classes accept whitespace and the
      // full set of box-drawing glyphs Claude's TUI uses to frame prompt
      // lines:
      //   straight:   │ ║ ┃ ═ ━ ─ ┄ ┅ ┆ ┇ ┈ ┉
      //   corners:    ╭ ╮ ╯ ╰ ╔ ╗ ╝ ╚ ┌ ┐ ┘ └
      //   separators: · ─
      // Round-3 P2: omitting corners caused boxed prompt lines ending in
      // `╮` or `╯` to be skipped. Round-4 P2: omitting `─` (U+2500, light
      // horizontal) missed boxed prompts like `╭─ Do you want to
      // proceed? ─╮`. Round-5 P2: omitting the leading anchor allowed
      // conversational lines such as `Please click Allow tool use for
      // Bash` to slip through — the round-2 comment promised "real
      // prompts occupy the whole line" but the regex only checked the
      // suffix. The whole-line constraint now applies on both ends.
      //
      // Tool-name pattern covers TWO and only two forms:
      //   - Claude's built-in tool labels: `[A-Z][A-Za-z]+` (Bash, Edit,
      //     Write, WebFetch, TodoWrite, ExitPlanMode, ...). Capitalized,
      //     no underscores or hyphens.
      //   - Canonical MCP namespaced form: `mcp__<server>__<tool>` with
      //     literal `mcp__` prefix, at least two `__` segments, and
      //     hyphens permitted inside the server/tool ids
      //     (`mcp__context7__get-library-docs`). Round-5 P2: the prior
      //     `mcp__[A-Za-z0-9_]+` rejected hyphens and accepted
      //     non-canonical single-`__` names like `mcp__github_create_issue`.
      //
      // `\s*` between words: Claude Code 2.1.281 draws this row with cursor
      // moves on some frames (`Do ESC[5G you ESC[9G want ESC[14G to ESC[17G
      // proceed?`), which strips to `Doyouwanttoproceed?`. In a replay of 33
      // real Bash permission prompts, 15 had lost some or all spaces, so the
      // literal-space form never marked those panes as needing the user.
      //
      // #1494/#1506: processLine skips the `Do you want to …` entries on a
      // Claude pane; scanDialog judges those questions by the option row.
      { regex: /^[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Do\s*you\s*want\s*to\s*proceed\?[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/,                                                                                  status: 'awaiting_input',   message: 'Approval requested' },
      { regex: /^[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Allow\s*tool\s*use\s*for\s*(?:[A-Z][A-Za-z]+|mcp__[A-Za-z0-9-]+__[A-Za-z0-9_-]+)\??[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/, status: 'awaiting_input',   message: 'Tool approval requested' },
      // File-edit approval prompts (`Do you want to create/overwrite/make this
      // edit to <file>?`). Live incident 2026-07-17: a worker pane sat on
      // `Do you want to overwrite calculator.html?` for 100 minutes because
      // only the `proceed`/`Allow tool use` forms were matched, so no
      // awaiting_input ever fired and the orchestrator was never woken.
      //
      // Two rendering hazards, both observed in that pane's buffer:
      //   1. The TUI draws prompt words with cursor moves, so after ANSI strip
      //      the spaces can vanish (`Doyouwanttooverwrite`) — same phenomenon
      //      as the `ClaudeCode` gate note above. Hence `\s*` between words.
      //   2. In a narrow pane the prompt WRAPS after the verb, putting the
      //      filename on the next rendered line — so a filename-bearing
      //      one-line pattern alone can never match. The second pattern
      //      accepts the verb ending the line on its own.
      // Both stay whole-line anchored (leading + trailing frame class), same
      // false-positive discipline as the patterns above.
      // (`╌╍` — light/heavy double-dash horizontals — appear in the observed
      // buffer's separator rule but are missing from the frame class the
      // older patterns use, so the new class includes them.)
      { regex: /^[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Do\s*you\s*want\s*to\s*(?:create|overwrite|make\s*this\s*edit\s*to)\s*\S[^?]*\?[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/, status: 'awaiting_input',   message: 'Edit approval requested' },
      { regex: /^[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Do\s*you\s*want\s*to\s*(?:create|overwrite|make\s*this\s*edit\s*to)[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/,             status: 'awaiting_input',   message: 'Edit approval requested' },
    ],
  },

  // ── OpenClaude ───────────────────────────────────────────────────────────
  // Gate: OpenClaude startup banner — same fork-derived TUI as Claude Code
  // but draws its own banner.
  // NOTE: "bypass permissions on" is NOT used for waiting because OpenClaude
  // re-renders its status bar every frame, flooding notifications (confirmed
  // via debug capture 2026-07-22 — the line reaches the detector as a single
  // concatenated token "…bypassPermissions modeisactive…" every ~16ms).
  // "shift+tab to cycle" does NOT appear in OpenClaude's TUI at all (unlike
  // Claude Code). The actual prompt after ANSI strip + trim is just ">" or
  // "> ○" (with spinner), so we match those directly.
  {
    agent: 'OpenClaude',
    slug: 'openclaude',
    gate: /Open\s*Claude|openclaude|╭.*OpenClaude/,
    patterns: [
      // Waiting — the bare ">" prompt after trim, optionally followed by a
      // spinner character (○) when the TUI is waiting for input.
      { regex: /^>[\s○◌●]*$/,                                                                               status: 'waiting',          message: 'Ready for input' },
      { regex: /^[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Do\s*you\s*want\s*to\s*proceed\?[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/,                                                              status: 'awaiting_input',   message: 'Approval requested' },
      { regex: /^[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Allow\s*tool\s*use\s*for\s*(?:[A-Z][A-Za-z]+|mcp__[A-Za-z0-9-]+__[A-Za-z0-9_-]+)\??[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/, status: 'awaiting_input',   message: 'Tool approval requested' },
      { regex: /^[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Do\s*you\s*want\s*to\s*(?:create|overwrite|make\s*this\s*edit\s*to)\s*\S[^?]*\?[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/, status: 'awaiting_input',   message: 'Edit approval requested' },
      { regex: /^[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Do\s*you\s*want\s*to\s*(?:create|overwrite|make\s*this\s*edit\s*to)[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/,             status: 'awaiting_input',   message: 'Edit approval requested' },
    ],
  },

  // ── Aider ─────────────────────────────────────────────────────────────────
  {
    agent: 'Aider',
    slug: 'aider',
    gate: /aider v/i,
    chrome: isAiderChrome,
    completeChromeRow: true,
    patterns: [
      { regex: /^aider>\s*$/,                    status: 'waiting',   message: 'Waiting for input' },
      { regex: /Applied edit to/,                status: 'complete',  message: 'Edit applied' },
    ],
  },

  // ── Codex CLI ─────────────────────────────────────────────────────────────
  {
    agent: 'Codex CLI',
    slug: 'codex',
    approvalScreen: codexScreenApproval,
    // codex-cli 0.162.1 (live capture, __tests__/fixtures/
    // codex-0.162.1-trust-120x40.json) draws the trust screen in the alternate
    // screen with CUP only, no CR/LF, so no line pattern below sees it. Read
    // from the grid once process identity has seeded the profile.
    approvalReady: { question: /Trust\s*this\s*folder\?\s*Codex\s*can/, end: /enter\s*continue\s*·\s*esc\s*back/, shared: true },
    // The trust-prompt phrase is part of the gate because on a first boot in
    // an untrusted directory Codex shows it BEFORE the "OpenAI Codex" banner
    // — with the banner-only gate the trust pattern below could never fire.
    // checkGates runs before pattern matching on the same line, so the one
    // line both opens the gate and emits awaiting_input.
    //
    // Cheap hint only — checkGates opens this gate through isCodexChrome, a
    // line-level check. A substring gate (`codex `, then `OpenAI Codex`)
    // opened on any line that merely named Codex — `command -v codex` in a
    // review panel, a `git log -S"…OpenAI Codex"` echo — made Codex the
    // lastAgent of a Claude pane and silenced every Claude pattern for the
    // rest of the session. The PermissionRequest hook (#1107) is Codex's
    // primary approval signal anyway.
    gate: /OpenAI\s*Codex|Do you trust the contents of this directory|Trust\s*this\s*folder\?/,
    patterns: [
      { regex: /^codex>\s*$/,                    status: 'waiting',   message: 'Waiting for input' },
      // Approval prompts — clean-room transcribed from a live Codex CLI
      // 0.145.0 TUI session on 2026-07-17 (NOT copied from any third-party
      // detection ruleset; see plans/notification-overhaul-2026-07-15.md
      // Phase 2). Codex's `notify` hook only fires on turn-complete, so
      // mid-turn approval pauses are ONLY observable by screen text — and
      // the awaiting_input carve-out in PTYBridge/DaemonPTYBridge already
      // exempts these from hook-authority veto for exactly that reason.
      //
      // #1107: codex-cli >= 0.141.0 also has a `PermissionRequest` lifecycle
      // hook, measured firing 2026-09-07 and now mapped to
      // agent.awaiting_input by the hooks bridge. These regexes are the
      // FALLBACK, not the primary: a pane with a trusted hook gets the fact,
      // and these cover panes whose operator never approved the hook (the
      // trust gate is silent, so an uninstalled bridge is the common case).
      //
      // Anchored to the whole line: the question occupies its own line in
      // the TUI (two-space indent, no box-drawing frame in Codex), whereas
      // a conversational mention would sit inside surrounding sentence text.
      { regex: /^\s*Would you like to run the following command\?\s*$/, status: 'awaiting_input', message: 'Command approval requested' },
      { regex: /^\s*Would you like to make the following edits\?\s*$/,  status: 'awaiting_input', message: 'Edit approval requested' },
      // Startup trust prompt. Line continues with explanatory text after
      // the question mark ("Working with untrusted contents comes with
      // higher risk..."), so only the start is anchored.
      { regex: /^\s*Do you trust the contents of this directory\?/,     status: 'awaiting_input', message: 'Directory trust prompt' },
      // codex-cli 0.157's wording ("Folder access" / "Trust this folder?" /
      // "› 1. Trust and continue"): the question has its own row. 0.162.1
      // goes on with the explanation on the same row ("Trust this folder?
      // Codex can read, …", a narrow pane may wrap after `Codex`). Only that
      // sentence: Kimi Code CLI asks the bare question too, and this must
      // claim no more of it than before.
      { regex: /^\s*Trust\s*this\s*folder\?(?:\s*Codex(?:\s*can|\s*$)|\s*$)/, status: 'awaiting_input', message: 'Directory trust prompt' },
    ],
  },

  // ── Qwen Code ─────────────────────────────────────────────────────────────
  // Live capture 2026-10-26, @qwen-code/qwen-code 0.26.1 on macOS (120x40 and
  // 60x30, `--approval-mode default`, a loopback model; the frames are in
  // __tests__/fixtures/qwen-code-0.26.1-*.json). Qwen Code is a Gemini CLI fork
  // and draws Gemini's composer row (`>   Type your message or
  // @path/to/file`), which opens the Gemini gate. Qwen's own chrome usually
  // comes first (the window title is the first thing it prints, and the
  // banner row tops each frame until the transcript pushes it off). When the
  // composer row wins, the next title Qwen sets takes the pane back.
  // Each frame is a full repaint, one row per CRLF line (also at 60x30):
  //   - footer `<mode> (shift + tab to cycle)` on a row of its own only while
  //     idle. Mid-turn the same row reads `Enter to steer · Ctrl+Q to queue ·
  //     ⏸ Ask permissions (…)` (cut with `…` in a narrow pane), and a prompt
  //     typed but not yet sent adds ` ⏳ 1 queued` after it;
  //   - spinner row `⠸ <phrase>... (1s · ↓ 8 tokens · esc to cancel)` while a
  //     turn runs, its counters changing on every frame; a narrow pane wraps
  //     the counters onto a row of their own;
  //   - every permission dialog (shell `Allow execution of: 'touch'?`, file
  //     write `Apply this change?`) ends its frame with the spinner row
  //     `⠏ Waiting for user confirmation...`, with no counters. Just after an
  //     answer the running spinner can keep that phrase, with its counters
  //     beside it or, when narrow, on the next row; so the row counts only as
  //     the frame's last. The question rows stay out: the transcript is
  //     repainted on every frame, and a reply line quoting a question would
  //     read as a live dialog.
  // English UI only; on Windows the footer says `(tab to cycle)` (not
  // captured, so not matched).
  {
    agent: 'Qwen Code',
    slug: 'qwen',
    // The dialog read off the grid once a process or hook identity arrives
    // after it was drawn, when no line pattern was reading for Qwen yet; the
    // folder-trust dialog (security.folderTrust.enabled) is read the same way.
    approvalScreen: (rows) => qwenScreenApproval(rows) ?? folderTrustScreenApproval(rows),
    // Its question (shell, or file write and edit), then the confirmation
    // spinner row drawn below the choices, without the counters a running
    // spinner adds beside it (or, when narrow, on the next row) just after
    // an answer. Or the folder-trust question, then its last choice
    // ("3. Don't trust (esc)", cut with "…" in a narrow pane).
    approvalReady: {
      question: /Allow\s*execution\s*of:|Apply\s*this\s*change\?/,
      end: /Waiting\s*for\s*user\s*confirmation\.\.\.(?!\s*\()/,
      also: [{ question: /Do[\s│]*you[\s│]*trust[\s│]*this[\s│]*folder\?/, end: /3\.[\s│]*Don/ }],
    },
    gate: /Qwen\s*Code\s*\(v\d|Qwen - /,
    chrome: isQwenChrome,
    completeChromeRow: true,
    // In the 60x30 capture the dialog's spinner row and the idle footer are
    // both such bottom rows.
    frameEndsRow: true,
    takesOverFrom: ['gemini'],
    patterns: [
      { regex: /(?<=^[⠀-⣿]\s*)Waiting\s*for\s*user\s*confirmation\.\.\.$/,         status: 'awaiting_input', message: 'Approval requested', frameTail: true },
      // Only the fixed tail, so the ticking counters do not re-emit each frame.
      { regex: /(?<=\(\d+[smh]\b[^()]*)·\s*esc\s*to\s*cancel\)$/,                           status: 'running',        message: 'Working' },
      // The five approval modes' labels, each captured live.
      { regex: /^(?:⏸ Ask permissions|Auto mode|auto-accept edits|plan mode|YOLO mode) \(shift \+ tab to cycle\)$/, status: 'waiting', message: 'Ready for input' },
    ],
  },

  // ── Gemini CLI ────────────────────────────────────────────────────────────
  {
    agent: 'Gemini CLI',
    slug: 'gemini',
    // Cheap hint only — checkGates opens this gate through isGeminiChrome, a
    // line-level check. The old substring gate (`gemini ` / `Gemini CLI`)
    // opened on any row that merely named Gemini — a Claude reply comparing
    // models, `cd ~/projects/gemini`, `npm i -g @google/gemini-cli` — and on
    // a pane whose Claude gate was not yet confirmed (or whose Claude had
    // exited) that made Gemini the pane's lastAgent. The daemon persists that
    // slug as lastDetectedAgent, so after a restart a Claude-only pane lost
    // its resume pill (Gemini has no resume grammar) or offered another
    // agent's picker. The hint names the composer and a model name
    // (`gemini-2.5…`), not the word: a cwd like `~/gemini-cli` sits in
    // Claude's statusline on every repaint and must not pay for
    // candidateLines on each chunk.
    gate: /Type\s*your\s*message\s*or|gemini-\d|Gemini CLI update/,
    chrome: (line) => isGeminiChrome(line),
    // Its folder-trust dialog (live capture, 0.35.3 and 0.65.0), drawn at
    // startup in a boxed frame before the composer: read off the grid once a
    // process identity arrives. Ready once the last choice ("3. Don't trust",
    // cut with "…" in a narrow pane) is drawn under the question; a narrow
    // box puts its border between the question's words.
    approvalScreen: folderTrustScreenApproval,
    approvalReady: {
      question: /Do[\s│]*you[\s│]*trust[\s│]*the[\s│]*files[\s│]*in[\s│]*this[\s│]*folder\?/,
      end: /3\.[\s│]*Don/,
    },
    patterns: [
      { regex: /^gemini>\s*$/,                   status: 'waiting',   message: 'Waiting for input' },
    ],
  },

  // ── Antigravity CLI (agy) ─────────────────────────────────────────────────
  // Live capture 2026-09-29, agy 1.2.13 on Windows (ConPTY, 120x40). The
  // banner reads `Antigravity CLI 1.2.13` and the signed-out splash
  // `Welcome to the Antigravity CLI.`; the footer row carries the state:
  // `esc to cancel` while a turn runs, `? for shortcuts` once the composer is
  // idle, both followed on the same row by `<mode> · <model> · <effort>`.
  // The trust screen shows before the banner in an untrusted folder.
  // The trust question is not an identity signal: other tools and documents
  // can show it too. It reports awaiting_input only after provider chrome has
  // identified agy. A trust-only first run needs process/hook identity, which
  // this screen-only detector does not receive.
  {
    agent: 'Antigravity CLI',
    slug: 'agy',
    approvalScreen: agyScreenApproval,
    gate: /Antigravity\s*CLI/,
    chrome: isAntigravityChrome,
    completeChromeRow: true,
    patterns: [
      { regex: /^\s*Do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*project\?/, status: 'awaiting_input', message: 'Project trust prompt' },
      { regex: /^\s*esc\s*to\s*cancel/,                                        status: 'running',        message: 'Working' },
      { regex: /^\s*\?\s*for\s*shortcuts/,                                     status: 'waiting',        message: 'Ready for input' },
      // A request refused for quota. Error forms only: the model picker shows
      // "Quota available" / "Quota exhausted" labels in normal use. Pane status
      // only: account choice reads the quota sensor, never pane text.
      { regex: /\bRESOURCE_EXHAUSTED\b|\bout\s+of\s+quota\b|\bquota\s+(?:has\s+been\s+)?exceeded\b|\bexhausted\s+your\s+(?:\w+\s+)?quota\b/i, status: 'error', message: 'Quota exhausted' },
    ],
  },

  // ── Kiro CLI ──────────────────────────────────────────────────────────────
  // The generic gate loop below special-cases this slug and opens it only
  // after BOTH KIRO_CHROME_LINE and KIRO_PROMPT_LINE have been observed.
  {
    agent: 'Kiro CLI',
    slug: 'kiro',
    gate: KIRO_CHROME_LINE,
    patterns: [
      { regex: KIRO_PROMPT_LINE, status: 'waiting', message: 'Ready for input' },
    ],
  },

  // ── OpenCode ──────────────────────────────────────────────────────────────
  {
    agent: 'OpenCode',
    slug: 'opencode',
    approvalScreen: openCodeScreenApproval,
    gate: /OpenCode|OC \|/,
    chrome: isOpenCodeChrome,
    patterns: [
      { regex: /^opencode>\s*$/,                 status: 'waiting',   message: 'Waiting for input' },
    ],
  },

  // ── Pi ────────────────────────────────────────────────────────────────────
  // Live capture 2026-10-26, @earendil-works/pi-coding-agent 1.4.0 on macOS
  // (120x40, loopback fake model; __tests__/fixtures/pi-1.4.0-capture.json).
  // Pi owns the alternate screen and places every row with CUP: it writes no
  // CR/LF until it exits, so no line pattern ever sees its composer or its
  // `── ⠦ Working ──` border, and running/idle come from output activity.
  // Identity is its native title, `π - <cwd basename>`, written once at
  // startup. Tools (bash included) run without asking. The one question it
  // asks is the project-trust selector, drawn as CRLF rows before the title:
  // it is read only structurally (approvalScreen, the current grid) once
  // process identity has seeded the profile. Its question row alone is no
  // evidence: a seeded `pi -p` or a shell after Pi exits can print it.
  {
    agent: 'Pi',
    slug: 'pi',
    approvalScreen: piScreenApproval,
    // The question, then the key footer that is the selector's last row (a
    // narrow pane wraps `cancel`).
    approvalReady: { question: /Trust\s*project\s*folder\?/, end: /escape\/ctrl\+c\s*cancel/ },
    gate: /π - /,
    chrome: isPiChrome,
    patterns: [],
  },

  // ── GitHub Copilot CLI ────────────────────────────────────────────────────
  {
    agent: 'GitHub Copilot CLI',
    slug: 'copilot',
    gate: /GitHub\s*Copilot/,
    chrome: isCopilotChrome,
    completeChromeRow: true,
    patterns: [
      { regex: /^copilot>\s*$/,                  status: 'waiting',   message: 'Waiting for input' },
    ],
  },

  // ── Grok (xAI CLI) ───────────────────────────────────────────────────────
  // Captured from a live grok TUI on 2026-08-16 (startup menu: "Grok 4.6 is
  // here!", "Help improve Grok", "Select 'Grok 4.6' under /model."). A bare
  // "Grok" mention is not enough — other agents' logs talk about Grok.
  {
    agent: 'Grok',
    slug: 'grok',
    // Line-level chrome only — see isGrokChrome. The regex here is the
    // cheap hint checkGates uses before walking lines; the slug === 'grok'
    // branch is what actually opens the gate.
    gate: /Grok\s+\d+(?:\.\d+)?\s+is here|Help improve Grok|Select ['']Grok|Grok\s+\d+(?:\.\d+)?\s+\([^)]+\)\s*·\s*always-approve/,
    patterns: [
      { regex: /Help improve Grok/,                    status: 'waiting', message: 'Ready for input' },
      { regex: /Grok\s+\d+(?:\.\d+)?\s+is here/,       status: 'waiting', message: 'Ready for input' },
      { regex: /Grok\s+\d+(?:\.\d+)?\s+\([^)]+\)\s*·\s*always-approve/, status: 'waiting', message: 'Ready for input' },
    ],
  },
];

/** The slugs that have a screen profile above. The registry's `detect` field
 *  (src/shared/agentIdentity.ts) must name exactly these; a test holds them
 *  together. */
export const DETECTOR_PROFILE_SLUGS: readonly AgentSlug[] = AGENT_PATTERNS.map((ap) => ap.slug);
/** The profile table by slug. */
const PROFILE_BY_SLUG = new Map(AGENT_PATTERNS.map((ap) => [ap.slug, ap]));
/**
 * How far before the newly drawn text an approvalReady match may begin: a
 * footer a narrow pane wraps carries that row's padding.
 */
const READY_MATCH_REACH = 512;
/** A CSI, OSC or charset escape at the very end of a read, not yet finished. */
// eslint-disable-next-line no-control-regex
const UNFINISHED_ESCAPE = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*|\][^\x07\x1b]*|\()?$/;
/** The profiles with an approvalReady question, its patterns compiled global once. */
const READY_PROFILES = AGENT_PATTERNS.flatMap((ap) => (ap.approvalReady
  ? [ap.approvalReady, ...(ap.approvalReady.also ?? [])].map(({ question, end }, i) => ({
    // What arms: the profile's slug for its first question, then one key per further question.
    key: i === 0 ? ap.slug : `${ap.slug}:${i}`, slug: ap.slug, question: globalRegExp(question), end: globalRegExp(end),
  }))
  : []));

function globalRegExp(re: RegExp): RegExp {
  return re.global ? re : new RegExp(re.source, `${re.flags}g`);
}

// Derive the Claude waiting patterns from the table above so the gate replay
// and the ordinary pattern pass can never disagree about which fragment a line
// matched. Order is preserved: the pattern pass takes the first entry that
// matches, so the replay must resolve the same way.
CLAUDE_WAITING_PATTERNS = (AGENT_PATTERNS.find((ap) => ap.slug === 'claude')?.patterns ?? [])
  .filter((p) => p.status === 'waiting')
  .map((p) => p.regex);

const MAX_BUFFER = 16 * 1024;
/** Longest OSC the line buffer's cut keeps whole (a title fits many times over). */
const MAX_OSC_KEPT = 4096;

/** Where feedOutput ends a line; the second also ends one at a frame's end (`frameEndsRow`). */
const ROW_END_G = /\r?\n|\r(?!\n)/g;
// eslint-disable-next-line no-control-regex
const ROW_OR_FRAME_END_G = /\r?\n|\r(?!\n)|\x1b\[\?2026l/g;
const FRAME_END_ROW_AGENTS: ReadonlySet<string> = new Set(AGENT_PATTERNS.filter((ap) => ap.frameEndsRow).map((ap) => ap.agent));

// ANSI escape strip regex. Covers:
//   CSI    \x1b[ <params> <intermediates> <final>   params are 0x30-0x3F
//                                   (digits, `;`, `:` subparameters, and the
//                                   private-mode prefixes ? < = >),
//                                   intermediates 0x20-0x2F, and the final
//                                   is a letter A-Z/a-z or '@'
//   OSC    \x1b] <data> \x07
//   Charset designation \x1b(X
//
// Previous version omitted ?/</=/> and missed `\x1b[?25h` style sequences that
// Claude/Codex TUIs emit frequently, leaving stray fragments in `clean` and
// occasionally breaking pattern matching.
// eslint-disable-next-line no-control-regex
const ANSI_STRIP = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[a-zA-Z@]|\][^\x07]*\x07|\([A-Z])/g;

/**
 * Row boundaries as a full-screen TUI actually draws them.
 *
 * Newlines are only half the story. Claude repaints its whole bottom region —
 * input box, statusline, mode footer — as ONE run with no newline in it,
 * positioning each visual row with a CUP escape (`ESC[<row>;<col>H`). Splitting
 * on newlines alone therefore hands the chrome tests a single ~900-char blob,
 * and `isClaudePromptChrome` then rejects the footer via SOURCE_LINE_RE because
 * something ELSE in that blob looks like code. Measured on a live pane: the
 * user's own echoed prompt (`sleep 8; echo s1`) and an env var in a Claude
 * warning (`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`) each supplied the `;`/`=`
 * that killed the gate. Cutting on CUP restores the row the TUI meant to draw,
 * `bypasspermissionson(shift+tabtocycle)`, which reads as chrome cleanly.
 */
// eslint-disable-next-line no-control-regex
const ROW_BREAK_RE = /\r\n|\n|\r|\u001b\[[0-9]{0,4}(?:;[0-9]{0,4})?[Hf]/;
/** Complete lines in `text`, or `[text]` itself when it is still a tail. */
function candidateLines(text: string): string[] {
  if (!ROW_BREAK_RE.test(text)) return [text];
  return text.split(new RegExp(ROW_BREAK_RE.source, 'g')).filter((l) => l.length > 0);
}

/**
 * #1494 — Claude Code's permission dialog, recognised by its structure rather
 * than by one whole line.
 *
 * Ink draws the dialog in whatever shape the frame diff calls for: the
 * question row can be placed by a CUP with no line break, glued after a diff
 * row by width padding and autowrap, or split from its filename by a wrap. The
 * whole-line anchored patterns miss all of those. Loosening them to the row
 * the TUI drew is not enough on its own: Claude's transcript can hold the same
 * question on a row of its own (a reply that prints it), and every full
 * repaint draws that row again.
 *
 * What only the live dialog has is the first option row, `❯ 1. Yes`, as the
 * next thing drawn after the question. So a question counts only when the
 * next non-blank row is that option row, or when the option is glued onto the
 * question row by padding. Ink's diff redraw can skip unchanged cells, so the
 * `.` after the `1` is optional.
 *
 * The WebFetch dialog asks `Do you want to allow Claude to fetch this
 * content?` (Claude Code 2.1.292); a narrow pane wraps it after `fetch` or
 * `this`, and the rest is read off the next row like a wrapped filename.
 *
 * #1931 — the diff can skip LETTERS too. A cell that already shows the right
 * character is passed over with a cursor-forward (`CSI n C`) instead of being
 * written again. For a space that never mattered (stripping the escape only
 * closes the gap), but a skipped letter drops out of the row: the second Bash
 * dialog of a Windows session arrived as `pr ESC[1C ceed?`, read as
 * `prceed?`, and nothing ever raised it. So the scan keeps one SKIPPED_CELL per
 * skipped cell, and the question and first-option patterns accept one
 * wherever a character is expected. A bound on how many letters may be
 * missing keeps a row the renderer skipped wholesale from reading as a dialog.
 */
const SKIPPED_CELL = '￿';
const SKIPPED_CELL_G = /￿/g;
// eslint-disable-next-line no-control-regex
const CURSOR_FORWARD_G = /\u001b\[(\d{0,4})C/g;
/** A cursor-forward wider than this is a layout jump, not a run of skipped cells. */
const MAX_SKIPPED_RUN = 512;
/** Most letters of the question's fixed words a match may be missing. */
const MAX_SKIPPED_QUESTION_LETTERS = 3;
/** Most of the first option's five cells (`❯`, `1`, `Yes`) a match may be missing. */
const MAX_SKIPPED_OPTION_CELLS = 2;
const DIALOG_FRAME = `[\\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·${SKIPPED_CELL}]`;
/**
 * Between two words: nothing (a CHA/CUP gap), spaces, or skipped cells. Lazy,
 * so a run of skipped cells is first offered to the letters after it: greedy,
 * `to ESC[7C ?` (all of "proceed" skipped) matched as `to` + gap + a fully
 * skipped `create`, and the right reading was never tried.
 */
const DIALOG_GAP = `[\\s${SKIPPED_CELL}]*?`;
/** `phrase` as a pattern where every character may also be a skipped cell. */
function skippable(phrase: string): string {
  return phrase.split(' ')
    .map((word) => [...word].map((ch) => `[${ch.replace(/[\\\]^-]/g, '\\$&')}${SKIPPED_CELL}]`).join(''))
    .join(DIALOG_GAP);
}
const DIALOG_EDIT_VERBS = ['create', 'overwrite', 'make this edit to'].map((verb) => ({ verb, re: new RegExp(`^${skippable(verb)}$`) }));
const DIALOG_QUESTION_RE = new RegExp(
  `(?:^|${DIALOG_FRAME})(${skippable('Do you want to')}${DIALOG_GAP}(?:`
  + `(?<proceed>${skippable('proceed?')})`
  + `|(?<fetch>${skippable('allow Claude to fetch')}(?:${DIALOG_GAP}(?<fetchThis>${skippable('this')})(?:${DIALOG_GAP}(?<fetchContent>${skippable('content?')}))?)?)`
  + `|(?<edit>${DIALOG_EDIT_VERBS.map((v) => skippable(v.verb)).join('|')})(?:${DIALOG_GAP}(?<file>\\S[^?]*\\?))?`
  + '))',
  'g',
);
const DIALOG_OPTION_RE = new RegExp(
  `^${DIALOG_FRAME}*(?<cursor>[❯${SKIPPED_CELL}])${DIALOG_GAP}(?<one>[1${SKIPPED_CELL}])[.${SKIPPED_CELL}]?${DIALOG_GAP}`
  + `(?<yes>[Y${SKIPPED_CELL}][e${SKIPPED_CELL}][s${SKIPPED_CELL}])(?![A-Za-z0-9_])`,
);
const DIALOG_BLANK_RE = new RegExp(`^${DIALOG_FRAME}*$`);
const DIALOG_FILENAME_RE = new RegExp(`^${DIALOG_FRAME}*(\\S[^?]*\\?)`);

/** A completed row as the dialog scan reads it: escapes stripped, each skipped cell kept as SKIPPED_CELL. */
function dialogRowText(row: string): string {
  if (!row.includes('\u001b')) return row;
  return row
    .replace(CURSOR_FORWARD_G, (_, n: string) => {
      const cells = Number(n) || 1;
      return cells > MAX_SKIPPED_RUN ? '' : SKIPPED_CELL.repeat(cells);
    })
    .replace(ANSI_STRIP, '');
}

/** Characters actually drawn: no whitespace, no skipped cells. */
function drawnLength(text: string): number {
  return text.replace(/[\s￿]/g, '').length;
}

/** Cheap pre-check: a question row keeps at least one of these words whole. */
function mayHoldDialogQuestion(row: string): boolean {
  return row.includes('want') || row.includes('proceed');
}

/**
 * The question a DIALOG_QUESTION_RE match stands for, spelled out in full, or
 * null when too many letters of its fixed words were skipped. The full
 * spelling is also the emission dedup value, so a partial redraw of the same
 * question cannot count as a new one.
 */
function dialogQuestionText(m: RegExpExecArray): string | null {
  const g = m.groups ?? {};
  let words: string;
  if (g.proceed !== undefined) words = 'proceed?';
  else if (g.fetch !== undefined) {
    words = 'allow Claude to fetch';
    if (g.fetchThis !== undefined) words += g.fetchContent !== undefined ? ' this content?' : ' this';
  } else {
    const verb = DIALOG_EDIT_VERBS.find((v) => v.re.test(g.edit ?? ''));
    if (!verb) return null;
    words = verb.verb;
  }
  const canonical = `Do you want to ${words}`;
  const file = g.file ?? '';
  const missing = drawnLength(canonical) - (drawnLength(m[1]) - drawnLength(file));
  if (missing > MAX_SKIPPED_QUESTION_LETTERS) return null;
  return file ? `${canonical} ${file.replace(SKIPPED_CELL_G, '')}` : canonical;
}

/** Whether `row` (from its start) is the dialog's first option, `❯ 1. Yes`. */
function isDialogOption(row: string): boolean {
  const g = DIALOG_OPTION_RE.exec(row)?.groups;
  if (!g) return false;
  return 5 - drawnLength(`${g.cursor}${g.one}${g.yes}`) <= MAX_SKIPPED_OPTION_CELLS;
}
/**
 * Claude Code's answer to an interrupted turn, as its own tool-result row:
 * `  ⎿  Interrupted · What should Claude do instead?`. Read as a row by
 * scanDialog, the same way as the dialog question: live, the row usually
 * replaces a tool row that already showed `⎿`, so the diff skips the gutter
 * with `CSI n C` and only the sentence is written (Claude Code 2.1.301). The
 * gutter therefore counts drawn or skipped, but something must stand before
 * the sentence, so a reply row that starts with it does not match.
 */
const INTERRUPTED_SENTENCE = 'Interrupted · What should Claude do instead?';
const CLAUDE_INTERRUPTED_ROW = new RegExp(
  `^[\\s${SKIPPED_CELL}]*[⎿${SKIPPED_CELL}]${DIALOG_GAP}(${skippable(INTERRUPTED_SENTENCE)})[\\s${SKIPPED_CELL}]*$`,
);
/** Whether a dialogRowText row is the interrupted-turn row. */
function isInterruptedRow(row: string): boolean {
  const m = CLAUDE_INTERRUPTED_ROW.exec(row);
  return m !== null && drawnLength(INTERRUPTED_SENTENCE) - drawnLength(m[1]) <= MAX_SKIPPED_QUESTION_LETTERS;
}
const ROW_BREAK_G = new RegExp(ROW_BREAK_RE.source, 'g');
/** Longest incomplete row the dialog scan carries between chunks. */
const MAX_DIALOG_ROW = 4096;
interface DialogQuestion {
  text: string;
  /** A `proceed?` or WebFetch question ("Approval requested"), not a file edit. */
  proceed: boolean;
  /** `make this edit to` wrapped before its filename, or the fetch question before its end. */
  needsFilename: boolean;
  /** The whole-line pass emitted an approval in the feed that drew this row. */
  reported: boolean;
}

function stripAnsi(line: string): string {
  return line.includes('\u001b') ? line.replace(ANSI_STRIP, '') : line;
}

function visibleChrome(line: string): string {
  return stripAnsi(line).replace(CHROME_NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** OSC title, or a line whose visible text *starts* with `Claude Code`. */
function isClaudeBannerChrome(line: string): boolean {
  // OSC titles intentionally contain ESC and BEL delimiters.
  // eslint-disable-next-line no-control-regex
  if (/\x1b\]0;[^\x07]*(?<!Open)(?<!Open\s)Claude/.test(line)) return true;
  const stripped = stripAnsi(line);
  if (SOURCE_LINE_RE.test(stripped)) return false;
  const v = visibleChrome(stripped);
  // Prefix, not substring: btop's `3304  Claude Code  43%` must not count.
  // Suffix is allowed (`Claude Code starting`, `Claude Code v2.1.172`).
  return /^Claude\s*Code\b/i.test(v);
}

/**
 * The splash line Claude Code draws at launch: its logo glyphs and the
 * versioned product name on ONE row (` ▐▛███▛█   Claude Code v2.1.274`).
 *
 * #1392 — the compound gate's prompt signal is the permission footer
 * (`bypass permissions on` / `shift+tab to cycle`), which a pane started with
 * `--permission-mode default` never draws, so such a pane was never detected
 * at all. The splash is product chrome no other source prints in this shape:
 * a btop row has no logo, a README or changelog line quoting the version has
 * no logo, and `claude --version` prints `2.1.274 (Claude Code)`. It therefore
 * stands in for both signals. The glyph requirement is what keeps the plain
 * `Claude Code v2.1.172` banner line — which agents working this repo print
 * from source, and which #850's tests feed as banner-only — from opening the
 * gate on its own.
 */
// Whitespace is dropped before the test, not made optional: Claude Code paints
// the row with cursor moves (` ▐ ESC[48;2;0;0;0m ▛███▛█ ESC[12G ESC[1m Claude
// Code ESC[24G v2.1.274` on 2.1.274), so after the ANSI strip the glyphs and
// the name may touch with no space at all.
// The whole Block Elements range, not the six glyphs of one build: a future
// logo drawn with other shades must not reopen this gap.
const CLAUDE_SPLASH_RE = /[\u2580-\u259f]+ClaudeCodev\d+\.\d+/;
function isClaudeSplashLine(line: string): boolean {
  const stripped = stripAnsi(line);
  if (SOURCE_LINE_RE.test(stripped)) return false;
  return CLAUDE_SPLASH_RE.test(stripped.replace(/\s+/g, ''));
}

/** Idle-footer fragment that is not a source/comment/regex dump of that fragment. */
function isClaudePromptChrome(line: string): boolean {
  const stripped = stripAnsi(line);
  if (!CLAUDE_PROMPT_RE.test(stripped)) return false;
  return !SOURCE_LINE_RE.test(stripped);
}

/**
 * The Codex TUI's own chrome: the banner row (`│ >_ OpenAI Codex (v0.149.1) │`,
 * measured on 0.149.1) or the first-boot trust prompt (either wording), which
 * Codex draws before the banner. Both must START the row's visible text, so a shell
 * command, a log line or prose that quotes either phrase does not count.
 */
function isCodexChrome(line: string): boolean {
  const stripped = stripAnsi(line);
  if (SOURCE_LINE_RE.test(stripped)) return false;
  const v = visibleChrome(stripped);
  return /^>_\s*OpenAI\s*Codex\b/.test(v)
    || /^Do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*directory\?/.test(v)
    // 0.162.1 explains on the same row; the bare question is also Kimi's.
    || /^Trust\s*this\s*folder\?(?:\s*Codex(?:\s*can|$)|$)/.test(v);
}

/**
 * Qwen Code's own chrome (0.26.1 live capture): its window title, `Qwen -
 * <folder>`, set at launch and again with a status glyph (`◐︎ Qwen - proj`) as
 * each turn starts and ends; or its banner row, `│ >_ Qwen Code (v0.26.1) │`,
 * which, like the Codex banner, must be the row's whole visible text once the
 * logo and frame are stripped. The banner leaves the screen once the
 * transcript outgrows it; the title does not. Qwen pads the title with spaces
 * to 80 columns, which a shell or editor title that merely starts `Qwen - `
 * (`vim 'Qwen - notes.md'`) does not.
 */
function isQwenChrome(line: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/\x1b\][02];(?:\S{1,3} )?Qwen - [^\x07\x1b\r\n]{1,160}? {2,}(?:\x07|\x1b\\)/.test(line)) return true;
  const stripped = stripAnsi(line);
  if (SOURCE_LINE_RE.test(stripped)) return false;
  return /^>_\s*Qwen\s*Code\s*\(v\d+\.\d+\.\d+[\w.+-]*\)$/.test(visibleChrome(stripped));
}

/**
 * The Gemini CLI's own chrome, as opposed to a row that merely names Gemini.
 * From the upstream TUI (packages/cli/src/ui/components, read 2026-10-18):
 *   - the empty composer's placeholder, `>   Type your message or
 *     @path/to/file` (voice mode: `… or hold space to talk (Esc to exit)`),
 *     redrawn whenever the composer is empty — the one row every session
 *     shows, in every footer configuration;
 *   - the footer's model column with the context display beside it:
 *     `gemini-2.5-pro 12% used`, `gemini-2.5-pro 12%`, or the older
 *     `gemini-2.5-pro (88% context left)`. The percentage is hidden by
 *     default and the model may read `auto`, so this is a second chance,
 *     not the main one;
 *   - the update notice, `Gemini CLI update available …`.
 * A row that STARTS with `Gemini CLI` is not enough: a Claude reply's table
 * (`│ Gemini CLI │ Google │`) or wrapped prose begins the same way once the
 * frame is stripped, and those rows are the bug this check exists to stop.
 */
function isGeminiChrome(line: string): boolean {
  const stripped = stripAnsi(line);
  if (SOURCE_LINE_RE.test(stripped)) return false;
  const v = visibleChrome(stripped);
  // `\s*` between the words: a cursor-drawn row loses its spaces after the
  // strip (the same reason CLAUDE_PROMPT_RE and the Kiro check allow it).
  return /^[>!*]?\s*Type\s*your\s*message\s*or\s*(?:@path\/to\/file|(?:hold\s*)?space\s*to\s*talk)/.test(v)
    || isGeminiFooterRow(line)
    || /^Gemini CLI update available/.test(v);
}

/**
 * The Gemini footer row, read as the whole row rather than through
 * `visibleChrome()`, which turns a table's column rules into spaces: a
 * Claude reply's `│ gemini-2.5-pro │ 63% │` then reads exactly like the
 * footer. Upstream (Footer.tsx, read 2026-10-18) draws one unframed row of
 * columns separated by padding or ` · ` — workspace, branch, sandbox, then
 * the model column with the context display beside it — and never a
 * vertical rule. So the row must:
 *   - hold no vertical rule anywhere (`│ ┃ ║ |`): a table row is not a footer;
 *   - have a column before the model, set off by a column gap (two or more
 *     spaces, or ` · `), not a word of prose (`ran with gemini-2.5-pro 95%`);
 *   - end with the context display right after the model:
 *     `gemini-2.5-pro   12% used`, `gemini-2.5-pro · 12%`, or the older
 *     `gemini-2.5-pro (88% context left)`.
 * A cursor-forward move counts as the spaces it skips, so a row drawn with
 * cursor moves keeps its gaps.
 */
function isGeminiFooterRow(line: string): boolean {
  // eslint-disable-next-line no-control-regex
  const row = stripAnsi(line.replace(/\u001b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n || '1'), 8))))
    .replace(/[\r\n]/g, '')
    .trimEnd();
  if (/[│┃║|]/.test(row)) return false;
  return /\S(?: {2,}| · )gemini-\d[\w.-]*(?: +·)? +(?:\d+%(?: +used)?|\(\d+% *context *left\))$/i.test(row);
}

/** Existing Aider startup fixtures carry its version on a row of its own. */
function isAiderChrome(line: string): boolean {
  return /^aider v\d+\.\d+\.\d+(?:[\w.+-]*)?$/i.test(visibleChrome(line));
}

/** agy 1.2.13 live-capture shapes, including the block-glyph version logo. */
function isAntigravityChrome(line: string): boolean {
  const v = visibleChrome(line);
  return /^Antigravity\s*CLI\s+\d+\.\d+\.\d+(?:[\w.+-]*)?$/.test(v)
    || /^Welcome\s+to\s+the\s+Antigravity\s*CLI\.(?:\s+You\s+are\s+currently\s+not\s+signed\s+in\.)?$/.test(v);
}

/**
 * Native titles, not a visible product-name mention. Source shape verified in
 * anomalyco/opencode packages/tui/src/app.tsx (2026-10-19): home uses OpenCode,
 * a named session uses OC | <title>. Both OSC title selectors/terminators are
 * accepted; local 1.18.30 --pure startup emitted OSC 0 / BEL with OpenCode.
 * An unfinished OSC is not evidence. Title-disabled sessions need
 * hook/process identity instead of guessing from documentation on screen.
 */
function isOpenCodeChrome(line: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\x1b\][02];(?:OpenCode|OC \| [^\x07\x1b\r\n]{1,160})(?:\x07|\x1b\\)/.test(line);
}

/**
 * Pi's native title, `π - <cwd basename>` or `π - <session> - <cwd basename>`
 * (pi 1.4.0 interactive-mode setTitle, OSC 0 / BEL in the live capture). The
 * basename is empty at `/` or a drive root, and a session name has no length
 * bound. Both OSC title selectors and terminators are accepted; an unfinished
 * OSC or the same words as visible text are not evidence.
 */
function isPiChrome(line: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\x1b\][02];π - [^\x07\x1b\r\n]*(?:\x07|\x1b\\)/.test(line);
}

/**
 * Welcome rows documented by github/gh-copilot's README and
 * github/copilot-cli's changelog. Command echoes (`gh copilot`, `copilot-cli`)
 * are not provider output. Keep the optional historical `in the` spelling.
 */
function isCopilotChrome(line: string): boolean {
  return /^Welcome\s+to\s+GitHub\s+Copilot\s+(?:in\s+the\s+)?CLI!?$/.test(visibleChrome(line));
}

/**
 * #1610 — whether an output chunk draws the Codex banner row
 * (`│ >_ OpenAI Codex (v…) │`). Codex prints it once per session boot (launch,
 * resume, `/new`), with or without a prompt, and on both the plain and the
 * `--remote` TUI. The caller must check the pane is Codex-owned: another
 * agent's reply can print the same row.
 */
export function drawsCodexBanner(chunk: string): boolean {
  if (!chunk.includes('OpenAI')) return false;
  return candidateLines(chunk).some((line) => {
    const stripped = stripAnsi(line);
    return !SOURCE_LINE_RE.test(stripped) && /^>_\s*OpenAI\s*Codex\b/.test(visibleChrome(stripped));
  });
}

function isGrokChrome(line: string): boolean {
  const stripped = stripAnsi(line);
  const v = visibleChrome(stripped);
  if (/^Grok\s+\d+(?:\.\d+)?\s+is here/i.test(v)) return true;
  if (/Help improve Grok/i.test(v) && /\[Opt\s+(?:out|in)\]/i.test(v)) {
    return !SOURCE_LINE_RE.test(stripped);
  }
  if (/Select ['\u2018\u2019]Grok/i.test(v)) {
    return !SOURCE_LINE_RE.test(stripped);
  }
  // Live composer, 2026-08-16: `╰──── Grok 4.6 (high) · always-approve ─╯`
  // Require the box so a source comment quoting the phrase does not match.
  if (
    /Grok\s+\d+(?:\.\d+)?\s+\([^)]+\)/i.test(v)
    && /always-approve/i.test(v)
    && /[╰╯─]/.test(stripped)
    && !SOURCE_LINE_RE.test(stripped)
  ) {
    return true;
  }
  return false;
}

/** OSC 133 prompt start / command end: the shell has the terminal again. */
// eslint-disable-next-line no-control-regex
const SHELL_RETURN_RE = /\u001b\]133;([AD])(?:;[^\u0007\u001b]{0,256})?(?:\u0007|\u001b\\)/g;
/** The same, and the command start (C) that hands the terminal to a program (launchBoundaries). */
// eslint-disable-next-line no-control-regex
const LAUNCH_BOUNDARY_RE = /\u001b\]133;([ACD])(?:;[^\u0007\u001b]{0,256})?(?:\u0007|\u001b\\)/g;
/** A read ending inside one of those markers: held until the next read completes it. */
// eslint-disable-next-line no-control-regex
const PARTIAL_SHELL_RETURN_RE = /^\u001b\]133;(?:[AD](?:;[^\u0007\u001b]{0,256})?)?(?:\u001b)?$/;
// eslint-disable-next-line no-control-regex
const PARTIAL_LAUNCH_BOUNDARY_RE = /^\u001b\]133;(?:[ACD](?:;[^\u0007\u001b]{0,256})?)?(?:\u001b)?$/;

export class AgentDetector {
  /**
   * #2673 — the detector ends the pane's agent at every OSC 133 command start
   * and command end itself, where each sits in the stream, instead of its
   * owner doing it once the whole read has been seen. The daemon's bridge
   * sets it: it ends the agent on those markers anyway, and doing it after the
   * read wiped the gate a splash later in the same read had just opened.
   */
  private readonly launchBoundaries: boolean;

  constructor(options: { launchBoundaries?: boolean } = {}) {
    this.launchBoundaries = options.launchBoundaries === true;
  }

  private callbacks: AgentEventCallback[] = [];
  private criticalCallbacks: CriticalEventCallback[] = [];
  private usageLimitCallbacks: UsageLimitLineCallback[] = [];
  // Reported on every sighting: the row stays in the transcript, so a redraw
  // prints it again, and consumers tell a fresh one apart by the Escape that
  // must precede it (idleSuppression.recentlyEscaped). A dedup here would let a
  // redrawn old row use up the report the real interrupt needs.
  private interruptedCallbacks: InterruptedCallback[] = [];
  // The owner's approvalReady question became ready: see takeApprovalRecheckRequest.
  private approvalRecheckRequested = false;
  // approvalReady questions whose question row was drawn, and those whose
  // finishing row followed it, since the screen was last invalidated.
  private approvalArmed = new Set<string>();
  private approvalReadySlugs = new Set<AgentSlug>();
  // An identity change kept the approval evidence, and no question has been
  // drawn since: the next seed drops it unless its profile has approvalReady.
  private approvalEvidenceRetired = false;
  private codexLimitScanner = new CodexUsageLimitLineScanner();
  private lineBuffer = '';
  /** Incomplete OSC 133 boundary, bounded to a short shell payload. */
  private shellBoundaryBuffer = '';
  // Per (agent:status) dedup: stores the last matched string for each key.
  // Same key + same match = skip emit. New active cycle calls
  // resetEmissionState() to clear, so turn N+1 can emit again even when the
  // prompt text is identical to turn N.
  private lastEmittedFor = new Map<string, string>();
  // Critical lines this pane reported, by label + matched line → when. Not
  // cleared by resetEmissionState(): a redraw starts a new activity cycle too.
  // Insertion order is emit order (a re-emit moves its key to the end).
  private criticalSeen = new Map<string, number>();
  // Track which agents have been "gated" (confirmed active) in this session
  private activeAgents = new Set<string>();
  // Pattern owner: screen-confirmed or explicitly seeded from fresh external
  // identity. External identity alone must never become screen evidence.
  private lastAgent: string | null = null;
  private lastScreenAgent: string | null = null;
  private trustedAgent: AgentSlug | null = null;
  private identityEpoch = 0;
  private identityBoundaryAt = 0;
  private approvalOutputRevision = 0;
  private approvalScreenGeneration = 0;
  private approvalHintTail = '';
  private approvalHintAt: number | null = null;
  private approvalRecheckEpoch: number | null = null;
  // The owner's approvalReady question's own recheck (see `shared`).
  private approvalReadyRecheckEpoch: number | null = null;
  // Kiro uses a compound gate so another agent merely mentioning "Kiro CLI"
  // cannot steal this PTY's identity. Evidence is scoped to this detector/PTy.
  private kiroChromeSeen = false;
  private kiroPromptSeen = false;
  private kiroPromptEvidence: string | null = null;
  // #850: Claude uses the same compound-gate pattern. A process monitor (btop)
  // showing "claude" in its process list must NOT open the gate — require both
  // the banner AND a Claude-specific prompt pattern before confirming identity.
  private claudeBannerSeen = false;
  private claudePromptSeen = false;
  private claudePromptEvidence: { text: string; status: AgentEventStatus; message: string } | null = null;
  // An OSC 133 prompt/command mark arrived since lastAgent took the pane: the
  // shell is drawing its prompt again, so the owning agent has exited. Agent
  // TUIs do not emit these mid-session (none in any replayed Claude buffer
  // after launch), which is what lets a substring gate switch the pane.
  private shellPromptSinceOwner = false;
  // #1494 dialog scan: the incomplete row carried to the next chunk, and a
  // question row still waiting for its option row (see DIALOG_QUESTION_RE).
  private dialogRow = '';
  private dialogQuestion: DialogQuestion | null = null;
  // The whole-line pass already reported an approval in this feed() call.
  private approvalEmittedInFeed = false;
  // A `frameTail` match waiting for its frame to end with nothing drawn after it.
  private frameTail: AgentEvent & { value: string } | null = null;

  /**
   * Register a callback for agent status events.
   * Returns an unsubscribe function. Callers MUST invoke it on disposal to
   * prevent listener accumulation across PTY lifecycles (the same pattern as
   * ActivityMonitor.onActiveToIdle / .onActive).
   */
  onEvent(callback: AgentEventCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }

  /**
   * Subscribe to critical-pattern hits. NOTIFY-ONLY, permanently.
   *
   * These fire on PTY OUTPUT, not on a pending action: nothing is blocked,
   * nothing is waiting, and there is no addressee for an answer — a keystroke
   * sent "in reply" would type into whatever is currently running. A line the
   * pane already reported is dropped for CRITICAL_REPEAT_WINDOW_MS, so a
   * consumer cannot even count them reliably.
   *
   * Anything a human ANSWERS gates on the hook-sourced `awaiting_input`
   * signal instead (`src/daemon/approvals/` — real request identity, a
   * lifecycle, and the agent's own envelope). See issue #605.
   */
  onCritical(callback: CriticalEventCallback): () => void {
    this.criticalCallbacks.push(callback);
    return () => {
      const idx = this.criticalCallbacks.indexOf(callback);
      if (idx >= 0) this.criticalCallbacks.splice(idx, 1);
    };
  }

  /**
   * Subscribe to a Codex pane's usage-limit row. Codex has no turn-failure
   * hook, so its screen is the only source; Claude Code's limit arrives as a
   * StopFailure hook instead and is never read off the screen here.
   */
  onUsageLimit(callback: UsageLimitLineCallback): () => void {
    this.usageLimitCallbacks.push(callback);
    return () => {
      const idx = this.usageLimitCallbacks.indexOf(callback);
      if (idx >= 0) this.usageLimitCallbacks.splice(idx, 1);
    };
  }

  /**
   * Subscribe to the agent's own "turn interrupted" row. Claude Code fires no
   * Stop hook for an interrupted turn, so this row and the keystroke that
   * caused it are the only evidence the turn is over.
   */
  onInterrupted(callback: InterruptedCallback): () => void {
    this.interruptedCallbacks.push(callback);
    return () => {
      const idx = this.interruptedCallbacks.indexOf(callback);
      if (idx >= 0) this.interruptedCallbacks.splice(idx, 1);
    };
  }

  /** Profile activation history, including explicit trusted identity seeds. */
  getActiveAgents(): string[] {
    return Array.from(this.activeAgents);
  }

  /** Most recent screen-confirmed name; a trusted seed alone returns null. */
  getLastAgent(): string | null {
    return this.lastScreenAgent;
  }

  /** External identity is separate from screen provenance and turn state. */
  getTrustedAgent(): AgentSlug | null {
    return this.trustedAgent;
  }

  /** Capture before an asynchronous process probe; stale results cannot seed. */
  getIdentityEpoch(): number {
    return this.identityEpoch;
  }

  /** Reject hook timestamps at/before this boundary, in addition to epoch checks. */
  getIdentityBoundaryAt(): number {
    return this.identityBoundaryAt;
  }

  /**
   * Activate only prompt parsing for a fresh, verified process/hook identity.
   * The caller must establish provenance and freshness (including hook event
   * time after getIdentityBoundaryAt), never use cached metadata or a TTL.
   * This method does not infer running, completion, or even an Agent started
   * event from process presence. Unsupported profiles and stale epochs fail
   * without changing the current owner. Repeated same-owner evidence is a
   * no-op so a pending dialog and emission dedup survive repeated probes.
   */
  seedTrustedIdentity(slug: AgentSlug, expectedEpoch: number): boolean {
    if (expectedEpoch !== this.identityEpoch) return false;
    const profile = PROFILE_BY_SLUG.get(slug);
    if (!profile) return false;
    if (this.trustedAgent === slug && !this.shellPromptSinceOwner) return true;

    const sameOwner = this.lastAgent === profile.agent && !this.shellPromptSinceOwner;
    if (!sameOwner) {
      if (this.lastAgent !== null && this.lastAgent !== profile.agent) {
        this.advanceIdentityBoundary();
        this.retireApprovalScreen();
      }
      this.resetLaunchEvidence();
      this.lastScreenAgent = null;
    }
    // Evidence an identity change kept: a grid-only question this owner drew
    // before its seed is still read once ready; any other profile drops it.
    // A `shared` profile keeps it only for that question, once drawn.
    const ready = profile.approvalReady;
    if (this.approvalEvidenceRetired && !(ready && (!ready.shared || this.approvalArmed.has(slug)))) this.invalidateApprovalScreen();
    this.approvalEvidenceRetired = false;
    this.trustedAgent = slug;
    this.lastAgent = profile.agent;
    this.activeAgents.add(profile.agent);
    this.shellPromptSinceOwner = false;
    return true;
  }

  /** Confirmed death/disposal: revoke all launch identity, without an event. */
  clearTrustedIdentity(): void {
    this.retireApprovalScreen();
    this.advanceIdentityBoundary();
    this.trustedAgent = null;
    this.lastAgent = null;
    this.lastScreenAgent = null;
    this.activeAgents.clear();
    this.shellPromptSinceOwner = false;
    this.resetLaunchEvidence();
  }

  /** Input/resize makes the previous unanswered-looking grid unsafe to recover. */
  invalidateApprovalScreen(): void {
    this.approvalScreenGeneration++;
    this.approvalHintTail = '';
    this.approvalHintAt = null;
    this.approvalRecheckEpoch = null;
    this.approvalReadyRecheckEpoch = null;
    this.approvalRecheckRequested = false;
    this.approvalArmed = new Set();
    this.approvalReadySlugs = new Set();
    this.approvalEvidenceRetired = false;
  }

  /**
   * An identity change (its callers advance the identity epoch, which resets
   * the recheck): no read in flight may land, but the evidence, and output
   * drawn before the next seed, stays for that seed to judge.
   */
  private retireApprovalScreen(): void {
    this.approvalScreenGeneration++;
    this.approvalRecheckRequested = false;
    this.approvalEvidenceRetired = true;
    // A question the ending owner drew belongs to that lifetime: its next
    // launch must not inherit it half-drawn or ready.
    const ending = this.trustedAgent ?? AGENT_PATTERNS.find((ap) => ap.agent === this.lastAgent)?.slug;
    if (ending) {
      for (const key of this.approvalArmed) if (key === ending || key.startsWith(`${ending}:`)) this.approvalArmed.delete(key);
      this.approvalReadySlugs.delete(ending);
    }
  }

  /**
   * One bounded current-screen check after fresh identity arrives. The recent
   * raw hint only justifies a read; it is never replayed or treated as an
   * approval. Only a provider's interactive, current viewport may emit here,
   * and only awaiting_input. No gate, running, completion or critical path is
   * called. A busy renderer gets one fresh read after output overtakes it.
   */
  async revalidateApprovalScreen(read: () => Promise<ApprovalScreenSnapshot | null>): Promise<boolean> {
    const owner = this.trustedAgent;
    const profile = owner === null ? undefined : PROFILE_BY_SLUG.get(owner);
    const epoch = this.identityEpoch;
    const generation = this.approvalScreenGeneration;
    const fresh = (): boolean => this.approvalHintAt !== null
      && Date.now() >= this.approvalHintAt && Date.now() - this.approvalHintAt <= 30_000;
    if (!owner || !profile?.approvalScreen || !fresh()) return false;
    const readyRead = this.approvalReadySlugs.has(owner);
    // Not spent on half a question: the row that finishes it asks again.
    if (profile.approvalReady && !profile.approvalReady.shared && !readyRead) return false;
    if ((readyRead ? this.approvalReadyRecheckEpoch : this.approvalRecheckEpoch) === epoch) return false;
    if (readyRead) this.approvalReadyRecheckEpoch = epoch;
    else this.approvalRecheckEpoch = epoch;
    const owns = (): boolean => this.trustedAgent === owner && this.identityEpoch === epoch
      && this.approvalScreenGeneration === generation && !this.shellPromptSinceOwner && fresh();
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = this.approvalOutputRevision;
      let snapshot: ApprovalScreenSnapshot | null;
      try { snapshot = await read(); } catch { return false; }
      if (!owns()) return false;
      if (revision !== this.approvalOutputRevision) continue;
      if (!snapshot || !snapshot.isCurrent()) return false;
      const approval = profile.approvalScreen(snapshot.rows);
      if (!approval) return false;
      const key = `${profile.agent}:awaiting_input`;
      // Whitespace-insensitive, like emitDialog's stored value.
      if (this.lastEmittedFor.get(key)?.replace(/\s+/g, '') === approval.text.replace(/\s+/g, '')) return false;
      this.lastEmittedFor.set(key, approval.text);
      for (const cb of this.callbacks) cb({ agent: profile.agent, status: 'awaiting_input', message: approval.message });
      return true;
    }
    return false;
  }

  private advanceIdentityBoundary(): void {
    this.identityEpoch++;
    // Keep time monotonic if the wall clock moves backwards. Epoch is the
    // authority for process probes; hook timestamps additionally use this.
    this.identityBoundaryAt = Math.max(this.identityBoundaryAt, Date.now());
  }

  /**
   * Clear emission dedup state. Called by PTYBridge on a new ActivityMonitor
   * active cycle so the agent's next idle prompt (turn N+1) can emit even
   * when its text is identical to the previous turn.
   */
  resetEmissionState(): void {
    this.lastEmittedFor.clear();
  }

  /**
   * Whether a critical line may fire now: not reported by this pane within
   * CRITICAL_REPEAT_WINDOW_MS. Records it when it may. Expired entries are
   * dropped from the front, and past CRITICAL_SEEN_MAX the oldest go too.
   */
  private admitCritical(key: string): boolean {
    const now = Date.now();
    // A time ahead of the clock (it was set back) counts as expired.
    const fresh = (at: number): boolean => at <= now && now - at < CRITICAL_REPEAT_WINDOW_MS;
    const last = this.criticalSeen.get(key);
    if (last !== undefined && fresh(last)) return false;
    this.criticalSeen.delete(key);
    this.criticalSeen.set(key, now);
    for (const [k, at] of this.criticalSeen) {
      if (this.criticalSeen.size <= CRITICAL_SEEN_MAX && fresh(at)) break;
      this.criticalSeen.delete(k);
    }
    return true;
  }

  feed(data: string): void {
    if (data) this.approvalOutputRevision++;
    const text = this.shellBoundaryBuffer + data;
    this.shellBoundaryBuffer = '';
    // Process each launch in wire order, even when a PTY read contains both
    // the old agent's last frame and the new agent's banner. OSC may itself
    // span reads; neither a chunk boundary nor an unterminated marker is a
    // shell return. Support both OSC terminators.
    const boundary = new RegExp(this.launchBoundaries ? LAUNCH_BOUNDARY_RE : SHELL_RETURN_RE);
    let start = 0;
    for (let match = boundary.exec(text); match; match = boundary.exec(text)) {
      this.feedOutput(text.slice(start, match.index));
      const kind = match[1];
      if (kind !== 'C') this.noteShellReturn();
      // The foreground program changed hands here: a launch starts (C) or the
      // shell has the terminal back (D).
      if (this.launchBoundaries && kind !== 'A') this.clearTrustedIdentity();
      start = match.index + match[0].length;
    }
    const rest = text.slice(start);
    const oscAt = rest.lastIndexOf('\u001b]');
    const candidate = oscAt < 0 ? '' : rest.slice(oscAt);
    // Only hold a prefix that can still become our marker. Other escapes
    // (including agent titles) remain available to the detector immediately.
    const partialBoundary = this.launchBoundaries ? PARTIAL_LAUNCH_BOUNDARY_RE : PARTIAL_SHELL_RETURN_RE;
    const holdAt = candidate && ('\u001b]133;'.startsWith(candidate) || partialBoundary.test(candidate))
      ? oscAt : rest.endsWith('\u001b') ? rest.length - 1 : rest.length;
    this.shellBoundaryBuffer = rest.slice(holdAt);
    this.feedOutput(rest.slice(0, holdAt));
  }

  /**
   * Whether the output fed since the last call finished a grid-only question
   * on a pane whose owner's one recheck is still unused (approvalReady).
   * The host calls this once the same output is on the screen it reads, and
   * answers true with revalidateApprovalScreen. Reading clears the request.
   */
  takeApprovalRecheckRequest(): boolean {
    const requested = this.approvalRecheckRequested;
    this.approvalRecheckRequested = false;
    return requested;
  }

  private noteShellReturn(): void {
    this.invalidateApprovalScreen();
    this.advanceIdentityBoundary();
    this.trustedAgent = null;
    if (this.lastAgent !== null) this.shellPromptSinceOwner = true;
    this.resetLaunchEvidence();
  }

  private resetLaunchEvidence(): void {
    this.resetEmissionState();
    // activeAgents is detection history, not evidence that an earlier
    // launch owns the pane. Compound gates and unfinished dialogs must be
    // established again, including when the same agent starts again.
    this.claudeBannerSeen = false;
    this.claudePromptSeen = false;
    this.claudePromptEvidence = null;
    this.kiroChromeSeen = false;
    this.kiroPromptSeen = false;
    this.kiroPromptEvidence = null;
    this.lineBuffer = '';
    this.dialogRow = '';
    this.dialogQuestion = null;
    this.approvalEmittedInFeed = false;
    this.frameTail = null;
    this.codexLimitScanner = new CodexUsageLimitLineScanner();
  }

  private feedOutput(data: string): void {
    if (!data) return;
    // An escape the last read cut short is not text yet: measured as text it
    // would push the boundary of newly drawn text past the row that finishes it.
    const previousLength = stripAnsi(this.approvalHintTail.replace(UNFINISHED_ESCAPE, '')).length;
    const probe = this.approvalHintTail + data;
    const cleanProbe = stripAnsi(probe);
    // Keep in step with the approvalReady questions (READY_PROFILES). The key
    // row ends every dialog of Claude Code's screen-reader layout, whose
    // AskUserQuestion asks in its own words.
    const hint = /Do[\s│]*you[\s│]*(?:want|trust)|Would\s*you\s*like|Allow\s*tool\s*use|Permission\s*required|Trust\s*project\s*folder|Allow\s*execution\s*of:|Apply\s*this\s*change\?|Trust\s*this\s*folder|Is\s*this\s*a\s*project\s*you\s*created|Select\s*with\s*numbers|Enter\s*y\/n:/g;
    for (const match of cleanProbe.matchAll(hint)) {
      // Only newly drawn text refreshes freshness. Retaining an old question
      // in the tail across a title update must not make it recent again.
      if (match.index + match[0].length > previousLength) {
        this.approvalHintAt = Date.now();
        // A question drawn after an identity change belongs to whoever owns
        // the pane next: the next seed keeps it, as before the change.
        this.approvalEvidenceRetired = false;
      }
    }
    // Readiness reads only the newly drawn text, with room for a match that
    // began just before it; positions below are relative to `recentAt`.
    let readyForOwner = false;
    const recentAt = Math.max(0, previousLength - READY_MATCH_REACH);
    const recent = cleanProbe.slice(recentAt);
    const drawnAfter = previousLength - recentAt;
    for (const { key, slug, question, end } of READY_PROFILES) {
      // An end counts only after its question: from 0 once that one is armed.
      let from = this.approvalArmed.has(key) ? 0 : -1;
      for (const match of recent.matchAll(question)) {
        if (match.index + match[0].length <= drawnAfter) continue;
        from = match.index + match[0].length;
        this.approvalArmed.add(key);
        this.approvalReadySlugs.delete(slug);
      }
      if (from < 0) continue;
      for (const match of recent.matchAll(end)) {
        if (match.index < from || match.index + match[0].length <= drawnAfter) continue;
        this.approvalReadySlugs.add(slug);
        if (slug === this.trustedAgent && this.approvalReadyRecheckEpoch !== this.identityEpoch) readyForOwner = true;
      }
    }
    this.approvalHintTail = probe.slice(-4096);
    this.lineBuffer += data;
    if (this.lineBuffer.length > MAX_BUFFER) {
      // A CUP-only screen never shortens the buffer, so one read can bury a
      // title written once (Pi, `--continue` at 300x90: 26 KB of frame right
      // after it). The gates see the dropped part first, and the cut does not
      // split an OSC: one begun shortly before it and unterminated there is
      // kept whole (a longer one is no title and may be cut).
      let cut = this.lineBuffer.length - MAX_BUFFER;
      const osc = this.lineBuffer.lastIndexOf('\u001b]', cut - 1);
      const split = osc < 0 ? '' : this.lineBuffer.slice(osc + 2, cut);
      if (osc >= 0 && osc >= cut - MAX_OSC_KEPT && !split.includes('\u0007') && !split.includes('\u001b\\')) cut = osc;
      if (cut > 0) this.checkGates(this.lineBuffer.slice(0, cut));
      this.lineBuffer = this.lineBuffer.slice(cut);
    }
    // Split on both LF and lone CR. TUI footers (Claude, Codex) redraw the
    // same line using CR without a following LF; without this split the
    // entire redraw collapses into one buffered string and patterns fail to
    // match line-anchored regexes. The owner is looked up per line: a gate
    // opened by one line decides how the next one ends.
    const buffer = this.lineBuffer;
    let start = 0;
    for (;;) {
      const rowEnd = this.lastAgent !== null && !this.shellPromptSinceOwner && FRAME_END_ROW_AGENTS.has(this.lastAgent)
        ? ROW_OR_FRAME_END_G : ROW_END_G;
      rowEnd.lastIndex = start;
      const m = rowEnd.exec(buffer);
      if (!m) break;
      this.processLine(buffer.slice(start, m.index));
      start = m.index + m[0].length;
      if (m[0].startsWith('\u001b')) this.flushFrameTail();
    }
    this.lineBuffer = buffer.slice(start);

    // 미완성 라인(아직 개행이 안 온 redraw)의 gate도 미리 검사한다. claude처럼
    // 시작 배너를 개행 없이 커서 이동으로 그리는 TUI는 "Claude Code vX"가
    // lineBuffer에 갇혀 라인 완성이 영영 안 될 수 있고, 그러면 gate가 chunk
    // 타이밍에 따라 가끔만 매칭돼 agentName 감지가 불안정해진다.
    // Visible-row chrome profiles still require a completed visual row:
    // a chunk ending at a banner-shaped prefix is not an identity signal.
    const tail = this.lineBuffer.replace(ANSI_STRIP, '').trim();
    if (tail) this.checkGates(tail);
    // Raw-tail gate check — see processLine: current Claude Code only carries
    // its name inside the OSC window-title escape, which the strip removes.
    if (this.lineBuffer) this.checkGates(this.lineBuffer);

    // Asked only when no line pattern reported the dialog in this read.
    if (readyForOwner && !this.approvalEmittedInFeed) this.approvalRecheckRequested = true;
    this.scanDialog(data);
  }

  /**
   * Walk the rows of Claude's output as each one completes (the next CR, LF
   * or CUP arrives), not when the whole line does. Judging a row at the time
   * it is drawn matters: a dialog row redrawn just before the user answered
   * can sit in an unfinished line until the post-answer clear completes it,
   * and reading it then re-raised the dialog after it was gone.
   */
  private scanDialog(data: string): void {
    const approvalEmitted = this.approvalEmittedInFeed;
    this.approvalEmittedInFeed = false;
    if (this.shellPromptSinceOwner || this.lastAgent !== 'Claude Code' || !this.activeAgents.has('Claude Code')) {
      this.dialogRow = '';
      this.dialogQuestion = null;
      return;
    }
    const rows = (this.dialogRow + data).split(ROW_BREAK_G);
    const tail = rows.pop() ?? '';
    this.dialogRow = tail.length > MAX_DIALOG_ROW ? tail.slice(-MAX_DIALOG_ROW) : tail;
    for (const row of rows) {
      // Reported on every sighting; see interruptedCallbacks.
      if (this.interruptedCallbacks.length > 0
        && (row.includes('Interrupted') || row.includes('instead'))
        && isInterruptedRow(dialogRowText(row).trim())) {
        for (const cb of this.interruptedCallbacks) cb({ agent: 'Claude Code' });
        continue;
      }
      if (!this.dialogQuestion && !mayHoldDialogQuestion(row)) continue;
      const clean = dialogRowText(row).trim();
      // Nothing drawn (or only skipped cells): a pending question waits on.
      if (drawnLength(clean) === 0) continue;
      const q = this.dialogQuestion;
      this.dialogQuestion = null;
      if (q) {
        if (!q.needsFilename && isDialogOption(clean)) {
          this.emitDialog(q);
          continue;
        }
        if (q.needsFilename) {
          const m = DIALOG_FILENAME_RE.exec(clean);
          if (m) {
            this.afterQuestion({ ...q, text: `${q.text} ${m[1].replace(SKIPPED_CELL_G, '')}`, needsFilename: false }, clean.slice(m[0].length));
            continue;
          }
        }
      }
      if (!mayHoldDialogQuestion(clean)) continue;
      let last: { match: RegExpExecArray; text: string } | null = null;
      DIALOG_QUESTION_RE.lastIndex = 0;
      for (let m = DIALOG_QUESTION_RE.exec(clean); m; m = DIALOG_QUESTION_RE.exec(clean)) {
        const text = dialogQuestionText(m);
        if (text !== null) last = { match: m, text };
      }
      if (!last) continue;
      const { match, text } = last;
      const groups = match.groups ?? {};
      this.afterQuestion(
        { text, proceed: groups.proceed !== undefined || groups.fetch !== undefined, needsFilename: !text.endsWith('?'), reported: approvalEmitted },
        clean.slice(match.index + match[0].length),
      );
    }
  }

  /** A question row was read; `rest` is what the row holds after it. */
  private afterQuestion(q: DialogQuestion, rest: string): void {
    if (DIALOG_BLANK_RE.test(rest)) {
      this.dialogQuestion = q;
    } else if (!q.needsFilename && isDialogOption(rest)) {
      this.emitDialog(q);
    }
  }

  private emitDialog(q: DialogQuestion): void {
    // The whole-line pass already reported this dialog in the feed that drew
    // its question; a second event with differently spaced text would only
    // repeat it.
    if (q.reported) return;
    const key = 'Claude Code:awaiting_input';
    const value = q.text.replace(/\s+/g, '');
    if (this.lastEmittedFor.get(key) === value) return;
    this.lastEmittedFor.set(key, value);
    for (const cb of this.callbacks) {
      cb({
        agent: 'Claude Code',
        status: 'awaiting_input',
        message: q.proceed ? 'Approval requested' : 'Edit approval requested',
      });
    }
  }

  /**
   * gate 매칭 → 에이전트 활성화 + 'running' 시작 이벤트 1회 emit + lastAgent
   * 설정. 라인 완성 여부와 무관하게 호출할 수 있도록 분리(feed의 미완성 라인
   * 검사와 processLine 양쪽에서 사용). activeAgents 가드로 세션당 1회만 발화.
   */
  private checkGates(clean: string, completeRow = false): void {
    // While external identity is authoritative, unrelated chrome cannot even
    // accumulate partial evidence for a later gate. Use the pattern owner for
    // this policy; it applies equally to every compound profile below.
    const canCollectChrome = (agent: string): boolean => this.trustedAgent === null || this.lastAgent === agent;
    // Kiro has no hook fallback, so identify its live TUI from two independent
    // pieces of chrome. Newer v3 builds show the docs URL instead of a "Kiro
    // CLI" banner; their cursor-drawn composer can also collapse whitespace in
    // the raw PTY stream. Probe only a bounded tail and only when a cheap
    // literal hint is present. Once Kiro is active this entire path is skipped.
    const kiroIsActive = this.activeAgents.has('Kiro CLI') && !this.shellPromptSinceOwner
      && (this.trustedAgent === null || this.lastScreenAgent === 'Kiro CLI');
    if (canCollectChrome('Kiro CLI')
      && !kiroIsActive && (!this.kiroChromeSeen || !this.kiroPromptSeen)) {
      const probe = clean.length > 4096 ? clean.slice(-4096) : clean;
      const mayContainChrome = !this.kiroChromeSeen && (
        probe.includes('kiro') ||
        probe.includes('Kiro') ||
        probe.includes('KIRO') ||
        probe.includes('Trust All Tools')
      );
      const mayContainPrompt = !this.kiroPromptSeen && (
        probe.includes('ask') || probe.includes('Ask')
      );

      if (mayContainChrome || mayContainPrompt) {
        // feed/processLine also call this with an ANSI-stripped candidate. Avoid
        // doing the regex replacement twice when this candidate is already clean.
        const evidenceLine = probe.includes('\u001b')
          ? probe.replace(ANSI_STRIP, '')
          : probe;
        const normalized = evidenceLine.trim();
        const lower = normalized.toLowerCase();

        if (
          mayContainChrome &&
          (lower.includes('kiro.dev/docs/cli/') || KIRO_CHROME_LINE.test(normalized))
        ) {
          this.kiroChromeSeen = true;
        }

        if (mayContainPrompt) {
          const promptStart = lower.lastIndexOf('ask');
          const compactPrompt = promptStart >= 0
            ? lower.slice(promptStart, promptStart + 96).replace(/\s+/g, '')
            : '';
          const promptMatch = normalized.match(KIRO_PROMPT_LINE);
          if (
            promptMatch ||
            compactPrompt.includes('askaquestionordescribeatask')
          ) {
            this.kiroPromptSeen = true;
            // When this is a normal complete line, retain the exact value the
            // ordinary pattern pass will see so its same-frame dedup hits. The
            // canonical fallback is only for cursor-concatenated evidence that
            // cannot match the line pattern later in processLine.
            this.kiroPromptEvidence = promptMatch?.[0]
              ?? 'ask a question or describe a task';
          }
        }
      }
    }

    // #850: Claude compound gate — same model as Kiro. Collect banner and
    // prompt evidence independently; gate opens only when both are present.
    const claudeIsActive = this.activeAgents.has('Claude Code') && !this.shellPromptSinceOwner
      && (this.trustedAgent === null || this.lastScreenAgent === 'Claude Code');
    if (canCollectChrome('Claude Code')
      && !claudeIsActive && (!this.claudeBannerSeen || !this.claudePromptSeen)) {
      // Bound the probe and gate it behind a cheap literal, then walk lines.
      // A blob-level `╭.*Claude` used to backtrack the whole 4 KB probe on
      // every full-screen TUI frame (btop); line-level chrome is both cheaper
      // and the thing that stops another agent from inheriting Claude's name.
      const probe = clean.length > 4096 ? clean.slice(-4096) : clean;
      const mayContainBanner = !this.claudeBannerSeen && (
        probe.includes('Claude') || probe.includes('claude')
      );
      const mayContainPrompt = !this.claudePromptSeen && (
        // Both spellings: the cursor-drawn footer collapses to
        // `bypasspermissionson` after the strip (see CLAUDE_PROMPT_RE), and
        // this prefilter runs on the stripped probe as well as the raw one.
        probe.includes('bypass permissions') || probe.includes('bypasspermissions') || probe.includes('shift+tab')
        || probe.includes('⏸')
      );
      // #1392 — the versioned splash satisfies both signals (see
      // isClaudeSplashLine). Its own prefilter, because the banner one is
      // switched off once an OSC title has named the pane, and the prompt one
      // only looks for footer words the default permission mode never draws.
      const mayContainSplash = !this.claudePromptSeen && probe.includes('Claude');

      if (mayContainBanner || mayContainPrompt || mayContainSplash) {
        for (const line of candidateLines(probe)) {
          if (mayContainSplash && !this.claudePromptSeen && isClaudeSplashLine(line)) {
            this.claudeBannerSeen = true;
            this.claudePromptSeen = true;
            continue;
          }
          if (mayContainBanner && !this.claudeBannerSeen && isClaudeBannerChrome(line)) {
            this.claudeBannerSeen = true;
          }
          if (mayContainPrompt && !this.claudePromptSeen && isClaudePromptChrome(line)) {
            const stripped = stripAnsi(line);
            const m = stripped.match(CLAUDE_PROMPT_RE);
            if (!m) continue;
            this.claudePromptSeen = true;
            // Store the value the ordinary pattern pass will produce, not this
            // regex's — same requirement the Kiro replay documents above.
            // CLAUDE_PROMPT_RE is an alternation and matches at the earliest
            // POSITION, while the pattern pass tries CLAUDE_PATTERNS in ARRAY
            // order. On a footer carrying both fragments with "shift+tab to
            // cycle" first, the two disagree and the same prompt emits two
            // 'waiting' events, because the dedup key is keyed on match text.
            // A footer no waiting pattern reads (the manual-mode one) opens the
            // gate without replaying a status.
            const replayText = CLAUDE_WAITING_PATTERNS
              .map((re) => stripped.match(re)?.[0])
              .find((t): t is string => t !== undefined);
            if (replayText === undefined) continue;
            this.claudePromptEvidence = {
              text: replayText,
              status: 'waiting',
              message: 'Ready for input',
            };
          }
        }
      }
    }

    for (const ap of AGENT_PATTERNS) {
      // Skip an already-seen gate within a launch, but reconsider it after
      // the shell returns: Claude -> Codex -> Claude must reclaim the pane.
      if (this.trustedAgent !== null && this.trustedAgent !== ap.slug) continue;
      const trustedOwner = this.trustedAgent === ap.slug;
      if (!ap.gate || (this.activeAgents.has(ap.agent) && !this.shellPromptSinceOwner
        && (!trustedOwner || this.lastScreenAgent === ap.agent))) continue;
      // Opening a gate makes its agent the lastAgent, and processLine then
      // skips every other agent's patterns for the rest of the session. The
      // compound gates (Claude, Kiro) and Grok's chrome may take a pane at any
      // time. Every other gate may take a pane another agent owns only after
      // the shell prompt has come back (OSC 133), i.e. the owner exited:
      // mid-session, an echoed command or a sentence naming an agent
      // ("Claude/OpenClaude", "opencode-sync-render") silenced a live Claude
      // pane's permission prompts. Codex is included — its banner row can be
      // reproduced by a Claude reply that wraps with `>_ OpenAI Codex` at the
      // start of a row (seen live when a Claude pane printed that line).
      // A fork may take its parent's pane (`takesOverFrom`).
      const blockedTakeover = this.lastAgent !== null && this.lastAgent !== ap.agent
        && !this.shellPromptSinceOwner
        && !ap.takesOverFrom?.some((slug) => AGENT_PATTERNS.find((other) => other.slug === slug)?.agent === this.lastAgent);
      const gateMatched = ap.slug === 'kiro'
        ? this.kiroChromeSeen && this.kiroPromptSeen
        : ap.slug === 'claude'
          ? this.claudeBannerSeen && this.claudePromptSeen
          : ap.slug === 'grok'
            ? candidateLines(clean).some(isGrokChrome)
            : ap.slug === 'codex'
              ? !blockedTakeover && ap.gate.test(clean) && candidateLines(clean).some(isCodexChrome)
              : !blockedTakeover && ap.gate.test(clean)
                && (!ap.chrome || (
                  // A version/welcome prefix can still grow into prose.
                  // Only judge these rows after LF/CR/CUP, never a PTY-read
                  // boundary. Native OSC chrome has its own terminator.
                  completeRow || !ap.completeChromeRow
                    ? candidateLines(clean)
                    : clean.split(new RegExp(ROW_BREAK_RE.source, 'g')).slice(0, -1)
                ).some(ap.chrome));
      if (!gateMatched) continue;

      if (this.shellPromptSinceOwner) this.resetEmissionState();
      this.activeAgents.add(ap.agent);
      this.lastAgent = ap.agent;
      this.lastScreenAgent = ap.agent;
      this.shellPromptSinceOwner = false;
      // The profile was already active from fresh external identity. Chrome
      // adds screen provenance, not another launch or a replayed prompt.
      if (trustedOwner) continue;
      for (const cb of this.callbacks) {
        cb({ agent: ap.agent, status: 'running', message: 'Agent started' });
      }
      // The two Kiro evidence lines may arrive in either order. If the
      // composer prompt arrived first, its normal pattern pass happened while
      // the gate was still closed. Replay the saved evidence once.
      if (ap.slug === 'kiro' && this.kiroPromptEvidence) {
        const key = `${ap.agent}:waiting`;
        const value = this.kiroPromptEvidence;
        if (this.lastEmittedFor.get(key) !== value) {
          this.lastEmittedFor.set(key, value);
          for (const cb of this.callbacks) {
            cb({ agent: ap.agent, status: 'waiting', message: 'Ready for input' });
          }
        }
      }
      // #850: same replay for Claude — if the prompt evidence arrived before
      // the banner, its normal pattern pass ran while the gate was still closed.
      if (ap.slug === 'claude' && this.claudePromptEvidence) {
        const ev = this.claudePromptEvidence;
        const key = `${ap.agent}:${ev.status}`;
        if (this.lastEmittedFor.get(key) !== ev.text) {
          this.lastEmittedFor.set(key, ev.text);
          for (const cb of this.callbacks) {
            cb({ agent: ap.agent, status: ev.status, message: ev.message });
          }
        }
      }
    }
  }

  /** The frame ended: report a held frame-tail match if its agent still owns the pane. */
  private flushFrameTail(): void {
    const tail = this.frameTail;
    this.frameTail = null;
    if (!tail || tail.agent !== this.lastAgent || this.shellPromptSinceOwner) return;
    const key = `${tail.agent}:${tail.status}`;
    if (this.lastEmittedFor.get(key) === tail.value) return;
    this.lastEmittedFor.set(key, tail.value);
    if (tail.status === 'awaiting_input') this.approvalEmittedInFeed = true;
    for (const cb of this.callbacks) cb({ agent: tail.agent, status: tail.status, message: tail.message });
  }

  private processLine(line: string): void {
    // RAW-line gate check BEFORE the empty-clean bail. Live incident
    // 2026-07-17 (Fable-era Claude Code): the TUI renders no visible
    // "Claude Code" text — the name only appears in the OSC 0 window-title
    // sequence (`ESC ]0;✳ Claude Code BEL`), which ANSI_STRIP removes
    // wholesale; a title-only line then strips to empty and used to return
    // before any gate check, leaving the gate permanently closed and every
    // Claude pattern (including approval awaiting_input) dead. Gates are
    // activation-only signals, so matching inside escape payloads is safe;
    // status patterns still run on cleaned lines only.
    this.checkGates(line, true);

    const clean = line.replace(ANSI_STRIP, '').trim();
    if (!clean) return;
    // A held frame-tail row was not the frame's last: another row followed it.
    this.frameTail = null;

    // Only on a pane Codex owns: another agent quoting the message (a review
    // of this very detector) must not hold its pane. The row regex is also
    // anchored at the line start.
    if (!this.shellPromptSinceOwner && this.usageLimitCallbacks.length > 0 &&
      (this.lastAgent === 'Codex CLI' || (this.lastAgent === null && this.activeAgents.has('Codex CLI')))) {
      const hit = this.codexLimitScanner.feed(clean);
      if (hit) for (const cb of this.usageLimitCallbacks) cb({ provider: 'codex', ...hit });
    }

    // Check critical patterns first
    const searchOrPrint = isSearchOrPrintLine(clean);
    let criticalMatched = false;
    for (const cp of CRITICAL_PATTERNS) {
      if (matchesCriticalPattern(cp, clean)) {
        criticalMatched = true;
        // The match is that command's argument: no other pattern on this line can run either.
        if (searchOrPrint) break;
        // Normalize ONCE, then cap: stripControls drops the C0 bytes that
        // survived ANSI_STRIP and collapses whitespace, and only the result is
        // sliced to 80 for the payload. Two lines that differ only by a tab or
        // other control byte collapse to one emission instead of both firing.
        // Normalizing before the cap also means the 80-char limit counts
        // visible characters, not control bytes. This string ends up in
        // notification bodies and on a phone. The dedup key takes the line
        // past 80 (bounded), so two long commands that differ late both fire.
        const line = stripControls(clean);
        const value = line.slice(0, 80);
        if (!this.admitCritical(`${cp.label}\n${line.slice(0, CRITICAL_KEY_MAX)}`)) return;
        for (const cb of this.criticalCallbacks) {
          cb({ action: cp.label, riskLevel: cp.riskLevel, matchedLine: value });
        }
        return;
      }
    }
    if (criticalMatched) return;

    // Check agent gates — activate agents when their gate pattern matches.
    // gate가 처음 매칭되는 순간 'running'으로 한 번 emit한다(checkGates). idle
    // prompt 패턴(Claude의 "bypass permissions on" 등)이 버전에 따라 사라져도
    // (Claude Code v2.1.x는 입력대기 hint가 "❯"만 남음) 시작 배너(gate)만으로
    // agentName이 확정된다.
    this.checkGates(clean, true);

    // Remember the last identity for callers, but no old launch's prompt
    // patterns may emit until fresh chrome has reclaimed the pane.
    if (this.shellPromptSinceOwner) return;

    // Only check patterns for the agent that currently owns this PTY.
    // Multiple gates can be in activeAgents (Grok reading this file will
    // still mention Claude chrome as source), but status patterns must not
    // flip lastAgent back to the other one.
    // #1494: on a Claude pane, the `Do you want to …` questions are left to
    // scanDialog. Read here, a question row redrawn while the dialog was up
    // could be judged only when a later clear completed the line — after the
    // user had answered. #1506: that holds for lines with no CUP too. A full
    // redraw after a split or resize re-emits the transcript as plain CRLF
    // lines, and a reply that printed the question on a line of its own then
    // matched by itself; only the option row that follows tells the dialog
    // apart. `Allow tool use for` is not one of the scanned questions, so it
    // keeps this pass.
    const dialogScanned = this.lastAgent === 'Claude Code';
    for (const ap of AGENT_PATTERNS) {
      if (ap.gate && !this.activeAgents.has(ap.agent)) continue;
      if (this.lastAgent && ap.agent !== this.lastAgent) continue;

      for (const p of ap.patterns) {
        if (dialogScanned && p.status === 'awaiting_input' && p.message !== 'Tool approval requested') continue;
        const match = clean.match(p.regex);
        if (match && p.frameTail) {
          this.frameTail = { agent: ap.agent, status: p.status, message: match[1] || p.message, value: match[0] };
          return;
        }
        if (match) {
          const key = `${ap.agent}:${p.status}`;
          const value = match[0];
          if (this.lastEmittedFor.get(key) === value) return;
          this.lastEmittedFor.set(key, value);
          this.lastAgent = ap.agent;
          if (p.status === 'awaiting_input') this.approvalEmittedInFeed = true;

          for (const cb of this.callbacks) {
            cb({ agent: ap.agent, status: p.status, message: match[1] || p.message });
          }
          return;
        }
      }
    }
  }
}
