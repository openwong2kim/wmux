// Terminal agent status detection — monitors PTY output for known AI agent
// prompt patterns and status indicators. This is status display only;
// no content is captured, stored, or transmitted.
//
// DESIGN: Only use patterns that are UNIQUE to each agent's output.
// Never use generic patterns like "Done", "Failed", "?" that match
// normal shell output. False positives are worse than missed detections.

export interface AgentEvent {
  agent: string;
  status: 'completed' | 'waiting' | 'running' | 'error';
  message: string;
}

export interface CriticalEvent {
  action: string;
  riskLevel: 'review' | 'critical';
}

type AgentEventCallback = (event: AgentEvent) => void;
type CriticalEventCallback = (event: CriticalEvent) => void;

interface AgentPattern {
  agent: string;
  // An optional "gate" regex: patterns are only checked if the gate has
  // previously matched in this session, confirming the agent is active.
  gate?: RegExp;
  patterns: { regex: RegExp; status: AgentEvent['status']; message: string }[];
}

// ---------------------------------------------------------------------------
// Per-agent patterns — ONLY agent-specific, no generic patterns
// ---------------------------------------------------------------------------

const AGENT_PATTERNS: AgentPattern[] = [
  // ── Claude Code ────────────────────────────────────────────────────────────
  // Gate: Claude Code startup banner (matches once to activate detection)
  {
    agent: 'Claude Code',
    gate: /Claude Code|claude-code|╭.*Claude/,
    patterns: [
      // Waiting — Claude Code's unique idle prompt fragments
      { regex: /bypass permissions on/,          status: 'waiting',   message: 'Ready for input' },
      { regex: /shift\+tab to cycle/,            status: 'waiting',   message: 'Ready for input' },
      { regex: /esc to interrupt/,               status: 'waiting',   message: 'Ready for input' },
      { regex: /Do you want to proceed/,         status: 'waiting',   message: 'Waiting for confirmation' },
    ],
  },

  // ── Aider ─────────────────────────────────────────────────────────────────
  {
    agent: 'Aider',
    gate: /aider v|aider --/,
    patterns: [
      { regex: /^aider>\s*$/,                    status: 'waiting',   message: 'Waiting for input' },
      { regex: /Applied edit to/,                status: 'completed', message: 'Edit applied' },
    ],
  },

  // ── Codex CLI ─────────────────────────────────────────────────────────────
  {
    agent: 'Codex CLI',
    gate: /codex |OpenAI Codex/,
    patterns: [
      { regex: /^codex>\s*$/,                    status: 'waiting',   message: 'Waiting for input' },
    ],
  },

  // ── Gemini CLI ────────────────────────────────────────────────────────────
  {
    agent: 'Gemini CLI',
    gate: /gemini |Gemini CLI/,
    patterns: [
      { regex: /^gemini>\s*$/,                   status: 'waiting',   message: 'Waiting for input' },
    ],
  },

  // ── OpenCode ──────────────────────────────────────────────────────────────
  {
    agent: 'OpenCode',
    gate: /opencode/,
    patterns: [
      { regex: /^opencode>\s*$/,                 status: 'waiting',   message: 'Waiting for input' },
    ],
  },

  // ── GitHub Copilot CLI ────────────────────────────────────────────────────
  {
    agent: 'GitHub Copilot CLI',
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

export class AgentDetector {
  private callbacks: AgentEventCallback[] = [];
  private criticalCallbacks: CriticalEventCallback[] = [];
  private lineBuffer = '';
  private lastEmittedKey = '';
  // Track which agents have been "gated" (confirmed active) in this session
  private activeAgents = new Set<string>();

  onEvent(callback: AgentEventCallback): void {
    this.callbacks.push(callback);
  }

  onCritical(callback: CriticalEventCallback): void {
    this.criticalCallbacks.push(callback);
  }

  feed(data: string): void {
    this.lineBuffer += data;
    if (this.lineBuffer.length > MAX_BUFFER) {
      this.lineBuffer = this.lineBuffer.slice(-MAX_BUFFER);
    }
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    // Strip ANSI escape codes for pattern matching
    const clean = line.replace(/\x1b(?:\[[0-9;]*[a-zA-Z]|\][^\x07]*\x07|\([A-Z])/g, '').trim();
    if (!clean) return;

    // Check critical patterns first
    for (const cp of CRITICAL_PATTERNS) {
      if (cp.regex.test(clean)) {
        const key = `critical:${cp.label}:${clean.slice(0, 80)}`;
        if (key !== this.lastEmittedKey) {
          this.lastEmittedKey = key;
          for (const cb of this.criticalCallbacks) {
            cb({ action: cp.label, riskLevel: cp.riskLevel });
          }
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
          const key = `${ap.agent}:${p.status}:${match[0]}`;
          if (key === this.lastEmittedKey) return;
          this.lastEmittedKey = key;

          for (const cb of this.callbacks) {
            cb({ agent: ap.agent, status: p.status, message: match[1] || p.message });
          }
          return;
        }
      }
    }
  }
}
