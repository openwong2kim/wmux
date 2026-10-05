// Moa's operator-approved hand-off: the shared contract.
//
// Moa (the HQ brain) never pastes work into another workspace's agent. It
// proposes a hand-off with `moa_propose_handoff`; main stores the body and
// raises a card in the TARGET workspace's decision slot. Only a human click
// (or, when the operator allowed it, main's own danger-mode auto path)
// delivers it, through the operator lane, as the operator's own typing: the
// body plus one provenance line (buildHandoffLabel).
//
// THE PROVENANCE LINE IS A LABEL, NOT AN AUTHENTICATION BOUNDARY. Anyone who
// can type into a pane can type the same words. What it is for: telling the
// worker where the text came from and how to report back, and letting main
// refuse a non-operator caller that tries to pass its own text off as a
// hand-off (containsHandoffMarker — a tripwire, nothing more).

/** The card's options. */
export const HANDOFF_OPTIONS = {
  handOff: 'Hand off',
  edit: 'Edit',
  cancel: 'Cancel',
} as const;

/** The one option of the card that says a hand-off could not be delivered. */
export const HANDOFF_NOTICE_OPTION = 'OK';

/** Largest body main stores, in UTF-8 bytes. */
export const HANDOFF_BODY_MAX_BYTES = 16 * 1024;

/** Largest text the A2A delivery path takes (shared validateMessage's cap).
 *  Body + label must fit, or the click would fail after the human made it, so
 *  a longer body is refused when it is proposed. */
export const HANDOFF_MESSAGE_MAX_CHARS = 10_000;

/** Characters of the body the card's question/context preview shows. */
export const HANDOFF_PREVIEW_CHARS = 600;

/** The worker's closing words kept as an untrusted summary, in UTF-8 bytes. */
export const HANDOFF_LAST_MESSAGE_MAX_BYTES = 2 * 1024;

/** Auto hand-offs (danger mode, no click) allowed per target workspace per hour. */
export const HANDOFF_AUTO_PER_HOUR_DEFAULT = 6;

/** The fixed start of the provenance line. Matched case-insensitively by the
 *  tripwire, so a caller cannot dodge it with a different case. */
export const HANDOFF_MARKER = '(Handed off by you via Moa';

/** The first 8 characters of a task id, as the label shows it. */
export function shortTaskId(taskId: string): string {
  return taskId.replace(/^task[-_]?/i, '').slice(0, 8);
}

/**
 * The provenance line appended to a delivered hand-off. A label for the
 * worker, never proof of anything (see the header).
 */
export function buildHandoffLabel(taskId: string, auto = false): string {
  return `${HANDOFF_MARKER}${auto ? ' (auto, danger mode)' : ''} · task ${shortTaskId(taskId)}. When you finish or need input, say so in this pane.)`;
}

/** The text pasted into the worker's pane: the body, a blank line, the label. */
export function buildHandoffText(body: string, taskId: string, auto = false): string {
  return `${body.trim()}\n\n${buildHandoffLabel(taskId, auto)}`;
}

/** Room the label takes, with its separator (task ids are bounded). */
export const HANDOFF_LABEL_RESERVE_CHARS = buildHandoffLabel('x'.repeat(40), true).length + 2;

/** Text as the tripwire compares it: compatibility-normalized (NFKC, so
 *  full-width and other look-alike forms fold), control and format characters
 *  (zero-width, bidi marks) dropped, whitespace runs collapsed, lowercased. */
export function normalizeForMarker(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (/\s/.test(c) ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const MARKER_NORMALIZED = normalizeForMarker(HANDOFF_MARKER);

/** Does this text carry the provenance marker? The non-operator tripwire. */
export function containsHandoffMarker(text: unknown): boolean {
  return typeof text === 'string' && normalizeForMarker(text).includes(MARKER_NORMALIZED);
}

/** Byte length in UTF-8. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Why a body cannot be proposed, or null when it can. */
export function handoffBodyRefusal(body: unknown): 'body_empty' | 'body_too_long' | null {
  if (typeof body !== 'string' || body.trim().length === 0) return 'body_empty';
  const b = body.trim();
  if (utf8Bytes(b) > HANDOFF_BODY_MAX_BYTES) return 'body_too_long';
  if (b.length + HANDOFF_LABEL_RESERVE_CHARS > HANDOFF_MESSAGE_MAX_CHARS) return 'body_too_long';
  return null;
}

/** What the renderer's hand-off card needs beyond the decision itself. */
export interface MoaHandoffCardInfo {
  /** The full body Moa proposed (the Edit field starts from it). */
  body: string;
  /** A short title for the receipt and the task. */
  title: string;
  agentName: string;
  targetPaneId: string;
  targetPtyId: string;
  /** The target agent takes no multi-line paste: newlines become " — ". */
  foldsNewlines: boolean;
  /** The agent was mid-turn when the card was raised: the text will queue. */
  willQueue: boolean;
}

/** DECK_MOA_HANDOFF_RESOLVE's request: the card by id; a body only on Edit. */
export interface MoaHandoffResolveRequest {
  workspaceId: string;
  id: string;
  action: 'handoff' | 'cancel';
  /** The operator's edited body. Absent = the stored one. */
  body?: string;
}

export type MoaHandoffResolveResult =
  | { ok: true; delivered: boolean; taskId?: string; note?: string }
  | { ok: false; code: 'not_pending' | 'invalid' | 'body_empty' | 'body_too_long' | 'edit_needs_body' | 'error'; message?: string };

/** A non-blocking receipt of an auto (no-click) hand-off. */
export interface MoaAutoHandoffReceipt {
  id: string;
  taskId: string;
  title: string;
  targetWorkspaceId: string;
  targetWorkspaceName?: string;
  targetPaneId: string;
  at: number;
  /** Stop was pressed (the task is canceled). */
  stopped?: boolean;
}
