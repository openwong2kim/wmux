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
): 'agent.stop' | 'agent.activity' | null {
  switch (status) {
    case 'waiting':
    case 'complete':
      return 'agent.stop';
    case 'running':
      return 'agent.activity';
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
    gate: /Claude Code|claude-code|╭.*Claude/,
    patterns: [
      // Waiting — Claude Code's unique idle prompt fragments.
      //
      // NOTE: `esc to interrupt` was previously matched here but it actually
      // appears while a response is in flight (hint that the user can ESC to
      // cancel), not when the agent is idle. Including it produced
      // false-positive "waiting" notifications mid-turn. Removed.
      { regex: /bypass permissions on/,          status: 'waiting',   message: 'Ready for input' },
      { regex: /shift\+tab to cycle/,            status: 'waiting',   message: 'Ready for input' },
      { regex: /Do you want to proceed/,         status: 'waiting',   message: 'Waiting for confirmation' },
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
    gate: /codex |OpenAI Codex/,
    patterns: [
      { regex: /^codex>\s*$/,                    status: 'waiting',   message: 'Waiting for input' },
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

    // Check agent gates — activate agents when their gate pattern matches
    for (const ap of AGENT_PATTERNS) {
      if (ap.gate && !this.activeAgents.has(ap.agent) && ap.gate.test(clean)) {
        this.activeAgents.add(ap.agent);
      }
    }

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
