// #783 — configuration for the PreToolUse permission gate.
//
// The gated-tools list lives in daemon config (not in hooks.json) for two
// reasons (eng-review §3-5):
//   1. Editing hooks.json requires restarting every live Claude Code session;
//      a config slice is read on every gate signal, so `wmux gate --add` takes
//      effect on the next tool call with no restart.
//   2. A plugin update would overwrite a matcher-based list; a config slice is
//      operator-owned and survives.
//
// The hook matcher stays WIDE (every PreToolUse) and the daemon decides gate
// vs pass-through by checking this list. That keeps the hook installation
// stable while the gate policy is runtime-editable.

/**
 * Tools gated by default. Restricted to tools that can modify the filesystem
 * or execute arbitrary commands — gating read-only tools (Read, Glob, Grep)
 * would add per-call latency for no safety gain. The list is deliberately
 * short: every entry is one more call per turn that blocks until a phone
 * answers or the deadline defers.
 *
 * Tool names match Claude Code's `tool_name` field in the PreToolUse payload.
 */
export const DEFAULT_GATED_TOOLS: readonly string[] = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
] as const;

export interface GateConfig {
  /**
   * Claude Code tool names that trigger the remote permission gate. Edited via
   * `wmux gate --add/--remove` or the config file. An empty array disables the
   * gate (same as `WMUX_GATE=0`, but durable). Defaults to
   * `DEFAULT_GATED_TOOLS`.
   */
  gatedTools: string[];
}

/**
 * Per-field backfill for the `gate` config slice. Same discipline as the
 * browser/lanlink slices: `validateConfig` deliberately ignores this field, so
 * a garbage value here can never trigger the whole-file reset. Absent or
 * malformed → `DEFAULT_GATED_TOOLS`.
 */
export function coerceGate(raw: unknown): GateConfig {
  const slice = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {});
  const toolsRaw = slice['gatedTools'];
  if (!Array.isArray(toolsRaw)) {
    return { gatedTools: [...DEFAULT_GATED_TOOLS] };
  }
  // Keep only non-empty strings; deduplicate preserving order.
  const seen = new Set<string>();
  const gatedTools: string[] = [];
  for (const t of toolsRaw) {
    if (typeof t !== 'string' || t.length === 0) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    gatedTools.push(t);
  }
  return { gatedTools };
}

/** Create a fresh default gate config (used by `createDefaultConfig`). */
export function createDefaultGateConfig(): GateConfig {
  return { gatedTools: [...DEFAULT_GATED_TOOLS] };
}
