// Terminal agent status detection — monitors PTY output for known AI agent
// prompt patterns and status indicators. This is status display only; the one
// piece of terminal content that leaves here is `CriticalEvent.matchedLine`
// (a single 80-char sanitized line, so a "spicy command" heads-up can say
// WHICH one) — nothing is stored, and no other output is transmitted.
//
// DESIGN: Only use patterns that are UNIQUE to each agent's output.
// Never use generic patterns like "Done", "Failed", "?" that match
// normal shell output. False positives are worse than missed detections.

import { CRITICAL_PATTERNS } from '../../shared/criticalPatterns';
import type { AgentStatus } from '../../shared/types';
import type { AgentSlug } from '../../shared/agentIdentity';
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

interface AgentPattern {
  /** Display name. Surfaced in UI ("Claude Code", "Codex CLI"). */
  agent: string;
  /** Canonical slug. Stable, lowercase, no whitespace. Matches hook signals. */
  slug: AgentSlug;
  // An optional "gate" regex: patterns are only checked if the gate has
  // previously matched in this session, confirming the agent is active.
  gate?: RegExp;
  patterns: { regex: RegExp; status: AgentEvent['status']; message: string }[];
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
const CLAUDE_PROMPT_RE = /bypass\s*permissions\s*on|shift\+tab\s*to\s*cycle/;
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
      { regex: /shift\+tab\s*to\s*cycle/,        status: 'waiting',          message: 'Ready for input' },
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
      { regex: /^[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Do you want to proceed\?[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/,                                                                                  status: 'awaiting_input',   message: 'Approval requested' },
      { regex: /^[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Allow tool use for (?:[A-Z][A-Za-z]+|mcp__[A-Za-z0-9-]+__[A-Za-z0-9_-]+)\??[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/, status: 'awaiting_input',   message: 'Tool approval requested' },
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
      { regex: /^[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Do you want to proceed\?[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/,                                                              status: 'awaiting_input',   message: 'Approval requested' },
      { regex: /^[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Allow tool use for (?:[A-Z][A-Za-z]+|mcp__[A-Za-z0-9-]+__[A-Za-z0-9_-]+)\??[\s│║┃═━─┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/, status: 'awaiting_input',   message: 'Tool approval requested' },
      { regex: /^[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Do\s*you\s*want\s*to\s*(?:create|overwrite|make\s*this\s*edit\s*to)\s*\S[^?]*\?[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/, status: 'awaiting_input',   message: 'Edit approval requested' },
      { regex: /^[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*Do\s*you\s*want\s*to\s*(?:create|overwrite|make\s*this\s*edit\s*to)[\s│║┃═━─╌╍┄┅┆┇┈┉╭╮╯╰╔╗╝╚┌┐┘└·]*$/,             status: 'awaiting_input',   message: 'Edit approval requested' },
    ],
  },

  // ── Aider ─────────────────────────────────────────────────────────────────
  {
    agent: 'Aider',
    slug: 'aider',
    gate: /aider v|aider --/,
    patterns: [
      { regex: /^aider>\s*$/,                    status: 'waiting',   message: 'Waiting for input' },
      { regex: /Applied edit to/,                status: 'complete',  message: 'Edit applied' },
    ],
  },

  // ── Codex CLI ─────────────────────────────────────────────────────────────
  {
    agent: 'Codex CLI',
    slug: 'codex',
    // The trust-prompt phrase is part of the gate because on a first boot in
    // an untrusted directory Codex shows it BEFORE the "OpenAI Codex" banner
    // — with the banner-only gate the trust pattern below could never fire.
    // checkGates runs before pattern matching on the same line, so the one
    // line both opens the gate and emits awaiting_input.
    gate: /codex |OpenAI Codex|Do you trust the contents of this directory/,
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
      // Anchored to the whole line: the question occupies its own line in
      // the TUI (two-space indent, no box-drawing frame in Codex), whereas
      // a conversational mention would sit inside surrounding sentence text.
      { regex: /^\s*Would you like to run the following command\?\s*$/, status: 'awaiting_input', message: 'Command approval requested' },
      { regex: /^\s*Would you like to make the following edits\?\s*$/,  status: 'awaiting_input', message: 'Edit approval requested' },
      // Startup trust prompt. Line continues with explanatory text after
      // the question mark ("Working with untrusted contents comes with
      // higher risk..."), so only the start is anchored.
      { regex: /^\s*Do you trust the contents of this directory\?/,     status: 'awaiting_input', message: 'Directory trust prompt' },
    ],
  },

  // ── Gemini CLI ────────────────────────────────────────────────────────────
  {
    agent: 'Gemini CLI',
    slug: 'gemini',
    gate: /gemini |Gemini CLI/,
    patterns: [
      { regex: /^gemini>\s*$/,                   status: 'waiting',   message: 'Waiting for input' },
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
    gate: /opencode/,
    patterns: [
      { regex: /^opencode>\s*$/,                 status: 'waiting',   message: 'Waiting for input' },
    ],
  },

  // ── GitHub Copilot CLI ────────────────────────────────────────────────────
  {
    agent: 'GitHub Copilot CLI',
    slug: 'copilot',
    gate: /gh copilot|copilot-cli/,
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

// Derive the Claude waiting patterns from the table above so the gate replay
// and the ordinary pattern pass can never disagree about which fragment a line
// matched. Order is preserved: the pattern pass takes the first entry that
// matches, so the replay must resolve the same way.
CLAUDE_WAITING_PATTERNS = (AGENT_PATTERNS.find((ap) => ap.slug === 'claude')?.patterns ?? [])
  .filter((p) => p.status === 'waiting')
  .map((p) => p.regex);

const MAX_BUFFER = 16 * 1024;

// ANSI escape strip regex. Covers:
//   CSI    \x1b[ <params> <final>   where params may include digits/semicolons
//                                   AND private-mode prefixes ? < = >
//                                   final is a letter A-Z/a-z or '@'
//   OSC    \x1b] <data> \x07
//   Charset designation \x1b(X
//
// Previous version omitted ?/</=/> and missed `\x1b[?25h` style sequences that
// Claude/Codex TUIs emit frequently, leaving stray fragments in `clean` and
// occasionally breaking pattern matching.
// eslint-disable-next-line no-control-regex
const ANSI_STRIP = /\x1b(?:\[[0-9;?<=>]*[a-zA-Z@]|\][^\x07]*\x07|\([A-Z])/g;

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

function stripAnsi(line: string): string {
  return line.includes('\u001b') ? line.replace(ANSI_STRIP, '') : line;
}

function visibleChrome(line: string): string {
  return stripAnsi(line).replace(CHROME_NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** OSC title, or a line whose visible text *starts* with `Claude Code`. */
function isClaudeBannerChrome(line: string): boolean {
  if (/\x1b\]0;[^\x07]*(?<!Open)(?<!Open\s)Claude/.test(line)) return true;
  const stripped = stripAnsi(line);
  if (SOURCE_LINE_RE.test(stripped)) return false;
  const v = visibleChrome(stripped);
  // Prefix, not substring: btop's `3304  Claude Code  43%` must not count.
  // Suffix is allowed (`Claude Code starting`, `Claude Code v2.1.172`).
  return /^Claude\s*Code\b/i.test(v);
}

/** Idle-footer fragment that is not a source/comment/regex dump of that fragment. */
function isClaudePromptChrome(line: string): boolean {
  const stripped = stripAnsi(line);
  if (!CLAUDE_PROMPT_RE.test(stripped)) return false;
  return !SOURCE_LINE_RE.test(stripped);
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

export class AgentDetector {
  private callbacks: AgentEventCallback[] = [];
  private criticalCallbacks: CriticalEventCallback[] = [];
  private lineBuffer = '';
  // Per (agent:status) and (critical:label) dedup: stores the last matched
  // string for each key. Same key + same match = skip emit. New active cycle
  // calls resetEmissionState() to clear, so turn N+1 can emit again even when
  // the prompt text is identical to turn N.
  private lastEmittedFor = new Map<string, string>();
  // Track which agents have been "gated" (confirmed active) in this session
  private activeAgents = new Set<string>();
  // Most recently emitted agent name. PTYBridge consults this when forwarding
  // ActivityMonitor 'active' transitions to label the running status with the
  // agent that owns this PTY.
  private lastAgent: string | null = null;
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
   * sent "in reply" would type into whatever is currently running. Repeats
   * within a cycle are also dropped by the dedup below, so a consumer cannot
   * even count them reliably.
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

  /** Snapshot of agent gates that have matched in this session. */
  getActiveAgents(): string[] {
    return Array.from(this.activeAgents);
  }

  /** Most recently emitted agent name, or null if no agent event has fired. */
  getLastAgent(): string | null {
    return this.lastAgent;
  }

  /**
   * Clear emission dedup state. Called by PTYBridge on a new ActivityMonitor
   * active cycle so the agent's next idle prompt (turn N+1) can emit even
   * when its text is identical to the previous turn.
   */
  resetEmissionState(): void {
    this.lastEmittedFor.clear();
  }

  feed(data: string): void {
    this.lineBuffer += data;
    if (this.lineBuffer.length > MAX_BUFFER) {
      this.lineBuffer = this.lineBuffer.slice(-MAX_BUFFER);
    }
    // Split on both LF and lone CR. TUI footers (Claude, Codex) redraw the
    // same line using CR without a following LF; without this split the
    // entire redraw collapses into one buffered string and patterns fail to
    // match line-anchored regexes.
    const lines = this.lineBuffer.split(/\r?\n|\r(?!\n)/);
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line);
    }

    // 미완성 라인(아직 개행이 안 온 redraw)의 gate도 미리 검사한다. claude처럼
    // 시작 배너를 개행 없이 커서 이동으로 그리는 TUI는 "Claude Code vX"가
    // lineBuffer에 갇혀 라인 완성이 영영 안 될 수 있고, 그러면 gate가 chunk
    // 타이밍에 따라 가끔만 매칭돼 agentName 감지가 불안정해진다. patterns는
    // 라인 완성 후에만 검사하지만(부분 매칭 오탐 방지), gate는 활성화 신호일
    // 뿐이라 미완성 라인에서 미리 봐도 안전하다.
    const tail = this.lineBuffer.replace(ANSI_STRIP, '').trim();
    if (tail) this.checkGates(tail);
    // Raw-tail gate check — see processLine: current Claude Code only carries
    // its name inside the OSC window-title escape, which the strip removes.
    if (this.lineBuffer) this.checkGates(this.lineBuffer);
  }

  /**
   * gate 매칭 → 에이전트 활성화 + 'running' 시작 이벤트 1회 emit + lastAgent
   * 설정. 라인 완성 여부와 무관하게 호출할 수 있도록 분리(feed의 미완성 라인
   * 검사와 processLine 양쪽에서 사용). activeAgents 가드로 세션당 1회만 발화.
   */
  private checkGates(clean: string): void {
    // Kiro has no hook fallback, so identify its live TUI from two independent
    // pieces of chrome. Newer v3 builds show the docs URL instead of a "Kiro
    // CLI" banner; their cursor-drawn composer can also collapse whitespace in
    // the raw PTY stream. Probe only a bounded tail and only when a cheap
    // literal hint is present. Once Kiro is active this entire path is skipped.
    const kiroIsActive = this.activeAgents.has('Kiro CLI');
    if (!kiroIsActive && (!this.kiroChromeSeen || !this.kiroPromptSeen)) {
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
    const claudeIsActive = this.activeAgents.has('Claude Code');
    if (!claudeIsActive && (!this.claudeBannerSeen || !this.claudePromptSeen)) {
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
      );

      if (mayContainBanner || mayContainPrompt) {
        for (const line of candidateLines(probe)) {
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
            const replayText = CLAUDE_WAITING_PATTERNS
              .map((re) => stripped.match(re)?.[0])
              .find((t): t is string => t !== undefined) ?? m[0];
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
      // Gate checks run on every PTY output chunk. Never re-run regexes for an
      // already-active agent; this keeps full-screen repaint traffic O(inactive
      // agents) and makes the Kiro additions cheaper than the previous loop.
      if (!ap.gate || this.activeAgents.has(ap.agent)) continue;
      const gateMatched = ap.slug === 'kiro'
        ? this.kiroChromeSeen && this.kiroPromptSeen
        : ap.slug === 'claude'
          ? this.claudeBannerSeen && this.claudePromptSeen
          : ap.slug === 'grok'
            ? candidateLines(clean).some(isGrokChrome)
            : ap.gate.test(clean);
      if (!gateMatched) continue;

      this.activeAgents.add(ap.agent);
      this.lastAgent = ap.agent;
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
    this.checkGates(line);

    const clean = line.replace(ANSI_STRIP, '').trim();
    if (!clean) return;

    // Check critical patterns first
    for (const cp of CRITICAL_PATTERNS) {
      if (cp.regex.test(clean)) {
        const key = `critical:${cp.label}`;
        // Normalize ONCE, then cap: stripControls drops the C0 bytes that
        // survived ANSI_STRIP and collapses whitespace, and only the result is
        // sliced to 80. That single value is the dedup key AND the payload, so
        // what a surface shows is exactly what the dedup judged — two lines
        // that differ only by a tab or other control byte now collapse to one
        // emission instead of both firing. Normalizing before the cap also
        // means the 80-char limit counts visible characters, not control
        // bytes. This string ends up in notification bodies and on a phone.
        const value = stripControls(clean).slice(0, 80);
        if (this.lastEmittedFor.get(key) === value) return;
        this.lastEmittedFor.set(key, value);
        for (const cb of this.criticalCallbacks) {
          cb({ action: cp.label, riskLevel: cp.riskLevel, matchedLine: value });
        }
        return;
      }
    }

    // Check agent gates — activate agents when their gate pattern matches.
    // gate가 처음 매칭되는 순간 'running'으로 한 번 emit한다(checkGates). idle
    // prompt 패턴(Claude의 "bypass permissions on" 등)이 버전에 따라 사라져도
    // (Claude Code v2.1.x는 입력대기 hint가 "❯"만 남음) 시작 배너(gate)만으로
    // agentName이 확정된다.
    this.checkGates(clean);

    // Only check patterns for the agent that currently owns this PTY.
    // Multiple gates can be in activeAgents (Grok reading this file will
    // still mention Claude chrome as source), but status patterns must not
    // flip lastAgent back to the other one.
    for (const ap of AGENT_PATTERNS) {
      if (ap.gate && !this.activeAgents.has(ap.agent)) continue;
      if (this.lastAgent && ap.agent !== this.lastAgent) continue;

      for (const p of ap.patterns) {
        const match = clean.match(p.regex);
        if (match) {
          const key = `${ap.agent}:${p.status}`;
          const value = match[0];
          if (this.lastEmittedFor.get(key) === value) return;
          this.lastEmittedFor.set(key, value);
          this.lastAgent = ap.agent;

          for (const cb of this.callbacks) {
            cb({ agent: ap.agent, status: p.status, message: match[1] || p.message });
          }
          return;
        }
      }
    }
  }
}
