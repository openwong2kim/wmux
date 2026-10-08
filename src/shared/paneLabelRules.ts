// Pane label policy. A pane's user label doubles as an addressing tag
// (`#backend` in a prompt, resolved by `pane.resolveName`), so it must be a
// single token that cannot be confused with the auto coordinate, a mention or a
// tag sigil, and it must be unique among live panes. MetadataStore is the only
// place that enforces this (both the UI rename and MCP pane_metadata write
// through it); this module only holds the pure shape rules and the error type
// so the store, its callers and the UI agree on the rejection codes.

export type PaneLabelRejection =
  | 'whitespace'
  | 'reserved-char'
  | 'leading-digit'
  | 'auto-name'
  | 'duplicate';

/** Thrown by MetadataStore when a label breaks the policy. `code` is stable and
 *  is what the UI maps to a localized reason. */
export class PaneLabelError extends Error {
  readonly code: PaneLabelRejection;

  constructor(code: PaneLabelRejection, message: string) {
    super(message);
    this.name = 'PaneLabelError';
    this.code = code;
  }
}

/** `w<ws>-<pane>` — the auto coordinate every pane already has. A label that
 *  starts with it would read as (or shadow) another pane's tag. */
export const PANE_AUTO_NAME_PREFIX_RE = /^w\d+-\d+/i;

const REJECTION_MESSAGES: Record<PaneLabelRejection, string> = {
  whitespace: 'a pane label cannot contain whitespace',
  'reserved-char': 'a pane label cannot contain "#" or "@"',
  'leading-digit': 'a pane label cannot start with a digit',
  'auto-name': 'a pane label cannot look like an automatic pane name (w<n>-<n>)',
  duplicate: 'another live pane already uses this label',
};

export function paneLabelRejectionMessage(code: PaneLabelRejection): string {
  return REJECTION_MESSAGES[code];
}

/**
 * Shape check for a label that is about to be SET (the caller has already
 * trimmed it and knows it is non-empty). Returns the first broken rule, or null.
 * Uniqueness needs the store's other entries and is checked there.
 */
export function paneLabelShapeError(label: string): PaneLabelRejection | null {
  if (/\s/.test(label)) return 'whitespace';
  if (/[#@]/.test(label)) return 'reserved-char';
  if (/^\d/.test(label)) return 'leading-digit';
  if (PANE_AUTO_NAME_PREFIX_RE.test(label)) return 'auto-name';
  return null;
}

/** Labels compare trimmed and case-insensitively, the same way the name
 *  resolver matches them. */
export function normalizePaneLabel(label: string): string {
  return label.trim().toLowerCase();
}
