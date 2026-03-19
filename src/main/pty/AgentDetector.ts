// Terminal agent status detection — monitors PTY output for known AI agent
// prompt patterns and status indicators. This is status display only;
// no content is captured, stored, or transmitted.

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
  patterns: { regex: RegExp; status: AgentEvent['status']; message: string }[];
}

// ---------------------------------------------------------------------------
// Common cross-agent terminal patterns
// ---------------------------------------------------------------------------

/** Shared completion indicators (✓ ✔ Done Complete Finished Success) */
const COMMON_COMPLETE: AgentPattern['patterns'] = [
  { regex: /[✓✔]\s+(.+)/,               status: 'completed', message: 'Task completed' },
  { regex: /\b(Done|Complete(?:d)?|Finished|Success(?:ful)?)\b/, status: 'completed', message: 'Task completed' },
];

/** Shared error indicators (✗ ✘ Error Failed error:) */
const COMMON_ERROR: AgentPattern['patterns'] = [
  { regex: /[✗✘]\s+(.+)/,               status: 'error',     message: 'Error occurred' },
  { regex: /\bFailed\b/,                 status: 'error',     message: 'Task failed' },
  { regex: /\berror:\s+(.+)/i,           status: 'error',     message: 'Error occurred' },
];

/** Shared waiting indicators (? Waiting for Press y/n [Y/n]) */
const COMMON_WAITING: AgentPattern['patterns'] = [
  { regex: /\?\s+(.+)/,                  status: 'waiting',   message: 'Waiting for input' },
  { regex: /Waiting for\s+(.+)/i,        status: 'waiting',   message: 'Waiting for input' },
  { regex: /Press\s+.+\s+to\s+/i,        status: 'waiting',   message: 'Waiting for key press' },
  { regex: /\[Y\/n\]|\(y\/n\)/i,         status: 'waiting',   message: 'Waiting for confirmation' },
];

// ---------------------------------------------------------------------------
// Per-agent patterns
// ---------------------------------------------------------------------------

