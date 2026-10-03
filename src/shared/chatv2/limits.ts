/**
 * Chat v2 size and timing limits. The fold (apply.ts) enforces the per-block
 * caps itself, so the daemon and every renderer truncate at the same byte;
 * whatever a cap cut off stays readable through `bodies` (see ipc.ts).
 * All sizes are UTF-8 bytes.
 */

/** Main's control pipe drops its buffer above 1 MiB; one push or result stays far below. */
export const CHATV2_MAX_PUSH_BYTES = 128 * 1024;
/** Serialized budget of one snapshot window or history page (a page still returns at least one block). */
export const CHATV2_PAGE_BUDGET_BYTES = 96 * 1024;
/** One stamped event, serialized. Drivers split longer deltas; the host truncates anything still larger. */
export const CHATV2_MAX_EVENT_BYTES = 32 * 1024;
/** One prompt's text. */
export const CHATV2_MAX_PROMPT_BYTES = 32 * 1024;

/** Inline text of one block (assistant, reasoning, plan, user, system). Overflow → `bodies` field `text`. */
export const CHATV2_BLOCK_TEXT_BYTES = 32 * 1024;
/** A tool block's `detail`. Overflow → `bodies` field `detail`. */
export const CHATV2_TOOL_DETAIL_BYTES = 8 * 1024;
/** A tool preview's `output`. Overflow → `bodies` field `output`. */
export const CHATV2_PREVIEW_OUTPUT_BYTES = 4 * 1024;
/** Subagent steps kept on a parent tool block (oldest dropped), and each step's caps (truncated, no body). */
export const CHATV2_AGENT_STEPS_MAX = 40;
export const CHATV2_AGENT_STEP_TEXT_BYTES = 512;
export const CHATV2_AGENT_STEP_DETAIL_BYTES = 1024;
/** Items in one task list, and each item's text (truncated, no body). */
export const CHATV2_TASK_ITEMS_MAX = 100;
export const CHATV2_TASK_ITEM_BYTES = 256;

/** Daemon-side delta batching window; approvals, questions, errors and turn ends flush at once. */
export const CHATV2_BATCH_MS = 120;
/** Most events in one push. */
export const CHATV2_MAX_EVENTS_PER_PUSH = 512;
/** An approval or question is answerable this long after it was requested (registry rule). */
export const CHATV2_ANSWER_ARM_MS = 1_500;
/** The folded record is persisted at most this long after a change (sooner on turn end, decisions, handoff, close). */
export const CHATV2_PERSIST_DEBOUNCE_MS = 1_000;
/** clientMessageIds remembered per record for duplicate detection. */
export const CHATV2_SEND_LEDGER_MAX = 256;
/** Overflow bodies kept per record (oldest dropped → `body-gone`). */
export const CHATV2_BODY_STORE_MAX_BYTES = 8 * 1024 * 1024;
/** `ChatV2Host.dispose` gives up and returns after this long. */
export const CHATV2_DISPOSE_TIMEOUT_MS = 5_000;

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting
 * a code point. Pure, so every fold truncates at the same place.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}
