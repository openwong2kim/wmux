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

// SLUG-form agent identifier. Lowercase, no whitespace. Used as the
// canonical key shared with hook-based signals (integrations/<agent>/).
// HookSignalRouter dedup matches AgentDetector emissions against bridge
// signals on this slug.
//
// The union and both slug<->display lookups now live in
// src/shared/agentIdentity.ts, so a new agent is one row there rather than
// eight hand-synced lists. Re-exported here because callers have long imported
// the identity helpers from the detector.
export type { AgentSlug } from '../../shared/agentIdentity';
export { agentDisplayToSlug } from '../../shared/agentIdentity';

import type { AgentSlug } from '../../shared/agentIdentity';

/**
 * One way to recognise a piece of an agent's chrome on a line.
 *
 *   line       regex against the ANSI-stripped, trimmed text. Use `^...$` when
 *              the chrome owns its whole line — that is what stops a quoted
 *              mention in someone else's log from counting as evidence.
 *   contains   case-insensitive substring. For chrome with no stable line
 *              shape, e.g. a docs URL printed inside a longer banner.
 *   normalized whitespace-stripped, lowercased substring. TUIs that paint with
 *              cursor moves lose their spaces in the PTY stream, so
 *              "ask a question" can arrive as "askaquestion" and no
 *              space-bearing pattern can ever match it.
 */
type EvidenceMatcher =
  | { line: RegExp }
  | { contains: string }
  | { normalized: string };

/**
 * One piece of evidence a compound gate requires. Satisfied when ANY matcher
 * hits; the gate opens when EVERY clause is satisfied, in any order and across
 * any number of PTY chunks.
 */
interface EvidenceClause {
  /** Stable id. Keys the per-detector evidence ledger. */
  id: string;
  /**
   * Cheap lowercase literals. The matchers run only when the candidate line
   * contains one of these, so an inactive compound gate costs a substring scan
   * per line rather than a regex sweep. Required — an evidence clause with no
   * hint would run its regexes on every line of every plain shell forever.
   */
  hints: readonly string[];
  any: readonly EvidenceMatcher[];
  /**
   * Emit this status once, at the moment the gate opens, using the text this
   * clause actually captured.
   *
   * Needed because evidence can arrive in any order: if the composer prompt is
   * painted BEFORE the banner, its ordinary pattern pass already happened while
   * the gate was still shut, so without a replay the pane sits at 'running'
   * while it is really idle. The captured text becomes the dedup value, so the
   * next ordinary pass over the same prompt suppresses instead of double-firing.
   *
   * `evidence` is the canonical text to fall back on when the matcher that hit
   * was not a regex (a `normalized` hit has no meaningful capture).
   */
  emitOnGateOpen?: { status: AgentEventStatus; message: string; evidence: string };
}

/**
 * A gate is either a single regex (the agent's banner is enough to identify it)
 * or a set of clauses that must ALL be satisfied.
 *
 * The compound form exists because a product-name mention is not proof: agents
 * routinely print logs and docs naming other agents. Requiring two independent
 * pieces of chrome from the same PTY is what separates "Kiro is running here"
 * from "something printed the word Kiro".
 */
type AgentGate = RegExp | { allOf: readonly EvidenceClause[] };

