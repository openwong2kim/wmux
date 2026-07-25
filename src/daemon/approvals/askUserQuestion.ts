// A4 — pull the QUESTION and its OPTION LABELS out of a PreToolUse envelope.
//
// Why this exists: approve is encoded as "press the first option" (see
// approvalKeystrokes.ts), and a pending request that does not say WHAT is being
// asked makes that press blind. "Approve" is a safe word for a consent-shaped
// question and a dangerous one for "which file should I delete?" — the phone
// has to show the question text and the options it is choosing between, or the
// operator is answering a question they cannot read.
//
// The input is the raw Claude Code hook payload, forwarded verbatim by the
// bridge (`payload: {...(payload ?? {})}` in wmux-bridge.mjs). It is
// AGENT-AUTHORED and therefore untrusted in both senses that matter here:
//   - shape: any field may be missing or any type. Every access is guarded and
//     an unrecognized shape yields absent fields, never a throw and never a
//     blocked request creation. A request with no question text is still worth
//     far more than no request at all.
//   - content: these strings land in approvals.json, in an HTTP body, and on a
//     phone screen. They are cleaned of control characters (an agent can put
//     ANSI escapes in an option label) and hard-truncated before any of that.
//
// The sanitising follows src/shared/activitySummary.ts, which solves the same
// problem for the Fleet activity line: cap the raw string BEFORE any regex work
// so a multi-MB field cannot make the control-char scan do O(n) work, then
// strip, collapse, trim, and truncate to the display cap.

/** Cap applied BEFORE any regex work on an untrusted string (activitySummary's MAX_RAW_LEN). */
const MAX_RAW_LEN = 1024;

/** Display caps. A phone renders these; anything longer is noise. */
export const MAX_QUESTION_CHARS = 200;
export const MAX_OPTION_LABEL_CHARS = 80;
/** Claude's own permission prompts offer 2-3 options; 8 is slack, not a target. */
export const MAX_OPTIONS = 8;

// C0 controls, DEL, and C1 controls — the same class activitySummary strips.
// Written with hex escapes so the source file stays pure ASCII: a literal
// control byte embedded in a source file is invisible in review and easy for a
// tool to mangle.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

export interface ExtractedQuestion {
  question?: string;
  options?: string[];
}

/**
 * Extract `{question, options}` from a PreToolUse hook payload.
 *
 * The canonical Claude Code `AskUserQuestion` tool_input is
 * `{questions: [{question, header, multiSelect, options: [{label, description}]}]}`.
 * A flatter `{question, options}` and bare-string options are both tolerated,
 * because this runs against whatever a future Claude Code build sends and the
 * cost of guessing wrong is a missing label, not a wrong keystroke.
 *
 * ONLY THE FIRST QUESTION is extracted. AskUserQuestion may carry several, but
 * the keystroke map presses one option on whatever the TUI is showing, which is
 * the first question — surfacing options from a later one would describe a
 * choice the press cannot make. (Multi-question prompts are a real gap here and
 * belong with the per-option press in M5/M6.)
 *
 * Never throws. Any field it cannot make sense of is simply absent.
 */
export function extractAskUserQuestion(payload: unknown): ExtractedQuestion {
  const toolInput = readObject(payload, 'tool_input');
  if (!toolInput) return {};

  // Canonical shape first: questions[0]. Fall back to the flat shape on the
  // tool_input itself.
  const questions = readArray(toolInput, 'questions');
  const source = (questions && isObject(questions[0]) ? questions[0] : toolInput) as Record<
    string,
    unknown
  >;

  const out: ExtractedQuestion = {};
  const question = clean(readString(source, 'question'), MAX_QUESTION_CHARS);
  if (question) out.question = question;

  const options = readOptionLabels(source);
  if (options.length > 0) out.options = options;

  return out;
}

/**
 * Option labels, from either `[{label}]` or `['label']`. Entries that yield no
 * usable label are DROPPED rather than kept as empty strings — a blank row on a
 * phone is worse than a shorter list — which is why the index of an option here
 * is not promised to match the digit that selects it. Nothing presses by index
 * from this list today (approve is hard-coded to the first option); when M5/M6
 * adds per-option press it must carry the real index, not this array's.
 */
function readOptionLabels(source: Record<string, unknown>): string[] {
  const raw = readArray(source, 'options');
  if (!raw) return [];
  const labels: string[] = [];
  for (const entry of raw) {
    if (labels.length >= MAX_OPTIONS) break;
    const label = typeof entry === 'string'
      ? clean(entry, MAX_OPTION_LABEL_CHARS)
      : clean(readString(entry, 'label'), MAX_OPTION_LABEL_CHARS);
    if (label) labels.push(label);
  }
  return labels;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readObject(source: unknown, key: string): Record<string, unknown> | null {
  if (!isObject(source)) return null;
  const v = source[key];
  return isObject(v) ? v : null;
}

function readArray(source: unknown, key: string): unknown[] | null {
  if (!isObject(source)) return null;
  const v = source[key];
  return Array.isArray(v) ? v : null;
}

function readString(source: unknown, key: string): string {
  if (!isObject(source)) return '';
  const v = source[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Cap → strip control chars → collapse whitespace → trim → truncate to the
 * display cap. The pre-regex cap is the load-bearing one: without it a
 * multi-megabyte label would make the control-char scan and whitespace collapse
 * do O(n) work on the daemon's event loop, on a path an agent controls.
 */
function clean(s: string, max: number): string {
  if (!s) return '';
  const capped = s.length > MAX_RAW_LEN ? s.slice(0, MAX_RAW_LEN) : s;
  const normalized = capped.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

/**
 * Re-apply the caps to values read back from disk. approvals.json is a plain
 * file: a hand-edit (or a record written by an older build with looser caps)
 * must not put an unbounded string into an HTTP response.
 */
export function sanitizeQuestion(value: unknown): string | undefined {
  const out = clean(typeof value === 'string' ? value : '', MAX_QUESTION_CHARS);
  return out || undefined;
}

export function sanitizeOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels: string[] = [];
  for (const entry of value) {
    if (labels.length >= MAX_OPTIONS) break;
    const label = clean(typeof entry === 'string' ? entry : '', MAX_OPTION_LABEL_CHARS);
    if (label) labels.push(label);
  }
  return labels.length > 0 ? labels : undefined;
}
