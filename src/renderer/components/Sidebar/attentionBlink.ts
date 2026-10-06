// ─── Attention blink (owner decision 2026-10-07) ─────────────────────────────
//
// A sidebar row that waits on you (a question, approval or permission dialog)
// keeps its dashed border and may also pulse, per the user's setting. A
// finished turn draws no dash, only the done dot, and may pulse once. All of
// it is CSS animation classes picked here from state, so no row runs a timer.

export type AttentionBlinkMode = 'off' | 'once' | 'remind' | 'continuous';
export type AttentionBlinkFinished = 'dot' | 'pulse';

export const ATTENTION_BLINK_MODES: readonly AttentionBlinkMode[] = ['off', 'once', 'remind', 'continuous'];
export const ATTENTION_BLINK_FINISHED: readonly AttentionBlinkFinished[] = ['dot', 'pulse'];
/** "Once + remind" intervals: 30 s, 1 min, 5 min. Each has its own keyframes. */
export const ATTENTION_REMIND_MS = [30_000, 60_000, 300_000] as const;
export type AttentionRemindMs = (typeof ATTENTION_REMIND_MS)[number];

export const DEFAULT_ATTENTION_BLINK: AttentionBlinkMode = 'remind';
export const DEFAULT_ATTENTION_REMIND_MS: AttentionRemindMs = 60_000;
export const DEFAULT_ATTENTION_BLINK_FINISHED: AttentionBlinkFinished = 'dot';

/** Persisted values are whitelisted on load; anything else is the default. */
export function resolveAttentionBlink(value: unknown): AttentionBlinkMode {
  return ATTENTION_BLINK_MODES.includes(value as AttentionBlinkMode) ? value as AttentionBlinkMode : DEFAULT_ATTENTION_BLINK;
}
export function resolveAttentionRemindMs(value: unknown): AttentionRemindMs {
  return ATTENTION_REMIND_MS.includes(value as AttentionRemindMs) ? value as AttentionRemindMs : DEFAULT_ATTENTION_REMIND_MS;
}
export function resolveAttentionBlinkFinished(value: unknown): AttentionBlinkFinished {
  return ATTENTION_BLINK_FINISHED.includes(value as AttentionBlinkFinished)
    ? value as AttentionBlinkFinished
    : DEFAULT_ATTENTION_BLINK_FINISHED;
}

export interface AttentionPulseInput {
  /** The row waits on a question, approval or permission dialog (the dash). */
  needsYou: boolean;
  /** A finished turn not yet looked at (the done dot). */
  done: boolean;
  /** The workspace is active or otherwise on screen. */
  visible: boolean;
  /** prefers-reduced-motion. Forces every pulse off. */
  reducedMotion: boolean;
  /** The row was already on screen during this wait: "once" has been spent,
   *  and "remind" waits a full interval before its next pulse. */
  seenThisWait?: boolean;
  mode: AttentionBlinkMode;
  remindMs: AttentionRemindMs;
  finished: AttentionBlinkFinished;
}

/** The row's pulse classes ('' for none). ui.css owns the keyframes. */
export function attentionPulseClass(input: AttentionPulseInput): string {
  if (input.reducedMotion || input.visible) return '';
  if (input.needsYou) {
    switch (input.mode) {
      case 'once':
        return input.seenThisWait ? '' : 'sidebar-row-pulse sidebar-row-pulse-once';
      case 'remind': {
        const every = `sidebar-row-pulse sidebar-row-pulse-remind-${input.remindMs / 1000}s`;
        return input.seenThisWait ? `${every} sidebar-row-pulse-deferred` : every;
      }
      case 'continuous':
        return 'sidebar-row-pulse sidebar-row-pulse-continuous';
      default:
        return '';
    }
  }
  if (input.done && input.finished === 'pulse') return 'sidebar-row-pulse sidebar-row-pulse-done';
  return '';
}