interface AgentPattern {
  /** Display name. Surfaced in UI ("Claude Code", "Codex CLI"). */
  agent: string;
  /** Canonical slug. Stable, lowercase, no whitespace. Matches hook signals. */
  slug: AgentSlug;
  // An optional "gate": patterns are only checked once it has matched in this
  // session, confirming the agent is active.
  gate?: AgentGate;
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

const AGENT_PATTERNS: AgentPattern[] = [
  // ── Claude Code ────────────────────────────────────────────────────────────
  // Gate: Claude Code startup banner (matches once to activate detection)
  {
    agent: 'Claude Code',
    slug: 'claude',
    // \s* — Claude Code TUI는 배너 "Claude Code"를 셀 단위 커서 이동으로 그려,
    // ANSI strip 후 "Claude"와 "Code" 사이 공백이 사라진 "ClaudeCode"가 된다.
    // 공백을 선택적으로 둬야 daemon mode에서도 gate가 매칭된다(핵심 race 원인).
    // (?<!Open)(?<!Open\s) keeps this gate from also opening on the
    // OpenClaude fork's banner ("╭ … OpenClaude" / "╭ … Open Claude"),
    // which would double-activate and misattribute events to Claude.
    gate: /(?<!Open)(?<!Open\s)Claude\s*Code|claude-code|╭.*(?<!Open)(?<!Open\s)Claude/,
    patterns: [
      // Waiting — Claude Code's unique idle prompt fragments.
      //
      // NOTE: `esc to interrupt` was previously matched here but it actually
      // appears while a response is in flight (hint that the user can ESC to
      // cancel), not when the agent is idle. Including it produced
      // false-positive "waiting" notifications mid-turn. Removed.
      { regex: /bypass permissions on/,          status: 'waiting',          message: 'Ready for input' },
      { regex: /shift\+tab to cycle/,            status: 'waiting',          message: 'Ready for input' },
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
  // Kiro has no hook bridge, so its identity comes entirely from the screen —
  // which is exactly when a compound gate is worth its cost. Two independent
  // pieces of chrome from the SAME PTY are required, in either order.
  {
    agent: 'Kiro CLI',
    slug: 'kiro',
    gate: {
      allOf: [
        {
          id: 'chrome',
          hints: ['kiro', 'trust all tools'],
          any: [
            // Newer v3 builds print the docs URL instead of a version banner.
            { contains: 'kiro.dev/docs/cli/' },
            { line: KIRO_CHROME_LINE },
          ],
        },
        {
          id: 'prompt',
          hints: ['ask'],
          any: [
            { line: KIRO_PROMPT_LINE },
            // Cursor-drawn composer: the spaces are gone by the time this
            // reaches us, so no space-bearing pattern can match it.
            { normalized: 'askaquestionordescribeatask' },
          ],
          emitOnGateOpen: {
            status: 'waiting',
            message: 'Ready for input',
            evidence: 'ask a question or describe a task',
          },
        },
      ],
    },
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
];

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

// Written as an escape so the source stays pure-ASCII, same reason as
// CONTROL_CHARS_RE above. Used to skip the strip on already-clean candidates.
const ESC = '\x1b';

/** How much of a candidate an evidence clause is allowed to look at. */
const MAX_EVIDENCE_PROBE = 4096;

/**
 * How many leading characters of a `normalized` needle anchor its search
 * window. Long enough to be selective, short enough to survive a needle whose
 * first word is tiny.
 */
const NORMALIZED_ANCHOR_LEN = 3;

/**
 * A candidate line prepared once for every evidence clause that examines it.
 *
 * `text` is ANSI-stripped and trimmed, because `checkGates` is deliberately
 * called with the RAW line too (Claude Code carries its name only inside the
 * OSC window-title escape, which the strip would otherwise remove wholesale).
 * `lower` backs both the cheap hint screen and `contains` matchers.
 */
interface GateProbe {
  readonly text: string;
  readonly lower: string;
}

function makeGateProbe(candidate: string): GateProbe {
  const bounded =
    candidate.length > MAX_EVIDENCE_PROBE
      ? candidate.slice(-MAX_EVIDENCE_PROBE)
      : candidate;
  // Callers pass both raw and already-cleaned candidates; skip the replacement
  // when there is nothing to strip.
  const stripped = bounded.includes(ESC) ? bounded.replace(ANSI_STRIP, '') : bounded;
  const text = stripped.trim();
  return { text, lower: text.toLowerCase() };
}

/**
 * Try each matcher in order; return the text the first hit captured, or null.
 *
 * The captured text matters beyond "did it match": a clause with
 * `emitOnGateOpen` replays it as the dedup value, so a regex hit must return
 * exactly what the ordinary pattern pass will later see.
 */
function matchEvidence(
  matchers: readonly EvidenceMatcher[],
  probe: GateProbe,
): string | null {
  for (const m of matchers) {
    if ('line' in m) {
      const hit = probe.text.match(m.line);
      if (hit) return hit[0];
    } else if ('contains' in m) {
      if (probe.lower.includes(m.contains)) return m.contains;
    } else {
      // Whitespace-stripped compare, windowed around the needle's own opening
      // literal so a long repaint does not pay for a full-probe replacement.
      // The window is generous: the raw text carries spaces the needle does not.
      //
      // FIRST occurrence, not last. The code this replaced used lastIndexOf and
      // could therefore never match: needles like
      // "askaquestionordescribeatask" contain their own anchor again near the
      // end ("...a task"), so lastIndexOf always landed on the trailing copy and
      // opened the window past the text it was looking for. That made the whole
      // space-collapsed path dead — the case it exists for (cursor-drawn
      // composers, where no space-bearing regex can match) was never covered.
      const anchor = m.normalized.slice(0, NORMALIZED_ANCHOR_LEN);
      const start = probe.lower.indexOf(anchor);
      if (start < 0) continue;
      const window = probe.lower.slice(start, start + m.normalized.length * 3 + 32);
      if (window.replace(/\s+/g, '').includes(m.normalized)) return m.normalized;
    }
  }
  return null;
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
  // Satisfied evidence clauses for compound gates, keyed `${slug}:${clauseId}`,
  // holding the text that satisfied them. Scoped to this detector — that is
  // what makes evidence per-PTY, so another agent merely printing "Kiro CLI"
  // in a log cannot hand this pane's identity away.
  private evidenceSeen = new Map<string, string>();

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
  private checkGates(candidate: string): void {
    let probe: GateProbe | null = null;

    for (const ap of AGENT_PATTERNS) {
      // Gate checks run on every PTY output chunk. Never re-run anything for an
      // already-active agent; this keeps full-screen repaint traffic
      // O(inactive agents).
      if (!ap.gate || this.activeAgents.has(ap.agent)) continue;

      let opened: boolean;
      if (ap.gate instanceof RegExp) {
        opened = ap.gate.test(candidate);
      } else {
        // Building the probe costs an ANSI strip and a lowercase, so defer it
        // until a compound gate actually asks. A session whose agents all use
        // plain regex gates never pays for it.
        probe ??= makeGateProbe(candidate);
        opened = this.accumulateEvidence(ap, ap.gate.allOf, probe);
      }
      if (!opened) continue;

      this.openGate(ap);
    }
  }

  /**
   * Record whichever clauses this candidate satisfies, and report whether that
   * completes the gate. Clauses persist for the life of the detector, so the
   * two halves of a compound gate may arrive in either order and any number of
   * PTY chunks apart. The ledger is per-detector, i.e. per PTY: one pane can
   * never satisfy another pane's gate.
   */
  private accumulateEvidence(
    ap: AgentPattern,
    clauses: readonly EvidenceClause[],
    probe: GateProbe,
  ): boolean {
    let satisfied = 0;
    for (const clause of clauses) {
      const key = `${ap.slug}:${clause.id}`;
      if (this.evidenceSeen.has(key)) {
        satisfied++;
        continue;
      }
      // Cheap literal screen first: an unsatisfied clause on a pane that is not
      // running this agent costs a substring scan, never a regex sweep.
      if (!clause.hints.some((h) => probe.lower.includes(h))) continue;

      const captured = matchEvidence(clause.any, probe);
      if (captured === null) continue;
      this.evidenceSeen.set(key, captured);
      satisfied++;
    }
    return satisfied === clauses.length;
  }

  /** Activate an agent: emit 'running' once, then replay any gate-open status. */
  private openGate(ap: AgentPattern): void {
    this.activeAgents.add(ap.agent);
    this.lastAgent = ap.agent;
    for (const cb of this.callbacks) {
      cb({ agent: ap.agent, status: 'running', message: 'Agent started' });
    }

    if (ap.gate === undefined || ap.gate instanceof RegExp) return;

    // If a clause carrying `emitOnGateOpen` was satisfied BEFORE the gate
    // opened, its ordinary pattern pass already ran and was ignored, so replay
    // it now — otherwise the pane sits at 'running' while it is really idle and
    // waiting for input.
    for (const clause of ap.gate.allOf) {
      const replay = clause.emitOnGateOpen;
      if (!replay) continue;
      const captured = this.evidenceSeen.get(`${ap.slug}:${clause.id}`);
      if (captured === undefined) continue;

      const key = `${ap.agent}:${replay.status}`;
      // Seed the dedup with the text the ordinary pass will see, so the same
      // prompt in the same frame suppresses instead of firing twice.
      if (this.lastEmittedFor.get(key) === captured) continue;
      this.lastEmittedFor.set(key, captured);
      for (const cb of this.callbacks) {
        cb({ agent: ap.agent, status: replay.status, message: replay.message });
      }
    }
  }

  /**
   * ONE LINE PRODUCES AT MOST ONE EMISSION. Every `return` below is that rule,
   * not an oversight — read this before "fixing" one into a `continue`.
   *
   *   line
   *    │
   *    ├─ checkGates(raw)         gates only; never returns (OSC-title case)
   *    ├─ clean === '' ──────────────────────────────────► return
   *    │
   *    ├─ CRITICAL_PATTERNS ─ match? ─┬─ new value  ─► emit ─► return
   *    │                              └─ deduped    ────────► return
   *    │        no match
   *    ├─ checkGates(clean)
   *    │
   *    └─ AGENT_PATTERNS ──── match? ─┬─ new value  ─► emit ─► return
   *                                   └─ deduped    ────────► return
   *
   * Why a deduped match still consumes the line:
   *
   *   - Critical vs agent patterns cannot co-match. Critical patterns are
   *     unanchored shell-command shapes (`git push --force`, `rm -rf`); agent
   *     status patterns are whole-line-anchored TUI chrome (`^codex>$`, the
   *     boxed `Do you want to proceed?`). Falling through on a deduped critical
   *     would therefore buy nothing.
   *   - Across agents it is load-bearing. Claude Code and OpenClaude are the
   *     same forked TUI and share their approval patterns outright, so the
   *     FIRST profile whose regex matches owns the line. Continuing to the next
   *     profile after a deduped match would let the second turn of a repeated
   *     prompt emit again under the other agent's name — a duplicate
   *     notification for a single on-screen event.
   *
   * So the rule is deliberately not "emit once per profile" but "the first
   * matching profile decides, and a suppressed match is still a decision".
   */
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

    // Only check patterns for agents that are confirmed active (gate matched)
    for (const ap of AGENT_PATTERNS) {
      if (ap.gate && !this.activeAgents.has(ap.agent)) continue;

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
