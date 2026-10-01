// ─── Claude model + effort options (single source) ──────────────────────────
//
// One list for every Claude model picker (deck chip, Settings orchestrator
// section, role-binding suggestions). Full ids pin an exact model; the bare
// aliases follow whatever the installed claude CLI maps them to (on 2.1.285,
// verified 2026-09-30: `sonnet` -> claude-sonnet-5-5).
//
// Verified 2026-09-30 against Claude Code 2.1.285: `claude -p --model
// claude-opus-5-5 --effort low` runs and reports modelUsage claude-opus-5-5.

export interface ClaudeModelOption {
  /** Value passed to `--model` / SDK `options.model`; '' = the CLI default. */
  value: string;
  /** Display name (product names are not translated). */
  label: string;
}

export const CLAUDE_MODEL_OPTIONS: readonly ClaudeModelOption[] = [
  { value: '', label: 'Default' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'opus', label: 'opus (latest)' },
  { value: 'sonnet', label: 'sonnet (latest)' },
  { value: 'haiku', label: 'haiku (latest)' },
];

/** Effort levels accepted by `claude --effort` and SDK `options.effort`. */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number];

/** Display label for a stored model value. An id missing from the list (typed
 *  by hand, or a newer model) shows as itself rather than as "Default". */
export function claudeModelLabel(value: string): string {
  return CLAUDE_MODEL_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/** A stored effort value, or '' (CLI default) when it is not a known level. */
export function sanitizeClaudeEffort(raw: unknown): ClaudeEffort | '' {
  return typeof raw === 'string' && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(raw)
    ? (raw as ClaudeEffort)
    : '';
}