const AGENT_PATTERNS: AgentPattern[] = [
  // ── Claude Code ────────────────────────────────────────────────────────────
  {
    agent: 'Claude Code',
    patterns: [
      { regex: /⏳\s+(.+)/,              status: 'running',   message: 'Processing...' },
      { regex: /❌\s+(.+)/,              status: 'error',     message: 'Error occurred' },
      { regex: /Do you want to/,         status: 'waiting',   message: 'Waiting for confirmation' },
      ...COMMON_COMPLETE,
      ...COMMON_ERROR,
      ...COMMON_WAITING,
    ],
  },

  // ── Cursor Agent ──────────────────────────────────────────────────────────
  {
    agent: 'Cursor Agent',
    patterns: [
      { regex: /Applied \d+ changes?/,   status: 'completed', message: 'Changes applied' },
      { regex: /Thinking\.\.\./,         status: 'running',   message: 'Thinking...' },
      ...COMMON_COMPLETE,
      ...COMMON_ERROR,
      ...COMMON_WAITING,
    ],
  },

  // ── Aider ─────────────────────────────────────────────────────────────────
  {
    agent: 'Aider',
    patterns: [
      { regex: /Applied edit to/,        status: 'completed', message: 'Edit applied' },
      { regex: /aider>/,                 status: 'waiting',   message: 'Waiting for input' },
      ...COMMON_COMPLETE,
      ...COMMON_ERROR,
      ...COMMON_WAITING,
    ],
  },

  // ── Codex CLI ─────────────────────────────────────────────────────────────
  {
    agent: 'Codex CLI',
    patterns: [
      { regex: /codex>/,                 status: 'waiting',   message: 'Waiting for input' },
      { regex: /Codex:\s+(.+)/,          status: 'running',   message: 'Processing...' },
      ...COMMON_COMPLETE,
      ...COMMON_ERROR,
      ...COMMON_WAITING,
    ],
  },

  // ── Gemini CLI ────────────────────────────────────────────────────────────
  {
    agent: 'Gemini CLI',
    patterns: [
      { regex: /gemini>/,                status: 'waiting',   message: 'Waiting for input' },
      { regex: /Gemini:\s+(.+)/,         status: 'running',   message: 'Processing...' },
      ...COMMON_COMPLETE,
      ...COMMON_ERROR,
      ...COMMON_WAITING,
    ],
  },

  // ── OpenCode ──────────────────────────────────────────────────────────────
  {
    agent: 'OpenCode',
    patterns: [
      { regex: /opencode>/,              status: 'waiting',   message: 'Waiting for input' },
      ...COMMON_COMPLETE,
      ...COMMON_ERROR,
      ...COMMON_WAITING,
    ],
  },

  // ── GitHub Copilot CLI ────────────────────────────────────────────────────
  {
    agent: 'GitHub Copilot CLI',
    patterns: [
      { regex: /copilot>/,               status: 'waiting',   message: 'Waiting for input' },
      { regex: /gh copilot\s+(.+)/,      status: 'running',   message: 'Processing...' },
      ...COMMON_COMPLETE,
      ...COMMON_ERROR,
      ...COMMON_WAITING,
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
  // Destructive git operations
  { regex: /git\s+push\s+(?:.*--force|-f)\b/i,          riskLevel: 'critical', label: 'git push --force' },
  { regex: /git\s+reset\s+--hard\b/i,                   riskLevel: 'critical', label: 'git reset --hard' },
  { regex: /git\s+clean\s+.*-f\b/i,                     riskLevel: 'critical', label: 'git clean -f' },
  // File system wipe
  { regex: /\brm\s+(?:.*-r.*-f|-f.*-r|-rf|-fr)\s+/i,   riskLevel: 'critical', label: 'rm -rf' },
  { regex: /\brmdir\s+\/[sS]\s+/,                       riskLevel: 'critical', label: 'rmdir /S' },
  // Database destructive
  { regex: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,     riskLevel: 'critical', label: 'DROP TABLE/DATABASE' },
  { regex: /\bDELETE\s+FROM\b/i,                        riskLevel: 'review',   label: 'DELETE FROM' },
  { regex: /\bTRUNCATE\s+TABLE\b/i,                     riskLevel: 'critical', label: 'TRUNCATE TABLE' },
  // NPM publishing
  { regex: /\bnpm\s+publish\b/i,                        riskLevel: 'critical', label: 'npm publish' },
  { regex: /\bnpx\s+.*--publish\b/i,                    riskLevel: 'review',   label: 'npx publish' },
  // Cloud resource destruction
  { regex: /\bterraform\s+destroy\b/i,                  riskLevel: 'critical', label: 'terraform destroy' },
  { regex: /\bkubectl\s+delete\b/i,                     riskLevel: 'review',   label: 'kubectl delete' },
  { regex: /\baws\s+.*\s+delete\b/i,                    riskLevel: 'review',   label: 'aws delete' },
  // Disk formatting
  { regex: /\bformat\s+[A-Za-z]:\\/i,                   riskLevel: 'critical', label: 'format disk' },
  { regex: /\bmkfs\b/i,                                 riskLevel: 'critical', label: 'mkfs' },
];

const MAX_BUFFER = 16 * 1024; // 16 KB

export class AgentDetector {
  private callbacks: AgentEventCallback[] = [];
  private criticalCallbacks: CriticalEventCallback[] = [];
  private lineBuffer = '';
  private lastEmittedKey = '';

  onEvent(callback: AgentEventCallback): void {
    this.callbacks.push(callback);
  }

  onCritical(callback: CriticalEventCallback): void {
    this.criticalCallbacks.push(callback);
  }

  feed(data: string): void {
    // Accumulate lines
    this.lineBuffer += data;
    // Prevent unbounded buffer growth
    if (this.lineBuffer.length > MAX_BUFFER) {
      this.lineBuffer = this.lineBuffer.slice(-MAX_BUFFER);
    }
    const lines = this.lineBuffer.split(/\r?\n/);
    // Keep the last incomplete line in buffer
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    // Strip ANSI escape codes for pattern matching
    const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (!clean) return;

    // Check critical patterns first
    for (const cp of CRITICAL_PATTERNS) {
      if (cp.regex.test(clean)) {
        const key = `critical:${cp.label}:${clean.slice(0, 80)}`;
        if (key !== this.lastEmittedKey) {
          this.lastEmittedKey = key;
          const event: CriticalEvent = { action: cp.label, riskLevel: cp.riskLevel };
          for (const cb of this.criticalCallbacks) {
            cb(event);
          }
        }
        return;
      }
    }

    for (const ap of AGENT_PATTERNS) {
      for (const p of ap.patterns) {
        const match = clean.match(p.regex);
        if (match) {
          // Deduplicate: don't emit the same event twice in a row
          const key = `${ap.agent}:${p.status}:${match[0]}`;
          if (key === this.lastEmittedKey) return;
          this.lastEmittedKey = key;

          const event: AgentEvent = {
            agent: ap.agent,
            status: p.status,
            message: match[1] || p.message,
          };
          for (const cb of this.callbacks) {
            cb(event);
          }
          return;
        }
      }
    }
  }
}
