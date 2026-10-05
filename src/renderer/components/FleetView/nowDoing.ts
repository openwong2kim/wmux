import type { FleetRow } from '../../stores/selectors/fleet';
import { parseActivity } from '../../../shared/activityVerb';
import { flattenAgentText } from '../../../shared/assistantPreview';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** "✎ foo.ts" → "Edited foo.ts" (or "Editing foo.ts" while the tool runs);
 *  an empty line → ''. */
export function activitySentence(summary: string | undefined, t: T, tense: 'past' | 'present' = 'past'): string {
  const parsed = parseActivity(summary);
  if (!parsed) return '';
  return t(`${tense === 'present' ? 'fleet.nowing' : 'fleet.now'}.${parsed.verb}`, { target: parsed.target });
}

export interface NowDoingLine {
  text: string;
  /** now = the running tool, last = the last tool of a finished turn,
   *  question / reply = the agent's own words, error = the last error line
   *  the terminal printed, status = a fixed label. */
  kind: 'now' | 'last' | 'question' | 'reply' | 'error' | 'status';
}

/**
 * The row's one readable line. A question always wins (it is why the row
 * needs you). An error row shows the last error line its terminal printed,
 * when there is one. A running agent says what it is doing, in the present
 * tense; anything else says what it did last, then falls back to its last
 * reply (agents that send no tool activity), then to the section's label.
 * Stopped and unconfirmed rows keep their label: it is the more urgent fact.
 */
export function nowDoingLine(row: FleetRow, lastActivity: string | undefined, t: T, errorLine?: string): NowDoingLine {
  if (row.detailSource === 'question' && row.detail) return { text: row.detail, kind: 'question' };
  if (row.detailKey === 'fleet.detail.error' && errorLine) return { text: errorLine, kind: 'error' };
  const status = row.detailKey === 'fleet.detail.error' || row.detailKey === 'fleet.detail.unconfirmed'
    || row.detailKey === 'fleet.detail.supervisionStopped';
  if (!status) {
    if (row.detailSource === 'activity') {
      const now = activitySentence(row.detail, t, 'present');
      if (now) return { text: now, kind: 'now' };
    }
    // Only a turn that is over says what it did last: a pane asking for input
    // (a permission prompt, no question text) keeps "Needs your input".
    const ended = row.pane.agentStatus === 'complete' || row.pane.agentStatus === 'idle' || row.pane.agentStatus === 'waiting';
    if (ended && row.pane.surfaceType === 'terminal') {
      const last = activitySentence(flattenAgentText(lastActivity ?? ''), t);
      if (last) return { text: t('fleet.now.last', { text: last }), kind: 'last' };
    }
    if (row.detailSource === 'lastMessage' && row.detail) return { text: row.detail, kind: 'reply' };
  }
  return { text: t(row.detailKey), kind: 'status' };
}

/** A line that reports an error: `Error: …`, `error[E0308]: …`, `npm ERR!`,
 *  `fatal: …`, a Python traceback head, `FAIL …`, `✗ …`. Conservative on
 *  purpose — a word "error" inside ordinary prose does not count. */
const ERROR_LINE = /^\s*(?:[\w.]*(?:Error|Exception)\b[:[]|error(?:\[[^\]]*\])?:|ERROR\b|npm ERR!|fatal:|panic:|Traceback \(most recent call last\)|FAIL(?:ED)?\b|[✗✘×]\s)/;

/** The last error line in a terminal tail, flattened for display; undefined
 *  when none of the lines reads as one. */
export function lastErrorLine(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ERROR_LINE.test(lines[i])) return flattenAgentText(lines[i].trim()) || undefined;
  }
  return undefined;
}

/** Index of that line in the same tail (for highlighting it), or -1. */
export function lastErrorLineIndex(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (ERROR_LINE.test(lines[i])) return i;
  return -1;
}

/** One numbered choice of a prompt drawn in the terminal. */
export interface PromptChoice {
  number: string;
  label: string;
  /** The choice the prompt's cursor is on. */
  current: boolean;
}

const CHOICE_LINE = /^\s*[│|]?\s*([❯›>])?\s*(\d{1,2})[.)]\s+(\S.*?)\s*[│|]?\s*$/;

/**
 * The numbered choices of the prompt at the bottom of a terminal tail
 * (`❯ 1. Yes` / `2. No`): the last run of consecutive numbers starting at 1,
 * allowing wrapped or blank lines between items. Empty when the tail ends in
 * something else, so ordinary numbered output far above is never offered.
 */
export function promptChoices(lines: readonly string[]): PromptChoice[] {
  // Footer hints under a picker ("Esc to cancel") are allowed below it.
  let found: PromptChoice[] = [];
  for (let i = Math.max(0, lines.length - 25); i < lines.length; i++) {
    const m = CHOICE_LINE.exec(lines[i]);
    if (!m) continue;
    const choice = { number: m[2], label: flattenAgentText(m[3]), current: !!m[1] };
    if (m[2] === '1') found = [choice];
    else if (found.length > 0 && Number(m[2]) === found.length + 1) found.push(choice);
    else found = [];
  }
  return found.length >= 2 ? found : [];
}
