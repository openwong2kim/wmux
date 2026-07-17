// Terminal agent status detection — monitors PTY output for known AI agent
// prompt patterns and status indicators. This is status display only;
// no content is captured, stored, or transmitted.
//
// DESIGN: Only use patterns that are UNIQUE to each agent's output.
// Never use generic patterns like "Done", "Failed", "?" that match
// normal shell output. False positives are worse than missed detections.

import type { AgentStatus } from '../../shared/types';

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
}

type AgentEventCallback = (event: AgentEvent) => void;
type CriticalEventCallback = (event: CriticalEvent) => void;

// SLUG-form agent identifier. Lowercase, no whitespace. Used as the
// canonical key shared with hook-based signals (integrations/<agent>/).
// HookSignalRouter dedup matches AgentDetector emissions against bridge
// signals on this slug, so the two MUST stay in lock-step. New agents
// added here must also be added to integrations/shared/signal-types.ts
// (AgentSlug union) and to any HookSignalRouter dedup table.
export type AgentSlug = 'claude' | 'codex' | 'gemini' | 'aider' | 'opencode' | 'copilot';

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
 * Map display name → slug. Used by consumers that have an AgentEvent in
 * hand (which carries the display name) and need to derive the canonical
 * slug for dedup against hook signals.
 */
export function agentDisplayToSlug(display: string): AgentSlug | undefined {
  switch (display) {
    case 'Claude Code': return 'claude';
    case 'Codex CLI': return 'codex';
    case 'Gemini CLI': return 'gemini';
    case 'Aider': return 'aider';
    case 'OpenCode': return 'opencode';
    case 'GitHub Copilot CLI': return 'copilot';
    default: return undefined;
  }
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

const AGENT_PATTERNS: AgentPattern[] = [
  // ── Claude Code ────────────────────────────────────────────────────────────
  // Gate: Claude Code startup banner (matches once to activate detection)
  {
    agent: 'Claude Code',
    slug: 'claude',
    // \s* — Claude Code TUI는 배너 "Claude Code"를 셀 단위 커서 이동으로 그려,
    // ANSI strip 후 "Claude"와 "Code" 사이 공백이 사라진 "ClaudeCode"가 된다.
    // 공백을 선택적으로 둬야 daemon mode에서도 gate가 매칭된다(핵심 race 원인).
    gate: /Claude\s*Code|claude-code|╭.*Claude/,
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

// ---------------------------------------------------------------------------
// Critical action patterns — require approval before execution
// ---------------------------------------------------------------------------

interface CriticalPattern {
  regex: RegExp;
  riskLevel: 'review' | 'critical';
  label: string;
}

const CRITICAL_PATTERNS: CriticalPattern[] = [
  { regex: /git\s+push\s+(?:.*--force|-f)\b/i,          riskLevel: 'critical', label: 'git push --force' },
  { regex: /git\s+reset\s+--hard\b/i,                   riskLevel: 'critical', label: 'git reset --hard' },
  { regex: /git\s+clean\s+.*-f\b/i,                     riskLevel: 'critical', label: 'git clean -f' },
  { regex: /\brm\s+(?:.*-r.*-f|-f.*-r|-rf|-fr)\s+/i,   riskLevel: 'critical', label: 'rm -rf' },
  { regex: /\brmdir\s+\/[sS]\s+/,                       riskLevel: 'critical', label: 'rmdir /S' },
  { regex: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,     riskLevel: 'critical', label: 'DROP TABLE/DATABASE' },
  { regex: /\bDELETE\s+FROM\b/i,                        riskLevel: 'review',   label: 'DELETE FROM' },
  { regex: /\bTRUNCATE\s+TABLE\b/i,                     riskLevel: 'critical', label: 'TRUNCATE TABLE' },
  { regex: /\bnpm\s+publish\b/i,                        riskLevel: 'critical', label: 'npm publish' },
  { regex: /\bterraform\s+destroy\b/i,                  riskLevel: 'critical', label: 'terraform destroy' },
  { regex: /\bkubectl\s+delete\b/i,                     riskLevel: 'review',   label: 'kubectl delete' },
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
  }

  /**
   * gate 매칭 → 에이전트 활성화 + 'running' 시작 이벤트 1회 emit + lastAgent
   * 설정. 라인 완성 여부와 무관하게 호출할 수 있도록 분리(feed의 미완성 라인
   * 검사와 processLine 양쪽에서 사용). activeAgents 가드로 세션당 1회만 발화.
   */
  private checkGates(clean: string): void {
    for (const ap of AGENT_PATTERNS) {
      if (ap.gate && !this.activeAgents.has(ap.agent) && ap.gate.test(clean)) {
        this.activeAgents.add(ap.agent);
        this.lastAgent = ap.agent;
        for (const cb of this.callbacks) {
          cb({ agent: ap.agent, status: 'running', message: 'Agent started' });
        }
      }
    }
  }

  private processLine(line: string): void {
    const clean = line.replace(ANSI_STRIP, '').trim();
    if (!clean) return;

    // Check critical patterns first
    for (const cp of CRITICAL_PATTERNS) {
      if (cp.regex.test(clean)) {
        const key = `critical:${cp.label}`;
        const value = clean.slice(0, 80);
        if (this.lastEmittedFor.get(key) === value) return;
        this.lastEmittedFor.set(key, value);
        for (const cb of this.criticalCallbacks) {
          cb({ action: cp.label, riskLevel: cp.riskLevel });
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
