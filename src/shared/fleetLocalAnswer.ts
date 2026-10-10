// A Moa Fleet fast-path answer as structured data (main/deck/fleetFastPath.ts).
//
// Main does not know the operator's UI language, so it ships the counts and
// the already-sanitized rows, and the renderer writes the sentences from its
// locale tables (renderer/components/Moa/panel/fleetAnswerText.ts) — the same
// split as the deck briefing's `BriefingCounts`.

export type FleetIntent = 'needs_you' | 'finished' | 'status';

/** The row reasons a local answer can list: the board's Needs you reasons and
 *  a finished turn. Running and idle rows are counted, never listed. */
export type FleetAnswerReason = 'input' | 'error' | 'unconfirmed' | 'supervisionStopped' | 'complete';

export interface FleetAnswerRow {
  /** Display-safe label: controls, bidi marks and Markdown/HTML punctuation
   *  already removed, at most 80 characters. Empty when nothing displayable
   *  was left; the renderer then shows its own word for "untitled". */
  title: string;
  /** Same treatment as `title`. */
  workspaceName: string;
  reason: FleetAnswerReason;
}

export interface FleetLocalAnswer {
  intent: FleetIntent;
  /** Section totals, omitted rows included. */
  counts: { needsYou: number; finished: number; running: number; idle: number };
  /** At most `FLEET_ANSWER_MAX_ROWS` rows to list, in board order. */
  rows: FleetAnswerRow[];
  /** The board or the list left rows out: the answer points at Fleet. */
  limited: boolean;
}

export const FLEET_ANSWER_MAX_ROWS = 12;
